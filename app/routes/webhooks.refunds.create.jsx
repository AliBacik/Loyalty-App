import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

export const action = async ({ request }) => {
  console.log("-----------------------------------------");
  console.log("⚡️ WEBHOOK RECEIVED: REFUNDS_CREATE");

  const { topic, shop, payload } = await authenticate.webhook(request);
  if (topic !== "REFUNDS_CREATE") return new Response();

  // Will be populated after refund processing for Cloud Function payload
  let klaviyoCustomerData = null;

  try {
    const orderId = payload.order_id;
    const refundId = payload.id; // Shopify's unique refund ID
    
    console.log(`🔍 Processing Refund for Shop: ${shop}, Order ID: ${orderId}, Refund ID: ${refundId}`);
    
    // Log transactions to see what Shopify sends
    const transactions = payload.transactions || [];
    console.log(`📦 Found ${transactions.length} transaction(s) in payload`);
    transactions.forEach((t, i) => {
      console.log(`   Transaction ${i + 1}:`);
      console.log(`     - ID: ${t.id}`);
      console.log(`     - Kind: ${t.kind}`);
      console.log(`     - Status: ${t.status}`);
      console.log(`     - Amount: ${t.amount} ${t.currency}`);
      console.log(`     - Gateway: ${t.gateway || 'N/A'}`);
    });

    // 1. Quick status check - only process successful refunds
    const hasSuccessRefund = transactions.some(t => 
      t.kind === 'refund' && 
      t.status === 'success'
    );

    if (!hasSuccessRefund) {
      console.warn("⚠️ SKIPPING: No successful refund transactions found (pending/failed)");
      return new Response(JSON.stringify({ status: 200, message: 'Pending refund ignored' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log(`✅ Found successful refund transaction(s) - proceeding`);

    // 1. Get Shop
    const { data: loyaltyShop, error: shopError } = await supabase
      .from("shops")
      .select("id")
      .eq("shopify_domain", shop)
      .single();

    if (shopError || !loyaltyShop) {
      console.error("❌ DB ERROR: Could not find shop.", shopError);
      return new Response();
    }

    // 2. Find Original Earning Event (id also used for allocation reversal)
    const { data: originalEarnEvent, error: eventError } = await supabase
      .from("events")
      .select("id, customer_id, points")
      .eq("shopify_order_id", orderId)
      .eq("event_type", "Earn")
      .single();

    if (eventError || !originalEarnEvent) {
      console.warn("⚠️ SKIPPING: No 'Earn' event found for this order.");
      return new Response();
    }

    // Alias for backward compatibility with rest of the code
    const earnEventData = originalEarnEvent;
    console.log(`✅ Found Earn event ID: ${earnEventData.id}`);

    // 3. Calculate Refund Basis — prefer presentment amounts (same currency as presentment, e.g. USD)
    // This ensures refund amounts are compared in the same currency the customer paid in.
    let refundBasisValue = 0.0;
    let refundCurrency = null;

    transactions.forEach((tx) => {
      if (tx.kind === "refund" && tx.status === "success") {
        // prefer presentment_money.amount (USD), fallback to tx.amount
        const presentmentAmount = tx.presentment_money?.amount;
        const presentmentCurrency = tx.presentment_money?.currency_code;
        const amt = presentmentAmount !== undefined ? parseFloat(presentmentAmount) : parseFloat(tx.amount || 0);
        refundBasisValue += amt;
        refundCurrency = refundCurrency || presentmentCurrency || tx.currency;
      }
    });

    // Log line items for informational purposes only
    if (payload.refund_line_items && payload.refund_line_items.length > 0) {
      console.log("📦 Refund Line Items (info only):");
      payload.refund_line_items.forEach((item) => {
        console.log(
          `   - Returned: ${item.line_item.title} x${item.quantity} (subtotal before order discounts: $${parseFloat(item.subtotal || 0).toFixed(2)})`,
        );
      });
    }

    console.log(
      `💰 Total Value for Point Deduction: $${refundBasisValue.toFixed(2)}`,
    );

    // 4. Deduct Points
    if (refundBasisValue > 0) {
      const originalPointsEarned = Math.abs(originalEarnEvent.points);

      // Read ORIGINAL order value in presentment currency (total_price_set = original, NOT current_total_price_set which changes after refunds)
      let originalOrderValue = 0;
      let orderCurrency = null;

      if (payload.order?.total_price_set?.presentment_money?.amount) {
        originalOrderValue = parseFloat(payload.order.total_price_set.presentment_money.amount);
        orderCurrency = payload.order.total_price_set.presentment_money.currency_code;
      } else if (payload.order?.total_price_set?.shop_money?.amount) {
        originalOrderValue = parseFloat(payload.order.total_price_set.shop_money.amount);
        orderCurrency = payload.order.total_price_set.shop_money.currency_code;
      } else if (payload.order?.total_price) {
        originalOrderValue = parseFloat(payload.order.total_price);
        orderCurrency = payload.order?.currency || null;
      }

      // If totals missing or currency mismatch, fetch order from Shopify using total_price_set (original, not current)
      if ((!originalOrderValue || originalOrderValue <= 0) || (refundCurrency && orderCurrency && refundCurrency !== orderCurrency)) {
        console.log("⚠️ payload.order totals missing or currency mismatch — attempting to fetch order from Shopify API for original totals");
        try {
          const { data: shopData } = await supabase
            .from("shops")
            .select("access_token")
            .eq("id", loyaltyShop.id)
            .single();

          if (shopData?.access_token) {
            const orderRes = await fetch(`https://${shop}/admin/api/2025-01/orders/${orderId}.json`, {
              headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": shopData.access_token,
              },
            });

            if (orderRes.ok) {
              const orderJson = await orderRes.json();
              const fetchedOrder = orderJson.order || orderJson;
              // Use total_price_set (original order total) — NOT current_total_price_set (changes after refunds)
              if (fetchedOrder?.total_price_set?.presentment_money?.amount) {
                originalOrderValue = parseFloat(fetchedOrder.total_price_set.presentment_money.amount);
                orderCurrency = fetchedOrder.total_price_set.presentment_money.currency_code;
              } else if (fetchedOrder?.total_price) {
                originalOrderValue = parseFloat(fetchedOrder.total_price);
                orderCurrency = fetchedOrder?.currency || orderCurrency;
              }
              console.log("DEBUG fetchedOrder original total:", originalOrderValue, "currency:", orderCurrency);
            } else {
              console.warn("⚠️ Shopify order fetch failed", orderRes.status);
            }
          } else {
            console.warn("⚠️ No access token available for shop — cannot fetch order");
          }
        } catch (fetchErr) {
          console.warn("⚠️ Error fetching order from Shopify:", fetchErr);
        }
      }

      if (!originalOrderValue || originalOrderValue <= 0) {
        console.error("❌ Cannot determine original order value from payload.order or Shopify API");
        // Fail gracefully to avoid retries — log for investigation
        return new Response(JSON.stringify({ status: 200, message: 'No order total available; refund processing skipped' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      console.log("DEBUG orderCurrency:", orderCurrency, "refundCurrency:", refundCurrency);

      console.log(`💰 Original order value (from payload): $${originalOrderValue.toFixed(2)}`);
      console.log(`💰 This refund amount: $${refundBasisValue.toFixed(2)}`);

      // ── Cumulative-delta to avoid rounding errors on multiple partial refunds ──
      // 1. Sum points already deducted by previous Refund events for this order
      const { data: priorRefundEvents } = await supabase
        .from("events")
        .select("points")
        .eq("shopify_order_id", orderId)
        .eq("event_type", "Refund");

      const alreadyDeductedPoints = (priorRefundEvents || []).reduce(
        (sum, r) => sum + Math.abs(r.points || 0), 0
      );

      // 2. Back-calculate cumulative refunded dollars from already deducted points
      const cumulativeRefundedBefore = originalPointsEarned > 0
        ? (alreadyDeductedPoints / originalPointsEarned) * originalOrderValue
        : 0;

      // 3. Expected total deduction after this refund (single round — no cumulative rounding error)
      const cumulativeRefundedAfter = cumulativeRefundedBefore + refundBasisValue;
      const expectedTotalDeduct = Math.round(
        originalPointsEarned * (cumulativeRefundedAfter / originalOrderValue)
      );

      // 4. This webhook deducts only the delta
      let pointsToDeduct = expectedTotalDeduct - alreadyDeductedPoints;
      pointsToDeduct = Math.max(0, Math.min(pointsToDeduct, originalPointsEarned - alreadyDeductedPoints));

      console.log(`🧮 Points: expected total=${expectedTotalDeduct}, already deducted=${alreadyDeductedPoints}, this refund=${pointsToDeduct}`);

      // ====================================================================
      // PHASE 1: READ-ONLY OPERATIONS & CALCULATIONS (safe for concurrent execution)
      // ====================================================================
      
      // Track total points restored from coupon cancellations
      let totalRestoredPoints = 0;

      // Read unused points from Earn event (read-only, safe)
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
      } else {
        console.log(`⚠️ No earnEventData.id found - unusedPoints will be 0`);
      }

      // 5. Prepare coupon cancellation data (READ-ONLY PHASE)
      let affectedAllocations = null;
      if (earnEventData?.id) {
        console.log(`🎟️ Checking for coupons created from this order's points...`);
        console.log(`🔍 Looking for allocations with from_event_id=${earnEventData.id}`);
        
        // 5a. Find all Create Coupon events that used points from this Earn event
        // Use RPC to bypass permission issues
        const { data: allocData, error: allocError } = await supabase.rpc(
          'get_allocations_by_from_event',
          { _from_event_id: earnEventData.id }
        );

        if (allocError) {
          console.error("❌ Error fetching allocations:", allocError);
        } else {
          console.log(`📊 Found ${allocData?.length || 0} allocation(s)`);
          affectedAllocations = allocData;
        }
      }

      // ====================================================================
      // PHASE 2: ATOMIC INSERT (Duplicate Prevention)
      // ====================================================================
      
      console.log(`🔒 INSERTING Refund event (atomic duplicate check)...`);
      const { error: insertError } = await supabase.from("events").insert({
        shop_id: loyaltyShop.id,
        customer_id: originalEarnEvent.customer_id,
        event_type: "Refund",
        points: -pointsToDeduct, // Negative points
        shopify_order_id: orderId,
        shopify_refund_id: refundId, // Unique constraint - prevents duplicates atomically
        remaining_points: 0, // IMPORTANT: Refunds don't have expiration
        redeemed_code: "REFUND", // Marker for analytics
      });

      if (insertError) {
        // PostgreSQL unique constraint violation (23505) or duplicate key error
        if (insertError.code === '23505' || insertError.message?.includes('duplicate') || insertError.message?.includes('unique')) {
          console.warn("⚠️ DUPLICATE REFUND PREVENTED: Already processed (race condition caught by DB)");
          console.warn(`   Refund ID: ${refundId}, Order ID: ${orderId}`);
          console.warn(`   → Aborting all side-effects (nothing modified)`);
          return new Response(JSON.stringify({ status: 200, message: 'Already processed' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        console.error("❌ DB Insert Error:", insertError);
        throw insertError;
      }

      console.log(`✅ SUCCESS! Refund event inserted. Now processing side-effects...`);

      // ====================================================================
      // PHASE 3: SIDE-EFFECTS (Only executed if INSERT succeeded)
      // ====================================================================

      // 5b. Handle affected coupons (now safe to modify)
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

      // 6. Update the original Earn event's remaining_points proportionally (not to 0 for partial refunds)
      if (earnEventData?.id) {
        const newEarnRemaining = Math.max(0, unusedPoints - pointsToDeduct);
        console.log(`📦 Earn event remaining_points: ${unusedPoints} → ${newEarnRemaining} (deducted ${pointsToDeduct})`);
        const { error: updateError } = await supabase
          .from("events")
          .update({ remaining_points: newEarnRemaining })
          .eq("id", earnEventData.id);

        if (updateError) {
          console.error("❌ DB Update Error (Earn event remaining_points):", updateError);
        } else {
          console.log(`✅ Updated Earn event remaining_points to ${newEarnRemaining}`);
        }
      }

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

      // 9. Update customer's redeemable_points balance
      // ✅ IMPORTANT LOGIC:
      // - Unused points from this order: Deduct them
      // - Restored from non-refunded orders (coupon cancellation): Add them
      // - Coupon points used in this order: Restore them
      // Formula: Current - Unused + Restored + CouponPointsRestored
      // NOTE: Allow negative balance (fraud prevention - customer may owe points)
      // Note: redeemable_points and lifetime_points are updated automatically by the DB trigger on events INSERT.
      // We only need to read the updated values for tier check.
      const { data: currentCustomer } = await supabase
        .from("customers")
        .select("redeemable_points, lifetime_points")
        .eq("id", originalEarnEvent.customer_id)
        .single();

      if (currentCustomer) {
        console.log(`💰 Balances (from DB trigger): Redeemable=${currentCustomer.redeemable_points}, Lifetime=${currentCustomer.lifetime_points}`);

        // Check for tier downgrade after lifetime reduction (read trigger-updated value)
        const { data: customerForTier } = await supabase
          .from("customers")
          .select("tier, lifetime_points, email")
          .eq("id", originalEarnEvent.customer_id)
          .single();

        let newTier = "Circle";
        if (customerForTier.lifetime_points >= 2500) newTier = "Legacy Circle";
        else if (customerForTier.lifetime_points >= 1000) newTier = "Inner Circle";

        if (customerForTier && newTier !== customerForTier.tier) {
          await supabase
            .from("customers")
            .update({ tier: newTier })
            .eq("id", originalEarnEvent.customer_id);
          console.log(`⬇️ DOWNGRADE: User is now ${newTier} (was ${customerForTier.tier})`);
        }

        // Collect final customer state for Cloud Function
        klaviyoCustomerData = {
          email: customerForTier?.email,
          redeemable_points: currentCustomer.redeemable_points,
          tier: newTier,
          order_id: orderId,
          refund_id: refundId,
        };
        console.log(`📤 Cloud Function payload prepared:`, klaviyoCustomerData);
      }
    } else {
      console.log("🛑 Refund basis was 0. No points deducted.");
    }
  } catch (error) {
    console.error("🔥 Refund Error:", error);
  }

  // trigger Cloud Function
  const queueUrl = process.env.PROCESS_REFUND_QUEUE_URL;
  if (queueUrl && klaviyoCustomerData?.email) {
    fetch(queueUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(klaviyoCustomerData),
    }).catch((err) =>
      console.warn('⚠️ Could not trigger refund queue processor:', err)
    );
  }
  
  return new Response();
};
