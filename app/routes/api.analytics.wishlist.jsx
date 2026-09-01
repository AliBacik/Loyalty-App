import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setDate(defaultFrom.getDate() - 30);
  const fromParam = url.searchParams.get("from") || defaultFrom.toISOString().split("T")[0];
  const toParam = url.searchParams.get("to") || now.toISOString().split("T")[0];
  // "logged" = registered customers (default), "guest" = non-logged visitors
  const customerType = url.searchParams.get("customerType") || "logged";

  const fromISO = new Date(fromParam).toISOString();
  const toDate = new Date(toParam);
  toDate.setHours(23, 59, 59, 999);
  const toISO = toDate.toISOString();

  // Get shop
  const { data: shopData } = await supabase
    .from("shops")
    .select("id")
    .eq("shopify_domain", session.shop)
    .single();

  if (!shopData) {
    return new Response(JSON.stringify({ error: "Shop not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (customerType === "guest") {
    return loadGuestAnalytics(shopData.id, fromISO, toISO);
  }

  // All queries in parallel — logged customers
  const [
    { data: productRows },
    { data: variantRows },
    { data: categoryRows },
    { count: totalItems },
    { data: customerIdRows },
    { data: trendRows },
    { data: conversionRows },
  ] = await Promise.all([
    // Top products
    supabase.from("wishlist_items").select("product_title, product_handle")
      .eq("shop_id", shopData.id).gte("added_at", fromISO).lte("added_at", toISO)
      .not("product_title", "is", null),

    // Top variants
    supabase.from("wishlist_items").select("variant_gid, variant_title, product_title")
      .eq("shop_id", shopData.id).gte("added_at", fromISO).lte("added_at", toISO),

    // Categories
    supabase.from("wishlist_items").select("product_type")
      .eq("shop_id", shopData.id).gte("added_at", fromISO).lte("added_at", toISO)
      .not("product_type", "is", null),

    // Total items in period
    supabase.from("wishlist_items").select("id", { count: "exact", head: true })
      .eq("shop_id", shopData.id).gte("added_at", fromISO).lte("added_at", toISO),

    // Customer IDs in period — fetch to count unique in JS (Supabase has no COUNT DISTINCT)
    supabase.from("wishlist_items").select("customer_id")
      .eq("shop_id", shopData.id).gte("added_at", fromISO).lte("added_at", toISO),

    // Trend: added_at timestamps
    supabase.from("wishlist_items").select("added_at")
      .eq("shop_id", shopData.id).gte("added_at", fromISO).lte("added_at", toISO),

    // Conversion data
    supabase.from("wishlist_items")
      .select("product_title, product_handle, variant_gid, variant_title, converted_at, added_at")
      .eq("shop_id", shopData.id).gte("added_at", fromISO).lte("added_at", toISO),
  ]);

  const totalCustomers = new Set((customerIdRows || []).map(r => r.customer_id)).size;

  // ── Aggregate products ───────────────────────────────────────────────────────
  const productMap = {};
  for (const row of (productRows || [])) {
    const key = row.product_handle || row.product_title || "Unknown";
    if (!productMap[key]) {
      productMap[key] = { name: row.product_title || key, count: 0, productHandle: row.product_handle };
    }
    productMap[key].count++;
  }
  const topProducts = Object.values(productMap)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // ── Aggregate variants ───────────────────────────────────────────────────────
  const variantMap = {};
  for (const row of (variantRows || [])) {
    const key = row.variant_gid;
    if (!variantMap[key]) {
      variantMap[key] = {
        name: row.product_title ? `${row.product_title} – ${row.variant_title}` : (row.variant_title || key),
        shortName: row.variant_title || key,
        productTitle: row.product_title,
        count: 0,
      };
    }
    variantMap[key].count++;
  }
  const topVariants = Object.values(variantMap)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // ── Aggregate categories ─────────────────────────────────────────────────────
  const categoryMap = {};
  for (const row of (categoryRows || [])) {
    const cat = (row.product_type && row.product_type.trim()) || "Other";
    categoryMap[cat] = (categoryMap[cat] || 0) + 1;
  }
  const topCategories = Object.entries(categoryMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  // ── Daily trend ──────────────────────────────────────────────────────────────
  // Fill every day in the range with 0, then count
  const dayMap = {};
  const cursor = new Date(fromISO);
  const end = new Date(toISO);
  while (cursor <= end) {
    dayMap[cursor.toISOString().split("T")[0]] = 0;
    cursor.setDate(cursor.getDate() + 1);
  }
  for (const row of (trendRows || [])) {
    const day = row.added_at.split("T")[0];
    if (day in dayMap) dayMap[day]++;
  }
  const dailyTrend = Object.entries(dayMap)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // ── Day-of-week distribution ──────────────────────────────────────────────────
  const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dowMap = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const row of (trendRows || [])) {
    const dow = new Date(row.added_at).getDay();
    dowMap[dow]++;
  }
  const dowDistribution = DOW_LABELS.map((name, i) => ({ name, count: dowMap[i] }));

  // ── Avg wishlist size (all-time: total items / unique customers) ─────────────
  const avgWishlistSize = (totalCustomers && totalItems)
    ? Math.round((totalItems / totalCustomers) * 10) / 10
    : 0;

  // ── Conversion metrics ────────────────────────────────────────────────────────
  const rows = conversionRows || [];
  const totalConverted = rows.filter(r => r.converted_at).length;
  const conversionRate = rows.length > 0
    ? Math.round((totalConverted / rows.length) * 1000) / 10  // one decimal %
    : 0;

  // Avg dwell time: days between added_at → converted_at (converted items only)
  const dwellTimes = rows
    .filter(r => r.converted_at && r.added_at)
    .map(r => (new Date(r.converted_at) - new Date(r.added_at)) / (1000 * 60 * 60 * 24));
  const avgDwellDays = dwellTimes.length > 0
    ? Math.round(dwellTimes.reduce((a, b) => a + b, 0) / dwellTimes.length)
    : null;

  // Top converted products
  const convertedProductMap = {};
  const neverConvertedProductMap = {};
  for (const row of rows) {
    const key = row.product_handle || row.product_title || "Unknown";
    const name = row.product_title || key;
    if (row.converted_at) {
      convertedProductMap[key] = convertedProductMap[key] || { name, count: 0 };
      convertedProductMap[key].count++;
    } else {
      neverConvertedProductMap[key] = neverConvertedProductMap[key] || { name, count: 0 };
      neverConvertedProductMap[key].count++;
    }
  }

  // Most wished but never purchased (high wishlist, 0 conversions)
  // Only include products that have 0 conversions at all
  const convertedKeys = new Set(Object.keys(convertedProductMap));
  const mostWishedNeverBought = Object.entries(neverConvertedProductMap)
    .filter(([key]) => !convertedKeys.has(key))
    .map(([, v]) => v)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const topConvertedProducts = Object.values(convertedProductMap)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return new Response(JSON.stringify({
    topProducts,
    topVariants,
    topCategories,
    dailyTrend,
    dowDistribution,
    totalWishlistItems: totalItems || 0,
    totalCustomersWithWishlists: totalCustomers,
    avgWishlistSize,
    totalConverted,
    conversionRate,
    avgDwellDays,
    topConvertedProducts,
    mostWishedNeverBought,
  }), {
    headers: { "Content-Type": "application/json" },
  });
};

// ── Guest analytics ───────────────────────────────────────────────────────────
// Shows ALL guest "added" events regardless of sync status.
// Synced (converted_customer_id IS NOT NULL) items are still counted in the main
// metrics but also surfaced separately in the "synced to account" section.
async function loadGuestAnalytics(shopId, fromISO, toISO) {
  const [
    { data: allAddedRows },
    { data: variantRows },
    { data: categoryRows },
    { data: trendRows },
    { data: syncedRows },
  ] = await Promise.all([
    // All "added" events in range — no IS NULL filter, synced items stay visible
    supabase.from("guest_wishlist_events")
      .select("product_title, product_handle, session_id, converted_customer_id")
      .eq("shop_id", shopId).eq("action", "added")
      .gte("created_at", fromISO).lte("created_at", toISO),

    supabase.from("guest_wishlist_events")
      .select("variant_gid, variant_title, product_title")
      .eq("shop_id", shopId).eq("action", "added")
      .gte("created_at", fromISO).lte("created_at", toISO),

    supabase.from("guest_wishlist_events")
      .select("product_type")
      .eq("shop_id", shopId).eq("action", "added")
      .gte("created_at", fromISO).lte("created_at", toISO)
      .not("product_type", "is", null),

    supabase.from("guest_wishlist_events")
      .select("created_at")
      .eq("shop_id", shopId).eq("action", "added")
      .gte("created_at", fromISO).lte("created_at", toISO),

    // Synced events: join with customers table to get email + sync timestamp
    supabase.from("guest_wishlist_events")
      .select("session_id, product_title, product_handle, variant_title, variant_gid, created_at, converted_customer_id, customers(email)")
      .eq("shop_id", shopId).eq("action", "added")
      .not("converted_customer_id", "is", null)
      .gte("created_at", fromISO).lte("created_at", toISO)
      .order("created_at", { ascending: false }),
  ]);

  const allAdded = allAddedRows || [];
  const totalItems = allAdded.length;

  const uniqueSessions = new Set(allAdded.map(r => r.session_id));
  const totalSessions = uniqueSessions.size;
  const avgWishlistSize = totalSessions > 0
    ? Math.round((totalItems / totalSessions) * 10) / 10
    : 0;

  // Top products (all — active + synced)
  const productMap = {};
  for (const row of allAdded) {
    if (!row.product_title) continue;
    const key = row.product_handle || row.product_title;
    if (!productMap[key]) productMap[key] = { name: row.product_title, count: 0, productHandle: row.product_handle };
    productMap[key].count++;
  }
  const topProducts = Object.values(productMap).sort((a, b) => b.count - a.count).slice(0, 20);

  // Top variants
  const variantMap = {};
  for (const row of (variantRows || [])) {
    const key = row.variant_gid;
    if (!variantMap[key]) variantMap[key] = {
      name: row.product_title ? `${row.product_title} – ${row.variant_title}` : (row.variant_title || key),
      shortName: row.variant_title || key,
      productTitle: row.product_title,
      count: 0,
    };
    variantMap[key].count++;
  }
  const topVariants = Object.values(variantMap).sort((a, b) => b.count - a.count).slice(0, 20);

  // Categories
  const categoryMap = {};
  for (const row of (categoryRows || [])) {
    const cat = (row.product_type && row.product_type.trim()) || "Other";
    categoryMap[cat] = (categoryMap[cat] || 0) + 1;
  }
  const topCategories = Object.entries(categoryMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  // Daily trend (all events)
  const dayMap = {};
  const cursor = new Date(fromISO);
  const end = new Date(toISO);
  while (cursor <= end) {
    dayMap[cursor.toISOString().split("T")[0]] = 0;
    cursor.setDate(cursor.getDate() + 1);
  }
  for (const row of (trendRows || [])) {
    const day = row.created_at.split("T")[0];
    if (day in dayMap) dayMap[day]++;
  }
  const dailyTrend = Object.entries(dayMap)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Day-of-week
  const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dowMap = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const row of (trendRows || [])) {
    dowMap[new Date(row.created_at).getDay()]++;
  }
  const dowDistribution = DOW_LABELS.map((name, i) => ({ name, count: dowMap[i] }));

  // Sync metrics
  const syncedItems = syncedRows || [];
  const syncedSessionIds = new Set(syncedItems.map(r => r.session_id));
  const totalSynced = syncedSessionIds.size; // unique sessions that logged in
  const syncRate = totalSessions > 0
    ? Math.round((totalSynced / totalSessions) * 1000) / 10
    : 0;

  // Synced events detail list for the table (deduplicated per session+product)
  const seenSyncedKeys = new Set();
  const syncedDetail = [];
  for (const row of syncedItems) {
    const k = `${row.session_id}|${row.product_handle || row.product_title}`;
    if (seenSyncedKeys.has(k)) continue;
    seenSyncedKeys.add(k);
    syncedDetail.push({
      productTitle: row.product_title || "—",
      productHandle: row.product_handle || null,
      variantTitle: row.variant_title || null,
      variantGid: row.variant_gid || null,
      email: row.customers?.email || null,
      sessionId: row.session_id || null,
      syncedAt: row.created_at,
    });
  }

  return new Response(JSON.stringify({
    topProducts,
    topVariants,
    topCategories,
    dailyTrend,
    dowDistribution,
    totalWishlistItems: totalItems,
    totalCustomersWithWishlists: totalSessions,
    avgWishlistSize,
    // Guest-specific sync fields (used instead of conversion fields in guest mode)
    totalSynced,
    syncRate,
    syncedDetail,
    // Keep these keys so shared frontend code doesn't break
    totalConverted: totalSynced,
    conversionRate: syncRate,
    avgDwellDays: null,
    topConvertedProducts: [],
    mostWishedNeverBought: [],
  }), {
    headers: { "Content-Type": "application/json" },
  });
}
