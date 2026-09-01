import { supabase } from "../supabase.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export const loader = async ({ request }) => {
  try {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const shop = url.searchParams.get("shop");
    const customerId = url.searchParams.get("customerId");

    if (!shop || !customerId) {
      return new Response(
        JSON.stringify({ error: "Missing required params: shop, customerId" }),
        { status: 400, headers: corsHeaders }
      );
    }

    // 1. Get shop
    const { data: loyaltyShop } = await supabase
      .from("shops")
      .select("id")
      .eq("shopify_domain", shop)
      .single();

    if (!loyaltyShop) {
      return new Response(
        JSON.stringify({ error: "Shop not found" }),
        { status: 404, headers: corsHeaders }
      );
    }

    // 2. Get loyalty customer
    const customerGid = customerId.startsWith("gid://")
      ? customerId
      : `gid://shopify/Customer/${customerId}`;
    const numericCustomerId = customerGid.replace("gid://shopify/Customer/", "");

    const { data: loyaltyCustomer } = await supabase
      .from("customers")
      .select("id")
      .eq("shopify_customer_id", numericCustomerId)
      .eq("shop_id", loyaltyShop.id)
      .single();

    if (!loyaltyCustomer) {
      return new Response(
        JSON.stringify({ success: true, customerId: customerGid, wishlist: [], count: 0 }),
        { status: 200, headers: corsHeaders }
      );
    }

    // 3. Fetch wishlist items from Supabase
    const { data: wishlistItems, error } = await supabase
      .from("wishlist_items")
      .select("variant_gid, item_key, product_title, variant_title, product_handle, product_type, price, image_url, added_at, properties")
      .eq("customer_id", loyaltyCustomer.id)
      .eq("shop_id", loyaltyShop.id)
      .order("added_at", { ascending: false });

    if (error) {
      console.error("[getwishlist] Supabase error:", error.message);
      return new Response(
        JSON.stringify({ error: "Database error", detail: error.message }),
        { status: 500, headers: corsHeaders }
      );
    }

    const wishlist = (wishlistItems || []).map(item => {
      const numericId = item.variant_gid.replace("gid://shopify/ProductVariant/", "");
      // item_key is stored as GID-based in DB: "gid://shopify/ProductVariant/123|prop=val"
      // Frontend uses numeric-based keys: "123|prop=val" — strip the GID prefix
      const rawKey = item.item_key || item.variant_gid;
      const numericKey = rawKey.replace("gid://shopify/ProductVariant/", "");
      return {
        addedAt: item.added_at || null,
        variantId: numericId,
        itemKey: numericKey,
        variantTitle: item.variant_title || null,
        variantImage: item.image_url || null,
        price: item.price || null,
        productHandle: item.product_handle || null,
        productTitle: item.product_title || null,
        productUrl: item.product_handle ? `https://${shop}/products/${item.product_handle}` : null,
        properties: item.properties || null,
      };
    });

    return new Response(
      JSON.stringify({ success: true, customerId: customerGid, wishlist, count: wishlist.length }),
      { status: 200, headers: corsHeaders }
    );
  } catch (err) {
    console.error("[getwishlist] Unhandled error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error", detail: err?.message }),
      { status: 500, headers: corsHeaders }
    );
  }
};
