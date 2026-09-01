import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export const loader = async ({ request }) => {
  // Handle CORS preflight before any auth — otherwise the OPTIONS request
  // gets caught by authenticate.admin and never returns the CORS headers.
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(request.url);
  const domainParam = url.searchParams.get("domain");
  const email = url.searchParams.get("email");
  const customerId = url.searchParams.get("customerId");
  const shopParam = url.searchParams.get("shop");

  // Public read-only endpoint — no admin session required when shop is provided
  // via query param (called from storefront). Fall back to admin session for
  // internal dashboard calls that don't pass shop explicitly.
  let domain = domainParam || shopParam || null;
  if (!domain) {
    try {
      const { session } = await authenticate.admin(request);
      domain = session?.shop || null;
    } catch (e) {
      // not an admin session — domain stays null
    }
  }
  if (!domain) return new Response(JSON.stringify({ error: "Provide domain (or be authenticated)" }), { status: 400, headers: corsHeaders });

  const { data: shopData, error: shopError } = await supabase
    .from("shops")
    .select("id")
    .eq("shopify_domain", domain)
    .single();

  if (shopError || !shopData) return new Response(JSON.stringify({ error: "Shop not found" }), { status: 404, headers: corsHeaders });
  if (!email && !customerId) return new Response(JSON.stringify({ error: "Provide email or customerId" }), { status: 400, headers: corsHeaders });

  let query = supabase
    .from("customers")
    .select("id,email,gifts")
    .eq("shop_id", shopData.id);

  if (customerId) {
    query = query.eq("id", customerId);
  } else {
    query = query.eq("email", email);
  }

  const { data: customer, error } = await query.single();
  if (error || !customer) return new Response(JSON.stringify({ error: "Customer not found" }), { status: 404, headers: corsHeaders });

  const gifts = customer.gifts || {};
  const enabledGifts = Object.keys(gifts).filter((k) => gifts[k] === true);

  return new Response(JSON.stringify({ ok: true, customer: { id: customer.id, email: customer.email }, gifts, enabledGifts }), { status: 200, headers: corsHeaders });
};
