import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

export const action = async ({ request }) => {
  // 🔍 DEBUG 1: Did the request hit the server?
  console.log("----------------------------------------------------");
  console.log("📣 WEBHOOK HIT: /webhooks/orders/create");

  let topic, shop, payload;

  try {
    const result = await authenticate.webhook(request);
    topic = result.topic;
    shop = result.shop;
    payload = result.payload;
    console.log(`✅ Auth Success! Topic: ${topic}, Shop: ${shop}`);
  } catch (authError) {
    console.error("❌ AUTH FAILED:", authError);
    return new Response("Unauthorized", { status: 401 });
  }

  // 🔍 DEBUG 2: Topic Check
  if (topic !== "ORDERS_CREATE") {
    console.log(`⚠️ EXITING: Topic is ${topic}, expected ORDERS_CREATE`);
    return new Response();
  }

  // 🔍 DEBUG 2.5: Ensure order is authorized or paid before awarding points
  const financialStatus = payload?.financial_status;
  if (!["authorized", "paid"].includes(financialStatus)) {
    console.log(`ℹ️ EXITING: Order ${payload?.id} financial_status=${financialStatus}; expected authorized or paid`);
    return new Response();
  }

  try {
    // 🔍 DEBUG 3: Shop Lookup
    const { data: loyaltyShop, error: shopError } = await supabase
      .from("shops")
      .select("id")
      .eq("shopify_domain", shop)
      .single();

    if (shopError || !loyaltyShop) {
      console.error(`❌ DB ERROR: Shop '${shop}' not found in 'shops' table.`);
      return new Response();
    }

    // DEBUG: Log payload and customer object to diagnose null issues
    try {
      console.log("DEBUG payload:", JSON.stringify(payload, null, 2));
    } catch (e) {
      console.log("DEBUG payload: <unserializable>");
    }
    try {
      console.log("DEBUG payload.customer:", JSON.stringify(payload.customer, null, 2));
    } catch (e) {
      console.log("DEBUG payload.customer: <unserializable>");
    }

    const customerId = payload.customer?.id;
    const customerEmail = payload.customer?.email;
    const customerState = payload.customer?.state;

    if (!customerId) {
      console.error("❌ MISSING customer.id in webhook payload; aborting. payload.customer:", payload.customer);
      return new Response();
    }

    // Shopify 'state' helps identifying guests. 'disabled' usually means guest.
    const isGuest = customerState === "disabled";

    console.log(
      `👤 Customer: ${customerEmail} | ID: ${customerId} | State: ${customerState} (Guest: ${isGuest})`,
    );

    // 2. Find Customer in Loyalty DB
    let { data: customer } = await supabase
      .from("customers")
      .select("*")
      .eq("shopify_customer_id", customerId)
      .eq("shop_id", loyaltyShop.id)
      .single();

    // 3. Handle Enrollment (If not in DB yet)
    if (!customer) {
      console.log("🆕 User not found in DB. Checking enrollment rules...");

      // CHECK SUBSCRIPTION STATUS
      let isSubscribed = false;
      if (payload.customer.email_marketing_consent) {
        isSubscribed =
          payload.customer.email_marketing_consent.state === "subscribed";
      } else if (payload.customer.accepts_marketing) {
        isSubscribed = true;
      }

      console.log(`   -> Marketing Consent: ${isSubscribed}`);

      let newStatus = null;

      if (!isGuest) {
        // Registered account
        newStatus = "pending"; // still pending cause they didnt join the circle yet
        console.log("   -> ✅ Enrolling Registered Account (Pending)");
      } else if (isGuest && isSubscribed) {
        // Guest but subscribed
        newStatus = "pending";
        console.log("   -> ✅ Enrolling Guest Subscriber (Pending)");

        await sendKlaviyoEvent("Loyalty Pending Activation", customerEmail, {
          status: "pending",
          register_url: `https://${shop}/account/register`,
        });
      } else {
        // IGNORE CASE
        console.log("🚫 EXITING: Guest not subscribed.");
        return new Response();
      }

      // Create the Customer — always set `status` to "pending" for newly created customers
      const { data: newCustomer, error } = await supabase
        .from("customers")
        .insert({
          shop_id: loyaltyShop.id,
          shopify_customer_id: customerId,
          email: customerEmail,
          tier: "Circle",
          status: "pending",
          redeemable_points: 0,
          lifetime_points: 0,
        })
        .select()
        .single();

      if (error) {
        console.error("❌ Error creating customer:", error);
        return new Response();
      }
      customer = newCustomer;
      console.log("   -> Customer Created Successfully.");
    } else {
      console.log("   -> Customer found in DB. Proceeding to points...");
    }

    // 3.5. Recalculate tier based on current lifetime (in case it changed from refunds)
    let currentTier = customer.tier;
    const currentLifetime = customer.lifetime_points || 0;
    
    if (currentLifetime >= 2500) {
      currentTier = "Legacy Circle";
    } else if (currentLifetime >= 1000) {
      currentTier = "Inner Circle";
    } else {
      currentTier = "Circle";
    }

    // Update tier if it changed (downgrade or upgrade)
    if (currentTier !== customer.tier) {
      await supabase
        .from("customers")
        .update({ tier: currentTier, status: customer.status })
        .eq("id", customer.id);
      console.log(`🔄 Tier adjusted: ${customer.tier} → ${currentTier} (lifetime: ${currentLifetime})`);
      customer.tier = currentTier; // Update local reference
    }

    // 4. Calculate Points — prefer presentment (customer currency) totals to match refund presentment
    let subtotalPresentment = parseFloat(payload.subtotal_price || 0);
    let orderCurrency = null;

    if (payload.current_subtotal_price_set?.presentment_money?.amount) {
      subtotalPresentment = parseFloat(payload.current_subtotal_price_set.presentment_money.amount);
      orderCurrency = payload.current_subtotal_price_set.presentment_money.currency_code;
    } else if (payload.current_subtotal_price_set?.shop_money?.amount) {
      subtotalPresentment = parseFloat(payload.current_subtotal_price_set.shop_money.amount);
      orderCurrency = payload.current_subtotal_price_set.shop_money.currency_code;
    }

    // Determine the amount the customer actually paid (after ALL discounts)
    // Prefer presentment totals, then shop totals, then total_price
    let paidAmount = parseFloat(payload.subtotal_price || 0);
    if (payload.current_total_price_set?.presentment_money?.amount) {
      paidAmount = parseFloat(payload.current_total_price_set.presentment_money.amount);
      orderCurrency = orderCurrency || payload.current_total_price_set.presentment_money.currency_code;
    } else if (payload.current_total_price_set?.shop_money?.amount) {
      paidAmount = parseFloat(payload.current_total_price_set.shop_money.amount);
      orderCurrency = orderCurrency || payload.current_total_price_set.shop_money.currency_code;
    } else if (payload.total_price) {
      paidAmount = parseFloat(payload.total_price);
    }

    console.log("DEBUG orderCurrency:", orderCurrency, "paidAmount:", paidAmount);

    // Still lookup LOYALTY coupons for redemption tracking, but do NOT subtract their value
    // from paidAmount — Shopify's total_price already reflects applied discounts.
    const couponEvents = {};
    if (payload.discount_codes && payload.discount_codes.length > 0) {
      for (const dc of payload.discount_codes) {
        if (!dc.code || !dc.code.startsWith("LOYALTY-")) continue;
        try {
          const { data: foundCoupon, error: couponError } = await supabase
            .from("events")
            .select("id, customer_id, points, remaining_points, redeemed_code, event_type")
            .eq("redeemed_code", dc.code)
            .eq("event_type", "Create Coupon")
            .eq("shop_id", loyaltyShop.id)
            .maybeSingle();

          if (couponError) {
            console.warn("⚠️ coupon lookup error for", dc.code, couponError);
            continue;
          }

          if (foundCoupon && foundCoupon.customer_id === customer.id && foundCoupon.remaining_points !== -1) {
            couponEvents[dc.code] = foundCoupon;
            console.log(`🔎 Found loyalty coupon ${dc.code} value $${Math.abs(foundCoupon.points || 0)}`);
          } else if (foundCoupon) {
            console.log(`🔎 Coupon ${dc.code} found but not applicable (owner or already used).`);
          }
        } catch (e) {
          console.warn("⚠️ coupon lookup exception for", dc.code, e);
        }
      }
    }

    let multiplier = 1.0;
    if (customer.tier === "Inner Circle") multiplier = 1.5;
    if (customer.tier === "Legacy Circle") multiplier = 2.0;

    const pointsEarned = Math.round(Math.max(0, paidAmount) * multiplier);
    console.log(
      `🧮 Points Calc: Paid $${paidAmount} (after discounts) * ${multiplier}x = ${pointsEarned}`,
    );

    // 5. Insert Earn Event (with idempotency check)
    if (pointsEarned > 0) {
      // Check for an existing Earn event for this order/customer to avoid duplicates
      const { data: existingEvent, error: existingError } = await supabase
        .from("events")
        .select("id")
        .eq("shopify_order_id", payload.id)
        .eq("event_type", "Earn")
        .eq("customer_id", customer.id)
        .limit(1)
        .maybeSingle();

      if (existingError) {
        console.warn("⚠️ Failed checking for existing event:", existingError);
      }

      if (existingEvent) {
        console.log("⚠️ Duplicate earn event detected — skipping insert for order:", payload.id);
      } else {
        const expiresAt = new Date();
        expiresAt.setMonth(expiresAt.getMonth() + 6);

        await supabase.from("events").insert({
          shop_id: loyaltyShop.id,
          customer_id: customer.id,
          event_type: "Earn",
          points: pointsEarned,
          remaining_points: pointsEarned,
          shopify_order_id: payload.id,
          shopify_order_name: payload.name,
          expires_at: expiresAt,
        });

        // Note: redeemable_points and lifetime_points are updated automatically by DB trigger on events INSERT
        console.log(`✅ Awarded ${pointsEarned} points. Status: ${customer.status}. (Balance updated by DB trigger)`);

        // 6. Check Tier Upgrade
        const { data: freshCustomer } = await supabase
          .from("customers")
          .select("lifetime_points, tier, status")
          .eq("id", customer.id)
          .single();

        let newTier = freshCustomer.tier;
        if (freshCustomer.lifetime_points >= 2500) newTier = "Legacy Circle";
        else if (freshCustomer.lifetime_points >= 1000) newTier = "Inner Circle";

        if (newTier !== freshCustomer.tier) {
          await supabase
            .from("customers")
            .update({ tier: newTier, status: freshCustomer.status })
            .eq("id", customer.id);
          console.log(`🎉 UPGRADE: User is now ${newTier}`);
        }
      }
    } else {
      console.log("⚠️ Points earned was 0. No event created.");
    }

    if (payload.discount_codes && payload.discount_codes.length > 0) {
      for (const dc of payload.discount_codes) {
        if (!dc.code || !dc.code.startsWith("LOYALTY-")) continue;

        const foundCoupon = couponEvents[dc.code];

        // If we previously looked up a valid coupon for this customer, record the Redeem event and mark used
        if (foundCoupon) {
          const { data: redeemEvent, error: redeemEventError } = await supabase
            .from("events")
            .insert({
              shop_id: loyaltyShop.id,
              customer_id: customer.id,
              event_type: "Redeem",
              points: 0,
              remaining_points: 0,
              redeemed_code: dc.code,
              shopify_order_id: payload.id,
            })
            .select()
            .maybeSingle();

          if (redeemEventError) console.error("❌ events.redeem.insert error:", redeemEventError);
          else console.log("✅ events.redeem.insert returned:", redeemEvent);

          // Mark original coupon event as used
          const { error: markUsedErr } = await supabase
            .from("events")
            .update({ remaining_points: -1 })
            .eq("id", foundCoupon.id);

          if (markUsedErr) console.error("❌ failed to mark coupon used:", markUsedErr);

          // Remove from customer's discount_codes array if present
          const { data: latestCustomer } = await supabase
            .from("customers")
            .select("discount_codes")
            .eq("id", customer.id)
            .single();

          if (latestCustomer && latestCustomer.discount_codes) {
            const currentCodes = latestCustomer.discount_codes;
            const updatedCodes = currentCodes.filter((c) => c !== dc.code);

            const { error: updateCodesError } = await supabase
              .from("customers")
              .update({ discount_codes: updatedCodes })
              .eq("id", customer.id);

            if (updateCodesError) console.error("❌ customers.update(discount_codes) error:", updateCodesError);
            else console.log(`✅ Removed used code ${dc.code} from wallet.`);
          }
        } else {
          console.log(`ℹ️ Discount code ${dc.code} ignored (not a loyalty coupon or invalid).`);
        }
      }
    }
    // ── Wishlist conversion tracking ─────────────────────────────────────────
    try {
      const lineItems = payload.line_items || [];
      if (lineItems.length > 0 && customer?.id) {
        const variantGids = lineItems
          .map(item => item.variant_id ? `gid://shopify/ProductVariant/${item.variant_id}` : null)
          .filter(Boolean);

        if (variantGids.length > 0) {
          const { data: matchedItems } = await supabase
            .from("wishlist_items")
            .select("id, variant_gid")
            .eq("customer_id", customer.id)
            .in("variant_gid", variantGids)
            .is("converted_at", null);

          if (matchedItems && matchedItems.length > 0) {
            const now = new Date().toISOString();
            const ids = matchedItems.map(i => i.id);
            await supabase
              .from("wishlist_items")
              .update({ converted_at: now, shopify_order_id: String(payload.id) })
              .in("id", ids);

            console.log(`💜 Wishlist conversion: ${matchedItems.length} item(s) converted for customer ${customer.id} (order ${payload.name})`);
          }
        }
      }
    } catch (e) {
      console.warn("⚠️ Wishlist conversion tracking failed:", e?.message || e);
    }

  } catch (err) {
    console.error("🔥 CRITICAL ERROR:", err);
  }

  return new Response();
};
