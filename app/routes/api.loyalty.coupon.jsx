import { supabase } from "../supabase.server";

// CORS Headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// Handle CORS preflight (OPTIONS)
export const loader = async () => {
  return new Response(null, { headers: corsHeaders });
};

export const action = async ({ request }) => {

  // 1. Parse Request
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: corsHeaders });
  }

  // Normalize and debug incoming values
  let { customerId, shop, pointsToRedeem } = body || {};
  console.log("📥 Incoming coupon request:", { customerId, shop, rawPoints: pointsToRedeem });
  console.log("📥 Raw types:", { pointsToRedeemType: typeof pointsToRedeem });

  // Coerce to integer (safe normalization)
  pointsToRedeem = Math.floor(Number(pointsToRedeem || 0));
  console.log("📥 Normalized pointsToRedeem:", pointsToRedeem);

  if (!customerId || !shop || !pointsToRedeem) {
    return new Response(JSON.stringify({ error: "Missing data" }), { status: 400, headers: corsHeaders });
  }

  // 2. Database Checks (Get Shop & Customer)
  const { data: loyaltyShop } = await supabase
    .from("shops")
    .select("id, access_token")
    .eq("shopify_domain", shop)
    .single();

  if (!loyaltyShop || !loyaltyShop.access_token) {
    console.error(`❌ Shop ${shop} or Access Token missing.`);
    return new Response(JSON.stringify({ error: "Auth missing" }), { status: 404, headers: corsHeaders });
  }

  const { data: customer } = await supabase
    .from("customers")
    .select("id, email, redeemable_points, lifetime_points, discount_codes")
    .eq("shopify_customer_id", customerId)
    .eq("shop_id", loyaltyShop.id)
    .single();

  if (!customer) {
    return new Response(JSON.stringify({ error: "Customer not found" }), { status: 404, headers: corsHeaders });
  }

  // Only count points from non-expired Earn events (remaining_points > 0 AND expires_at in the future)
  const now = new Date().toISOString();
  const { data: availableEarnEvents, error: earnError } = await supabase
    .from("events")
    .select("remaining_points")
    .eq("customer_id", customer.id)
    .eq("shop_id", loyaltyShop.id)
    .eq("event_type", "Earn")
    .gt("remaining_points", 0)
    .gt("expires_at", now);

  if (earnError) {
    console.error("❌ Failed to check available points:", earnError);
    return new Response(JSON.stringify({ error: "Failed to verify points" }), { status: 500, headers: corsHeaders });
  }

  const availablePoints = (availableEarnEvents || []).reduce((sum, e) => sum + e.remaining_points, 0);
  console.log(`📊 Non-expired available points: ${availablePoints} / Requested: ${pointsToRedeem}`);

  if (availablePoints < pointsToRedeem) {
    return new Response(JSON.stringify({ error: "Insufficient points" }), { status: 400, headers: corsHeaders });
  }

  // 3. Prepare Shopify Payload
  // Logic: 10 Points = $1.00
  const discountValue = Math.floor(pointsToRedeem / 10);
  if (discountValue < 1) {
    return new Response(JSON.stringify({ error: "Minimum redemption is 10 points ($1)" }), { status: 400, headers: corsHeaders });
  }

  // Minimum purchase amount must be 3x discount value
  const minimumAmount = (discountValue * 3).toFixed(2); // string like "60.00"

  const code = `LOYALTY-${pointsToRedeem}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

  const startsAt = new Date();
  const endsAt = new Date();
  endsAt.setDate(endsAt.getDate() + 30); // 30 Day Expiration

  const mutation = `
    mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              title
              codes(first: 1) { nodes { code } }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    basicCodeDiscount: {
      title: code,
      code: code,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      usageLimit: 1, // Use once
      customerSelection: {
        customers: { add: [`gid://shopify/Customer/${customerId}`] } // Lock to user
      },
      minimumRequirement: {
        subtotal: {
          greaterThanOrEqualToSubtotal: minimumAmount.toString() // Sadece string değer
        }
      },
      customerGets: {
        value: {
          discountAmount: {
            amount: discountValue.toString(),
            appliesOnEachItem: false
          }
        },
        items: { all: true }
      }
    }
  };

  // 4. CALL SHOPIFY (DEBUG MODE 🔍)
  // This section is critical for seeing WHY it fails in your terminal
  console.log(`🚀 Sending Request to Shopify: ${shop}`);
  console.log(`🔑 Using Token: ${loyaltyShop.access_token.substring(0, 10)}...`);

  try {
    const response = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": loyaltyShop.access_token,
      },
      body: JSON.stringify({ query: mutation, variables })
    });

    // 🛑 LOG RAW STATUS
    console.log(`📡 Response Status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const text = await response.text();
      console.error("❌ HTTP Error Body:", text);
      throw new Error(`Shopify API Failed: ${response.statusText}`);
    }

    const responseJson = await response.json();

    // 🛑 LOG TOP-LEVEL ERRORS (e.g. Scopes/Auth)
    if (responseJson.errors) {
      console.error("❌ Top-Level GraphQL Errors:", JSON.stringify(responseJson.errors, null, 2));
      throw new Error("GraphQL Error: " + responseJson.errors[0].message);
    }

    // 🛑 LOG USER ERRORS (Logic issues)
    const userErrors = responseJson.data?.discountCodeBasicCreate?.userErrors || [];
    if (userErrors.length > 0) {
      console.error("❌ Mutation UserErrors:", userErrors);
      throw new Error(userErrors[0].message);
    }

    console.log(`✅ SUCCESS! Created Code: ${code}`);

    // 5. Create Event in DB (existing logic)
    const { data: redeemEvent, error: eventError } = await supabase
      .from("events")
      .insert({
        shop_id: loyaltyShop.id,
        customer_id: customer.id,
        event_type: "Create Coupon",
        points: -pointsToRedeem,
        redeemed_code: code,
        remaining_points: 0, // Redeem events don't have remaining_points
        expires_at: endsAt.toISOString()
      })
      .select()
      .single();

    if (eventError) {
      console.error("❌ Failed to create event:", eventError);
      return new Response(JSON.stringify({ error: "Failed to create coupon event" }), { status: 500, headers: corsHeaders });
    }

    console.log(`📝 Event created: ${redeemEvent.id}`);

    // 6. Allocate Points (atomic via RPC)
    const { data: allocations, error: allocError } = await supabase.rpc(
      'allocate_points_to_event',
      {
        _to_event_id: redeemEvent.id,
        _customer_id: customer.id,
        _shop_id: loyaltyShop.id,
        _points_needed: pointsToRedeem
      }
    );

    if (allocError) {
      console.error("❌ Point allocation failed:", allocError);

      // Handle insufficient points specifically
      if (allocError.message?.includes('INSUFFICIENT_POINTS')) {
        return new Response(
          JSON.stringify({ error: "Insufficient available points" }),
          { status: 400, headers: corsHeaders }
        );
      }

      return new Response(
        JSON.stringify({ error: "Failed to allocate points" }),
        { status: 500, headers: corsHeaders }
      );
    }

    console.log(`✅ Allocated points from ${allocations?.length || 0} events`);

    // 7. Update customer's discount_codes array AND redeemable_points (NOT lifetime!)
    const currentCodes = customer.discount_codes || [];
    const updatedCodes = [...currentCodes, code];
    const newRedeemable = Math.max(0, customer.redeemable_points - pointsToRedeem);

    // Debug: Check lifetime before update
    console.log(`📊 BEFORE UPDATE - Redeemable: ${customer.redeemable_points}, Lifetime: ${customer.lifetime_points}`);

    const { error: updateError } = await supabase
      .from("customers")
      .update({ 
        discount_codes: updatedCodes,
        redeemable_points: newRedeemable 
      })
      .eq("id", customer.id);

    if (updateError) {
      console.error("❌ Customer update error:", updateError);
    }

    // Debug: Check lifetime after update
    const { data: afterCustomer } = await supabase
      .from("customers")
      .select("redeemable_points, lifetime_points")
      .eq("id", customer.id)
      .single();

    console.log(`📊 AFTER UPDATE - Redeemable: ${afterCustomer?.redeemable_points}, Lifetime: ${afterCustomer?.lifetime_points}`);

    console.log(`💰 Updated customer balance: -${pointsToRedeem} points (new total: ${newRedeemable})`);

    // 8. Send Klaviyo "created loyalty code" event
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
                  attributes: { name: "Created Loyalty Code" }
                }
              },
              profile: {
                data: {
                  type: "profile",
                  attributes: { email: customer.email }
                }
              },
              properties: {
                discount_code: code,
                points_redeemed: pointsToRedeem,
                discount_value_usd: discountValue,
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
          console.warn("⚠️ Klaviyo event failed:", klaviyoRes.status, errText);
        } else {
          console.log(`📧 Klaviyo 'created loyalty code' event sent for ${customer.email}`);
        }
      } catch (klaviyoErr) {
        console.warn("⚠️ Klaviyo event exception:", klaviyoErr);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      code: code,
      value: discountValue,
      usedPoints: pointsToRedeem,
      remainingPoints: newRedeemable,
      allocations: allocations // Shows which Earn events contributed
    }), { status: 200, headers: corsHeaders });

  } catch (error) {
    console.error("🔥 EXCEPTION:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
};