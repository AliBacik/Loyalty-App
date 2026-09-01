import { supabase } from "../supabase.server";
import { authenticate } from "../shopify.server";

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
      console.log('[reset] Authenticated via CRON_SECRET for shop', shop);
    } catch (e) {
      console.error('[reset] Failed to parse body for CRON_SECRET request:', e?.message || e);
    }
  }
  // Bearer token for embedded app
  else if (authHeader?.startsWith('Bearer ')) {
    try {
      const { session } = await authenticate.admin(request);
      shop = session?.shop;
      isAuthenticated = !!shop;
      console.log('[reset] Authenticated via authenticate.admin for shop:', shop);
    } catch (err) {
      console.error('[reset] authenticate.admin failed:', err?.message || err);
    }
  }

  if (!isAuthenticated || !shop) {
    console.error('[reset] Authentication failed - no valid shop');
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
      .select("id")
      .eq("shopify_domain", shopToQuery)
      .single();

    if (shopError || !loyaltyShop) {
      return new Response(JSON.stringify({ error: "Shop not found" }), { status: 404, headers: corsHeaders });
    }

    // 2. Find customer
    const { data: customer } = await supabase
      .from("customers")
      .select("id, email")
      .eq("shopify_customer_id", customerId)
      .eq("shop_id", loyaltyShop.id)
      .single();

    if (!customer) {
      return new Response(JSON.stringify({ error: "Customer not found" }), { status: 404, headers: corsHeaders });
    }

    // 3. Find all events for this customer
    const { data: events } = await supabase
      .from('events')
      .select('id')
      .eq('customer_id', customer.id);

    // 4. For each event, delete allocations referencing it (to_event) via RPC and delete allocations where from_event_id equals it
    let allocsDeleted = 0;
    if (events && events.length > 0) {
      for (const ev of events) {
        try {
          await supabase.rpc('delete_allocations_by_to_event', { _to_event_id: ev.id });
        } catch (e) {
          console.warn('delete_allocations_by_to_event failed for', ev.id, e.message || e);
        }

        // Try delete from point_allocations table where from_event_id = ev.id
        try {
          const { error: delErr, data: delData } = await supabase
            .from('point_allocations')
            .delete()
            .eq('from_event_id', ev.id);
          if (!delErr) {
            // delData length unknown; count not precise
            allocsDeleted += Array.isArray(delData) ? delData.length : 0;
          }
        } catch (e) {
          console.warn('Failed deleting point_allocations from_event', ev.id, e.message || e);
        }
      }
    }

    // 5. Delete all events for this customer
    const { error: delEventsErr } = await supabase
      .from('events')
      .delete()
      .eq('customer_id', customer.id);

    if (delEventsErr) {
      console.error('Failed deleting events for customer', delEventsErr);
      return new Response(JSON.stringify({ error: 'Failed deleting events' }), { status: 500, headers: corsHeaders });
    }

    // 6. Reset customer row
    const { error: custUpdateErr } = await supabase
      .from('customers')
      .update({ redeemable_points: 0, lifetime_points: 0, tier: 'Circle', discount_codes: [] })
      .eq('id', customer.id);

    if (custUpdateErr) {
      console.error('Failed resetting customer', custUpdateErr);
      return new Response(JSON.stringify({ error: 'Failed updating customer' }), { status: 500, headers: corsHeaders });
    }

    // Send Klaviyo "Loyalty Customer Reset" event
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
                  attributes: { name: "Loyalty Customer Reset" }
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
          console.warn("[reset] ⚠️ Klaviyo event failed:", klaviyoRes.status, errText);
        } else {
          console.log(`[reset] 📧 Klaviyo 'Loyalty Customer Reset' event sent for ${customer.email}`);
        }
      } catch (klaviyoErr) {
        console.warn("[reset] ⚠️ Klaviyo event exception:", klaviyoErr);
      }
    }

    return new Response(JSON.stringify({ success: true, allocsDeleted, eventsDeleted: true }), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error('Reset customer error:', err);
    return new Response(JSON.stringify({ error: err.message || 'Unknown error' }), { status: 500, headers: corsHeaders });
  }
};
