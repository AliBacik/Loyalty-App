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

// Called by guest-wishlist-sync.liquid when a guest logs in.
// Stamps converted_customer_id on all guest events for this session
// so analytics can show the guest→customer funnel without deleting rows.
export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: corsHeaders });
  }

  const { shop, sessionId, customerId } = body;

  if (!shop || !sessionId || !customerId) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: shop, sessionId, customerId" }),
      { status: 400, headers: corsHeaders }
    );
  }

  const { data: shopData, error: shopError } = await supabase
    .from("shops")
    .select("id")
    .eq("shopify_domain", shop)
    .single();

  if (shopError || !shopData) {
    return new Response(JSON.stringify({ error: "Shop not found" }), { status: 404, headers: corsHeaders });
  }

  const numericCustomerId = String(customerId).replace("gid://shopify/Customer/", "");

  const { data: loyaltyCustomer } = await supabase
    .from("customers")
    .select("id")
    .eq("shopify_customer_id", numericCustomerId)
    .eq("shop_id", shopData.id)
    .single();

  if (!loyaltyCustomer) {
    // Customer not in loyalty DB yet — skip silently, not a hard error
    return new Response(JSON.stringify({ success: true, skipped: true }), { status: 200, headers: corsHeaders });
  }

  const { error: updateError } = await supabase
    .from("guest_wishlist_events")
    .update({ converted_customer_id: loyaltyCustomer.id })
    .eq("session_id", sessionId)
    .eq("shop_id", shopData.id)
    .is("converted_customer_id", null);

  if (updateError) {
    console.error("[guest-wishlist-convert] update error:", updateError.message);
    return new Response(JSON.stringify({ error: "DB error" }), { status: 500, headers: corsHeaders });
  }

  return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
};
