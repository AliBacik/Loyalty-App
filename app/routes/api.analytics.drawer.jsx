import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const metric = url.searchParams.get("metric");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  if (!metric || !from || !to) {
    return json({ error: "Missing metric, from, or to params" }, { status: 400 });
  }

  const { data: shopData } = await supabase
    .from("shops")
    .select("id")
    .eq("shopify_domain", session.shop)
    .single();

  if (!shopData) {
    return json({ error: "Shop not found" }, { status: 404 });
  }

  const fromISO = new Date(from).toISOString();
  // "to" datini günün sonuna kadar dahil et
  const toDate = new Date(to);
  toDate.setHours(23, 59, 59, 999);
  const toISO = toDate.toISOString();

  // ── Activated Accounts ──────────────────────────────────────────────────────
  if (metric === "activated_accounts") {
    const { data: customers, error } = await supabase
      .from("customers")
      .select("email, status_changed_timestamp, tier, redeemable_points")
      .eq("shop_id", shopData.id)
      .eq("status", "active")
      .not("status_changed_timestamp", "is", null)
      .gte("status_changed_timestamp", fromISO)
      .lte("status_changed_timestamp", toISO)
      .order("status_changed_timestamp", { ascending: false });

    if (error) return json({ error: error.message }, { status: 500 });
    return json({ customers: customers || [] });
  }

  // ── Used Discount Codes ──────────────────────────────────────────────────────
  if (metric === "used_codes") {
    // Heavy API ile aynı sorgu formatı — tutarlı sayım için
    const queryString = `created_at:>='${from}T00:00:00' created_at:<='${to}T23:59:59' discount_code:LOYALTY*`;

    let allOrders = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
      const response = await admin.graphql(
        `query GetLoyaltyOrders($query: String!, $cursor: String) {
          orders(first: 250, query: $query, sortKey: CREATED_AT, reverse: true, after: $cursor) {
            edges {
              cursor
              node {
                id
                createdAt
                totalPriceSet { shopMoney { amount currencyCode } }
                customer { email }
                discountApplications(first: 10) {
                  edges {
                    node {
                      ... on DiscountCodeApplication { code }
                    }
                  }
                }
              }
            }
            pageInfo { hasNextPage }
          }
        }`,
        { variables: { query: queryString, cursor } }
      );

      const result = await response.json();
      if (result.errors) break;

      const edges = result?.data?.orders?.edges || [];
      allOrders = allOrders.concat(edges);
      hasNextPage = result?.data?.orders?.pageInfo?.hasNextPage || false;
      cursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;
    }

    const customers = allOrders.map(({ node: order }) => {
      const discounts = order.discountApplications?.edges || [];
      const loyaltyDiscount = discounts.find(({ node }) =>
        node.code && node.code.startsWith("LOYALTY")
      );
      return {
        email: order.customer?.email || "(no email)",
        discount_code: loyaltyDiscount?.node?.code || "",
        order_value: parseFloat(order.totalPriceSet?.shopMoney?.amount || "0"),
        created_at: order.createdAt,
      };
    });

    return json({ customers });
  }

  // ── Point Gift metrics ──────────────────────────────────────────────────────
  if (metric.startsWith("gift_")) {
    const giftKey = metric.slice(5); // strip "gift_"

    // Direct gifts: stored as events (event_type=Earn, event_desc=giftKey)
    const directGiftKeys = ['join', 'birthdayadded', 'instagram', 'tiktok'];

    if (directGiftKeys.includes(giftKey)) {
      const { data: rows, error } = await supabase
        .from("events")
        .select("customers(email), created_at")
        .eq("shop_id", shopData.id)
        .eq("event_type", "Earn")
        .eq("event_desc", giftKey)
        .gte("created_at", fromISO)
        .lte("created_at", toISO)
        .order("created_at", { ascending: false });

      if (error) return json({ error: error.message }, { status: 500 });

      const customers = (rows || []).map(r => ({
        email: r.customers?.email || "(no email)",
        created_at: r.created_at,
      }));
      return json({ customers });
    }

    // Pending gifts: stored in customer_pending_rewards (gift_key=giftKey)
    const { data: rows, error } = await supabase
      .from("customer_pending_rewards")
      .select("email, created_at")
      .eq("shop_id", shopData.id)
      .eq("gift_key", giftKey)
      .gte("created_at", fromISO)
      .lte("created_at", toISO)
      .order("created_at", { ascending: false });

    if (error) return json({ error: error.message }, { status: 500 });

    const customers = (rows || []).map(r => ({
      email: r.email || "(no email)",
      created_at: r.created_at,
    }));
    return json({ customers });
  }

  return json({ error: "Unknown metric" }, { status: 400 });
};
