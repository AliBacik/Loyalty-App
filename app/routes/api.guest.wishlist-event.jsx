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

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: corsHeaders });
  }

  const { shop, sessionId, variantId, itemKey: clientItemKey, action: eventAction,
          productTitle, variantTitle, productHandle, productType,
          price, image, properties } = body;

  if (!shop || !sessionId || !variantId || !eventAction) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: shop, sessionId, variantId, action" }),
      { status: 400, headers: corsHeaders }
    );
  }

  if (!["added", "removed"].includes(eventAction)) {
    return new Response(JSON.stringify({ error: "action must be 'added' or 'removed'" }), { status: 400, headers: corsHeaders });
  }

  const { data: shopData, error: shopError } = await supabase
    .from("shops")
    .select("id")
    .eq("shopify_domain", shop)
    .single();

  if (shopError || !shopData) {
    return new Response(JSON.stringify({ error: "Shop not found" }), { status: 404, headers: corsHeaders });
  }

  const variantGid = variantId.startsWith("gid://")
    ? variantId
    : `gid://shopify/ProductVariant/${variantId}`;

  // Build item_key (same logic as the logged-in endpoint)
  let itemKey;
  if (clientItemKey) {
    const pipeIdx = clientItemKey.indexOf("|");
    const numericPart = pipeIdx === -1 ? clientItemKey : clientItemKey.slice(0, pipeIdx);
    const suffix = pipeIdx === -1 ? "" : clientItemKey.slice(pipeIdx);
    const gidPart = numericPart.startsWith("gid://") ? numericPart : `gid://shopify/ProductVariant/${numericPart}`;
    itemKey = gidPart + suffix;
  } else {
    itemKey = variantGid;
  }

  const { error: insertError } = await supabase
    .from("guest_wishlist_events")
    .insert({
      shop_id:       shopData.id,
      session_id:    sessionId,
      variant_gid:   variantGid,
      item_key:      itemKey,
      action:        eventAction,
      product_title: productTitle || null,
      variant_title: variantTitle || null,
      product_handle: productHandle || null,
      product_type:  productType || null,
      price:         price ? parseFloat(price) : null,
      image_url:     image || null,
      properties:    (properties && typeof properties === "object") ? properties : null,
    });

  if (insertError) {
    console.error("[guest-wishlist-event] insert error:", insertError.message);
    return new Response(JSON.stringify({ error: "DB error" }), { status: 500, headers: corsHeaders });
  }

  return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
};
