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

function getTier(lifetimePoints) {
  if (lifetimePoints >= 2500) return "Legacy Circle";
  if (lifetimePoints >= 1000) return "Inner Circle";
  return "Circle";
}

/**
 * POST /api/loyalty/award_bulk
 * Body: { rows: [{email, points}, ...] }   max 2000 rows per call
 *
 * Performs the same logic as award_by_email but in bulk:
 *  1. Single SELECT to find existing customers
 *  2. Single INSERT to create missing customers
 *  3. Single array INSERT for all events
 *  4. Parallel UPDATE for all customers (chunked, 50 at a time)
 *
 * If the same email appears multiple times in a request the points are summed.
 */
export const action = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // ── Auth (same flow as award_by_email) ──────────────────────────────────────
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  let shop = null;
  let isAuthenticated = false;
  let body = null;

  try {
    const { session } = await authenticate.admin(request);
    if (session?.shop) {
      shop = session.shop;
      isAuthenticated = true;
    }
  } catch (e) {
    // Fall through to next auth method
  }

  if (
    !isAuthenticated &&
    key === process.env.CRON_SECRET &&
    process.env.CRON_SECRET
  ) {
    try {
      body = await request.json();
      shop = body.shop;
      isAuthenticated = true;
    } catch (e) {}
  }

  if (!isAuthenticated || !shop) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  if (!body) {
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: corsHeaders,
      });
    }
  }

  // ── Input validation ─────────────────────────────────────────────────────────
  const { rows } = body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return new Response(
      JSON.stringify({ error: "rows must be a non-empty array" }),
      { status: 400, headers: corsHeaders }
    );
  }

  const MAX_ROWS = 2000;
  if (rows.length > MAX_ROWS) {
    return new Response(
      JSON.stringify({ error: `Too many rows. Max ${MAX_ROWS} per request.` }),
      { status: 400, headers: corsHeaders }
    );
  }

  // ── Find shop ────────────────────────────────────────────────────────────────
  const { data: shopRow } = await supabase
    .from("shops")
    .select("id")
    .eq("shopify_domain", shop)
    .single();

  if (!shopRow) {
    return new Response(JSON.stringify({ error: "Shop not found" }), {
      status: 404,
      headers: corsHeaders,
    });
  }

  // ── Normalize rows ───────────────────────────────────────────────────────────
  const validRows = [];
  const invalidRows = [];

  for (const row of rows) {
    const email =
      typeof row.email === "string" ? row.email.trim().toLowerCase() : null;
    const points = Number(row.points);
    if (!email || isNaN(points)) {
      invalidRows.push({ ...row, reason: "Invalid email or points" });
    } else {
      validRows.push({ email, points });
    }
  }

  if (validRows.length === 0) {
    return new Response(
      JSON.stringify({ error: "No valid rows", invalid: invalidRows }),
      { status: 400, headers: corsHeaders }
    );
  }

  // Group by email: sum points if same email appears multiple times
  const emailPointsMap = {};
  for (const { email, points } of validRows) {
    emailPointsMap[email] = (emailPointsMap[email] ?? 0) + points;
  }
  const uniqueEmails = Object.keys(emailPointsMap);

  // ── Fetch existing customers (1 query) ──────────────────────────────────────
  const { data: existingCustomers = [] } = await supabase
    .from("customers")
    .select("id, email, redeemable_points, lifetime_points, tier")
    .eq("shop_id", shopRow.id)
    .in("email", uniqueEmails);

  const customerByEmail = {};
  for (const c of existingCustomers) {
    customerByEmail[c.email.toLowerCase().trim()] = c;
  }

  // ── Bulk create missing customers (1 INSERT) ─────────────────────────────────
  const missingEmails = uniqueEmails.filter((e) => !customerByEmail[e]);

  if (missingEmails.length > 0) {
    const toInsert = missingEmails.map((email) => ({
      shop_id: shopRow.id,
      email,
      redeemable_points: 0,
      lifetime_points: 0,
      tier: "Circle",
    }));

    const { data: inserted, error: insertErr } = await supabase
      .from("customers")
      .insert(toInsert)
      .select("id, email, redeemable_points, lifetime_points, tier");

    if (insertErr) {
      console.error("[award_bulk] Failed to create customers:", insertErr);
      return new Response(
        JSON.stringify({
          error: "Failed to create customers",
          detail: insertErr.message,
        }),
        { status: 500, headers: corsHeaders }
      );
    }

    for (const c of inserted || []) {
      customerByEmail[c.email.toLowerCase().trim()] = c;
    }
  }

  // ── Compute new state, prepare event inserts & customer updates ──────────────
  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setMonth(expiresAt.getMonth() + 6);
  const expiresAtISO = expiresAt.toISOString();

  const eventInserts = [];
  const customerUpdates = [];
  const notFoundEmails = [];

  for (const email of uniqueEmails) {
    const customer = customerByEmail[email];
    if (!customer) {
      notFoundEmails.push(email);
      continue;
    }

    const pts = emailPointsMap[email];
    const isPositive = pts > 0;

    eventInserts.push({
      shop_id: shopRow.id,
      customer_id: customer.id,
      event_type: "Earn",
      points: pts,
      remaining_points: isPositive ? Math.abs(pts) : 0,
      expires_at: isPositive ? expiresAtISO : null,
    });

    const newRedeemable =
      (customer.redeemable_points || 0) + (isPositive ? pts : 0);
    const newLifetime =
      (customer.lifetime_points || 0) + (isPositive ? pts : 0);
    const newTier = getTier(newLifetime);

    customerUpdates.push({
      id: customer.id,
      redeemable_points: newRedeemable,
      lifetime_points: newLifetime,
      tier: newTier,
    });
  }

  // ── Bulk insert all events (1 INSERT) ────────────────────────────────────────
  let eventsInserted = 0;
  let eventsErrors = 0;

  if (eventInserts.length > 0) {
    const { error: evErr } = await supabase
      .from("events")
      .insert(eventInserts);

    if (evErr) {
      console.error("[award_bulk] Events insert error:", evErr);
      eventsErrors = eventInserts.length;
    } else {
      eventsInserted = eventInserts.length;
    }
  }

  // ── Parallel customer updates (chunks of 50) ─────────────────────────────────
  // Each chunk fires all updates simultaneously via Promise.all.
  const UPDATE_CHUNK = 50;
  let customersUpdated = 0;
  let customerErrors = 0;

  for (let i = 0; i < customerUpdates.length; i += UPDATE_CHUNK) {
    const chunk = customerUpdates.slice(i, i + UPDATE_CHUNK);

    const results = await Promise.all(
      chunk.map(({ id, redeemable_points, lifetime_points, tier }) =>
        supabase
          .from("customers")
          .update({ redeemable_points, lifetime_points, tier })
          .eq("id", id)
      )
    );

    for (const { error } of results) {
      if (error) {
        console.error("[award_bulk] Customer update error:", error);
        customerErrors++;
      } else {
        customersUpdated++;
      }
    }
  }

  console.log(
    `[award_bulk] Done. events_inserted=${eventsInserted}, customers_updated=${customersUpdated}, ` +
      `customers_created=${missingEmails.length}, not_found=${notFoundEmails.length}, ` +
      `ev_errors=${eventsErrors}, cust_errors=${customerErrors}`
  );

  return new Response(
    JSON.stringify({
      success: true,
      total_input: rows.length,
      valid_rows: validRows.length,
      unique_emails: uniqueEmails.length,
      customers_created: missingEmails.length,
      customers_updated: customersUpdated,
      events_inserted: eventsInserted,
      not_found: notFoundEmails.length,
      invalid_rows: invalidRows.length,
      errors: eventsErrors + customerErrors,
      invalid: invalidRows.length > 0 ? invalidRows : undefined,
    }),
    { status: 200, headers: corsHeaders }
  );
};
