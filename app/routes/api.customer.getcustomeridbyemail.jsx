import { supabase } from "../supabase.server";

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

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const email = url.searchParams.get("email");

  if (!shop || !email) {
    return new Response(
      JSON.stringify({ error: "Missing required params: shop, email" }),
      { status: 400, headers: corsHeaders }
    );
  }

  // Get shop access token
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

  // Query Shopify Admin API for customer by email
  const query = `
    query FindCustomerByEmail($query: String!) {
      customers(first: 1, query: $query) {
        edges {
          node {
            id
            email
          }
        }
      }
    }
  `;

  const res = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": loyaltyShop.access_token,
    },
    body: JSON.stringify({ query, variables: { query: `email:${email}` } }),
  });

  if (!res.ok) {
    return new Response(
      JSON.stringify({ error: "Shopify API error", detail: res.status }),
      { status: 502, headers: corsHeaders }
    );
  }

  const json = await res.json();

  if (json.errors?.length) {
    return new Response(
      JSON.stringify({ error: "GraphQL error", details: json.errors }),
      { status: 502, headers: corsHeaders }
    );
  }

  const node = json.data?.customers?.edges?.[0]?.node;

  if (!node) {
    return new Response(
      JSON.stringify({ error: "Customer not found", email }),
      { status: 404, headers: corsHeaders }
    );
  }

  // Return both GID and numeric ID for convenience
  const gid = node.id; // e.g. "gid://shopify/Customer/123456"
  const numericId = gid.replace("gid://shopify/Customer/", "");

  return new Response(
    JSON.stringify({ success: true, customerId: numericId, customerGid: gid, email: node.email }),
    { status: 200, headers: corsHeaders }
  );
};
