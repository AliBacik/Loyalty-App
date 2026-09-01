import { authenticate } from "../shopify.server";
import { json } from "@remix-run/node";

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const { variantGids } = await request.json();

  if (!variantGids?.length) return json({ skus: {} });

  const skuMap = {};
  const priceMap = {};
  const productTitleMap = {};
  const BATCH = 250;

  for (let i = 0; i < variantGids.length; i += BATCH) {
    const batch = variantGids.slice(i, i + BATCH);
    const result = await admin.graphql(
      `#graphql
      query GetVariantSkus($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            sku
            price
            product {
              title
            }
          }
        }
      }`,
      { variables: { ids: batch } }
    );
    const data = await result.json();
    for (const node of data?.data?.nodes || []) {
      if (node?.id) {
        skuMap[node.id] = node.sku || "";
        priceMap[node.id] = node.price || "";
        productTitleMap[node.id] = node.product?.title || "";
      }
    }
  }

  return json({ skus: skuMap, prices: priceMap, productTitles: productTitleMap });
};
