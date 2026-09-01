import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

/**
 * GET /api/analytics/ltv
 *
 * Calculates average lifetime value per tier by batch-querying
 * Shopify for each loyalty member's total amountSpent.
 */
export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  const { data: shopData } = await supabase
    .from("shops")
    .select("id")
    .eq("shopify_domain", session.shop)
    .single();

  if (!shopData) return json({ error: "Shop not found" }, { status: 404 });

  // Fetch all loyalty members with shopify_customer_id and tier (paginated)
  const PAGE_SIZE = 2000;
  let allMembers = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("customers")
      .select("shopify_customer_id, tier")
      .eq("shop_id", shopData.id)
      .eq("status", "active")
      .not("shopify_customer_id", "is", null)
      .range(from, from + PAGE_SIZE - 1);

    if (error || !data || data.length === 0) break;
    allMembers.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  if (allMembers.length === 0) {
    return json({ avg_ltv_by_tier: {}, total_members: 0 });
  }

  // Batch-query Shopify for customer amountSpent (50 per request)
  const BATCH_SIZE = 50;
  const tierSpend = {};
  const tierCount = {};

  for (let i = 0; i < allMembers.length; i += BATCH_SIZE) {
    const batch = allMembers.slice(i, i + BATCH_SIZE);
    const fields = batch
      .map((c, idx) => {
        const gid = `gid://shopify/Customer/${c.shopify_customer_id}`;
        return `c${idx}: customer(id: "${gid}") { amountSpent { amount } }`;
      })
      .join("\n");

    const query = `query LTVBatch { ${fields} }`;

    try {
      const response = await admin.graphql(query);
      const result = await response.json();

      if (result.data) {
        for (let j = 0; j < batch.length; j++) {
          const cData = result.data[`c${j}`];
          if (!cData) continue;
          const spend = parseFloat(cData.amountSpent?.amount || "0");
          const tier = batch[j].tier || "Circle";
          tierSpend[tier] = (tierSpend[tier] || 0) + spend;
          tierCount[tier] = (tierCount[tier] || 0) + 1;
        }
      }
    } catch (e) {
      console.error("[LTV] Shopify batch error:", e);
    }
  }

  const avg_ltv_by_tier = {};
  for (const tier of Object.keys(tierSpend)) {
    avg_ltv_by_tier[tier] =
      Math.round((tierSpend[tier] / tierCount[tier]) * 100) / 100;
  }

  return json({ avg_ltv_by_tier, total_members: allMembers.length, tier_counts: tierCount });
};
