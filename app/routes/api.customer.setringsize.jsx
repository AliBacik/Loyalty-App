import { supabase } from "../supabase.server";

// CORS Headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// Handle CORS preflight (OPTIONS)
export const loader = async () => {
  return new Response(null, { headers: corsHeaders });
};

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }

  try {
    const { customerId, value, shop } = await request.json();

    if (!customerId || value === undefined || !shop) {
      return new Response(JSON.stringify({ error: "Missing required fields: customerId, value, shop" }), { status: 400, headers: corsHeaders });
    }

    // 1. Get Shop and access token
    const { data: loyaltyShop } = await supabase
      .from("shops")
      .select("access_token")
      .eq("shopify_domain", shop)
      .single();

    if (!loyaltyShop?.access_token) {
      return new Response(JSON.stringify({ error: "Shop not found or no access token" }), { status: 404, headers: corsHeaders });
    }

    // 2. Set metafield on customer in Shopify
    const mutation = `
      mutation SetCustomerMetafield($customerId: ID!, $namespace: String!, $key: String!, $value: String!, $type: String!) {
        customerUpdate(input: {
          id: $customerId
          metafields: {
            namespace: $namespace
            key: $key
            value: $value
            type: $type
          }
        }) {
          customer {
            id
            metafields(first: 1) {
              edges {
                node {
                  namespace
                  key
                  value
                }
              }
            }
          }
          userErrors {
            field
            message
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
        query: mutation,
        variables: {
          customerId: `gid://shopify/Customer/${customerId}`,
          namespace: "loyalty_program",
          key: "ring_size",
          value: value.toString(),
          type: "single_line_text_field",
        },
      }),
    });

    const result = await response.json();

    if (result.errors || result.data?.customerUpdate?.userErrors?.length > 0) {
      console.error("Shopify error:", result.errors || result.data?.customerUpdate?.userErrors);
      return new Response(
        JSON.stringify({ error: "Failed to set metafield", details: result.errors || result.data?.customerUpdate?.userErrors }),
        { status: 400, headers: corsHeaders }
      );
    }

    console.log(`✅ Ring size set for customer ${customerId}: ${value}`);

    return new Response(
      JSON.stringify({ success: true, message: "Ring size updated", value }),
      { status: 200, headers: corsHeaders }
    );
  } catch (error) {
    console.error("❌ Error:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
};
