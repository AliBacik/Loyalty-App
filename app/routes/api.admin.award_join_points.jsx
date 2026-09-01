import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export const loader = async () => {
  return new Response(null, { headers: corsHeaders });
};

const CONCURRENCY = 25; // parallel customer updates

function getTier(lifetimePoints) {
  if (lifetimePoints >= 2500) return "Legacy Circle";
  if (lifetimePoints >= 1000) return "Inner Circle";
  return "Circle";
}

// Run an array of async tasks with max concurrency
async function runWithConcurrency(tasks, limit) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

export const action = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Admin session only
  let shop = null;
  try {
    const { session } = await authenticate.admin(request);
    shop = session?.shop;
  } catch (e) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
  }
  if (!shop) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });

  const { data: shopRow } = await supabase
    .from("shops")
    .select("id")
    .eq("shopify_domain", shop)
    .single();
  if (!shopRow) return new Response(JSON.stringify({ error: "Shop not found" }), { status: 404, headers: corsHeaders });

  // Get all active customers without join gift
  const { data: customers, error: custErr } = await supabase
    .from("customers")
    .select("id, email, redeemable_points, lifetime_points, tier, gifts")
    .eq("shop_id", shopRow.id)
    .eq("status", "active");

  if (custErr) return new Response(JSON.stringify({ error: custErr.message }), { status: 500, headers: corsHeaders });

  const eligible = (customers || []).filter(c => {
    let gifts = c.gifts || {};
    if (typeof gifts === "string") { try { gifts = JSON.parse(gifts); } catch { gifts = {}; } }
    return !gifts?.join;
  });

  if (eligible.length === 0) {
    return new Response(
      JSON.stringify({ success: true, awarded: 0, message: "No eligible customers found" }),
      { status: 200, headers: corsHeaders }
    );
  }

  const PTS = 100;
  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setMonth(expiresAt.getMonth() + 6);
  const expiresAtISO = expiresAt.toISOString();
  const nowISO = now.toISOString();

  // 1. Batch insert all events in one query
  const eventRows = eligible.map(c => ({
    shop_id: shopRow.id,
    customer_id: c.id,
    event_type: "Earn",
    points: PTS,
    remaining_points: PTS,
    expires_at: expiresAtISO,
    event_desc: "join",
    created_at: nowISO,
  }));

  const { error: evErr } = await supabase.from("events").insert(eventRows);
  if (evErr) {
    console.error("[award_join_points] Batch event insert failed:", evErr.message);
    return new Response(JSON.stringify({ error: "Failed to insert events", detail: evErr.message }), { status: 500, headers: corsHeaders });
  }
  console.log(`[award_join_points] ✅ Batch inserted ${eventRows.length} events`);

  // 2. Update each customer in parallel (points + gifts + tier)
  let awarded = 0;
  let failed = 0;
  const errors = [];

  const tasks = eligible.map(c => async () => {
    try {
      let gifts = c.gifts || {};
      if (typeof gifts === "string") { try { gifts = JSON.parse(gifts); } catch { gifts = {}; } }
      gifts.join = true;

      const newRedeemable = (c.redeemable_points || 0) + PTS;
      const newLifetime = (c.lifetime_points || 0) + PTS;
      const newTier = getTier(newLifetime);
      const tierChanged = newTier !== c.tier;

      const { error: upErr } = await supabase
        .from("customers")
        .update({
          gifts,
          redeemable_points: newRedeemable,
          lifetime_points: newLifetime,
          ...(tierChanged ? { tier: newTier } : {}),
        })
        .eq("id", c.id);

      if (upErr) {
        errors.push({ email: c.email, error: upErr.message });
        failed++;
      } else {
        awarded++;
      }
    } catch (e) {
      errors.push({ email: c.email, error: e.message });
      failed++;
    }
  });

  await runWithConcurrency(tasks, CONCURRENCY);

  console.log(`[award_join_points] Done — awarded: ${awarded} | failed: ${failed}`);

  return new Response(
    JSON.stringify({ success: true, eligible: eligible.length, awarded, failed, errors }),
    { status: 200, headers: corsHeaders }
  );
};
