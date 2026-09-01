import { supabase } from "../supabase.server";

// CORS headers and preflight handler
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
  const headers = corsHeaders;

  // Require a key param for safety (use your CRON_SECRET)
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (key !== process.env.CRON_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers });
  }

  const { shop, customerId, subtotal = 100, email = null } = body; // subtotal in USD
  if (!shop || !customerId) {
    return new Response(JSON.stringify({ error: "Missing shop or customerId" }), { status: 400, headers });
  }

  // 1. Find Shop
  const { data: loyaltyShop } = await supabase.from("shops").select("id").eq("shopify_domain", shop).single();
  if (!loyaltyShop) return new Response(JSON.stringify({ error: "Shop not found" }), { status: 404, headers });

  // 2. Find or create customer
  let { data: customer } = await supabase
    .from("customers")
    .select("*")
    .eq("shopify_customer_id", customerId)
    .eq("shop_id", loyaltyShop.id)
    .single();

  if (!customer) {
    const { data: newCustomer, error } = await supabase
      .from("customers")
      .insert({
        shop_id: loyaltyShop.id,
        shopify_customer_id: customerId,
        email: email, // use provided email if any
        tier: "Circle",
        status: "active",
        redeemable_points: 0,
        lifetime_points: 0,
      })
      .select()
      .single();

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    customer = newCustomer;
  } else if (email && customer.email !== email) {
    // Update existing customer's email if a different email is provided
    const { error: emailUpdateError } = await supabase
      .from("customers")
      .update({ email })
      .eq("id", customer.id);

    if (emailUpdateError) {
      // Log but don't fail the whole flow; return details in response if needed
      console.warn("Failed updating customer email:", emailUpdateError);
    } else {
      customer.email = email; // reflect change locally
      console.log(`✉️ Updated customer email to ${email}`);
    }
  }

  // 2.5. Recalculate tier based on current lifetime (same as orders.paid webhook)
  let currentTier = customer.tier;
  const currentLifetime = customer.lifetime_points || 0;
  
  if (currentLifetime >= 2500) {
    currentTier = "Legacy Circle";
  } else if (currentLifetime >= 1000) {
    currentTier = "Inner Circle";
  } else {
    currentTier = "Circle";
  }

  // Update tier if it changed
  if (currentTier !== customer.tier) {
    await supabase
      .from("customers")
      .update({ tier: currentTier })
      .eq("id", customer.id);
    console.log(`🔄 Tier adjusted: ${customer.tier} → ${currentTier} (lifetime: ${currentLifetime})`);
    customer.tier = currentTier;
  }

  // 3. Calculate points (same logic as webhooks.orders.paid.jsx)
  let multiplier = 1.0;
  if (customer.tier === "Inner Circle") multiplier = 1.5;
  if (customer.tier === "Legacy Circle") multiplier = 2.0;

  const pointsEarned = Math.round(parseFloat(subtotal) * multiplier);
  if (pointsEarned <= 0) {
    return new Response(JSON.stringify({ error: "No points to award" }), { status: 400, headers });
  }

  // 4. Create Earn event and update customer's balances
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 6);

  // Generate order ID for tracking
  const generatedOrderId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const generatedOrderName = `#${generatedOrderId}`;

  const { error: insertError } = await supabase.from("events").insert({
    shop_id: loyaltyShop.id,
    customer_id: customer.id,
    event_type: "Earn",
    points: pointsEarned,
    remaining_points: pointsEarned,
    shopify_order_id: generatedOrderId,
    shopify_order_name: generatedOrderName,
    expires_at: expiresAt.toISOString(),
  });

  if (insertError) {
    return new Response(JSON.stringify({ error: insertError.message }), { status: 500, headers });
  }

  console.log(`✅ Event created with Order ID: ${generatedOrderId}`);

  // 5. Update customer balances (same as webhook logic)
  const newRedeemable = (customer.redeemable_points || 0) + pointsEarned;
  const newLifetime = (customer.lifetime_points || 0) + pointsEarned;

  const { error: updateError } = await supabase
    .from("customers")
    .update({ redeemable_points: newRedeemable, lifetime_points: newLifetime })
    .eq("id", customer.id);

  if (updateError) {
    return new Response(JSON.stringify({ error: "Event created but failed updating customer", details: updateError }), { status: 500, headers });
  }

  console.log(`💰 Points Updated: Redeemable=${newRedeemable}, Lifetime=${newLifetime}`);

  // 6. Check Tier Upgrade (SAME AS webhooks.orders.paid.jsx)
  const { data: freshCustomer } = await supabase
    .from("customers")
    .select("lifetime_points, tier")
    .eq("id", customer.id)
    .single();

  let newTier = freshCustomer.tier;
  let tierUpgraded = false;

  if (freshCustomer.lifetime_points >= 2500) {
    newTier = "Legacy Circle";
  } else if (freshCustomer.lifetime_points >= 1000) {
    newTier = "Inner Circle";
  }

  if (newTier !== freshCustomer.tier) {
    await supabase
      .from("customers")
      .update({ tier: newTier })
      .eq("id", customer.id);
    
    console.log(`🎉 TIER UPGRADE: ${freshCustomer.tier} → ${newTier}`);
    tierUpgraded = true;
  }

  return new Response(
    JSON.stringify({
      success: true,
      shopify_order_id: generatedOrderId,
      pointsAwarded: pointsEarned,
      redeemablePoints: newRedeemable,
      lifetimePoints: newLifetime,
      currentTier: newTier,
      tierUpgraded: tierUpgraded,
      oldTier: tierUpgraded ? freshCustomer.tier : null,
    }),
    { status: 200, headers }
  );
};
