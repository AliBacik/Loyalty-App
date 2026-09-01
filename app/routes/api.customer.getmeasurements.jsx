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

    // 1. Get Shop and access token
    const { data: loyaltyShop } = await supabase
      .from("shops")
      .select("access_token")
      .eq("shopify_domain", shop)
      .single();

    if (!loyaltyShop?.access_token) {
      return new Response(
        JSON.stringify({ error: "Shop not found or no access token" }),
        { status: 404, headers: corsHeaders }
      );
    }

    // 2. Get customer metafields from Shopify
    const query = `
      query GetCustomerMetafields($customerId: ID!) {
        customer(id: $customerId) {
          id
          metafields(namespace: "loyalty_program", first: 10) {
            edges {
              node {
                key
                value
              }
            }
          }
        }
      }
    `;

    const response = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": loyaltyShop.access_token,
      },
      body: JSON.stringify({
        query,
        variables: {
          customerId: `gid://shopify/Customer/${customerId}`,
        },
      }),
    });

    const result = await response.json();

    if (result.errors) {
      console.error("Shopify error:", result.errors);
      return new Response(
        JSON.stringify({ error: "Failed to fetch metafields", details: result.errors }),
        { status: 400, headers: corsHeaders }
      );
    }

    // 3. Parse metafields
    const metafields = result.data?.customer?.metafields?.edges || [];
    const data = {
      braceletLength: null,
      ringSize: null,
      necklaceLength: null,
    };

    metafields.forEach(({ node }) => {
      if (node.key === "bracelet_length") {
        data.braceletLength = node.value;
      } else if (node.key === "ring_size") {
        data.ringSize = node.value;
      } else if (node.key === "necklace_length") {
        data.necklaceLength = node.value;
      }
    });

    console.log(`✅ Customer measurements fetched for ${customerId}:`, data);

    return new Response(
      JSON.stringify({ success: true, ...data }),
      { status: 200, headers: corsHeaders }
    );
  } catch (error) {
    console.error("❌ Error:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
};
