import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const klaviyoApiKey = process.env.KLAVIYO_API_KEY;
  if (!klaviyoApiKey) {
    return json({ error: "Klaviyo API key not configured" }, { status: 500 });
  }

  const { data: shopRow } = await supabase
    .from("shops")
    .select("id, access_token")
    .eq("shopify_domain", shop)
    .single();

  if (!shopRow?.access_token) {
    return json({ error: "Shop access token not found" }, { status: 500 });
  }

  // Step 1: Supabase'den birthdayadded olan müşterileri çek
  const { data: supabaseCustomers, error } = await supabase
    .from("customers")
    .select("email, shopify_customer_id")
    .eq("shop_id", shopRow.id)
    .not("gifts->birthdayadded", "is", null);

  if (error) return json({ error: `Supabase error: ${error.message}` }, { status: 500 });
  if (!supabaseCustomers?.length) {
    return json({ sent: 0, failed: 0, message: "No customers with birthday today." });
  }

  // Step 2: Her müşteri için Shopify'dan birthday metafield çek, bugün olanları filtrele
  const now = new Date();
  const todayMonth = String(now.getMonth() + 1).padStart(2, "0");
  const todayDay = String(now.getDate()).padStart(2, "0");

  // Fetch name, email and the birthday metafield together via GraphQL.
  //
  // Two earlier approaches failed here:
  //   1. Two REST calls per customer at high concurrency blew past Shopify's 2 req/s REST
  //      limit; the 429s were swallowed by `return null`, so an unpredictable subset of
  //      customers silently never received their mail.
  //   2. The bulk REST /metafields.json endpoint only returns SHOP-level metafields — it
  //      ignores owner_resource=customer — so it found 1 metafield instead of ~272.
  //
  // GraphQL aliases pull 50 customers *and* their metafield per request. Failures retry and
  // then throw rather than quietly shrinking the recipient list.
  const withRetry = async (fn, label) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const throttled = /throttl|429|exceeded/i.test(e?.message || "");
        if (!throttled || attempt === 4) throw e;
        const waitMs = 500 * Math.pow(2, attempt);
        console.warn(`[birthday-klaviyo] ${label} throttled — retrying in ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw new Error(`${label} failed after retries`);
  };

  const enrolled = supabaseCustomers.filter((c) => c.shopify_customer_id);
  const todayCustomers = [];
  const BATCH = 50;

  for (let i = 0; i < enrolled.length; i += BATCH) {
    const batch = enrolled.slice(i, i + BATCH);
    const fields = batch
      .map(
        (c, idx) =>
          `c${idx}: customer(id: "gid://shopify/Customer/${c.shopify_customer_id}") { id firstName lastName email metafield(namespace: "loyalty_program", key: "birthday") { value } }`,
      )
      .join("\n");

    const gqlJson = await withRetry(async () => {
      const res = await admin.graphql(`query BatchCustomers { ${fields} }`);
      const body = await res.json();
      if (body?.errors?.length) {
        throw new Error(body.errors.map((e) => e.message).join("; "));
      }
      return body;
    }, `batch ${i / BATCH + 1}`);

    batch.forEach((c, j) => {
      const cData = gqlJson?.data?.[`c${j}`];
      const birthday = cData?.metafield?.value;
      if (!birthday) return;

      const parts = String(birthday).split("-");
      if (parts.length !== 3) return;
      const [, month, day] = parts;
      if (month !== todayMonth || day !== todayDay) return;

      const email = cData?.email || c.email || "";
      if (!email) return;

      todayCustomers.push({
        email,
        firstName: cData?.firstName || "",
        lastName: cData?.lastName || "",
        birthday,
      });
    });
  }

  console.log(
    `[birthday-klaviyo] enrolled: ${enrolled.length}, due today: ${todayCustomers.length}`,
  );

  if (todayCustomers.length === 0) {
    return json({ sent: 0, failed: 0, message: "No customers with birthday today." });
  }

  // Step 3: Klaviyo'ya event gönder
  let sent = 0;
  let failed = 0;
  const errors = [];

  // Stable per-day key so re-running the same day stays idempotent in Klaviyo,
  // while each customer still gets their own distinct event.
  const todayKey = `${now.getFullYear()}-${todayMonth}-${todayDay}`;

  await Promise.all(
    todayCustomers.map(async (c) => {
      try {
        const payload = {
          data: {
            type: "event",
            attributes: {
              metric: {
                data: { type: "metric", attributes: { name: "Birthday Mail" } },
              },
              profile: {
                data: { type: "profile", attributes: { email: c.email } },
              },
              properties: {
                first_name: c.firstName,
                last_name: c.lastName,
                birthday: c.birthday,
              },
              // Without a unique_id Klaviyo collapses same-metric events that share a
              // timestamp — Promise.all fires these in the same millisecond, so only
              // the first customer's event survived. Key it per customer + day.
              unique_id: `birthday-${todayKey}-${c.email.toLowerCase()}`,
              time: new Date().toISOString(),
            },
          },
        };

        const res = await fetch("https://a.klaviyo.com/api/events/", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Klaviyo-API-Key ${klaviyoApiKey}`,
            "revision": "2023-12-15",
          },
          body: JSON.stringify(payload),
        });

        if (res.ok || res.status === 202) {
          console.log(`[birthday-klaviyo] Sent to ${c.email} (${res.status})`);
          sent++;
        } else {
          const txt = await res.text().catch(() => "");
          console.error(`[birthday-klaviyo] Failed for ${c.email}: ${res.status} ${txt}`);
          errors.push({ email: c.email, status: res.status, error: txt.slice(0, 300) });
          failed++;
        }
      } catch (e) {
        console.error(`[birthday-klaviyo] Exception for ${c.email}:`, e);
        errors.push({ email: c.email, error: e?.message || String(e) });
        failed++;
      }
    })
  );

  console.log(`[birthday-klaviyo] Done — sent: ${sent}, failed: ${failed}, total: ${todayCustomers.length}`);

  return json({
    sent,
    failed,
    total: todayCustomers.length,
    recipients: todayCustomers.map((c) => c.email),
    errors,
  });
};
