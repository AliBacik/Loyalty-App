import { supabase } from "../supabase.server";

// CORS headers and preflight handler
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
  const headers = corsHeaders;

  // Require a key param for safety (use your CRON_SECRET)
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (key !== process.env.CRON_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers });
  }

  const { shop, customerId, email } = body;
  if (!shop || !customerId || !email) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: shop, customerId, email" }),
      { status: 400, headers }
    );
  }

  console.log("-----------------------------------------");
  console.log("🧪 TEST API: CUSTOMER_CREATE");
  console.log(`📧 Email: ${email}`);
  console.log(`🆔 Customer ID: ${customerId}`);
  console.log(`🏪 Shop: ${shop}`);

  try {
    // 1. Find Shop
    const { data: loyaltyShop, error: shopError } = await supabase
      .from("shops")
      .select("id")
      .eq("shopify_domain", shop)
      .single();

    if (shopError || !loyaltyShop) {
      console.error("❌ DB ERROR: Could not find shop.", shopError);
      return new Response(
        JSON.stringify({ error: "Shop not found", details: shopError }),
        { status: 404, headers }
      );
    }

    console.log(`✅ Shop Found: ${loyaltyShop.id}`);

    // 2. Create/Update Customer (same logic as webhooks.customers.create.jsx)
    const { data, error: upsertError } = await supabase
      .from("customers")
      .upsert(
        {
          shop_id: loyaltyShop.id,
          shopify_customer_id: customerId,
          email: email,
          tier: "Circle",
          status: "pending", 
        },
        { onConflict: "shop_id, shopify_customer_id" }
      )
      .select();

    if (upsertError) {
      console.error("❌ DB UPSERT ERROR:", upsertError);
      return new Response(
        JSON.stringify({ error: "Failed to create/update customer", details: upsertError }),
        { status: 500, headers }
      );
    }

    console.log("✅ SUCCESS! Customer enrolled (Active).");
    console.log("📊 Customer Data:", data);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Customer created/updated successfully",
        customer: data[0],
      }),
      { status: 200, headers }
    );
  } catch (error) {
    console.error("🔥 CRITICAL ERROR:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: error.message }),
      { status: 500, headers }
    );
  }
};
