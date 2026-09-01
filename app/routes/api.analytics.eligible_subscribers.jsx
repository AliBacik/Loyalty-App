import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

/**
 * GET /api/analytics/eligible_subscribers
 *
 * Returns customers who:
 *  1. Have at least one unused discount code in Supabase (discount_codes array is non-empty)
 *  2. Are subscribed to email marketing on Shopify
 */
export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  const { data: shopData } = await supabase
    .from("shops")
    .select("id")
    .eq("shopify_domain", session.shop)
    .single();

  if (!shopData) {
    return json({ error: "Shop not found" }, { status: 404 });
  }

  // Step 1: Get all Supabase customers that have at least one discount code
  // Supabase may limit rows per request (e.g. 2000). Page through results to collect all customers.
  const PAGE_SIZE = 2000;
  let dbCustomers = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("customers")
      .select("id, email, shopify_customer_id, discount_codes, tier, redeemable_points, status")
      .eq("shop_id", shopData.id)
      // Ensure discount_codes is not null AND not an empty array at the DB level
      .not("discount_codes", "is", null)
      .neq("discount_codes", "{}")
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      return json({ error: error.message }, { status: 500 });
    }

    if (!data || data.length === 0) break;

    dbCustomers.push(...data);

    if (data.length < PAGE_SIZE) break; // last page
    from += PAGE_SIZE;
  }

  // Filter to those with at least one code in the array
  const withCodes = (dbCustomers || []).filter(
    (c) => Array.isArray(c.discount_codes) && c.discount_codes.length > 0
  );

  if (withCodes.length === 0) {
    return json({ customers: [] });
  }

  // Step 2: Batch-check Shopify email marketing consent using field aliases (20 per request)
  const BATCH_SIZE = 20;
  const subscribedEmails = new Set();

  for (let i = 0; i < withCodes.length; i += BATCH_SIZE) {
    const batch = withCodes.slice(i, i + BATCH_SIZE);

    const fields = batch
      .map((c, idx) => {
        const gid = `gid://shopify/Customer/${c.shopify_customer_id}`;
        return `
        c${idx}: customer(id: "${gid}") {
          id
          email
          emailMarketingConsent {
            marketingState
          }
        }`;
      })
      .join("\n");

    const query = `query BatchEmailConsent { ${fields} }`;

    try {
      const response = await admin.graphql(query);
      const result = await response.json();

      if (result.data) {
        for (const key of Object.keys(result.data)) {
          const customer = result.data[key];
          if (!customer) continue;
          const state = customer.emailMarketingConsent?.marketingState;
          if (state === "SUBSCRIBED") {
            subscribedEmails.add((customer.email || "").toLowerCase().trim());
          }
        }
      }
    } catch (e) {
      console.error("[EligibleSubscribers] Shopify batch error:", e);
    }
  }

  // Step 3: Filter Supabase customers who are subscribed
  const eligible = withCodes.filter((c) =>
    subscribedEmails.has((c.email || "").toLowerCase().trim())
  );

  return json({ customers: eligible });
};
