import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

const MAX_PAGES = 40;

const getDaysUntil = (val) => {
  if (!val || !/^\d{4}-\d{2}-\d{2}$/.test(val)) return 999;
  const [, month, day] = val.split("-");
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thisYear = now.getFullYear();
  let next = new Date(thisYear, parseInt(month, 10) - 1, parseInt(day, 10));
  if (next < today) next = new Date(thisYear + 1, parseInt(month, 10) - 1, parseInt(day, 10));
  return Math.round((next - today) / (1000 * 60 * 60 * 24));
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const search = (url.searchParams.get("search") || "").trim().toLowerCase();
  const sortKey = url.searchParams.get("sort") || "upcoming";
  const sortDir = url.searchParams.get("dir") || "asc";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));

  // Get access token from Supabase
  const { data: shopRow } = await supabase
    .from("shops")
    .select("access_token")
    .eq("shopify_domain", shop)
    .single();

  if (!shopRow?.access_token) {
    return json({ error: "Shop access token not found" }, { status: 500 });
  }

  const accessToken = shopRow.access_token;
  const apiBase = `https://${shop}/admin/api/2025-01`;

  // Fetch all birthday metafields via REST — returns owner_id (customer numeric ID) + value
  // REST metafields endpoint supports filtering by namespace+key across all customers
  const allMetafields = [];
  let pageInfo = null;
  let pageCount = 0;

  while (pageCount < MAX_PAGES) {
    pageCount++;

    const params = new URLSearchParams({
      "metafield[owner_resource]": "customer",
      "metafield[namespace]": "loyalty_program",
      "metafield[key]": "birthday",
      limit: "250",
    });

    // Use page_info cursor if available, otherwise page number
    if (pageInfo) {
      params.set("page_info", pageInfo);
      params.delete("metafield[owner_resource]");
      params.delete("metafield[namespace]");
      params.delete("metafield[key]");
    }

    const res = await fetch(`${apiBase}/metafields.json?${params.toString()}`, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const txt = await res.text();
      console.error("[birthday-customers] REST error:", res.status, txt);
      return json({ error: `Shopify REST error: ${res.status}` }, { status: 500 });
    }

    const data = await res.json();
    const batch = data.metafields || [];
    allMetafields.push(...batch);

    // Check Link header for next page cursor
    const linkHeader = res.headers.get("Link") || "";
    const nextMatch = linkHeader.match(/<[^>]*[?&]page_info=([^>&"]+)[^>]*>;\s*rel="next"/);
    if (nextMatch && batch.length === 250) {
      pageInfo = nextMatch[1];
    } else {
      break;
    }
  }

  console.log(`[birthday-customers] Found ${allMetafields.length} birthday metafields via REST`);

  if (allMetafields.length === 0) {
    return json({ customers: [], totalCount: 0, totalPages: 1, page, todayCount: 0 });
  }

  // Build map: customer numeric ID → birthday value
  const birthdayMap = {};
  for (const mf of allMetafields) {
    if (mf.owner_id && mf.value) {
      birthdayMap[String(mf.owner_id)] = mf.value;
    }
  }

  // Fetch customer details for these IDs in batches via GraphQL
  const customerIds = Object.keys(birthdayMap);
  const allCustomers = [];
  const BATCH = 50;

  for (let i = 0; i < customerIds.length; i += BATCH) {
    const batch = customerIds.slice(i, i + BATCH);
    const fields = batch
      .map((id, idx) => `c${idx}: customer(id: "gid://shopify/Customer/${id}") { id firstName lastName email }`)
      .join("\n");

    const { admin } = await authenticate.admin(request);
    const gqlRes = await admin.graphql(`query BatchCustomers { ${fields} }`);
    const gqlJson = await gqlRes.json();

    if (gqlJson.data) {
      for (let j = 0; j < batch.length; j++) {
        const cData = gqlJson.data[`c${j}`];
        if (!cData) continue;
        const numericId = batch[j];
        allCustomers.push({
          id: cData.id,
          firstName: cData.firstName || "",
          lastName: cData.lastName || "",
          email: cData.email || "",
          birthday: birthdayMap[numericId],
        });
      }
    }
  }

  let filtered = allCustomers;
  if (search) {
    filtered = allCustomers.filter((c) =>
      c.email.toLowerCase().includes(search) ||
      c.firstName.toLowerCase().includes(search) ||
      c.lastName.toLowerCase().includes(search) ||
      c.birthday.includes(search)
    );
  }

  filtered.sort((a, b) => {
    let va, vb;
    if (sortKey === "upcoming" || sortKey === "birthday") {
      va = getDaysUntil(a.birthday);
      vb = getDaysUntil(b.birthday);
    } else if (sortKey === "email") {
      va = a.email.toLowerCase();
      vb = b.email.toLowerCase();
    } else {
      va = `${a.firstName} ${a.lastName}`.trim().toLowerCase();
      vb = `${b.firstName} ${b.lastName}`.trim().toLowerCase();
    }
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return sortDir === "desc" ? -cmp : cmp;
  });

  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / 50));
  const paginated = filtered.slice((page - 1) * 50, page * 50);
  const todayCount = allCustomers.filter((c) => getDaysUntil(c.birthday) === 0).length;

  return json({ customers: paginated, totalCount, totalPages, page, todayCount });
};
