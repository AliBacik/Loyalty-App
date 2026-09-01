import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import { json } from "@remix-run/node";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const emailFilter = url.searchParams.get("email") || "";
  const customerId = url.searchParams.get("customerId") || "";

  // Get shop
  const { data: shopData } = await supabase
    .from("shops")
    .select("id")
    .eq("shopify_domain", session.shop)
    .single();

  if (!shopData) {
    return json({ error: "Shop not found" }, { status: 404 });
  }

  // ── Detail mode: return wishlist items for a specific customer ────────────
  if (customerId) {
    const { data: items } = await supabase
      .from("wishlist_items")
      .select("product_title, variant_title, image_url, price, properties, added_at, item_key, product_handle, variant_gid")
      .eq("customer_id", customerId)
      .eq("shop_id", shopData.id)
      .order("added_at", { ascending: false });

    return json({ items: items || [] });
  }

  // ── List mode: customers who have wishlist items ───────────────────────────

  // 1. Get all wishlist_items for this shop (customer_id + added_at)
  const { data: wishlistRows, error: wlError } = await supabase
    .from("wishlist_items")
    .select("customer_id, added_at")
    .eq("shop_id", shopData.id)
    .order("added_at", { ascending: false });

  if (wlError) return json({ error: wlError.message }, { status: 500 });

  // Build per-customer aggregates
  const customerMap = {};
  for (const row of (wishlistRows || [])) {
    const cid = row.customer_id;
    if (!customerMap[cid]) {
      customerMap[cid] = { id: cid, itemCount: 0, lastAdded: row.added_at };
    }
    customerMap[cid].itemCount++;
  }

  const customerIds = Object.keys(customerMap);
  if (customerIds.length === 0) return json({ customers: [] });

  // 2. Fetch emails for those customer IDs, with optional email filter
  let custQuery = supabase
    .from("customers")
    .select("id, email")
    .in("id", customerIds);

  if (emailFilter) {
    custQuery = custQuery.ilike("email", `%${emailFilter}%`);
  }

  const { data: custRows } = await custQuery;

  // 3. Merge
  const customers = (custRows || [])
    .map(c => ({
      id: c.id,
      email: c.email,
      itemCount: customerMap[c.id]?.itemCount || 0,
      lastAdded: customerMap[c.id]?.lastAdded || null,
    }))
    .sort((a, b) => (b.lastAdded || "").localeCompare(a.lastAdded || ""));

  return json({ customers });
};
