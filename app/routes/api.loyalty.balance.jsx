import { supabase } from "../supabase.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId");
  const shop = url.searchParams.get("shop");

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers });

  if (!customerId || !shop) {
    return new Response(JSON.stringify({ error: "Missing params" }), { status: 400, headers });
  }

  // 1. Get Shop
  const { data: loyaltyShop } = await supabase.from("shops").select("id").eq("shopify_domain", shop).single();
  if (!loyaltyShop) return new Response(JSON.stringify({ error: "Shop not found" }), { status: 404, headers });

  // 2. Get Customer
  const { data: customer } = await supabase
    .from("customers")
    .select("id, redeemable_points, tier, lifetime_points, discount_codes")
    .eq("shopify_customer_id", customerId)
    .eq("shop_id", loyaltyShop.id)
    .single();

  if (!customer) {
    return new Response(JSON.stringify({ points: 0, tier: "Circle", lifetimePoints: 0, discountCodes: [], nextExpiration: null }), { status: 200, headers });
  }

  // 3. Find next expiring points - stack points from same day
  const { data: nextExpiringEvent } = await supabase
    .from("events")
    .select("remaining_points, expires_at, created_at")
    .eq("customer_id", customer.id)
    .eq("event_type", "Earn")
    .gt("remaining_points", 0)
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  let nextExpiration = null;
  // helper to format ISO date -> DD/MM/YYYY
  const formatDate = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  };

  if (nextExpiringEvent && nextExpiringEvent.expires_at) {
    // find all eventss from same day
    const createdDate = new Date(nextExpiringEvent.created_at);
    const dayStart = new Date(createdDate.getFullYear(), createdDate.getMonth(), createdDate.getDate());
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    // fetch all earn events from the same day with remaining points
    const { data: sameDayEvents } = await supabase
      .from("events")
      .select("remaining_points, expires_at")
      .eq("customer_id", customer.id)
      .eq("event_type", "Earn")
      .gt("remaining_points", 0)
      .gte("created_at", dayStart.toISOString())
      .lt("created_at", dayEnd.toISOString());

    // Sum up all points from same day
    const totalPoints = (sameDayEvents || []).reduce((sum, event) => sum + event.remaining_points, 0);

    const expiresAt = new Date(nextExpiringEvent.expires_at);
    const now = new Date();
    const daysUntilExpiration = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));

    nextExpiration = {
      points: totalPoints,
      expiresAt: formatDate(nextExpiringEvent.expires_at),
      daysUntilExpiration: Math.max(0, daysUntilExpiration) // Never negative
    };
  }

  // 4. Enrich discount codes with expiry info from Create Coupon events
  let discountCodesWithExpiry = [];
  const codes = customer.discount_codes || [];
  if (codes.length > 0) {
    const { data: couponEvents } = await supabase
      .from("events")
      .select("redeemed_code, expires_at")
      .in("redeemed_code", codes)
      .eq("event_type", "Create Coupon")
      .eq("shop_id", loyaltyShop.id);

    const map = {};
    (couponEvents || []).forEach((row) => {
      if (row && row.redeemed_code) map[row.redeemed_code] = row.expires_at;
    });

    const now = new Date();
    discountCodesWithExpiry = codes.map((c) => {
      const raw = map[c] || null;
      let daysUntilExpiration = null;
      if (raw) {
        const d = new Date(raw);
        daysUntilExpiration = Math.max(0, Math.ceil((d - now) / (1000 * 60 * 60 * 24)));
      }
      return {
        code: c,
        expiresAt: formatDate(raw),
        daysUntilExpiration: daysUntilExpiration,
      };
    });
  }

  // 5. Return Complete Data
  return new Response(JSON.stringify({
    points: customer.redeemable_points,
    tier: customer.tier,
    lifetimePoints: customer.lifetime_points || 0,
    discountCodes: discountCodesWithExpiry,
    nextExpiration: nextExpiration,
    exists: true
  }), { status: 200, headers });


};