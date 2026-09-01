import { supabase } from "../supabase.server";

// CORS Headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// Handle CORS preflight
export const loader = async () => {
  return new Response(null, { headers: corsHeaders });
};

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }

  try {
    const { customerId, shop, birthday, email } = await request.json();

    if ((!customerId && !email) || !shop || birthday === undefined) {
      return new Response(JSON.stringify({ error: "Missing required fields: (customerId or email), shop, birthday" }), { status: 400, headers: corsHeaders });
    }

    const { data: loyaltyShop } = await supabase
      .from("shops")
      .select("access_token,id")
      .eq("shopify_domain", shop)
      .single();

    if (!loyaltyShop?.access_token) {
      return new Response(JSON.stringify({ error: "Shop not found or no access token" }), { status: 404, headers: corsHeaders });
    }

    // If we don't have a customerId but have an email, look up the customer ID
    let resolvedCustomerId = customerId;
    if (!resolvedCustomerId && email) {
      const searchQuery = `
        query FindCustomerByEmail($query: String!) {
          customers(first:1, query: $query) { edges { node { id } } }
        }
      `;
      const qres = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": loyaltyShop.access_token,
        },
        body: JSON.stringify({ query: searchQuery, variables: { query: `email:${email}` } }),
      });
      const qjson = await qres.json();
      if (qjson.errors) {
        console.error('Shopify search error:', qjson.errors);
        return new Response(JSON.stringify({ error: 'Failed to lookup customer by email' }), { status: 400, headers: corsHeaders });
      }
      const node = qjson.data?.customers?.edges?.[0]?.node;
      if (node && node.id) resolvedCustomerId = node.id.replace('gid://shopify/Customer/','');
    }

    // Ensure we have a resolved customer id
    if (!resolvedCustomerId) {
      return new Response(JSON.stringify({ error: 'Customer not found for provided email' }), { status: 404, headers: corsHeaders });
    }

    // Build GID safely (if already a GID, use as-is)
    const customerGid = String(resolvedCustomerId).startsWith('gid://')
      ? String(resolvedCustomerId)
      : `gid://shopify/Customer/${resolvedCustomerId}`;

    // 2. Set customer metafield for birthday in namespace `loyalty_program`
    const mutation = `
      mutation SetBirthday($customerId: ID!, $namespace: String!, $key: String!, $value: String!, $type: String!) {
        customerUpdate(input: {
          id: $customerId
          metafields: {
            namespace: $namespace
            key: $key
            value: $value
            type: $type
          }
        }) {
          customer { id metafields(namespace: $namespace, first: 10) { edges { node { key value } } } }
          userErrors { field message }
        }
      }
    `;

    const updateRes = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": loyaltyShop.access_token,
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          customerId: customerGid,
          namespace: "loyalty_program",
          key: "birthday",
          value: String(birthday),
          type: "single_line_text_field",
        },
      }),
    });

    const updateJson = await updateRes.json();
    if (updateJson.errors || updateJson.data?.customerUpdate?.userErrors?.length > 0) {
      console.error('Shopify update error:', updateJson.errors || updateJson.data?.customerUpdate?.userErrors);
      return new Response(JSON.stringify({ error: 'Failed to set birthday metafield', details: updateJson.errors || updateJson.data?.customerUpdate?.userErrors }), { status: 400, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ success: true, message: 'Birthday updated', value: birthday }), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error('Error in setbirthday:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
};
