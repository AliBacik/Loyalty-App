import { supabase } from "../supabase.server";

// CORS Headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("customerId");
    const shop = url.searchParams.get("shop");

    if (!customerId || !shop) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: customerId, shop" }),
        { status: 400, headers: corsHeaders }
      );
    }

    const { data: loyaltyShop } = await supabase
      .from("shops")
      .select("id")
      .eq("shopify_domain", shop)
      .single();

    if (!loyaltyShop?.id) {
      return new Response(
        JSON.stringify({ error: "Shop not found" }),
        { status: 404, headers: corsHeaders }
      );
    }

    const { data: customer } = await supabase
      .from("customers")
      .select("id, status")
      .eq("shopify_customer_id", customerId)
      .eq("shop_id", loyaltyShop.id)
      .single();

    if (!customer) {
      return new Response(
        JSON.stringify({ success: true, status: null, exists: false }),
        { status: 200, headers: corsHeaders }
      );
    }

    return new Response(
      JSON.stringify({ success: true, status: customer.status || null, exists: true }),
      { status: 200, headers: corsHeaders }
    );
  } catch (error) {
    console.error("❌ Error in api.customer.status:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
};
