import { randomUUID } from "node:crypto";
import { supabase } from "../supabase.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const RETURN_API_BASE = "https://return-v2-api-140092896891.europe-west1.run.app";
// Per-store: set SHOPIFY_SHOP in each deployment's env. The literal remains the
// fallback so the existing Eternate deployment behaves identically if it is unset.
const SHOPIFY_SHOP    = process.env.SHOPIFY_SHOP || "riverdiamond.myshopify.com";
const SHOPIFY_API_VER = "2025-01";
const ZOHO_DESK_BASE  = "https://desk.zoho.eu/api/v1";
const ZOHO_ORG_ID     = process.env.ZOHO_ORG_ID || "20102213705";
// Zoho refuses a reply on the Email channel without an explicit sender:
// "fromEmailAddress is mandatory for Email channel". It must be an address the
// department is allowed to send from.
const ZOHO_FROM_EMAIL = process.env.ZOHO_FROM_EMAIL || "service@eternate.com";
// Every case created through the storefront return portal carries this tag.
// The test route uses its own so the cases it creates are filterable.
const PORTAL_TAG      = "ES-PORTAL-TEST";
// Destination warehouse for automatic return labels.
const RETURN_WAREHOUSE = process.env.RETURN_WAREHOUSE || "USA / Fulfillment CO";
// Automatic UPS bill of lading. ENABLED here — this is the test twin of
// api.returns.submit.jsx, which has the feature switched off while it is being
// validated. Everything else matches the live route: real Return V2 cases, real
// Zoho tickets, real label emails to the customer. Cases are tagged
// ES-PORTAL-TEST so they can be told apart from live traffic.
//
// Once the flow is signed off, re-enable autoLabel on the live route and delete
// this file rather than letting the two copies drift.

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return new Response(null, { status: 405, headers: corsHeaders });
};


