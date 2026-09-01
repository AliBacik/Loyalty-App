import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);

  const { data: shopData } = await supabase
    .from("shops")
    .select("id")
    .eq("shopify_domain", session.shop)
    .single();

  if (!shopData) {
    return json({ error: "Shop not found in database" }, { status: 404 });
  }

  const klaviyoApiKey = process.env.KLAVIYO_API_KEY;
  if (!klaviyoApiKey) {
    return json({ error: "Klaviyo API key not configured" }, { status: 400 });
  }

  // Step 1: Get the "Customer Status Changed" metric ID
  const metricsResponse = await fetch("https://a.klaviyo.com/api/metrics/", {
    headers: {
      Authorization: `Klaviyo-API-Key ${klaviyoApiKey}`,
      revision: "2024-10-15",
      Accept: "application/json",
    },
  });

  if (!metricsResponse.ok) {
    return json(
      { error: `Klaviyo metrics fetch failed: ${metricsResponse.status}` },
      { status: 500 }
    );
  }

  const metricsData = await metricsResponse.json();
  const statusChangedMetric = metricsData.data?.find(
    (m) => m.attributes?.name === "Customer Status Changed"
  );

  if (!statusChangedMetric) {
    return json(
      { error: 'Metric "Customer Status Changed" not found in Klaviyo' },
      { status: 404 }
    );
  }

  const metricId = statusChangedMetric.id;
  console.log("[SyncKlaviyo] Metric ID:", metricId);

  // Step 2: Fetch all events for this metric (all time), include profiles for emails
  const filterParam = `equals(metric_id,"${metricId}")`;
  const baseUrl = `https://a.klaviyo.com/api/events/?filter=${encodeURIComponent(
    filterParam
  )}&include=profile&fields[event]=datetime,event_properties&fields[profile]=email`;

  // Map: email (lowercase) -> earliest datetime when status became "active"
  const earliestActiveByEmail = {};

  let nextPageUrl = baseUrl;
  let pageCount = 0;

  while (nextPageUrl && pageCount < 200) {
    pageCount++;
    console.log(`[SyncKlaviyo] Fetching page ${pageCount}...`);

    const response = await fetch(nextPageUrl, {
      headers: {
        Authorization: `Klaviyo-API-Key ${klaviyoApiKey}`,
        revision: "2024-10-15",
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[SyncKlaviyo] Page ${pageCount} failed:`, response.status, errText);
      break;
    }

    const data = await response.json();
    const events = data.data || [];
    const included = data.included || [];

    // Build profile map for this page: profileId -> email
    const profileMap = {};
    for (const profile of included) {
      if (profile.type === "profile" && profile.attributes?.email) {
        profileMap[profile.id] = profile.attributes.email.toLowerCase().trim();
      }
    }

    // Process events on this page
    for (const event of events) {
      const status = event.attributes?.event_properties?.status;
      if (status !== "active") continue;

      const profileId = event.relationships?.profile?.data?.id;
      const email = profileId ? profileMap[profileId] : null;
      if (!email) continue;

      const datetime = event.attributes?.datetime;
      if (!datetime) continue;

      // Keep the earliest activation timestamp per email
      if (!earliestActiveByEmail[email] || datetime < earliestActiveByEmail[email]) {
        earliestActiveByEmail[email] = datetime;
      }
    }

    nextPageUrl = data.links?.next || null;
    console.log(
      `[SyncKlaviyo] Page ${pageCount}: ${events.length} events, ${included.length} profiles, hasNext: ${!!nextPageUrl}`
    );
  }

  const uniqueEmails = Object.keys(earliestActiveByEmail);
  console.log(`[SyncKlaviyo] Total unique active emails from Klaviyo: ${uniqueEmails.length}`);

  if (uniqueEmails.length === 0) {
    return json({ ok: true, total_klaviyo: 0, unique_emails: 0, updated: 0, not_found: 0, errors: 0 });
  }

  // Step 3: Fetch ALL customers paginated (Supabase default limit is 1000 rows)
  const customerMap = {};
  const PAGE_SIZE = 1000;
  let customerPage = 0;
  let customerDone = false;

  while (!customerDone) {
    const from = customerPage * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    const { data: batch, error: custFetchErr } = await supabase
      .from("customers")
      .select("id, email")
      .range(from, to);

    if (custFetchErr) {
      return json({ error: `Failed to fetch customers: ${custFetchErr.message}` }, { status: 500 });
    }

    for (const c of batch || []) {
      if (c.email) customerMap[c.email.toLowerCase().trim()] = c.id;
    }

    console.log(`[SyncKlaviyo] Customer page ${customerPage + 1}: ${(batch || []).length} rows`);

    if (!batch || batch.length < PAGE_SIZE) {
      customerDone = true;
    } else {
      customerPage++;
    }
  }

  console.log(`[SyncKlaviyo] Total customers loaded from DB: ${Object.keys(customerMap).length}`);

  // Step 4: Prepare batch updates
  const updates = [];
  const notFoundEmails = [];

  for (const [email, datetime] of Object.entries(earliestActiveByEmail)) {
    const customerId = customerMap[email];
    if (customerId) {
      updates.push({ id: customerId, status_changed_timestamp: datetime });
    } else {
      notFoundEmails.push(email);
    }
  }

  console.log(`[SyncKlaviyo] Updating ${updates.length} customers, ${notFoundEmails.length} not found in DB`);

  // Step 5: Update in parallel batches of 20 — use .update() not .upsert()
  // to avoid INSERT-path NOT NULL constraint violations on other columns.
  let updated = 0;
  let errors = 0;
  const CHUNK = 20;

  for (let i = 0; i < updates.length; i += CHUNK) {
    const batch = updates.slice(i, i + CHUNK);
    const results = await Promise.all(
      batch.map(({ id, status_changed_timestamp }) =>
        supabase
          .from("customers")
          .update({ status_changed_timestamp })
          .eq("id", id)
      )
    );
    for (const { error } of results) {
      if (error) {
        console.error(`[SyncKlaviyo] Update error:`, error);
        errors++;
      } else {
        updated++;
      }
    }
  }

  console.log(`[SyncKlaviyo] Done. Updated: ${updated}, Not found: ${notFoundEmails.length}, Errors: ${errors}`);

  return json({
    ok: true,
    unique_emails: uniqueEmails.length,
    updated,
    not_found: notFoundEmails.length,
    not_found_emails: notFoundEmails,
    errors,
  });
};
