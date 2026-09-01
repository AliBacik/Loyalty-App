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

  const { shop, customerId, subtotal = 100, email = null, couponCode = null } = body;
  if (!shop || !customerId) {
    return new Response(JSON.stringify({ error: "Missing shop or customerId" }), { status: 400, headers });
  }

  console.log("-----------------------------------------");
  console.log("🧪 TEST API: SIMULATE PURCHASE WITH COUPON");
  console.log(`🔍 Shop: ${shop}, Customer ID: ${customerId}`);
  console.log(`💰 Subtotal: $${subtotal}`);
  console.log(`🎟️ Coupon Code: ${couponCode || "None"}`);

  // 1. Find Shop
  const { data: loyaltyShop } = await supabase.from("shops").select("id").eq("shopify_domain", shop).single();
  if (!loyaltyShop) {
    return new Response(JSON.stringify({ error: "Shop not found" }), { status: 404, headers });
  }

  console.log(`✅ Shop Found: ${loyaltyShop.id}`);

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
        email: email,
        tier: "Circle",
        status: "active",
        redeemable_points: 0,
        lifetime_points: 0,
      })
      .select()
      .single();

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
    customer = newCustomer;
    console.log(`✅ Customer Created: ${customer.id}`);
  } else if (email && customer.email !== email) {
    await supabase.from("customers").update({ email }).eq("id", customer.id);
    customer.email = email;
    console.log(`✉️ Updated customer email to ${email}`);
  }

  console.log(`👤 Customer: ${customer.email || customer.shopify_customer_id} (${customer.tier})`);

  // 3. If coupon code provided, validate and create Redeem event
  let couponEvent = null;
  let couponUsed = false;
  
  if (couponCode && couponCode.startsWith("LOYALTY-")) {
    console.log(`🔍 Validating coupon: ${couponCode}`);
    
    // Find the Create Coupon event
    const { data: foundCoupon, error: couponError } = await supabase
      .from("events")
      .select("id, customer_id, points, remaining_points")
      .eq("redeemed_code", couponCode)
      .eq("event_type", "Create Coupon")
      .eq("shop_id", loyaltyShop.id)
      .single();

    if (couponError || !foundCoupon) {
      console.log(`❌ Coupon not found: ${couponCode}`);
      return new Response(
        JSON.stringify({ error: "Invalid coupon code" }), 
        { status: 400, headers }
      );
    }

    // Check if coupon belongs to this customer
    if (foundCoupon.customer_id !== customer.id) {
      console.log(`❌ Coupon belongs to different customer`);
      return new Response(
        JSON.stringify({ error: "This coupon belongs to another customer" }), 
        { status: 403, headers }
      );
    }

    // Check if coupon was already cancelled or used
    if (foundCoupon.remaining_points === -1) {
      console.log(`❌ Coupon already cancelled or used`);
      return new Response(
        JSON.stringify({ error: "This coupon has already been cancelled or used" }), 
        { status: 400, headers }
      );
    }

    // Check if coupon was already redeemed
    const { data: existingRedeem } = await supabase
      .from("events")
      .select("id")
      .eq("redeemed_code", couponCode)
      .eq("event_type", "Redeem")
      .eq("shop_id", loyaltyShop.id)
      .single();

    if (existingRedeem) {
      console.log(`❌ Coupon already used`);
      return new Response(
        JSON.stringify({ error: "This coupon has already been used" }), 
        { status: 400, headers }
      );
    }

    couponEvent = foundCoupon;
    console.log(`✅ Valid coupon: ${Math.abs(couponEvent.points)} points`);
  }

  // 4. Recalculate tier based on current lifetime (before calculating points)
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

  // 5. Calculate points (same logic as webhooks.orders.paid.jsx)
  let multiplier = 1.0;
  if (customer.tier === "Inner Circle") multiplier = 1.5;
  if (customer.tier === "Legacy Circle") multiplier = 2.0;

  // If a coupon was applied, points should be calculated on the amount actually paid
  const couponValue = couponEvent ? Math.abs(couponEvent.points) : 0;
  const paidAmount = Math.max(0, parseFloat(subtotal) - couponValue);
  const pointsEarned = Math.round(paidAmount * multiplier);
  console.log(
    `🧮 Points calculation: Paid $${paidAmount} (subtotal $${subtotal} - coupon $${couponValue}) × ${multiplier} = ${pointsEarned} points`,
  );

  if (pointsEarned <= 0) {
    return new Response(JSON.stringify({ error: "No points to award" }), { status: 400, headers });
  }

  // 6. Generate order ID for tracking
  const generatedOrderId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const generatedOrderName = `#${generatedOrderId}`;

  console.log(`📦 Generated Order ID: ${generatedOrderId}`);

  // 7. If coupon is used, create Redeem event FIRST
  if (couponEvent) {
    const { error: redeemError } = await supabase.from("events").insert({
      shop_id: loyaltyShop.id,
      customer_id: customer.id,
      event_type: "Redeem",
      points: 0, // Redeem events don't change points directly
      remaining_points: 0,
      redeemed_code: couponCode,
      shopify_order_id: generatedOrderId,
      shopify_order_name: generatedOrderName,
    });

    if (redeemError) {
      console.error(`❌ Failed to create Redeem event:`, redeemError);
      return new Response(
        JSON.stringify({ error: "Failed to apply coupon", details: redeemError }), 
        { status: 500, headers }
      );
    }

    // Mark coupon as used (remaining_points = -1)
    await supabase
      .from("events")
      .update({ remaining_points: -1 })
      .eq("id", couponEvent.id);

    // Remove from customer's discount_codes array
    const { data: customerData } = await supabase
      .from("customers")
      .select("discount_codes")
      .eq("id", customer.id)
      .single();

    if (customerData?.discount_codes) {
      const updatedCodes = customerData.discount_codes.filter(c => c !== couponCode);
      await supabase
        .from("customers")
        .update({ discount_codes: updatedCodes })
        .eq("id", customer.id);
    }

    couponUsed = true;
    console.log(`✅ Coupon applied: ${couponCode}`);
  }

  // 8. Create Earn event
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 6);

  const { error: insertError } = await supabase.from("events").insert({
    shop_id: loyaltyShop.id,
    customer_id: customer.id,
    event_type: "Earn",
    points: pointsEarned,
    remaining_points: pointsEarned,
    shopify_order_id: generatedOrderId,
    shopify_order_name: generatedOrderName,
    redeemed_code: couponUsed ? couponCode : null,
    expires_at: expiresAt.toISOString(),
  });

  if (insertError) {
    console.error(`❌ Failed to create Earn event:`, insertError);
    return new Response(
      JSON.stringify({ error: insertError.message }), 
      { status: 500, headers }
    );
  }

  console.log(`✅ Earn event created: +${pointsEarned} points`);

  // 9. Update customer balances
  const newRedeemable = (customer.redeemable_points || 0) + pointsEarned;
  const newLifetime = (customer.lifetime_points || 0) + pointsEarned;

  const { error: updateError } = await supabase
    .from("customers")
    .update({ 
      redeemable_points: newRedeemable, 
      lifetime_points: newLifetime 
    })
    .eq("id", customer.id);

  if (updateError) {
    console.error(`❌ Failed to update customer balances:`, updateError);
    return new Response(
      JSON.stringify({ error: "Event created but failed updating customer", details: updateError }), 
      { status: 500, headers }
    );
  }

  console.log(`💰 Customer balances updated:`);
  console.log(`   - Redeemable: ${customer.redeemable_points} → ${newRedeemable}`);
  console.log(`   - Lifetime: ${customer.lifetime_points} → ${newLifetime}`);

  // 10. Check Tier Upgrade
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

  console.log(`✅ SUCCESS! Order completed.`);
  console.log("-----------------------------------------");

  return new Response(
    JSON.stringify({
      success: true,
      shopify_order_id: generatedOrderId,
      shopify_order_name: generatedOrderName,
      pointsAwarded: pointsEarned,
      couponUsed: couponUsed,
      couponCode: couponUsed ? couponCode : null,
      couponValue: couponUsed ? Math.abs(couponEvent.points) : 0,
      redeemablePoints: newRedeemable,
      lifetimePoints: newLifetime,
      currentTier: newTier,
      tierUpgraded: tierUpgraded,
      oldTier: tierUpgraded ? freshCustomer.tier : null,
    }),
    { status: 200, headers }
  );
};
