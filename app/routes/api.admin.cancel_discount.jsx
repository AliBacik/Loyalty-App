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
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  const authHeader = request.headers.get("Authorization");

  let shop = null;
  let isAuthenticated = false;
  let body = null;

  if (key === process.env.CRON_SECRET && process.env.CRON_SECRET) {
    try {
      body = await request.json();
      shop = body.shop;
      isAuthenticated = true;
      console.log('[cancel_discount] Authenticated via CRON_SECRET for shop', shop);
    } catch (e) {
      console.error('[cancel_discount] Failed to parse body:', e?.message || e);
    }
  } else if (authHeader?.startsWith('Bearer ')) {
    try {
      const { session } = await authenticate.admin(request);
      shop = session?.shop;
      isAuthenticated = !!shop;
      console.log('[cancel_discount] Authenticated via authenticate.admin for shop:', shop);
    } catch (err) {
      console.error('[cancel_discount] authenticate.admin failed:', err?.message || err);
    }
  }

  if (!isAuthenticated || !shop) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  }

  if (!body) {
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: corsHeaders });
    }
  }

  const { customerId, code } = body || {};
  if (!customerId || !code) {
    return new Response(JSON.stringify({ error: 'Missing customerId or code' }), { status: 400, headers: corsHeaders });
  }

  try {
    // 1. Find shop
    const { data: loyaltyShop, error: shopError } = await supabase
      .from("shops")
      .select("id, access_token")
      .eq("shopify_domain", shop)
      .single();

    if (shopError || !loyaltyShop) {
      return new Response(JSON.stringify({ error: "Shop not found" }), { status: 404, headers: corsHeaders });
    }

    // 2. Find customer
    const { data: customer } = await supabase
      .from("customers")
      .select("id, email, discount_codes, redeemable_points")
      .eq("shopify_customer_id", customerId)
      .eq("shop_id", loyaltyShop.id)
      .single();

    if (!customer) {
      return new Response(JSON.stringify({ error: "Customer not found" }), { status: 404, headers: corsHeaders });
    }

    // 3. Build admin GraphQL caller
    let admin = null;
    try {
      const res = await unauthenticated.admin(shop);
      admin = res.admin;
    } catch (e) {
      console.log('[cancel_discount] Unauthenticated admin failed, using access_token fallback');
      if (!loyaltyShop.access_token) {
        return new Response(JSON.stringify({ error: "No admin session or access token" }), { status: 401, headers: corsHeaders });
      }
      admin = {
        graphql: (query, opts = {}) => fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': loyaltyShop.access_token,
          },
          body: JSON.stringify({ query, variables: opts.variables }),
        })
      };
    }

    // 4. Find discount in Shopify
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

    const searchJson = await searchResponse.json();
    const node = searchJson.data?.discountNodes?.nodes?.[0];

    let skipShopifyDelete = false;
    if (!node) {
      console.warn('[cancel_discount] Code not found in Shopify, proceeding with DB-only cancel:', code);
      skipShopifyDelete = true;
    } else if (node.discount?.asyncUsageCount > 0) {
      return new Response(JSON.stringify({ error: "Cannot cancel. This coupon has already been used." }), { status: 400, headers: corsHeaders });
    }

    // 5. Find original Create Coupon event
    const { data: originalEvent } = await supabase
      .from("events")
      .select("id, points, customer_id")
      .eq("redeemed_code", code)
      .eq("event_type", "Create Coupon")
      .eq("shop_id", loyaltyShop.id)
      .single();

    if (!originalEvent) {
      return new Response(JSON.stringify({ error: "Original transaction not found" }), { status: 404, headers: corsHeaders });
    }

    if (originalEvent.customer_id !== customer.id) {
      return new Response(JSON.stringify({ error: "Code does not belong to this customer" }), { status: 403, headers: corsHeaders });
    }

    // 6. Delete from Shopify
    if (!skipShopifyDelete) {
      const deleteResponse = await admin.graphql(
        `#graphql
        mutation discountCodeDelete($id: ID!) {
          discountCodeDelete(id: $id) {
            deletedCodeDiscountId
            userErrors { field message }
          }
        }`,
        { variables: { id: node.id } }
      );
      const deleteJson = await deleteResponse.json();
      if (deleteJson.data?.discountCodeDelete?.userErrors?.length > 0) {
        console.error('[cancel_discount] Shopify delete error:', deleteJson.data.discountCodeDelete.userErrors);
        return new Response(JSON.stringify({ error: "Failed to delete coupon in Shopify" }), { status: 500, headers: corsHeaders });
      }
      console.log('[cancel_discount] ✅ Coupon deleted from Shopify:', code);
    }

    // 7. Reverse point allocations
    const balanceBefore = customer.redeemable_points || 0;

    const { data: reverseResult, error: reverseError } = await supabase
      .rpc('reverse_point_allocations', { _to_event_id: originalEvent.id });

    if (reverseError) {
      console.error('[cancel_discount] Point reverse failed:', reverseError);
      return new Response(JSON.stringify({ error: "Point restoration failed", details: reverseError.message }), { status: 500, headers: corsHeaders });
    }

    const restoredPoints = reverseResult?.[0]?.restored_points || 0;
    const restoredCount = reverseResult?.[0]?.restored_count || 0;
    const expiredPoints = reverseResult?.[0]?.expired_points || 0;
    const expiredCount = reverseResult?.[0]?.expired_count || 0;

    console.log(`[cancel_discount] Reversed ${restoredCount} allocations, restored ${restoredPoints} points`);

    // 8. Insert Cancel Coupon audit event
    await supabase.from("events").insert({
      shop_id: loyaltyShop.id,
      customer_id: customer.id,
      event_type: "Cancel Coupon",
      points: restoredPoints,
      redeemed_code: code,
      remaining_points: 0,
    });

    // Mark original Create Coupon event as cancelled
    await supabase
      .from('events')
      .update({ remaining_points: -1 })
      .eq('id', originalEvent.id);

    // 9. Update customer: remove code, restore balance
    const updatedCodes = (customer.discount_codes || []).filter(c => c !== code);
    const newRedeemable = balanceBefore + restoredPoints;

    await supabase
      .from("customers")
      .update({ discount_codes: updatedCodes, redeemable_points: newRedeemable })
      .eq("id", customer.id);

    console.log(`[cancel_discount] Balance: ${balanceBefore} + ${restoredPoints} = ${newRedeemable}`);

    // 10. Send Klaviyo "Loyalty Discount Cancelled" event
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
                  attributes: { name: "Loyalty Discount Cancelled" }
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
                cancelled_code: code,
                refunded_points: restoredPoints,
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
          console.warn("[cancel_discount] ⚠️ Klaviyo event failed:", klaviyoRes.status, errText);
        } else {
          console.log(`[cancel_discount] 📧 Klaviyo 'Loyalty Discount Cancelled' event sent for ${customer.email}`);
        }
      } catch (klaviyoErr) {
        console.warn("[cancel_discount] ⚠️ Klaviyo event exception:", klaviyoErr);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      refundedPoints: restoredPoints,
      allocationsReversed: restoredCount,
      expiredAllocations: expiredCount,
      expiredPoints,
    }), { status: 200, headers: corsHeaders });

  } catch (err) {
    console.error('[cancel_discount] Error:', err);
    return new Response(JSON.stringify({ error: err.message || 'Unknown error' }), { status: 500, headers: corsHeaders });
  }
};
