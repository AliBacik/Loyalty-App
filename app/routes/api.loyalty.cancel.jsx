import { supabase } from "../supabase.server";
import { unauthenticated } from "../shopify.server";

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

  const { shop, customerId, code } = await request.json();

  if (!shop || !customerId || !code) {
    return new Response(JSON.stringify({ error: "Missing data" }), { status: 400, headers: corsHeaders });
  }

  // 2. Get Shop (with access_token for fallback)
  const { data: loyaltyShop, error: shopError } = await supabase
    .from("shops")
    .select("id, access_token")
    .eq("shopify_domain", shop)
    .single();

  if (shopError || !loyaltyShop) {
    return new Response(JSON.stringify({ error: "Shop not found" }), { status: 404, headers: corsHeaders });
  }

  // 3. Try unauthenticated admin, fallback to direct fetch
  let admin = null;
  try {
    const res = await unauthenticated.admin(shop);
    admin = res.admin;
  } catch (e) {
    console.log("⚠️ Unauthenticated admin failed, using access_token fallback");
    if (!loyaltyShop.access_token) {
      return new Response(JSON.stringify({ error: "No admin session or access token" }), { status: 401, headers: corsHeaders });
    }
    // Fallback: manual GraphQL caller
    admin = {
      graphql: (query, opts = {}) => {
        return fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": loyaltyShop.access_token,
          },
          body: JSON.stringify({ query, variables: opts.variables })
        });
      }
    };
  }

  // 4. Find the Discount in Shopify
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
    // Shopify doesn't have the code (maybe expired/removed). Continue with DB-only cancel.
    console.warn('Coupon not found in Shopify; proceeding with DB-only cancel for code:', code);
    skipShopifyDelete = true;
  } else {
    if (node.discount.asyncUsageCount > 0) {
      return new Response(JSON.stringify({ error: "Cannot cancel. This coupon has already been used." }), { status: 400, headers: corsHeaders });
    }
  }

  // 5. Find Original Transaction (To know how many points to refund)
  // Coupon codes share one namespace across stores, so scope by shop_id.
  const { data: originalEvent } = await supabase
    .from("events")
    .select("id, points, customer_id")
    .eq("redeemed_code", code)
    .eq("event_type", "Create Coupon") // Make sure this matches exactly what you saved earlier!
    .eq("shop_id", loyaltyShop.id)
    .single();

  if (!originalEvent) {
    console.error("❌ Could not find original event for code:", code);
    return new Response(JSON.stringify({ error: "Original transaction not found" }), { status: 404, headers: corsHeaders });
  }



  // 👇 FETCH "discount_codes" HERE
  // shopify_customer_id is only unique per store — without shop_id this .single()
  // can match another store's customer and break the ownership check below.
  const { data: customer } = await supabase
    .from("customers")
    .select("id, discount_codes")
    .eq("shopify_customer_id", customerId)
    .eq("shop_id", loyaltyShop.id)
    .single();

  if (!customer || customer.id !== originalEvent.customer_id) {
    return new Response(JSON.stringify({ error: "Not authorized to cancel this coupon" }), { status: 403, headers: corsHeaders });
  }

  // 6. Delete from Shopify (skip if missing)
  if (!skipShopifyDelete) {
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

    const deleteJson = await deleteResponse.json();
    if (deleteJson.data?.discountCodeDelete?.userErrors?.length > 0) {
        console.error("Shopify Delete Error:", deleteJson.data.discountCodeDelete.userErrors);
        return new Response(JSON.stringify({ error: "Failed to delete coupon in Shopify" }), { status: 500, headers: corsHeaders });
    }

    console.log("✅ Coupon deleted from Shopify");
  } else {
    console.log('Skipping Shopify delete because code was not found in Shopify');
  }

  // 7. Get customer balance BEFORE reversing (important for correct calculation)
  const { data: customerBeforeReverse } = await supabase
    .from("customers")
    .select("redeemable_points")
    .eq("id", customer.id)
    .single();

  const balanceBeforeReverse = customerBeforeReverse?.redeemable_points || 0;
  console.log(`📊 Customer balance BEFORE reverse: ${balanceBeforeReverse}`);

  // 8. Reverse Point Allocations (Atomic via RPC)
  const { data: reverseResult, error: reverseError } = await supabase
    .rpc('reverse_point_allocations', {
      _to_event_id: originalEvent.id
    });

  if (reverseError) {
    console.error("❌ Point reverse failed:", reverseError);
    return new Response(
      JSON.stringify({ 
        error: "Coupon deleted but point restoration failed. Contact support.", 
        details: reverseError.message 
      }), 
      { status: 500, headers: corsHeaders }
    );
  }

  // RPC now returns detailed results: restored_points, restored_count, expired_points, expired_count
  const restoredPoints = reverseResult?.[0]?.restored_points || 0;
  const restoredCount = reverseResult?.[0]?.restored_count || 0;
  const expiredPoints = reverseResult?.[0]?.expired_points || 0;
  const expiredCount = reverseResult?.[0]?.expired_count || 0;

  console.log(`✅ Reversed ${restoredCount} allocations, restored ${restoredPoints} points to Earn events`);
  if (expiredCount > 0) {
    console.log(`⚠️ ${expiredCount} allocations referenced expired Earn events; ${expiredPoints} points not restored`);
  }

  // 9. Create "Cancel Coupon" Event (for audit trail) — record only actually restored points
  const { error: insertError } = await supabase.from("events").insert({
    shop_id: loyaltyShop.id,
    customer_id: customer.id,
    event_type: "Cancel Coupon", 
    points: restoredPoints, // Only restored points are added back
    redeemed_code: code,
    remaining_points: 0,
  });

  if (insertError) {
    console.error("❌ Failed to create cancel event:", insertError);
    // Non-critical - points already restored
  }

  // 10. Remove Code from Customer's List & Update Balance
  const currentCodes = customer.discount_codes || [];
  const updatedCodes = currentCodes.filter(c => c !== code);

  // Use the balance we captured BEFORE the RPC call
  // RPC restored remaining_points to Earn events, now we update customer's redeemable_points
  const newRedeemable = balanceBeforeReverse + restoredPoints;

  await supabase
    .from("customers")
    .update({ 
      discount_codes: updatedCodes,
      redeemable_points: newRedeemable 
    })
    .eq("id", customer.id);

  console.log(`💰 Updated customer balance: ${balanceBeforeReverse} + ${restoredPoints} = ${newRedeemable}`);
  console.log("✅ Cancel Complete!");
  return new Response(
    JSON.stringify({ 
      success: true, 
      refunded: restoredPoints,
      allocationsReversed: restoredCount,
      expiredAllocations: expiredCount,
      expiredPoints: expiredPoints
    }), 
    { status: 200, headers: corsHeaders }
  );
};