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

  const { shop, orderId } = body;
  if (!shop || !orderId) {
    return new Response(JSON.stringify({ error: "Missing shop or orderId" }), { status: 400, headers });
  }

  console.log("-----------------------------------------");
  console.log("🧪 TEST API: REFUND");
  console.log(`🔍 Shop: ${shop}, Order ID: ${orderId}`);

  try {
    // 1. Find Shop
    const { data: loyaltyShop, error: shopError } = await supabase
      .from("shops")
      .select("id")
      .eq("shopify_domain", shop)
      .single();

    if (shopError || !loyaltyShop) {
      console.error("❌ DB ERROR: Could not find shop.", shopError);
      return new Response(JSON.stringify({ error: "Shop not found", details: shopError }), { status: 404, headers });
    }

    console.log(`✅ Shop Found: ${loyaltyShop.id}`);

    // 2. Find Original Earning Event (id also used for allocation reversal)
    const { data: originalEarnEvent, error: eventError } = await supabase
      .from("events")
      .select("id, customer_id, points")
      .eq("shopify_order_id", orderId)
      .eq("event_type", "Earn")
      .single();

    if (eventError || !originalEarnEvent) {
      console.warn("⚠️ No 'Earn' event found for this order.");
      return new Response(
        JSON.stringify({ error: "No Earn event found for this order", details: eventError }),
        { status: 404, headers }
      );
    }

    const earnEventData = originalEarnEvent; // alias
    console.log(`✅ Found Earn event ID: ${earnEventData.id}, points: ${originalEarnEvent.points}`);

    // 2b. Check if refund already exists for this order (test API - full refund only)
    const { data: existingRefund } = await supabase
      .from("events")
      .select("id")
      .eq("shopify_order_id", orderId)
      .eq("event_type", "Refund")
      .maybeSingle();

    if (existingRefund) {
      console.warn("⚠️ DUPLICATE REFUND DETECTED: This order was already refunded.");
      return new Response(
        JSON.stringify({ error: "This order has already been refunded" }),
        { status: 400, headers }
      );
    }

    // 4. Test API always does FULL refund - deduct all original points
    const originalPointsEarned = Math.abs(originalEarnEvent.points);
    const pointsToDeduct = originalPointsEarned;

    if (pointsToDeduct <= 0) {
      return new Response(JSON.stringify({ error: "No points to deduct for this order" }), { status: 400, headers });
    }

    console.log(`🧮 Full Refund (test): Deducting all ${pointsToDeduct} points`);

    // Track total points restored from coupon cancellations
    let totalRestoredPoints = 0;

    // 5. Handle affected coupons (partial refund logic)
    if (earnEventData?.id) {
      console.log(`🎟️ Checking for coupons created from this order's points...`);
      console.log(`🔍 Looking for allocations with from_event_id=${earnEventData.id}`);
      
      // 5a. Find all Create Coupon events that used points from this Earn event
      // Use RPC to bypass permission issues
      const { data: affectedAllocations, error: allocError } = await supabase.rpc(
        'get_allocations_by_from_event',
        { _from_event_id: earnEventData.id }
      );

      if (allocError) {
        console.error("❌ Error fetching allocations:", allocError);
      } else {
        console.log(`📊 Found ${affectedAllocations?.length || 0} allocation(s)`);
      }

      if (affectedAllocations && affectedAllocations.length > 0) {
        console.log(`⚠️ Found ${affectedAllocations.length} coupon(s) affected by this refund`);

        // Group by to_event_id (Create Coupon event)
        const couponEventIds = [...new Set(affectedAllocations.map(a => a.to_event_id))];

        for (const couponEventId of couponEventIds) {
          // Get the Create Coupon event details
          const { data: couponEvent } = await supabase
            .from("events")
            .select("id, redeemed_code, customer_id, remaining_points")
            .eq("id", couponEventId)
            .eq("event_type", "Create Coupon")
            .single();

          if (!couponEvent || !couponEvent.redeemed_code) continue;

          console.log(`🔄 Processing coupon: ${couponEvent.redeemed_code} (remaining_points: ${couponEvent.remaining_points})`);

          // 5b-1. Check if this coupon was USED (has a Redeem event)
          const { data: redeemCheck } = await supabase
            .from("events")
            .select("id, shopify_order_id")
            .eq("redeemed_code", couponEvent.redeemed_code)
            .eq("event_type", "Redeem")
            .eq("shop_id", loyaltyShop.id)
            .single();

          const couponWasUsed = !!redeemCheck;
          console.log(`🎟️ Coupon was used: ${couponWasUsed}`);

          // Skip if coupon was already cancelled (remaining_points = -1) AND not used
          if (couponEvent.remaining_points === -1 && !couponWasUsed) {
            console.log(`⏭️ Skipping already cancelled coupon (not used): ${couponEvent.redeemed_code}`);
            continue;
          }

          // 5b-2. Deactivate coupon in Shopify (using access token)
          const { data: shopData } = await supabase
            .from("shops")
            .select("access_token")
            .eq("id", loyaltyShop.id)
            .single();

          if (shopData?.access_token) {
            try {
              // Find the discount code node ID
              const searchQuery = `
                query {
                  codeDiscountNodes(first: 1, query: "title:'${couponEvent.redeemed_code}'") {
                    nodes { id }
                  }
                }
              `;

              const searchRes = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Shopify-Access-Token": shopData.access_token,
                },
                body: JSON.stringify({ query: searchQuery })
              });

              const searchJson = await searchRes.json();
              const nodeId = searchJson.data?.codeDiscountNodes?.nodes?.[0]?.id;

              if (nodeId) {
                // Delete the discount
                const deleteMutation = `
                  mutation discountCodeDelete($id: ID!) {
                    discountCodeDelete(id: $id) {
                      userErrors { field message }
                    }
                  }
                `;

                await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "X-Shopify-Access-Token": shopData.access_token,
                  },
                  body: JSON.stringify({ 
                    query: deleteMutation, 
                    variables: { id: nodeId } 
                  })
                });

                console.log(`✅ Deactivated coupon in Shopify: ${couponEvent.redeemed_code}`);
              }
            } catch (shopifyErr) {
              console.error(`⚠️ Failed to deactivate coupon in Shopify:`, shopifyErr);
            }
          }

          // 5c. Get all allocations for this coupon EXCEPT from the refunded order
          const { data: allAllocations } = await supabase.rpc(
            'get_allocations_by_to_event',
            { _to_event_id: couponEvent.id }
          );

          // Filter out the allocation from the refunded Earn event
          const allocationsToReverse = (allAllocations || []).filter(
            a => a.from_event_id !== earnEventData.id
          );

          let restoredPoints = 0;
          
          if (allocationsToReverse.length > 0) {
            // Manually reverse each allocation from non-refunded orders
            for (const allocation of allocationsToReverse) {
              // Check if this Earn event was already refunded
              const { data: checkRefund } = await supabase
                .from("events")
                .select("id")
                .eq("shopify_order_id", allocation.from_event_id)
                .eq("event_type", "Refund")
                .single();

              // Get the Earn event to find its order ID
              const { data: earnEventForOrder } = await supabase
                .from("events")
                .select("shopify_order_id")
                .eq("id", allocation.from_event_id)
                .single();

              // Check if that order was refunded
              let wasRefunded = false;
              if (earnEventForOrder?.shopify_order_id) {
                const { data: refundCheck } = await supabase
                  .from("events")
                  .select("id")
                  .eq("shopify_order_id", earnEventForOrder.shopify_order_id)
                  .eq("event_type", "Refund")
                  .single();
                wasRefunded = !!refundCheck;
              }

              if (wasRefunded) {
                console.log(`⚠️ Skipping allocation from already refunded order`);
                continue;
              }

              // Get the original Earn event
              const { data: earnEvent } = await supabase
                .from("events")
                .select("remaining_points")
                .eq("id", allocation.from_event_id)
                .single();

              if (earnEvent) {
                // Restore points to the Earn event
                await supabase
                  .from("events")
                  .update({ 
                    remaining_points: earnEvent.remaining_points + allocation.points 
                  })
                  .eq("id", allocation.from_event_id);

                restoredPoints += allocation.points;
                console.log(`✅ Restored ${allocation.points} points to Earn event ${allocation.from_event_id}`);
              }
            }

            if (restoredPoints > 0) {
              console.log(`✅ Total restored ${restoredPoints} points from non-refunded orders`);

              // Track total restored points
              totalRestoredPoints += restoredPoints;

              // Create Cancel Coupon event
              await supabase.from("events").insert({
                shop_id: loyaltyShop.id,
                customer_id: couponEvent.customer_id,
                event_type: "Cancel Coupon",
                points: restoredPoints,
                redeemed_code: couponEvent.redeemed_code,
                remaining_points: 0,
              });
            }

            // 5c-2. If coupon was USED, check if the order that USED it is still active
            // If that order is refunded, don't deduct points (already handled)
            if (couponWasUsed) {
              // Check if the order that USED the coupon was refunded
              const { data: refundCheck } = await supabase
                .from("events")
                .select("id")
                .eq("shopify_order_id", redeemCheck.shopify_order_id)
                .eq("event_type", "Refund")
                .maybeSingle();

              const orderUsingCouponWasRefunded = !!refundCheck;
              console.log(`🔍 Order that used coupon (${redeemCheck.shopify_order_id}) was refunded: ${orderUsingCouponWasRefunded}`);

              if (orderUsingCouponWasRefunded) {
                console.log(`✅ Order using coupon already refunded - no clawback needed`);
              } else {
                // Coupon was used and that order is STILL ACTIVE - deduct points
                // Get allocations FROM the refunded order's Earn event
                const allocationsFromRefundedOrder = (allAllocations || []).filter(
                  a => a.from_event_id === earnEventData.id
                );
                
                let pointsToDeductFromUsedCoupon = 0;
                for (const alloc of allocationsFromRefundedOrder) {
                  pointsToDeductFromUsedCoupon += alloc.points;
                }

                if (pointsToDeductFromUsedCoupon > 0) {
                  console.log(`⚠️ Coupon was USED but source order refunded!`);
                  console.log(`   Deducting ${pointsToDeductFromUsedCoupon} points (customer owes these)`);
                  
                  // Track as NEGATIVE restored points (deduction)
                  totalRestoredPoints -= pointsToDeductFromUsedCoupon;

                  // Create a "Clawback" adjustment event for audit trail
                  await supabase.from("events").insert({
                    shop_id: loyaltyShop.id,
                    customer_id: couponEvent.customer_id,
                    event_type: "Adjust",
                    points: -pointsToDeductFromUsedCoupon,
                    redeemed_code: couponEvent.redeemed_code,
                    shopify_order_id: orderId,
                    remaining_points: 0,
                  });
                }
              }
            }
          } else {
            console.log(`ℹ️ No points to restore (all from refunded order)`);

            // But if coupon was USED, check if order using it is still active
            if (couponWasUsed) {
              // Check if the order that USED the coupon was refunded
              const { data: refundCheck } = await supabase
                .from("events")
                .select("id")
                .eq("shopify_order_id", redeemCheck.shopify_order_id)
                .eq("event_type", "Refund")
                .maybeSingle();

              const orderUsingCouponWasRefunded = !!refundCheck;
              console.log(`🔍 Order that used coupon (${redeemCheck.shopify_order_id}) was refunded: ${orderUsingCouponWasRefunded}`);

              if (orderUsingCouponWasRefunded) {
                console.log(`✅ Order using coupon already refunded - no clawback needed`);
              } else {
                // Coupon was used and that order is STILL ACTIVE - deduct points
                // Get total points allocated to this coupon from the refunded order
                const allocationsFromRefundedOrder = (allAllocations || []).filter(
                  a => a.from_event_id === earnEventData.id
                );
                
                let pointsToDeductFromUsedCoupon = 0;
                for (const alloc of allocationsFromRefundedOrder) {
                  pointsToDeductFromUsedCoupon += alloc.points;
                }

                if (pointsToDeductFromUsedCoupon > 0) {
                  console.log(`⚠️ Coupon was USED but ALL points came from refunded order!`);
                  console.log(`   Deducting ${pointsToDeductFromUsedCoupon} points (customer owes these)`);
                  
                  // Track as NEGATIVE restored points (deduction)
                  totalRestoredPoints -= pointsToDeductFromUsedCoupon;

                  // Create a "Clawback" adjustment event for audit trail
                  await supabase.from("events").insert({
                    shop_id: loyaltyShop.id,
                    customer_id: couponEvent.customer_id,
                    event_type: "Adjust",
                    points: -pointsToDeductFromUsedCoupon,
                    redeemed_code: couponEvent.redeemed_code,
                    shopify_order_id: orderId,
                    remaining_points: 0,
                  });
                }
              }
            }
          }

          // Delete ALL allocations for this coupon at once (use RPC to bypass permissions)
          const { data: deleteResult, error: deleteAllocError } = await supabase.rpc(
            'delete_allocations_by_to_event',
            { _to_event_id: couponEvent.id }
          );

          if (deleteAllocError) {
            console.warn(`⚠️ Could not delete allocations (will be orphaned):`, deleteAllocError.message);
          } else {
            console.log(`🗑️ Deleted ${deleteResult || 'all'} allocations for ${couponEvent.redeemed_code}`);
          }

          // Mark the Create Coupon event as cancelled by updating remaining_points to -1
          await supabase
            .from("events")
            .update({ remaining_points: -1 }) // -1 = cancelled marker
            .eq("id", couponEvent.id);

          console.log(`🏷️ Marked coupon event as cancelled`);

          // 5d. Remove from customer's discount_codes array
          const { data: customerData } = await supabase
            .from("customers")
            .select("discount_codes")
            .eq("id", couponEvent.customer_id)
            .single();

          console.log(`🔍 Customer discount_codes BEFORE:`, customerData?.discount_codes);

          if (customerData?.discount_codes) {
            const updatedCodes = customerData.discount_codes.filter(c => c !== couponEvent.redeemed_code);
            
            console.log(`🔍 Customer discount_codes AFTER:`, updatedCodes);
            
            await supabase
              .from("customers")
              .update({ discount_codes: updatedCodes })
              .eq("id", couponEvent.customer_id);

            console.log(`✅ Removed ${couponEvent.redeemed_code} from customer's wallet`);
          } else {
            console.log(`⚠️ Customer has no discount_codes array`);
          }
        }
      } else {
        console.log(`ℹ️ No coupons affected by this refund`);
      }
    }

    // 6. Get unused points before updating
    let unusedPoints = 0;
    if (earnEventData?.id) {
      const { data: earnEventDetails, error: earnDetailsError } = await supabase
        .from("events")
        .select("remaining_points")
        .eq("id", earnEventData.id)
        .single();

      if (earnDetailsError) {
        console.error("❌ Error fetching Earn event details:", earnDetailsError);
      }

      unusedPoints = earnEventDetails?.remaining_points || 0;
      console.log(`📦 Earn event ID: ${earnEventData.id}`);
      console.log(`📦 Earn event remaining_points: ${earnEventDetails?.remaining_points}`);
      console.log(`📦 Unused points from this order: ${unusedPoints}`);

      // Update the original Earn event's remaining_points to 0
      const { error: updateError } = await supabase
        .from("events")
        .update({ remaining_points: 0 })
        .eq("id", earnEventData.id);

      if (updateError) {
        console.error("❌ DB Update Error (Earn event remaining_points):", updateError);
      } else {
        console.log(`✅ Updated Earn event remaining_points to 0`);
      }
    } else {
      console.log(`⚠️ No earnEventData.id found - unusedPoints will be 0`);
    }

    // 7. Insert Refund Event
    const { error: insertError } = await supabase.from("events").insert({
      shop_id: loyaltyShop.id,
      customer_id: originalEarnEvent.customer_id,
      event_type: "Refund",
      points: -pointsToDeduct, // IMPORTANT: Negative points
      shopify_order_id: orderId,
      remaining_points: 0, // Refunds don't have expiration
      redeemed_code: "REFUND", // Same marker as real webhook
    });

    if (insertError) {
      console.error("❌ DB Insert Error:", insertError);
      return new Response(JSON.stringify({ error: insertError.message }), { status: 500, headers });
    }

    console.log(`✅ Refund Event Created: -${pointsToDeduct} points`);

    // 8. Check if this order used any LOYALTY coupons - restore those points
    let couponPointsRestored = 0;
    
    // Find Redeem events for this order (coupons used in this order)
    const { data: redeemEvents } = await supabase
      .from("events")
      .select("redeemed_code")
      .eq("shopify_order_id", orderId)
      .eq("event_type", "Redeem");

    if (redeemEvents && redeemEvents.length > 0) {
      console.log(`🎟️ Found ${redeemEvents.length} coupon(s) used in this order`);
      
      for (const redeemEvent of redeemEvents) {
        if (!redeemEvent.redeemed_code?.startsWith("LOYALTY-")) continue;
        
        // Find the Create Coupon event to get the points spent
        const { data: couponEvent } = await supabase
          .from("events")
          .select("id, points, remaining_points")
          .eq("redeemed_code", redeemEvent.redeemed_code)
          .eq("event_type", "Create Coupon")
          .eq("shop_id", loyaltyShop.id)
          .single();

        if (couponEvent) {
          const couponPoints = Math.abs(couponEvent.points); // points is negative, make it positive

          // If coupon was already cancelled (remaining_points = -1), 
          // check if there was a Clawback - if so, reverse it
          if (couponEvent.remaining_points === -1) {
            // Check if Clawback was done for this coupon (Adjust event with negative points)
            const { data: clawbackEvent, error: clawbackError } = await supabase
              .from("events")
              .select("id, points")
              .eq("redeemed_code", redeemEvent.redeemed_code)
              .eq("event_type", "Adjust")
              .eq("shop_id", loyaltyShop.id)
              .lt("points", 0)
              .maybeSingle(); // Use maybeSingle() instead of single() to avoid error if not found

            console.log(`🔍 Clawback search for ${redeemEvent.redeemed_code}:`, { found: !!clawbackEvent, error: clawbackError });

            if (clawbackEvent) {
              const clawbackPoints = Math.abs(clawbackEvent.points);
              couponPointsRestored += clawbackPoints;
              console.log(`🔄 Reversing Clawback: +${clawbackPoints} points for cancelled coupon: ${redeemEvent.redeemed_code}`);
              
              // Create a "Clawback Reversal" adjustment event for audit trail
              await supabase.from("events").insert({
                shop_id: loyaltyShop.id,
                customer_id: originalEarnEvent.customer_id,
                event_type: "Adjust",
                points: clawbackPoints,
                redeemed_code: redeemEvent.redeemed_code,
                shopify_order_id: orderId,
                remaining_points: 0,
              });
            } else {
              console.log(`⏭️ Skipping already cancelled coupon (no clawback): ${redeemEvent.redeemed_code}`);
            }
            continue;
          }

          // Coupon was NOT cancelled - restore its points
          couponPointsRestored += couponPoints;
          console.log(`♻️ Restoring ${couponPoints} points from used coupon: ${redeemEvent.redeemed_code}`);
          
          // Create a "Coupon Refund" adjustment event for audit trail
          await supabase.from("events").insert({
            shop_id: loyaltyShop.id,
            customer_id: originalEarnEvent.customer_id,
            event_type: "Adjust",
            points: couponPoints,
            redeemed_code: redeemEvent.redeemed_code,
            shopify_order_id: orderId,
            remaining_points: 0,
          });

          // Mark this coupon as refunded (remaining_points = -1)
          await supabase
            .from("events")
            .update({ remaining_points: -1 })
            .eq("id", couponEvent.id);
        }
      }
      
      if (couponPointsRestored > 0) {
        console.log(`✅ Total coupon points restored: ${couponPointsRestored}`);
      }
    }

    // 9. Update customer's balances
    // ✅ IMPORTANT LOGIC:
    // - Unused points from this order: Deduct them
    // - Restored from non-refunded orders (coupon cancellation): Add them
    // - Coupon points used in this order: Restore them
    // Formula: Current - Unused + Restored + CouponPointsRestored
    // NOTE: Allow negative balance (fraud prevention - customer may owe points)
    const customer = originalEarnEvent.customer;
    // Allow negative redeemable (no Math.max(0, ...)) for fraud cases
    const newRedeemable = (customer.redeemable_points || 0) - unusedPoints + totalRestoredPoints + couponPointsRestored;
    const newLifetime = Math.max(0, (customer.lifetime_points || 0) - pointsToDeduct);

    console.log(`📊 Points Calculation:`);
    console.log(`   - Current Redeemable: ${customer.redeemable_points}`);
    console.log(`   - Unused points from refunded order: -${unusedPoints}`);
    console.log(`   - Restored from coupon cancellation: +${totalRestoredPoints}`);
    console.log(`   - Restored from used coupons: +${couponPointsRestored}`);
    console.log(`   - Net change: ${-unusedPoints + totalRestoredPoints + couponPointsRestored}`);
    console.log(`   - New Redeemable: ${newRedeemable}`);
    console.log(`   - Current Lifetime: ${customer.lifetime_points}`);
    console.log(`   - Refunded order points: -${pointsToDeduct}`);
    console.log(`   - New Lifetime: ${newLifetime}`);

    const { error: updateError } = await supabase
      .from("customers")
      .update({ redeemable_points: newRedeemable, lifetime_points: newLifetime })
      .eq("id", originalEarnEvent.customer_id);

    if (updateError) {
      console.error("⚠️ Failed updating customer balances:", updateError);
      return new Response(
        JSON.stringify({ error: "Event created but failed updating customer", details: updateError }),
        { status: 500, headers }
      );
    }

    console.log(`💰 Balances Updated: Redeemable=${newRedeemable}, Lifetime=${newLifetime}`);

    // Check for tier downgrade after lifetime reduction
    let newTier = "Circle";
    if (newLifetime >= 2500) newTier = "Legacy Circle";
    else if (newLifetime >= 1000) newTier = "Inner Circle";

    if (newTier !== currentTier) {
      await supabase
        .from("customers")
        .update({ tier: newTier })
        .eq("id", originalEarnEvent.customer_id);
      console.log(`⬇️ DOWNGRADE: User is now ${newTier} (was ${currentTier})`);
    }

    return new Response(
      JSON.stringify({
        success: true,
        pointsDeducted: pointsToDeduct,
        pointsRestored: totalRestoredPoints,
        redeemablePointsChange: totalRestoredPoints,
        lifetimePointsChange: -pointsToDeduct,
        redeemablePoints: newRedeemable,
        lifetimePoints: newLifetime,
        currentTier: newTier,
        originalPoints: originalEarnEvent.points,
      }),
      { status: 200, headers }
    );
  } catch (error) {
    console.error("🔥 CRITICAL ERROR:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: error.message }),
      { status: 500, headers }
    );
  }
};