function buildReturnApiAuth() {
  const user = process.env.RETURN_API_USERNAME;
  const pass = process.env.RETURN_API_PASSWORD;
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

function intentToReturnType(intent) {
  if (intent === "exchange") return "Exchange";
  if (intent === "repair")   return "Repair";
  if (intent === "return")   return "Return";
  return "Other";
}

// One Shopify store serves every country domain, so the storefront sends the
// host the customer actually opened (eternate.de, eternate.co.uk, …) rather
// than the permanent .myshopify.com domain, which is identical everywhere.
// Matched as a suffix: ".de" as a substring would also hit "eternate.design".
function domainToChannel(shopDomain) {
  if (!shopDomain) return "Eternate/SP";
  const d = shopDomain.toLowerCase().replace(/^www\./, "").split(":")[0];
  if (d.endsWith(".co.uk"))  return "Eternate/UK";
  if (d.endsWith(".de"))     return "Eternate/DE";
  if (d.endsWith(".com.tr")) return "Eternate/TR";
  return "Eternate/SP";
}

// Customer-facing email language follows the language the customer was reading
// the portal in, which is not the same thing as the domain: a customer can read
// eternate.de in English, or eternate.com in German.
const SUPPORTED_EMAIL_LANGUAGES = ["en", "de"];

function resolveEmailLanguage(locale) {
  // Shopify sends tags like "de" or "de-DE"; only the primary subtag matters.
  const lang = String(locale || "").toLowerCase().split("-")[0];
  return SUPPORTED_EMAIL_LANGUAGES.includes(lang) ? lang : "en";
}

function domainToZohoDepartmentId(shopDomain) {
  if (!shopDomain) return "185103000000007061";
  const d = shopDomain.toLowerCase().replace(/^www\./, "").split(":")[0];
  if (d.endsWith(".co.uk"))  return "185103000017293282"; // Eternate UK
  if (d.endsWith(".de"))     return "185103000015506538"; // Eternate Deutschland
  if (d.endsWith(".com.tr")) return "185103000017292758"; // Eternate Türkiye
  return "185103000000007061";                            // Eternate (SP, default)
}

function buildNote({ reasonLabel, subReasonLabel, details, notes, imageUrls = [], selectedItems = [] }) {
  const parts = [];
  if (selectedItems.length) {
    const itemLines = selectedItems.map(i => `${i.name}${i.variant ? ` — ${i.variant}` : ""}${i.qty > 1 ? ` ×${i.qty}` : ""}`).join(", ");
    parts.push(`<b>Items:</b> ${itemLines}`);
  }
  if (reasonLabel)      parts.push(`<b>Reason:</b> ${reasonLabel}`);
  if (subReasonLabel)   parts.push(`<b>Sub-reason:</b> ${subReasonLabel}`);
  if (details)          parts.push(`<b>Details:</b> ${details}`);
  if (notes)            parts.push(`<b>Additional notes:</b> ${notes}`);
  if (imageUrls.length) parts.push(`<b>Photos:</b><br>${imageUrls.map((u) => `<a href="${u}">${u}</a>`).join("<br>")}`);
  return parts.join("<br><br>");
}

// gid://shopify/Order/7310532214935 -> "7310532214935"
function numericFromGid(gid) {
  if (!gid) return "";
  const parts = String(gid).split("/");
  return parts[parts.length - 1] || "";
}

/* ── Label eligibility ──────────────────────────────── */

// The Return V2 API only issues a bill of lading for gold: a SKU carrying
// -10K-, -14K- or -18K-. Silver is refused with "ineligible_sku". Documented in
// RETURN-V2-API.md and confirmed by testing (RETURN-LABEL-FLOW.md).
const GOLD_SKU_PATTERN = /-(?:10|14|18)K-/i;

function isGoldSku(sku) {
  return GOLD_SKU_PATTERN.test(String(sku || ""));
}

/**
 * Pick the item whose SKU the single label is bought against.
 *
 * A multi-item return produces one label for the whole parcel, so one item has
 * to carry it. Gold wins: if any returned item is gold the label is issued
 * against that SKU, because a silver SKU would have the label refused outright
 * and the customer would get nothing. With no gold item there is nothing to
 * salvage — the first item is used and the API reports "skipped".
 */
function pickLabelItem(items) {
  if (!items.length) return null;
  return items.find((i) => isGoldSku(i.sku)) || items[0];
}

/**
 * Resolve customer, shipping address and the SKU/line key of every returned
 * line in one Shopify call.
 *
 * `lineIndexes` is the list of line positions being returned. A multi-item
 * return needs all of their SKUs — the label is bought against the gold one —
 * so this returns a `lines` array rather than a single SKU. One order fetch
 * serves the whole submission.
 */
async function fetchOrderData(accessToken, orderGid, lineIndexes) {
  const indexes = Array.isArray(lineIndexes) ? lineIndexes : [lineIndexes ?? 0];
  const query = `
    query GetOrderData($id: ID!) {
      order(id: $id) {
        customer { displayName email phone }
        shippingAddress {
          firstName
          lastName
          address1
          address2
          city
          provinceCode
          zip
          countryCodeV2
          phone
        }
        lineItems(first: 250) {
          nodes { id sku }
        }
      }
    }
  `;

  console.log("[returns.submit] fetchOrderData called:", { orderGid, lineIndexes: indexes });

  const res = await fetch(
    `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VER}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables: { id: orderGid } }),
    }
  );

  const rawText = await res.text();
  console.log("[returns.submit] Shopify GraphQL status:", res.status);
  console.log("[returns.submit] Shopify GraphQL response:", rawText);

  if (!res.ok) return {};

  const json  = JSON.parse(rawText);
  const order = json.data?.order || {};
  const nodes = order.lineItems?.nodes || [];

  const addr = order.shippingAddress || {};

  const orderNumeric = numericFromGid(orderGid);

  return {
    customerName:    order.customer?.displayName || "",
    customerEmail:   order.customer?.email || "",
    // One entry per returned line, in the order the caller asked for them.
    lines: indexes.map((idx) => {
      const node            = nodes[idx];
      const lineItemNumeric = node ? numericFromGid(node.id) : "";
      return {
        lineIndex:          idx,
        lineItemNumeric,
        sku:                node?.sku || "",
        sourceOrderLineKey: lineItemNumeric ? `${orderNumeric}/${lineItemNumeric}` : "",
      };
    }),
    // Shipping address drives the automatic UPS bill of lading; the return
    // travels back from wherever the parcel was delivered.
    shipping: {
      firstName:   addr.firstName    || "",
      lastName:    addr.lastName     || "",
      address1:    addr.address1     || "",
      address2:    addr.address2     || "",
      city:        addr.city         || "",
      state:       addr.provinceCode || "",
      zip:         addr.zip          || "",
      countryCode: addr.countryCodeV2 || "",
      phone:       addr.phone || order.customer?.phone || "",
    },
  };
}

/* ── Zoho Desk helpers ──────────────────────────────── */

async function getZohoAccessToken() {
  const res = await fetch("https://accounts.zoho.eu/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Zoho token refresh failed: ${data.error}`);
  return data.access_token;
}

async function getOrCreateZohoContact({ accessToken, email, customerName }) {
  const zohoHeaders = {
    "Content-Type":  "application/json",
    "Authorization": `Zoho-oauthtoken ${accessToken}`,
    "orgId":         ZOHO_ORG_ID,
  };

  // Mevcut contact'ları çekip email ile filtrele
  const listRes  = await fetch(`${ZOHO_DESK_BASE}/contacts?limit=200&fields=id,email`, { headers: zohoHeaders });
  const listData = await listRes.json();
  const existing = (listData.data || []).find((c) => c.email === email);
  if (existing) {
    console.log("[zoho] Found existing contact:", existing.id);
    return existing.id;
  }

  // Yoksa yeni contact oluştur
  const [firstName, ...rest] = (customerName || email).split(" ");
  const createRes  = await fetch(`${ZOHO_DESK_BASE}/contacts`, {
    method: "POST",
    headers: zohoHeaders,
    body: JSON.stringify({
      email,
      firstName: firstName || email,
      lastName:  rest.join(" ") || "",
    }),
  });
  const createData = await createRes.json();
  console.log("[zoho] Created contact:", createData.id);
  if (!createData.id) throw new Error("Zoho contact creation failed: " + JSON.stringify(createData));
  return createData.id;
}

async function createZohoTicket({ accessToken, subject, description, email, customerName, departmentId }) {
  const contactId = email
    ? await getOrCreateZohoContact({ accessToken, email, customerName })
    : null;

  const payload = {
    subject,
    departmentId,
    description,
    ...(contactId && { contactId }),
    ...(email     && { email }),
  };

  const res = await fetch(`${ZOHO_DESK_BASE}/tickets`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Zoho-oauthtoken ${accessToken}`,
      "orgId":         ZOHO_ORG_ID,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  console.log("[zoho] createTicket response:", JSON.stringify(data));

  if (!res.ok) throw new Error(data.message || `Zoho ticket error: ${res.status}`);
  return data;
}

/** Attach the label to the Zoho ticket so the agent sees it on the case. */
async function updateZohoTicketWithLabel({ accessToken, ticketId, label }) {
  const res = await fetch(`${ZOHO_DESK_BASE}/tickets/${ticketId}`, {
    method: "PATCH",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Zoho-oauthtoken ${accessToken}`,
      "orgId":         ZOHO_ORG_ID,
    },
    body: JSON.stringify({
      cf: {
        cf_shipping_label_url: label.labelUrl,
        ...(label.trackingNumber && { cf_tracking_number: label.trackingNumber }),
      },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Test route: the status code alone never says which field or scope Zoho
    // objected to, and that is what we are here to find out.
    console.error("[zoho] PATCH ticket failed:", res.status, JSON.stringify(data));
    throw new Error(data.message || `Zoho ticket update error: ${res.status}`);
  }
  return data;
}

/**
 * Push a file into Zoho's temporary upload area and return its attachment id.
 * sendReply cannot take a raw file — it only accepts ids produced here.
 */
async function uploadZohoAttachment({ accessToken, fileUrl, fileName }) {
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) throw new Error(`Label download failed: ${fileRes.status}`);

  const contentType = fileRes.headers.get("content-type") || "application/octet-stream";
  const blob        = await fileRes.blob();

  const form = new FormData();
  form.append("file", blob, fileName);

  const res = await fetch(`${ZOHO_DESK_BASE}/uploads`, {
    method: "POST",
    headers: {
      // No Content-Type here on purpose: fetch sets the multipart boundary.
      "Authorization": `Zoho-oauthtoken ${accessToken}`,
      "orgId":         ZOHO_ORG_ID,
    },
    body: form,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    throw new Error(data.message || `Zoho upload error: ${res.status}`);
  }
  console.log("[zoho] Uploaded label attachment:", data.id, `(${contentType})`);
  return data.id;
}

// Wording for the label email, per language. The label itself is identical.
const LABEL_EMAIL_TEXT = {
  en: {
    greeting:   (name) => `Hi${name ? ` ${name}` : ""},`,
    intro:      (order) => `Your return request for order <b>${order}</b> has been approved and your shipping label is ready.`,
    attached:   "Your shipping label is attached to this email.",
    linkText:   "Download your shipping label",
    tracking:   (num, carrier) => `Tracking number: <b>${num}</b>${carrier ? ` (${carrier})` : ""}`,
    instructions: "Please print the label, attach it to your parcel and hand it over to the carrier.",
    signoff:    "Kind regards,<br>Eternate Customer Care",
  },
  de: {
    greeting:   (name) => `Hallo${name ? ` ${name}` : ""},`,
    intro:      (order) => `Ihre Rücksendeanfrage für die Bestellung <b>${order}</b> wurde genehmigt und Ihr Versandetikett ist bereit.`,
    attached:   "Ihr Versandetikett finden Sie im Anhang dieser E-Mail.",
    linkText:   "Versandetikett herunterladen",
    tracking:   (num, carrier) => `Sendungsnummer: <b>${num}</b>${carrier ? ` (${carrier})` : ""}`,
    instructions: "Bitte drucken Sie das Etikett aus, bringen Sie es auf Ihrem Paket an und geben Sie es beim Versanddienstleister ab.",
    signoff:    "Mit freundlichen Grüßen,<br>Eternate Kundenservice",
  },
};

const LABEL_EMAIL_SUBJECT = {
  en: (order) => `Your shipping label for order ${order}`,
  de: (order) => `Ihr Versandetikett für die Bestellung ${order}`,
};

/**
 * Send the label to the customer as a reply on their ticket. The label is
 * attached to the email when we manage to upload it, and the link stays in the
 * body either way so the customer can still reach it if the upload failed.
 */
async function sendZohoLabelEmail({ accessToken, ticketId, toEmail, customerName, marketplaceId, label, language = "en" }) {
  // Best effort: a failed upload must still produce an email with the link.
  let attachmentIds = [];
  try {
    const ext      = (label.labelUrl.split("?")[0].match(/\.([a-z0-9]+)$/i) || [, "png"])[1];
    const fileName = `shipping-label-${marketplaceId || "return"}.${ext}`;
    const id = await uploadZohoAttachment({ accessToken, fileUrl: label.labelUrl, fileName });
    attachmentIds = [id];
  } catch (upErr) {
    console.error("[zoho] Label attachment upload failed (non-fatal):", upErr.message);
  }

  const t = LABEL_EMAIL_TEXT[language] || LABEL_EMAIL_TEXT.en;

  const content = `
    <p>${t.greeting(customerName)}</p>
    <p>${t.intro(marketplaceId)}</p>
    ${attachmentIds.length ? `<p>${t.attached}</p>` : ""}
    <p><a href="${label.labelUrl}">${t.linkText}</a></p>
    ${label.trackingNumber ? `<p>${t.tracking(label.trackingNumber, label.carrier)}</p>` : ""}
    <p>${t.instructions}</p>
    <p>${t.signoff}</p>
  `.trim();

  const res = await fetch(`${ZOHO_DESK_BASE}/tickets/${ticketId}/sendReply`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Zoho-oauthtoken ${accessToken}`,
      "orgId":         ZOHO_ORG_ID,
    },
    body: JSON.stringify({
      channel:     "EMAIL",
      fromEmailAddress: ZOHO_FROM_EMAIL,
      to:          toEmail,
      // No `subject`: a reply inherits the ticket's subject, and sending one
      // makes Zoho reject the call with "An extra parameter 'subject' is found".
      contentType: "html",
      content,
      ...(attachmentIds.length && { attachmentIds }),
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Test route: Zoho's generic "validation restrictions" message never says
    // which field it rejected; the errors array in the body does.
    console.error("[zoho] sendReply failed:", res.status, JSON.stringify(data));
    throw new Error(data.message || `Zoho sendReply error: ${res.status}`);
  }
  return data;
}




/**
 * Normalise the request body into the list of lines being returned.
 *
 * Two shapes are accepted. The portal now sends `items: [{ lineIndex, sku,
 * name, variant, qty }]` — the whole return in one call, which is what lets a
 * multi-item return share a single label. The older per-item shape
 * (`lineIndex` + `selectedItems` at the top level, one request per item) is
 * still accepted so the backend can be deployed before the portal.
 */
function parseItems(body) {
  if (Array.isArray(body.items) && body.items.length) {
    return body.items.map((it, i) => ({
      lineIndex: parseInt(it.lineIndex ?? 0, 10) || 0,
      sku:       it.sku     || "",
      name:      it.name    || "",
      variant:   it.variant || "",
      // Quantity travels as data instead of as repeated requests: the portal
      // used to POST qty times for one line, which cannot share a label.
      qty:       Math.max(1, parseInt(it.qty ?? it.selectedQty ?? 1, 10) || 1),
      position:  i,
    }));
  }

  // Legacy single-item body.
  const legacy = body.selectedItems?.[0] || {};
  return [{
    lineIndex: parseInt(body.lineIndex ?? "0", 10) || 0,
    sku:       body.sku       || legacy.sku     || "",
    name:      legacy.name    || "",
    variant:   legacy.variant || "",
    qty:       Math.max(1, parseInt(legacy.qty ?? 1, 10) || 1),
    position:  0,
  }];
}

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body           = await request.json();
    const orderId        = body.orderId        || "";
    const orderGid       = body.orderGid       || "";
    const intent         = body.intent         || "";
    const shopDomain     = body.shopDomain     || "";
    // Locale the customer was viewing the portal in, e.g. "de" or "en".
    const locale         = body.locale         || "";
    const reasonLabel    = body.reasonLabel    || "";
    const subReasonLabel = body.subReasonLabel || "";
    const details        = body.details        || "";
    // Honoured here, unlike the live route: this endpoint exists to exercise
    // the automatic label flow end to end. The caller decides per reason and
    // omitting the flag still means the manual flow.
    const autoLabel      = body.autoLabel === true;
    const notes          = body.notes          || "";
    // uploadedFiles: [{ url, path, name, type }] — GCS'e zaten yüklenmiş dosyalar
    const uploadedImages = body.uploadedFiles  || [];

    const items = parseItems(body);

    if (!orderId) {
      return new Response(
        JSON.stringify({ error: "Missing required field: orderId" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("[returns.submit] Submission:", {
      orderId,
      itemCount:   items.length,
      lineIndexes: items.map((i) => i.lineIndex),
      autoLabel,
      shape: Array.isArray(body.items) && body.items.length ? "items[]" : "legacy",
    });

    const { data: shopRow0 } = await supabase
      .schema("eternate")
      .from("shops")
      .select("id")
      .eq("shopify_domain", SHOPIFY_SHOP)
      .single();

    // 2. Resolve Shopify order data — one fetch covers every returned line.
    const marketplaceId = orderId.replace(/^#/, "");
    let customerName    = "";
    let customerEmail   = "";
    // Shipping address for the automatic bill of lading; empty on manual cases.
    let orderShipping   = null;

    if (orderGid) {
      const { data: shopRow } = await supabase
        .from("shops")
        .select("access_token")
        .eq("shopify_domain", SHOPIFY_SHOP)
        .single();

      if (shopRow?.access_token) {
        const orderData = await fetchOrderData(
          shopRow.access_token,
          orderGid,
          items.map((i) => i.lineIndex)
        );
        customerName  = orderData.customerName  || "";
        customerEmail = orderData.customerEmail || "";
        orderShipping = orderData.shipping || null;

        // Shopify is the source of truth for SKU and line key. Test route only:
        // a SKU sent per item wins, so a label-eligible SKU (-10K-/-14K-/-18K-)
        // can be tried against a real order whose own SKU does not qualify.
        (orderData.lines || []).forEach((line, i) => {
          const item = items[i];
          if (!item) return;
          if (line.sku && !item.sku) item.sku = line.sku;
          if (line.sourceOrderLineKey) item.sourceOrderLineKey = line.sourceOrderLineKey;
        });
      } else {
        console.log("[returns.submit] No access_token found for shop:", SHOPIFY_SHOP);
      }
    }

    // Every row of one submission needs a line key: it is the duplicate guard.
    // Without Shopify data there is no line item id, so fall back to the line
    // position, which is still unique within the order.
    items.forEach((item) => {
      if (!item.sourceOrderLineKey) {
        item.sourceOrderLineKey =
          `${numericFromGid(orderGid) || marketplaceId}/line-${item.lineIndex}`;
      }
    });

    // 1b. Duplicate check — per line, not per order. A customer returning three
    // items from one order is not a duplicate; re-submitting the same line is.
    if (shopRow0?.id) {
      const { data: existingRows } = await supabase
        .schema("eternate")
        .from("returns")
        .select("id, type, status, created_at, source_order_line_key")
        .eq("shop_id", shopRow0.id)
        .eq("order_id", orderId)
        .in("source_order_line_key", items.map((i) => i.sourceOrderLineKey));

      if (existingRows?.length) {
        const takenKeys = new Set(existingRows.map((r) => r.source_order_line_key));
        const fresh     = items.filter((i) => !takenKeys.has(i.sourceOrderLineKey));

        // Nothing new in the submission — the customer submitted it twice.
        if (!fresh.length) {
          const first = existingRows[0];
          return new Response(
            JSON.stringify({
              error: "duplicate",
              message: `A ${first.type} request for these items already exists (${first.status}).`,
              existingRequest: first,
            }),
            { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Partially new: process only the lines not already returned, so one
        // stale line cannot block the rest of the submission.
        console.log("[returns.submit] Skipping already-returned lines:",
          [...takenKeys], "| processing:", fresh.map((i) => i.sourceOrderLineKey));
        items.length = 0;
        items.push(...fresh);
      }
    }

    // 3+4. One Return V2 case and one Zoho ticket per returned line, exactly as
    // before. The label is the only thing that is now shared, so both of these
    // run per item — in parallel, because a five-item return would otherwise
    // serialise ten API round trips into one request.
    const returnApiAuth = buildReturnApiAuth();
    const returnType    = intentToReturnType(intent);
    const departmentId  = domainToZohoDepartmentId(shopDomain);
    const imageUrls     = uploadedImages.map((i) => i.url);

    let zohoToken = null;
    try {
      zohoToken = await getZohoAccessToken();
    } catch (tokErr) {
      console.error("[zoho] Token refresh failed (non-fatal):", tokErr.message);
    }

    // The label travels with the parcel, so its address must be decided once
    // for the whole submission.
    // Test route only: an address sent as body.shippingOverride replaces the
    // one Shopify holds, so a label-eligible destination (e.g. a US address
    // with a state) can be tried against an order shipped elsewhere. The live
    // route always uses the order's own shipping address.
    const shipping = body.shippingOverride
      ? { ...(orderShipping || {}), ...body.shippingOverride }
      : (orderShipping || {});

    if (body.shippingOverride) {
      console.log("[label] Shipping address overridden by request body:", {
        country: shipping.countryCode, state: shipping.state, zip: shipping.zip,
      });
    }

    // The Return V2 API rejects the whole request with 400 when the label flag
    // is set but customer data is incomplete — losing the return case over a
    // missing phone number is far worse than issuing the label by hand, so we
    // only ask for one when every required field is present.
    const hasLabelAddress =
      Boolean(shipping.firstName && shipping.lastName && shipping.address1 &&
              shipping.city && shipping.zip && shipping.countryCode && shipping.phone) &&
      // State is mandatory for US addresses only.
      (shipping.countryCode !== "US" || Boolean(shipping.state));

    const wantsLabel = autoLabel && hasLabelAddress;

    if (autoLabel && !wantsLabel) {
      console.log("[label] Skipping automatic label — incomplete customer data:", {
        hasLabelAddress,
        skus: items.map((i) => i.sku),
      });
    }

    // Exactly one item carries the label for the whole parcel. Gold wins, so a
    // silver item in the same return cannot cost the customer their label.
    const labelItem = wantsLabel ? pickLabelItem(items) : null;

    if (labelItem) {
      console.log("[label] Label item picked:", {
        lineIndex: labelItem.lineIndex,
        sku:       labelItem.sku,
        gold:      isGoldSku(labelItem.sku),
        of:        items.length,
      });
      if (!isGoldSku(labelItem.sku)) {
        console.log("[label] No gold SKU in this return — the API will report 'skipped'");
      }
    }

    async function postReturnCase(payload) {
      return fetch(`${RETURN_API_BASE}/return-cases`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: returnApiAuth,
        },
        body: JSON.stringify(payload),
      });
    }

    /** Create the Zoho ticket and Return V2 case for one returned line. */
    async function processItem(item) {
      const isLabelItem = labelItem === item;
      const note = buildNote({
        reasonLabel, subReasonLabel, details, notes, imageUrls,
        selectedItems: [{ name: item.name, variant: item.variant, qty: item.qty }],
      });

      // 3. Zoho ticket — one per line, unchanged.
      let zohoTicketId  = null;
      let zohoTicketRef = null;
      if (zohoToken) {
        try {
          const subject = `[${returnType}] Order ${marketplaceId}${customerName ? ` – ${customerName}` : ""}`;
          const ticket  = await createZohoTicket({
            accessToken:  zohoToken,
            subject,
            description:  note || `${returnType} request for order ${marketplaceId}`,
            email:        customerEmail,
            customerName,
            departmentId,
          });
          zohoTicketId  = ticket.ticketNumber;
          zohoTicketRef = ticket.id;
          console.log("[zoho] Ticket created:", zohoTicketId, "| id:", ticket.id,
            "| line:", item.lineIndex);
        } catch (zohoErr) {
          console.error("[zoho] Ticket creation failed (non-fatal):", zohoErr.message);
        }
      }

      // 4. Return V2 case — one per line, unchanged, except that the label
      // fields ride on the label item alone.
      const casePayload = {
        original_order_id: "xxx",
        return_type:       returnType,
        status:            "Open",
        channel:           domainToChannel(shopDomain),
        tags:              [PORTAL_TAG],
        ...(item.sku                && { sku: item.sku }),
        ...(customerName            && { customer_name:         customerName }),
        ...(marketplaceId           && { marketplace_id:        marketplaceId }),
        ...(item.sourceOrderLineKey && { source_order_line_key: item.sourceOrderLineKey }),
        ...(note                    && { customer_note:         note }),
        ...(zohoTicketId            && { zoho_ticket_id:        String(zohoTicketId) }),
        ...(isLabelItem && {
          createAutomaticBillOfLading: true,
          
          return_warehouse:       RETURN_WAREHOUSE,
          customer_first_name:    shipping.firstName,
          customer_last_name:     shipping.lastName,
          customer_address_line1: shipping.address1,
          ...(shipping.address2 && { customer_address_line2: shipping.address2 }),
          customer_city:          shipping.city,
          ...(shipping.state && { customer_state: shipping.state }),
          customer_zip_code:      shipping.zip,
          customer_country_code:  shipping.countryCode,
          customer_phone:         shipping.phone,
          ...(customerEmail && { customer_email: customerEmail }),
        }),
      };

      let caseRes = await postReturnCase(casePayload);

      // The label request is the only part of this payload that can be rejected
      // on its own (incomplete or unusable customer data). Losing the return
      // case over it would be far worse than shipping the label by hand, so
      // retry once without the label fields before giving up.
      if (!caseRes.ok && isLabelItem) {
        const failed = await caseRes.clone().json().catch(() => ({}));
        console.error("[label] Return case rejected with label request — retrying without it:",
          caseRes.status, failed.error || failed.message || "");

        const {
          createAutomaticBillOfLading,
          customer_first_name, customer_last_name,
          customer_address_line1, customer_address_line2,
          customer_city, customer_state, customer_zip_code,
          customer_country_code, customer_phone, customer_email,
          ...payloadWithoutLabel
        } = casePayload;

        caseRes = await postReturnCase(payloadWithoutLabel);
      }

      if (!caseRes.ok) {
        const err = await caseRes.json().catch(() => ({}));
        throw new Error(err.error || `Return API error: ${caseRes.status}`);
      }

      const caseData   = await caseRes.json();
      const returnCase = caseData.data || {};

      // 5. Save attachments — the photos belong to every line of the return.
      if (uploadedImages.length > 0 && returnCase.id) {
        await Promise.all(
          uploadedImages.map(({ url, path, name, type }) =>
            fetch(`${RETURN_API_BASE}/return-cases/${returnCase.id}/attachments`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: returnApiAuth,
              },
              body: JSON.stringify({
                file_name:      name,
                file_url:       url,
                file_type:      type || "image/jpeg",
                storage_bucket: "renart",
                storage_path:   path,
              }),
            })
          )
        );
      }

      return { item, returnCase, caseData, zohoTicketId, zohoTicketRef, isLabelItem };
    }

    const settled = await Promise.allSettled(items.map(processItem));

    const results  = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
    const failures = settled.filter((s) => s.status === "rejected")
                            .map((s) => s.reason?.message || String(s.reason));

    if (failures.length) {
      console.error("[returns.submit] Item failures:", failures);
    }

    // Every line failed: there is nothing to report as a success.
    if (!results.length) {
      throw new Error(failures[0] || "All return cases failed");
    }

    // 5b. Automatic shipping label — one per submission. The Return V2 API
    // already created it as part of the label item's return-case call; here we
    // only hand it to the customer. Every failure is non-fatal: the cases and
    // tickets exist, and an agent can still send the label by hand.
    let shippingLabel = null;
    const labelResult = results.find((r) => r.isLabelItem);

    // The API nests this under data.meta and names the link "signed_url"; the
    // tracking number lives on the case itself, not inside the bol block.
    const bol = labelResult
      ? (labelResult.returnCase.meta?.automatic_bill_of_lading ||
         labelResult.caseData.meta?.automatic_bill_of_lading ||
         labelResult.caseData.automatic_bill_of_lading ||
         null)
      : null;

    // Test route logs the whole block: "skipped" alone never says which rule
    // rejected the case, and that is the question this route exists to answer.
    if (bol) {
      console.log("[label] Bill of lading block:", JSON.stringify(bol));
      console.log("[label] Bill of lading status:", bol.status);
    } else if (wantsLabel) {
      console.log("[label] No bill of lading block in response");
    }

    // Recorded on the returns rows: "not_requested" covers both the manual flow
    // and a case whose label fields the retry had to strip, which is why it is
    // not simply null.
    const labelStatus = bol?.status || (wantsLabel ? "error" : "not_requested");
    const labelUrl    = bol?.signed_url || bol?.url || "";

    if (bol?.status === "created" && labelUrl) {
      shippingLabel = {
        labelUrl,
        trackingNumber: labelResult.returnCase.return_tracking_number || bol.tracking_number || "",
        carrier:        "UPS",
      };

      // The label covers the whole parcel, so it is written to every ticket of
      // the submission — whichever ticket the agent opens shows it.
      const ticketRefs = results.map((r) => r.zohoTicketRef).filter(Boolean);

      if (zohoToken && ticketRefs.length) {
        await Promise.all(ticketRefs.map(async (ref) => {
          try {
            await updateZohoTicketWithLabel({
              accessToken: zohoToken,
              ticketId:    ref,
              label:       shippingLabel,
            });
            console.log("[label] Zoho ticket updated with label:", ref);
          } catch (updErr) {
            console.error("[label] Zoho ticket update failed (non-fatal):", ref, updErr.message);
          }
        }));

        // One email for the whole return, sent on the label item's ticket — the
        // customer gets a single parcel and a single label, so a mail per line
        // would be three mails for one box.
        const emailTicketRef = labelResult.zohoTicketRef || ticketRefs[0];

        if (customerEmail && emailTicketRef) {
          try {
            await sendZohoLabelEmail({
              accessToken:   zohoToken,
              ticketId:      emailTicketRef,
              toEmail:       customerEmail,
              customerName,
              marketplaceId,
              label:         shippingLabel,
              language:      resolveEmailLanguage(locale),
            });
            console.log("[label] Label email sent to:", customerEmail,
              "| ticket:", emailTicketRef, "| covers", results.length, "item(s)");
          } catch (mailErr) {
            console.error("[label] Label email failed (non-fatal):", mailErr.message);
          }
        }
      }
    }

    // 6. Supabase'e kaydet — one row per returned line, all sharing a group id
    // so the rows of one submission can be told apart from separate returns.
    const returnGroupId = randomUUID();

    if (shopRow0?.id) {
      const { error: dbErr } = await supabase
        .schema("eternate")
        .from("returns")
        .insert(results.map((r) => ({
          shop_id:               shopRow0.id,
          order_id:              orderId,
          source_order_line_key: r.item.sourceOrderLineKey,
          return_group_id:       returnGroupId,
          customer_email:        customerEmail || null,
          type:                  intent || "return",
          status:                "pending",
          reason:                reasonLabel || null,
          notes:                 [subReasonLabel, details, notes].filter(Boolean).join(" | ") || null,
          file_urls:             imageUrls,
          // Label outcome: the Cloud Run logs roll off, so the row is the only
          // lasting record of whether a label was bought and why not. The label
          // covers the whole parcel, so every line of the group carries the same
          // url and tracking number, not just the item that triggered it.
          zoho_ticket_id:  r.zohoTicketId ? String(r.zohoTicketId) : null,
          return_case_id:  r.returnCase.id || null,
          rma_number:      r.returnCase.rma_number || null,
          auto_label:      autoLabel,
          label_status:    r.isLabelItem ? labelStatus
                                         : (shippingLabel ? "covered_by_group" : labelStatus),
          label_url:       shippingLabel?.labelUrl || null,
          tracking_number: shippingLabel?.trackingNumber || null,
        })));

      if (dbErr) {
        console.error("[returns.submit] Supabase insert failed (non-fatal):", dbErr.message);
      }
    }

    return new Response(
      JSON.stringify({
        success:      true,
        returnGroupId,
        // One entry per returned line, so the portal can report partial failure
        // instead of collapsing the whole submission into one error.
        items: results.map((r) => ({
          lineIndex:    r.item.lineIndex,
          sku:          r.item.sku,
          returnCaseId: r.returnCase.id,
          rmaNumber:    r.returnCase.rma_number,
          zohoTicketId: r.zohoTicketId,
          carriesLabel: r.isLabelItem,
        })),
        failedCount: failures.length,
        ...(failures.length && { failures }),
        // One label and one email per submission, kept flat.
        autoLabel,
        labelUrl:       shippingLabel?.labelUrl || null,
        trackingNumber: shippingLabel?.trackingNumber || null,
        labelStatus,
        imageUrls,
        // Legacy fields — the current portal reads these.
        returnCaseId: results[0].returnCase.id,
        rmaNumber:    results[0].returnCase.rma_number,
        zohoTicketId: results[0].zohoTicketId,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[api.returns.submit-test] Error:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};
