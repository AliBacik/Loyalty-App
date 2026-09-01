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
    const contentType = request.headers.get('content-type') || '';
    let body = {};
    if (contentType.indexOf('application/json') > -1) {
      body = await request.json();
    } else {
      // support form-encoded fallback
      const form = await request.formData();
      body.customerId = form.get('customerId');
      body.shop = form.get('shop');
      body.tags = form.get('tags');
    }

    const { customerId, shop, tags } = body;

    if (!customerId || !shop || tags === undefined) {
      return new Response(JSON.stringify({ error: "Missing required fields: customerId, shop, tags" }), { status: 400, headers: corsHeaders });
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

    // 2. Prepare tags array (comma-separated string -> array)
    const tagsArr = String(tags).split(',').map(s => s.trim()).filter(Boolean);

    // 3. Update customer tags via GraphQL
    const mutation = `
      mutation UpdateCustomerTags($customerId: ID!, $tags: [String!]) {
        customerUpdate(input: { id: $customerId, tags: $tags }) {
          customer { id tags }
          userErrors { field message }
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
          tags: tagsArr,
        },
      }),
    });

    const result = await response.json();

    if (result.errors || result.data?.customerUpdate?.userErrors?.length > 0) {
      console.error('Shopify error:', result.errors || result.data?.customerUpdate?.userErrors);
      return new Response(JSON.stringify({ error: 'Failed to update tags', details: result.errors || result.data?.customerUpdate?.userErrors }), { status: 400, headers: corsHeaders });
    }

    console.log(`✅ Customer tags updated for ${customerId}:`, tagsArr);

    return new Response(JSON.stringify({ success: true, tags: result.data.customerUpdate.customer.tags }), { status: 200, headers: corsHeaders });
  } catch (error) {
    console.error('❌ Error:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
};
