import { supabase } from "../supabase.server";
import { authenticate, unauthenticated } from "../shopify.server";

// CORS Headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export const loader = async () => {
  return new Response(null, { headers: corsHeaders });
};

export const action = async ({ request }) => {
  // Security Check: authenticate.admin or CRON_SECRET
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  const authHeader = request.headers.get("Authorization");

  let shop = null;
  let isAuthenticated = false;
  let body = null;

  // CRON_SECRET for cron jobs
  if (key === process.env.CRON_SECRET && process.env.CRON_SECRET) {
    try {
      body = await request.json();
      shop = body.shop;
      isAuthenticated = true;
      console.log('[clear] Authenticated via CRON_SECRET for shop', shop);
    } catch (e) {
      console.error('[clear] Failed to parse body for CRON_SECRET request:', e?.message || e);
    }
  }
  // Bearer token for embedded app
  else if (authHeader?.startsWith('Bearer ')) {
    try {
      const { session } = await authenticate.admin(request);
      shop = session?.shop;
      isAuthenticated = !!shop;
      console.log('[clear] Authenticated via authenticate.admin for shop:', shop);
    } catch (err) {
      console.error('[clear] authenticate.admin failed:', err?.message || err);
    }
  }

  if (!isAuthenticated || !shop) {
    console.error('[clear] Authentication failed - no valid shop');
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  }

  // Parse body once if not already parsed for CRON
  if (!body) {
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: corsHeaders });
    }
  }

  const { shop: bodyShop, customerId } = body || {};
  const shopToQuery = shop || bodyShop;

  if (!shopToQuery || !customerId) {
    return new Response(JSON.stringify({ error: 'Missing shop or customerId' }), { status: 400, headers: corsHeaders });
  }

  try {
    // 1. Find shop
    const { data: loyaltyShop, error: shopError } = await supabase
      .from("shops")
      .select("id, access_token")
      .eq("shopify_domain", shopToQuery)
      .single();

    if (shopError || !loyaltyShop) {
      return new Response(JSON.stringify({ error: "Shop not found" }), { status: 404, headers: corsHeaders });
    }

    // 2. Find customer
    const { data: customer } = await supabase
      .from("customers")
      .select("id, email, discount_codes")
      .eq("shopify_customer_id", customerId)
      .eq("shop_id", loyaltyShop.id)
      .single();

    if (!customer) {
      return new Response(JSON.stringify({ error: "Customer not found" }), { status: 404, headers: corsHeaders });
    }

    const codes = customer.discount_codes || [];

    // 3. For each code, try to mark the Create Coupon event as cancelled and delete allocations
    let processed = 0;
    let totalRefunded = 0;
    for (const code of codes) {
      // Find the Create Coupon event
      const { data: couponEvent } = await supabase
        .from("events")
        .select("id")
        .eq("redeemed_code", code)
        .eq("event_type", "Create Coupon")
        .eq("shop_id", loyaltyShop.id)
        .maybeSingle();

      if (couponEvent && couponEvent.id) {
        // Attempt to delete the coupon in Shopify as well (best-effort)
        try {
          let admin = null;
          try {
            const res = await unauthenticated.admin(shopToQuery);
            admin = res.admin;
          } catch (e) {
            // Fallback to raw fetch using stored access_token
            if (!loyaltyShop.access_token) {
              console.warn('[clear] No admin session or access token for shop', shopToQuery);
            } else {
              admin = {
                graphql: (query, opts = {}) => {
                  return fetch(`https://${shopToQuery}/admin/api/2025-01/graphql.json`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'X-Shopify-Access-Token': loyaltyShop.access_token,
                    },
                    body: JSON.stringify({ query, variables: opts.variables }),
                  });
                }
              };
            }
          }

          if (admin) {
            const searchResponse = await admin.graphql(
              `#graphql
              query findDiscount($query: String!) {
                discountNodes(first: 1, query: $query) {
                  nodes {
                    id
                    discount {
                      ... on DiscountCodeBasic {
                        title
                        asyncUsageCount
                        status
                      }
                    }
                  }
                }
              }`,
              { variables: { query: `code:${code}` } }
            );

            const searchJson = await searchResponse.json().catch(() => ({}));
            const node = searchJson.data?.discountNodes?.nodes?.[0];
            if (node) {
              if (node.discount?.asyncUsageCount > 0) {
                console.warn('[clear] Coupon has usage, skipping Shopify delete for', code);
              } else {
                const deleteResponse = await admin.graphql(
                  `#graphql
                  mutation discountCodeDelete($id: ID!) {
                    discountCodeDelete(id: $id) {
                      deletedCodeDiscountId
                      userErrors {
                          field
                          message
                      }
                    }
                  }`,
                  { variables: { id: node.id } }
                );
                const deleteJson = await deleteResponse.json().catch(() => ({}));
                if (deleteJson.data?.discountCodeDelete?.userErrors?.length > 0) {
                  console.warn('[clear] Shopify delete returned userErrors for code', code, deleteJson.data.discountCodeDelete.userErrors);
                } else {
                  console.log('[clear] Deleted coupon in Shopify for code', code);
                }
              }
            } else {
              console.log('[clear] No matching coupon found in Shopify for code', code);
            }
          }
        } catch (e) {
          console.warn('[clear] Shopify delete attempt failed for code', code, e?.message || e);
        }
        // 3.a Reverse allocations (restore points) if possible
        try {
          // Fetch customer's current redeemable before reverse
          const { data: custBefore } = await supabase
            .from('customers')
            .select('id, redeemable_points')
            .eq('id', customer.id)
            .single();

          const balanceBefore = custBefore?.redeemable_points || 0;

          const { data: reverseResult, error: reverseError } = await supabase.rpc('reverse_point_allocations', { _to_event_id: couponEvent.id });

          if (reverseError) {
            console.error('❌ Point reverse failed (RPC):', reverseError);
            return new Response(JSON.stringify({ error: 'Point reverse failed', details: reverseError.message || reverseError }), { status: 500, headers: corsHeaders });
          }

          let restoredPoints = 0;
          let reversedCount = 0;
          if (reverseResult && reverseResult[0]) {
            restoredPoints = reverseResult[0].restored_points || 0;
            reversedCount = reverseResult[0].restored_count || 0;
          }

          // Mark coupon event as cancelled
          await supabase
            .from('events')
            .update({ remaining_points: -1 })
            .eq('id', couponEvent.id);

          // Create audit event for Cancel Coupon
          try {
            await supabase.from('events').insert({
              shop_id: loyaltyShop.id,
              customer_id: customer.id,
              event_type: 'Cancel Coupon',
              points: restoredPoints,
              redeemed_code: code,
              remaining_points: 0,
            });
          } catch (e) {
            console.warn('Failed to insert Cancel Coupon event', e.message || e);
          }

          // Update customer's redeemable balance
          if (restoredPoints > 0) {
            const newRedeemable = balanceBefore + restoredPoints;
            const { error: updErr } = await supabase
              .from('customers')
              .update({ redeemable_points: newRedeemable })
              .eq('id', customer.id);
            if (updErr) console.warn('Failed updating customer redeemable after reverse', updErr);
            totalRefunded += restoredPoints;
          }

          // As a fallback, still attempt to delete any leftover allocations by to_event
          try {
            await supabase.rpc('delete_allocations_by_to_event', { _to_event_id: couponEvent.id });
          } catch (e) {
            console.warn('delete_allocations_by_to_event failed for', couponEvent.id, e.message || e);
          }

          processed += 1;
        } catch (e) {
          console.warn('Error handling coupon code', code, e.message || e);
        }
      }
    }

    // 4. Remove all discount_codes from customer
    const { error: updateErr } = await supabase
      .from('customers')
      .update({ discount_codes: [] })
      .eq('id', customer.id);

    if (updateErr) {
      console.error('Failed to clear discount_codes:', updateErr);
      return new Response(JSON.stringify({ error: 'Failed to update customer' }), { status: 500, headers: corsHeaders });
    }

    // Send Klaviyo "Loyalty Discounts Cleared" event
    const klaviyoApiKey = process.env.KLAVIYO_API_KEY;
    if (klaviyoApiKey && customer.email) {
      try {
        const klaviyoPayload = {
          data: {
            type: "event",
            attributes: {
              metric: {
                data: {
                  type: "metric",
                  attributes: { name: "Loyalty Discounts Cleared" }
                }
              },
              profile: {
                data: {
                  type: "profile",
                  attributes: { email: customer.email }
                }
              },
              properties: {
                shopify_customer_id: customerId,
                cleared_codes: codes,
                refunded_points: totalRefunded,
              },
              time: new Date().toISOString(),
            }
          }
        };

        const klaviyoRes = await fetch("https://a.klaviyo.com/api/events/", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Klaviyo-API-Key ${klaviyoApiKey}`,
            "revision": "2023-12-15",
          },
          body: JSON.stringify(klaviyoPayload),
        });

        if (!klaviyoRes.ok) {
          const errText = await klaviyoRes.text();
          console.warn("[clear] ⚠️ Klaviyo event failed:", klaviyoRes.status, errText);
        } else {
          console.log(`[clear] 📧 Klaviyo 'Loyalty Discounts Cleared' event sent for ${customer.email}`);
        }
      } catch (klaviyoErr) {
        console.warn("[clear] ⚠️ Klaviyo event exception:", klaviyoErr);
      }
    }

    return new Response(JSON.stringify({ success: true, processedCodes: processed, refundedPoints: totalRefunded }), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error('Clear discounts error:', err);
    return new Response(JSON.stringify({ error: err.message || 'Unknown error' }), { status: 500, headers: corsHeaders });
  }
};
