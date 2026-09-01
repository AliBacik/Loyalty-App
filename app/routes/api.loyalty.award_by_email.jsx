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
  // Auth: prefer admin session (cookie), fallback to CRON key or Bearer
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  const authHeader = request.headers.get("Authorization");

  let shop = null;
  let isAuthenticated = false;
  let body = null;

  // 1) Try admin session (cookie-based)
  try {
    const { session } = await authenticate.admin(request);
    if (session?.shop) {
      shop = session.shop;
      isAuthenticated = true;
    }
  } catch (e) {
    // ignore; we'll try other auth methods
  }

  // 2) If not authenticated via session, accept CRON_SECRET key
  if (!isAuthenticated && key === process.env.CRON_SECRET && process.env.CRON_SECRET) {
    try {
      body = await request.json();
      shop = body.shop;
      isAuthenticated = true;
    } catch (e) {}
  }

  // 3) If still not authenticated, support Bearer token flow
  if (!isAuthenticated && authHeader?.startsWith("Bearer ")) {
    try {
      const { session } = await authenticate.admin(request);
      shop = session?.shop;
      isAuthenticated = !!shop;
    } catch (e) { console.error('auth failed', e); }
  }

  if (!isAuthenticated || !shop) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  }

  if (!body) {
    try { body = await request.json(); } catch (e) { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: corsHeaders }); }
  }

  const { email, points, gift } = body;

  if (!email || points === undefined || points === null) {
    return new Response(JSON.stringify({ error: 'Missing required fields: email, points' }), { status: 400, headers: corsHeaders });
  }

  const pts = Number(points);
  if (Number.isNaN(pts)) return new Response(JSON.stringify({ error: 'Points must be a number' }), { status: 400, headers: corsHeaders });

  const eventDesc = gift ? String(gift).toLowerCase() : null;

  // Find shop row
  const { data: shopRow } = await supabase.from('shops').select('id').eq('shopify_domain', shop).single();
  if (!shopRow) return new Response(JSON.stringify({ error: 'Shop not found' }), { status: 404, headers: corsHeaders });

  // Find or create customer in customers table
  const { data: existingCustomer } = await supabase.from('customers').select('id,email,redeemable_points,lifetime_points,shopify_customer_id,tier').eq('email', email).eq('shop_id', shopRow.id).single();

  let customer = existingCustomer;
  if (!customer) {
    const insert = await supabase.from('customers').insert({
      shop_id: shopRow.id,
      email: email,
      redeemable_points: 0,
      lifetime_points: 0,
      // shopify_customer_id removed: will be set when customer registers/syncs
      tier: 'Circle'
    }).select().single();

    if (insert.error) {
      console.error('Failed to create customer', insert.error);
      return new Response(JSON.stringify({ error: 'Failed to create customer' }), { status: 500, headers: corsHeaders });
    }
    customer = insert.data;
  }

  // Create Earn event for redeemable points
  const isPositive = pts > 0;
  let expiresAt = null;
  let remainingPoints = 0;
  if (isPositive) {
    const d = new Date(); d.setMonth(d.getMonth() + 6); expiresAt = d.toISOString(); remainingPoints = Math.abs(pts);
  }

  const { error: evErr } = await supabase.from('events').insert({
    shop_id: shopRow.id,
    customer_id: customer.id,
    event_type: 'Earn',
    points: pts,
    remaining_points: remainingPoints,
    expires_at: expiresAt,
    event_desc: eventDesc,
  }).select();

  if (evErr) {
    console.error('[award_by_email] Failed to insert event', evErr);
    return new Response(JSON.stringify({ error: 'Failed to create event' }), { status: 500, headers: corsHeaders });
  }

  console.log('[award_by_email] ✅ Event created successfully.');

  // Update customer's redeemable_points and lifetime_points
  const newRedeemable = (customer.redeemable_points || 0) + (pts > 0 ? pts : 0);
  const newLifetime = (customer.lifetime_points || 0) + (pts > 0 ? pts : 0);

  await supabase
    .from('customers')
    .update({ 
      redeemable_points: newRedeemable,
      lifetime_points: newLifetime
    })
    .eq('id', customer.id);

  console.log(`[award_by_email] Updated points: redeemable=${newRedeemable}, lifetime=${newLifetime}`);

  // Check for tier upgrade based on lifetime points
  const { data: freshCustomer } = await supabase
    .from('customers')
    .select('lifetime_points, tier')
    .eq('id', customer.id)
    .single();

  let newTier = freshCustomer?.tier || 'Circle';
  const lifetimePoints = freshCustomer?.lifetime_points || 0;

  if (lifetimePoints >= 2500) {
    newTier = 'Legacy Circle';
  } else if (lifetimePoints >= 1000) {
    newTier = 'Inner Circle';
  } else {
    newTier = 'Circle';
  }

  if (newTier !== freshCustomer?.tier) {
    await supabase
      .from('customers')
      .update({ tier: newTier })
      .eq('id', customer.id);
    console.log(`[award_by_email] 🎉 TIER UPGRADE: ${freshCustomer?.tier} → ${newTier} (lifetime: ${lifetimePoints})`);
  }

  // Read final state
  const { data: finalCustomer } = await supabase
    .from('customers')
    .select('redeemable_points, lifetime_points, tier')
    .eq('id', customer.id)
    .single();

  console.log('[award_by_email] Final customer state:', finalCustomer);

  return new Response(JSON.stringify({ 
    success: true, 
    customerId: customer.id, 
    email: customer.email, 
    redeemable_points: finalCustomer?.redeemable_points || 0, 
    lifetime_points: finalCustomer?.lifetime_points || 0,
    tier: finalCustomer?.tier || 'Circle'
  }), { status: 200, headers: corsHeaders });
};
