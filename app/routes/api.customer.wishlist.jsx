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

    const { shop, customerId, variantId, properties, image, email: bodyEmail, itemKey: clientItemKey } = body;

    if (!shop || !customerId || !variantId) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: shop, customerId, variantId" }),
        { status: 400, headers: corsHeaders }
      );
    }

    // Build a composite key: variantGid + sorted properties fingerprint.
    // This allows the same variant with different properties (e.g. different
    // AI charm prompt or different birthstone selection) to be stored as
    // separate wishlist entries.
    function makeItemKey(gid, props) {
      if (!props || typeof props !== "object" || !Object.keys(props).length) return gid;
      // Exclude internal/image properties — only user-visible selections form the key
      const excluded = ['_Charm Image', '_Your Image URL'];
      const filtered = Object.keys(props).filter(k => !excluded.includes(k));
      if (!filtered.length) return gid;
      const sorted = filtered.sort().map(k => `${k}=${props[k]}`).join("&");
      return `${gid}|${sorted}`;
    }

    // 1. Get shop
    const { data: loyaltyShop, error: shopError } = await supabase
      .from("shops")
      .select("id, access_token, klaviyo_enabled, storefront_url")
      .eq("shopify_domain", shop)
      .single();

    if (shopError || !loyaltyShop) {
      return new Response(
        JSON.stringify({ error: "Shop not found", detail: shopError?.message }),
        { status: 404, headers: corsHeaders }
      );
    }

    const customerGid = customerId.startsWith("gid://")
      ? customerId
      : `gid://shopify/Customer/${customerId}`;
    const variantGid = variantId.startsWith("gid://")
      ? variantId
      : `gid://shopify/ProductVariant/${variantId}`;

    const numericCustomerId = customerGid.replace("gid://shopify/Customer/", "");

    // 2. Get loyalty customer
    let { data: loyaltyCustomer, error: customerError } = await supabase
      .from("customers")
      .select("id, email")
      .eq("shopify_customer_id", numericCustomerId)
      .eq("shop_id", loyaltyShop.id)
      .single();

    if (customerError) {
      console.warn("[wishlist] Customer lookup error:", customerError.message);
    }

    // Headless storefronts reach wishlist before any loyalty flow has created the
    // customer row, and the customers/create webhook only covers signups from now
    // on — so create the row on demand rather than rejecting the request.
    //
    // Restricted to stores that are NOT enrolled in the shared Klaviyo account
    // (currently only the headless store). On Eternate an INSERT here would fire
    // trg_customer_status_notify and email a "Customer Registered" event for a
    // customer who merely saved a wishlist item, so it keeps the old 404.
    const autoCreateCustomer = loyaltyShop.klaviyo_enabled === false;

    if (!loyaltyCustomer && autoCreateCustomer) {
      const { data: createdCustomer, error: createError } = await supabase
        .from("customers")
        .insert({
          shop_id: loyaltyShop.id,
          shopify_customer_id: numericCustomerId,
          email: bodyEmail || null,
          tier: "Circle",
          status: "pending",
          redeemable_points: 0,
          lifetime_points: 0,
        })
        .select("id, email")
        .single();

      if (createError || !createdCustomer) {
        console.error("[wishlist] Failed to create customer:", createError?.message);
        return new Response(
          JSON.stringify({ error: "Customer not found" }),
          { status: 404, headers: corsHeaders }
        );
      }

      loyaltyCustomer = createdCustomer;
      console.log("[wishlist] Created customer row for", numericCustomerId);
    }

    if (!loyaltyCustomer) {
      return new Response(
        JSON.stringify({ error: "Customer not found" }),
        { status: 404, headers: corsHeaders }
      );
    }

    // item_key = variantGid + sorted properties fingerprint.
    // If the client sent a pre-computed key, convert its numeric variant prefix to GID format.
    // Otherwise compute it from variantGid + properties.
    let itemKey;
    if (clientItemKey) {
      // clientItemKey is numeric-based: "47713409335447" or "47713409335447|prop=val"
      // DB stores GID-based: "gid://shopify/ProductVariant/47713409335447|prop=val"
      const pipeIdx = clientItemKey.indexOf("|");
      const numericPart = pipeIdx === -1 ? clientItemKey : clientItemKey.slice(0, pipeIdx);
      const suffix = pipeIdx === -1 ? "" : clientItemKey.slice(pipeIdx);
      const gidPart = numericPart.startsWith("gid://") ? numericPart : `gid://shopify/ProductVariant/${numericPart}`;
      itemKey = gidPart + suffix;
    } else {
      itemKey = makeItemKey(variantGid, properties);
    }

    // 3. Check if already in wishlist
    const { data: existing } = await supabase
      .from("wishlist_items")
      .select("id")
      .eq("customer_id", loyaltyCustomer.id)
      .eq("item_key", itemKey)
      .eq("shop_id", loyaltyShop.id)
      .single();

    let toggleAction;

    if (existing) {
      // Remove
      const { error: deleteError } = await supabase
        .from("wishlist_items")
        .delete()
        .eq("customer_id", loyaltyCustomer.id)
        .eq("item_key", itemKey)
        .eq("shop_id", loyaltyShop.id);

      if (deleteError) {
        console.error("[wishlist] Supabase delete error:", deleteError.message);
      } else {
        console.log("[wishlist] ✅ Removed — item_key:", itemKey);
      }
      toggleAction = "removed";
    } else {
      // Add — fetch variant details from Shopify
      let variantDetails = null;
      if (loyaltyShop.access_token) {
        try {
          const res = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": loyaltyShop.access_token,
            },
            body: JSON.stringify({
              query: `query GetVariantDetail($id: ID!) {
                node(id: $id) {
                  ... on ProductVariant {
                    title price
                    image { url }
                    product { title handle productType images(first: 1) { edges { node { url } } } }
                  }
                }
              }`,
              variables: { id: variantGid },
            }),
          });
          const data = await res.json();
          const node = data?.data?.node;
          if (node) {
            const variantImg = node.image?.url || null;
            const productImg = node.product?.images?.edges?.[0]?.node?.url || null;
            variantDetails = {
              variant_title: node.title || null,
              price: node.price ? parseFloat(node.price) : null,
              image_url: image || variantImg || productImg || null,
              product_title: node.product?.title || null,
              product_handle: node.product?.handle || null,
              product_type: node.product?.productType || null,
            };
          }
        } catch (e) {
          console.warn("[wishlist] Could not fetch variant details:", e?.message);
        }
      }

      const { error: upsertError } = await supabase.from("wishlist_items").upsert({
        shop_id: loyaltyShop.id,
        customer_id: loyaltyCustomer.id,
        variant_gid: variantGid,
        item_key: itemKey,
        ...variantDetails,
        ...(properties && typeof properties === "object" ? { properties } : {}),
      }, { onConflict: "customer_id,item_key" });

      if (upsertError) {
        console.error("[wishlist] Supabase upsert error:", upsertError.message);
      } else {
        console.log("[wishlist] ✅ Added — variant:", variantGid);

        // Klaviyo — honour the per-shop flag so a store can be onboarded without
        // its customers appearing in the shared Klaviyo account.
        const klaviyoApiKey = process.env.KLAVIYO_API_KEY;
        const klaviyoEnabled = loyaltyShop.klaviyo_enabled !== false;

        // Headless stores (Hydrogen) serve products from their own domain, not
        // <shop>.myshopify.com — fall back to the myshopify host when unset.
        const storefrontBase = loyaltyShop.storefront_url || `https://${shop}`;

        if (klaviyoApiKey && klaviyoEnabled && loyaltyCustomer.email) {
          try {
            const { data: allItems } = await supabase
              .from("wishlist_items")
              .select("variant_gid, product_title, variant_title, product_handle, product_type, price, image_url")
              .eq("customer_id", loyaltyCustomer.id)
              .eq("shop_id", loyaltyShop.id);

            const items = (allItems || []).map(item => ({
              variant_gid: item.variant_gid,
              product_title: item.product_title,
              variant_title: item.variant_title,
              product_handle: item.product_handle,
              product_type: item.product_type,
              price: item.price ?? null,
              image_url: item.image_url ?? null,
              product_url: item.product_handle ? `${storefrontBase}/products/${item.product_handle}` : null,
            }));

            await fetch("https://a.klaviyo.com/api/events/", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Klaviyo-API-Key ${klaviyoApiKey}`,
                revision: "2023-12-15",
              },
              body: JSON.stringify({
                data: {
                  type: "event",
                  attributes: {
                    metric: { data: { type: "metric", attributes: { name: "Wishlist Updated" } } },
                    profile: { data: { type: "profile", attributes: { email: loyaltyCustomer.email } } },
                    properties: {
                      item_count: items.length,
                      items,
                      added_variant_gid: variantGid,
                      added_product_title: variantDetails?.product_title || null,
                      added_product_url: variantDetails?.product_handle
                        ? `${storefrontBase}/products/${variantDetails.product_handle}`
                        : null,
                    },
                    time: new Date().toISOString(),
                  },
                },
              }),
            });
          } catch (e) {
            console.warn("[wishlist] Klaviyo exception:", e?.message);
          }
        }
      }
      toggleAction = "added";
    }

    return new Response(
      JSON.stringify({ success: true, action: toggleAction, variantId: variantGid }),
      { status: 200, headers: corsHeaders }
    );
  } catch (err) {
    console.error("[wishlist] Unhandled error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error", detail: err?.message }),
      { status: 500, headers: corsHeaders }
    );
  }
};
