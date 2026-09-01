import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  if (!fromParam || !toParam) {
    return json({ error: "Missing date parameters" }, { status: 400 });
  }

  const { data: shopData } = await supabase
    .from("shops")
    .select("*")
    .eq("shopify_domain", session.shop)
    .single();

  if (!shopData) {
    return json({ error: "Shop not found" }, { status: 404 });
  }

  try {
    // Fetch member emails for AOV calculation
    const { data: memberEmailRows } = await supabase
      .from("customers")
      .select("email")
      .eq("shop_id", shopData.id)
      .eq("status", "active");

    const memberEmailSet = new Set(
      (memberEmailRows || []).map(r => (r.email || "").toLowerCase().trim()).filter(Boolean)
    );

    let usedCodeCount = 0;
    let totalValue = 0;
    let memberOrderTotal = 0, memberOrderCount = 0;
    let nonMemberOrderTotal = 0, nonMemberOrderCount = 0;

    // Fetch all orders in date range (for AOV)
    let hasNextPageAllOrders = true;
    let cursorAllOrders = null;
    while (hasNextPageAllOrders) {
      const allOrdersQuery = `
        query GetAllOrders($query: String!, $cursor: String) {
          orders(first: 250, query: $query, sortKey: CREATED_AT, reverse: true, after: $cursor) {
            edges {
              cursor
              node {
                id
                totalPriceSet { shopMoney { amount currencyCode } }
                customer { email }
              }
            }
            pageInfo { hasNextPage }
          }
        }
      `;
      const response = await admin.graphql(allOrdersQuery, {
        variables: { query: `created_at:>='${fromParam}' created_at:<='${toParam}'`, cursor: cursorAllOrders },
      });
      const result = await response.json();
      if (result.errors) {
        console.error("[Analytics Heavy] GraphQL errors (all orders):", result.errors);
        break;
      }

      const edges = result?.data?.orders?.edges || [];
      for (const { node: order } of edges) {
        const email = (order.customer?.email || "").toLowerCase().trim();
        const value = parseFloat(order.totalPriceSet?.shopMoney?.amount || "0");
        if (email && memberEmailSet.has(email)) {
          memberOrderTotal += value;
          memberOrderCount++;
        } else {
          nonMemberOrderTotal += value;
          nonMemberOrderCount++;
        }
      }

      hasNextPageAllOrders = result?.data?.orders?.pageInfo?.hasNextPage || false;
      cursorAllOrders = edges.length > 0 ? edges[edges.length - 1].cursor : null;
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    // Fetch only orders with LOYALTY discount codes
    const loyaltyQueryString = `created_at:>='${fromParam}T00:00:00' created_at:<='${toParam}T23:59:59' discount_code:LOYALTY*`;

    let hasNextPageLoyalty = true;
    let cursorLoyalty = null;
    while (hasNextPageLoyalty) {
      const response = await admin.graphql(`
        query GetLoyaltyOrders($query: String!, $cursor: String) {
          orders(first: 250, query: $query, sortKey: CREATED_AT, reverse: true, after: $cursor) {
            edges {
              cursor
              node {
                id
                totalPriceSet { shopMoney { amount currencyCode } }
              }
            }
            pageInfo { hasNextPage }
          }
        }
      `, { variables: { query: loyaltyQueryString, cursor: cursorLoyalty } });

      const result = await response.json();
      if (result.errors) {
        console.error("[Analytics Heavy] GraphQL errors (loyalty orders):", result.errors);
        break;
      }

      const edges = result?.data?.orders?.edges || [];
      for (const { node: order } of edges) {
        usedCodeCount++;
        const value = parseFloat(order.totalPriceSet?.shopMoney?.amount || "0");
        totalValue += value;
      }

      hasNextPageLoyalty = result?.data?.orders?.pageInfo?.hasNextPage || false;
      cursorLoyalty = edges.length > 0 ? edges[edges.length - 1].cursor : null;
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    return json({
      used_codes: usedCodeCount,
      total_order_value: Math.round(totalValue * 100) / 100,
      aov_members: memberOrderCount > 0 ? Math.round((memberOrderTotal / memberOrderCount) * 100) / 100 : 0,
      aov_non_members: nonMemberOrderCount > 0 ? Math.round((nonMemberOrderTotal / nonMemberOrderCount) * 100) / 100 : 0,
    });
  } catch (e) {
    console.error("[Analytics Heavy] Error:", e);
    return json({ error: "Failed to calculate heavy metrics" }, { status: 500 });
  }
};
