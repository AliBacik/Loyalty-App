import { supabase } from "../supabase.server";

export const loader = async ({ request }) => {
  // 1. Security Check
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  
  if (key !== process.env.CRON_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log("🧹 Starting Expiration Sweep...");
  const now = new Date().toISOString();

  // Optional per-store scoping. A single scheduler currently sweeps every store, which is
  // correct — but passing ?shop=<domain> limits the sweep to one store, so a second store
  // can get its own scheduler later without both jobs racing over the same events.
  const shopParam = url.searchParams.get("shop");
  let shopFilterId = null;

  if (shopParam) {
    const { data: shopRow, error: shopError } = await supabase
      .from("shops")
      .select("id")
      .eq("shopify_domain", shopParam)
      .single();

    if (shopError || !shopRow) {
      return new Response(JSON.stringify({ error: `Shop not found: ${shopParam}` }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    shopFilterId = shopRow.id;
    console.log(`🔒 Scoped to shop ${shopParam} (id: ${shopFilterId})`);
  }

  // 2. Find "Earn" events that are EXPIRED but still have points LEFT
  let expiredQuery = supabase
    .from("events")
    .select("*")
    .eq("event_type", "Earn")
    .lt("expires_at", now)
    .gt("remaining_points", 0);

  if (shopFilterId !== null) {
    expiredQuery = expiredQuery.eq("shop_id", shopFilterId);
  }

  const { data: expiredEvents, error: fetchError } = await expiredQuery;

  if (fetchError) {
    console.error("Error fetching events:", fetchError);
    return new Response(JSON.stringify({ error: fetchError.message }), { status: 500 });
  }

  console.log(`Found ${expiredEvents.length} expired batches.`);
  const results = [];
  const errors = [];

  // 3. Process each expired batch
  for (const event of expiredEvents) {
    const pointsToRemove = event.remaining_points; 

    console.log(`Processing Event #${event.id}: Expiring ${pointsToRemove} points...`);

    // A. Create the 'Expire' Event (Negative points)
    const { error: insertError } = await supabase.from("events").insert({
      shop_id: event.shop_id,
      customer_id: event.customer_id,
      event_type: "Expire",
      points: -pointsToRemove,
      shopify_order_id: event.shopify_order_id,
      // ❌ REMOVED: description (since your DB doesn't have this column)
      created_at: now
    });

    if (insertError) {
        console.error(`❌ FAILED to insert Expire event for Order ${event.shopify_order_id}:`, insertError);
        errors.push(insertError);
    } else {
      // B. Close the Original Event ONLY if insert succeeded
      const { error: updateError } = await supabase
        .from("events")
        .update({ remaining_points: 0 })
        .eq("id", event.id);
        
      if (updateError) {
          console.error("❌ FAILED to zero out balance:", updateError);
      } else {
          results.push(`User ${event.customer_id}: Expired ${pointsToRemove} pts`);
          console.log("✅ Success.");
      }
    }
  }

  // 4. Return Success
  return new Response(JSON.stringify({ 
    success: true, 
    processed: results.length, 
    logs: results,
    errors: errors
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};