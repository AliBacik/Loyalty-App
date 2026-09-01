import { supabase } from "../supabase.server";
import { authenticate } from "../shopify.server";

// CORS Headers (match other admin APIs)
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
  // 1. Security Check: authenticate.admin (embedded app) or CRON_SECRET
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  const authHeader = request.headers.get("Authorization");

  let shop = null;
  let isAuthenticated = false;
  let body = null;

  // CRON_SECRET kontrolü (cron job'lar için)
  if (key === process.env.CRON_SECRET && process.env.CRON_SECRET) {
    try {
      body = await request.json();
      shop = body.shop;
      isAuthenticated = true;
      console.log('[adjust] Authenticated via CRON_SECRET');
    } catch (e) {
      console.error('[adjust] Failed to parse body for CRON_SECRET request:', e?.message || e);
    }
  }
  // Bearer token kontrolü (embedded app için)
  else if (authHeader?.startsWith("Bearer ")) {
    try {
      const { session } = await authenticate.admin(request);
      shop = session?.shop;
      isAuthenticated = !!shop;
      console.log('[adjust] Authenticated via authenticate.admin for shop:', shop);
    } catch (err) {
      console.error('[adjust] authenticate.admin failed:', err?.message || err);
    }
  }

  // Authentication başarısız
  if (!isAuthenticated || !shop) {
    console.error('[adjust] Authentication failed - no valid shop');
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  }

  // Request body'yi parse et (sadece bir kez)
  if (!body) {
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: corsHeaders });
    }
  }

  const { customerId, points, reason } = body;

  // Validasyon
  if (!customerId || points === undefined || points === null) {
    return new Response(JSON.stringify({ error: 'Missing required fields (customerId, points)' }), { status: 400, headers: corsHeaders });
  }

  // Log incoming request for debugging
  console.log('[adjust] Request body:', { customerId, points, reason });
  console.log('[adjust] Authenticated shop:', shop);

  // 3. Find Shop
  const shopToQuery = shop;
  const { data: loyaltyShop } = await supabase
    .from("shops")
    .select("id")
    .eq("shopify_domain", shopToQuery)
    .single();

  if (!loyaltyShop) {
    return new Response(JSON.stringify({ error: "Shop not found" }), { status: 404, headers: corsHeaders });
  }

  // 4. Find Customer
  console.log('[adjust] Looking for customer with shopify_customer_id:', customerId, 'shop_id:', loyaltyShop.id);
  
  const { data: customer, error: customerError } = await supabase
    .from("customers")
    .select("id, email, shopify_customer_id, tier")
    .eq("shopify_customer_id", customerId)
    .eq("shop_id", loyaltyShop.id)
    .single();

  if (!customer) {
    console.error('[adjust] Customer not found:', customerError);
    return new Response(JSON.stringify({ error: "Customer not found" }), { status: 404, headers: corsHeaders });
  }
  
  console.log('[adjust] Found customer:', customer);

  // 5. Create "Earn" Event for redeemable points
  const pointsDelta = points; // Just use delta directly
  const isPositive = pointsDelta > 0;
  let expiresAt = null;
  let remainingPoints = 0;
  
  if (isPositive) {
    const d = new Date();
    d.setMonth(d.getMonth() + 6); // 6 Month Expiry for manually granted points
    expiresAt = d.toISOString();
    remainingPoints = Math.abs(pointsDelta);
  }
  
  console.log('[adjust] Creating Earn event:', { pointsDelta });

  const { error, data: insertedEvent } = await supabase.from("events").insert({
    shop_id: loyaltyShop.id,
    customer_id: customer.id,
    event_type: 'Earn',
    points: pointsDelta,
    remaining_points: remainingPoints,
    expires_at: expiresAt,
  }).select();

  if (error) {
    console.error("[adjust] Event insert error:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }

  console.log("[adjust] Event inserted:", insertedEvent);

  // Check for tier upgrade based on lifetime points
  const { data: currentCustomer } = await supabase
    .from("customers")
    .select("redeemable_points, lifetime_points, tier")
    .eq("id", customer.id)
    .single();

  let newTier = currentCustomer?.tier || 'Circle';
  const newLifetime = currentCustomer?.lifetime_points || 0;
  if (newLifetime >= 2500) {
    newTier = 'Legacy Circle';
  } else if (newLifetime >= 1000) {
    newTier = 'Inner Circle';
  } else {
    newTier = 'Circle';
  }

  if (newTier !== currentCustomer?.tier) {
    await supabase
      .from("customers")
      .update({ tier: newTier })
      .eq("id", customer.id);
    console.log(`[adjust] 🎉 TIER UPGRADE: ${currentCustomer?.tier} → ${newTier} (lifetime: ${newLifetime})`);
  }

  console.log(`[adjust] Points adjusted by ${pointsDelta}. Current lifetime: ${newLifetime}`);

  // Read final balance to return to UI
  const { data: finalCustomer } = await supabase
    .from("customers")
    .select("redeemable_points, lifetime_points, tier")
    .eq("id", customer.id)
    .single();
  
  console.log("[adjust] Final customer state:", finalCustomer);

  // Send Klaviyo "Loyalty Points Adjusted" event
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
                attributes: { name: "Loyalty Points Adjusted" }
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
              points_adjusted: pointsDelta,
              reason: reason || null,
              redeemable_points: finalCustomer?.redeemable_points || 0,
              lifetime_points: finalCustomer?.lifetime_points || 0,
              tier: finalCustomer?.tier || 'Circle',
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
        console.warn("[adjust] ⚠️ Klaviyo event failed:", klaviyoRes.status, errText);
      } else {
        console.log(`[adjust] 📧 Klaviyo 'Loyalty Points Adjusted' event sent for ${customer.email}`);
      }
    } catch (klaviyoErr) {
      console.warn("[adjust] ⚠️ Klaviyo event exception:", klaviyoErr);
    }
  }

  return new Response(JSON.stringify({
    success: true,
    message: `Adjusted by ${pointsDelta} points.`,
    newBalance: {
      redeemable_points: finalCustomer?.redeemable_points || 0,
      lifetime_points: finalCustomer?.lifetime_points || 0,
      tier: finalCustomer?.tier || 'Circle'
    }
  }), {
    status: 200,
    headers: corsHeaders
  });
};