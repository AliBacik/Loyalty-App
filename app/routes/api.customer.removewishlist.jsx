import { supabase } from "../supabase.server";

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
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }

  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: corsHeaders });
    }

    const { shop, customerId, variantId } = body;
    if (!shop || !customerId || !variantId) {
      return new Response(JSON.stringify({ error: "Missing required fields: shop, customerId, variantId" }), { status: 400, headers: corsHeaders });
    }

    // 1. Get shop access token
    const { data: loyaltyShop, error: supabaseError } = await supabase
      .from("shops")
      .select("access_token")
      .eq("shopify_domain", shop)
      .single();

    if (supabaseError || !loyaltyShop?.access_token) {
      return new Response(JSON.stringify({ error: "Shop not found or no access token", detail: supabaseError?.message }), { status: 404, headers: corsHeaders });
    }

    // Normalize IDs to GID
    const customerGid = String(customerId).startsWith("gid://") ? String(customerId) : `gid://shopify/Customer/${customerId}`;
    const variantGid = String(variantId).startsWith("gid://") ? String(variantId) : `gid://shopify/ProductVariant/${variantId}`;

    const graphql = async (query, variables) => {
      const res = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": loyaltyShop.access_token,
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.status.toString());
        throw new Error(`Shopify API HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return res.json();
    };

    // 2. Fetch existing wishlist metafield
    const getMetafieldQuery = `
      query GetCustomerWishlist($customerId: ID!) {
        customer(id: $customerId) {
          id
          metafield(namespace: "custom", key: "wishlist") {
            id
            value
          }
        }
      }
    `;

    const metafieldResult = await graphql(getMetafieldQuery, { customerId: customerGid });
    if (metafieldResult.errors?.length) {
      return new Response(JSON.stringify({ error: "GraphQL errors fetching customer", details: metafieldResult.errors }), { status: 502, headers: corsHeaders });
    }

    const customerData = metafieldResult.data?.customer;
    if (!customerData) {
      return new Response(JSON.stringify({ error: "Customer not found in Shopify" }), { status: 404, headers: corsHeaders });
    }

    // 3. Parse existing list
    let wishlist = [];
    const rawMeta = customerData.metafield?.value;
    if (rawMeta) {
      try {
        const parsed = JSON.parse(rawMeta);
        if (Array.isArray(parsed)) wishlist = parsed.map(String);
      } catch {
        wishlist = String(rawMeta).split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
      }
      wishlist = wishlist.map((v) => (String(v).startsWith("gid://") ? String(v) : `gid://shopify/ProductVariant/${String(v)}`));
      wishlist = Array.from(new Set(wishlist));
    }

    // 4. Remove the variant if present
    const index = wishlist.indexOf(variantGid);
    if (index === -1) {
      return new Response(JSON.stringify({ success: true, action: "not_found", message: "Variant not in wishlist", wishlist }), { status: 200, headers: corsHeaders });
    }
    wishlist.splice(index, 1);

    // 5. Upsert metafield with updated array
    const upsertMutation = `
      mutation UpsertWishlist($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key value }
          userErrors { field message }
        }
      }
    `;

    const upsertResult = await graphql(upsertMutation, {
      metafields: [
        {
          ownerId: customerGid,
          namespace: "custom",
          key: "wishlist",
          type: "list.single_line_text_field",
          value: JSON.stringify(wishlist),
        },
      ],
    });

    if (upsertResult.errors?.length) {
      return new Response(JSON.stringify({ error: "GraphQL errors upserting metafield", details: upsertResult.errors }), { status: 502, headers: corsHeaders });
    }

    const userErrors = upsertResult.data?.metafieldsSet?.userErrors;
    if (userErrors?.length) {
      return new Response(JSON.stringify({ error: "Metafield update failed", details: userErrors }), { status: 500, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ success: true, action: "removed", variantId: variantGid, wishlist }), { status: 200, headers: corsHeaders });
  } catch (err) {
    console.error("[removewishlist] Unhandled error:", err);
    return new Response(JSON.stringify({ error: "Internal server error", detail: err?.message }), { status: 500, headers: corsHeaders });
  }
};
