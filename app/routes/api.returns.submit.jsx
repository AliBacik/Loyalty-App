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
// The portal asks whether the item still carries its original black tag. A cut
// tag means the item counts as used, so the agent has to apply the restocking
// fee — spell it out on the ticket rather than leaving the raw code.
const TAG_CONDITION_TEXT = {
  intact: "Original black tags still attached (unused, undamaged)",
  cut:    "Black tag cut or removed — item counts as used, customer accepted the 10%-20% restocking fee + shipping",
};

// Every case created through the storefront return portal carries this tag.
const PORTAL_TAG      = "ES-PORTAL";
// Destination warehouse for automatic return labels.
const RETURN_WAREHOUSE = process.env.RETURN_WAREHOUSE || "USA / Fulfillment CO";
// Automatic UPS bill of lading. DISABLED on this route — see the autoLabel
// assignment in the action. The portal decides per reason whether a case
// qualifies (autoLabel); reasons that are our fault or that carry free text
// stay on the manual flow. The Return V2 API produces the label as part of the
// return-case call. The label path is kept intact below so re-enabling it is a
// one-line change; api.returns.submit-test.jsx exercises it in the meantime.

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

function buildNote({ reasonLabel, subReasonLabel, tagCondition, details, notes, imageUrls = [], selectedItems = [] }) {
  const parts = [];
  if (selectedItems.length) {
    const itemLines = selectedItems.map(i => `${i.name}${i.variant ? ` — ${i.variant}` : ""}${i.qty > 1 ? ` ×${i.qty}` : ""}`).join(", ");
    parts.push(`<b>Items:</b> ${itemLines}`);
  }
  if (reasonLabel)      parts.push(`<b>Reason:</b> ${reasonLabel}`);
  if (subReasonLabel)   parts.push(`<b>Sub-reason:</b> ${subReasonLabel}`);
  if (tagCondition)     parts.push(`<b>Tag condition:</b> ${TAG_CONDITION_TEXT[tagCondition] || tagCondition}`);
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

async function fetchOrderData(accessToken, orderGid, lineIndex) {
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

  console.log("[returns.submit] fetchOrderData called:", { orderGid, lineIndex });

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

  return {
    customerName:    order.customer?.displayName || "",
    customerEmail:   order.customer?.email || "",
    lineItemNumeric: nodes[lineIndex] ? numericFromGid(nodes[lineIndex].id) : "",
    sku:             nodes[lineIndex]?.sku || "",
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
  if (!res.ok) throw new Error(data.message || `Zoho ticket update error: ${res.status}`);
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

  const subjectFor = LABEL_EMAIL_SUBJECT[language] || LABEL_EMAIL_SUBJECT.en;

  const res = await fetch(`${ZOHO_DESK_BASE}/tickets/${ticketId}/sendReply`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Zoho-oauthtoken ${accessToken}`,
      "orgId":         ZOHO_ORG_ID,
    },
    body: JSON.stringify({
      channel:     "EMAIL",
      to:          toEmail,
      subject:     subjectFor(marketplaceId),
      contentType: "html",
      content,
      ...(attachmentIds.length && { attachmentIds }),
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Zoho sendReply error: ${res.status}`);
  return data;
}



export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body     = await request.json();
    const orderId        = body.orderId        || "";
    const orderGid       = body.orderGid       || "";
    const lineIndex      = parseInt(body.lineIndex ?? "0", 10);
    const intent         = body.intent         || "";
    const shopDomain     = body.shopDomain     || "";
    // Locale the customer was viewing the portal in, e.g. "de" or "en".
    const locale         = body.locale         || "";
    const reasonLabel    = body.reasonLabel    || "";
    const subReasonLabel = body.subReasonLabel || "";
    const tagCondition   = body.tagCondition   || "";
    const details        = body.details        || "";
    // Automatic labels are disabled on this route while the flow is being
    // tested. The portal still sends body.autoLabel, and it is ignored here on
    // purpose: every case created through this endpoint stays on the manual
    // flow. Testing happens on api.returns.submit-test.jsx, which honours the
    // flag. Restore `body.autoLabel === true` here to switch the live portal
    // back on.
    const autoLabel      = false;
    const notes          = body.notes          || "";
    // uploadedFiles: [{ url, path, name, type }] — GCS'e zaten yüklenmiş dosyalar
    const uploadedImages = body.uploadedFiles  || [];
    const selectedItems  = body.selectedItems  || [];

    if (!orderId) {
      return new Response(
        JSON.stringify({ error: "Missing required field: orderId" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1b. Duplicate kontrolü — aynı order için daha önce istek var mı?
    const { data: shopRow0 } = await supabase
      .schema("eternate")
      .from("shops")
      .select("id")
      .eq("shopify_domain", SHOPIFY_SHOP)
      .single();

    if (shopRow0?.id) {
      const { data: existing } = await supabase
        .schema("eternate")
        .from("returns")
        .select("id, type, status, created_at")
        .eq("shop_id", shopRow0.id)
        .eq("order_id", orderId)
        .maybeSingle();

      if (existing) {
        return new Response(
          JSON.stringify({
            error: "duplicate",
            message: `A ${existing.type} request for this order already exists (${existing.status}).`,
            existingRequest: existing,
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // 2. Resolve Shopify order data
    const marketplaceId = orderId.replace(/^#/, "");
    let sourceOrderLineKey = "";
    let customerName       = "";
    let customerEmail      = "";
    // Portal may send the SKU it already has; Shopify remains the source of truth.
    let sku                = body.sku || "";
    // Shipping address for the automatic bill of lading; empty on manual cases.
    let orderShipping      = null;

    if (orderGid) {
      const { data: shopRow } = await supabase
        .from("shops")
        .select("access_token")
        .eq("shopify_domain", SHOPIFY_SHOP)
        .single();

      if (shopRow?.access_token) {
        const orderData = await fetchOrderData(shopRow.access_token, orderGid, lineIndex);
        customerName  = orderData.customerName;
        customerEmail = orderData.customerEmail;
        if (orderData.sku) sku = orderData.sku;
        if (orderData.lineItemNumeric) {
          sourceOrderLineKey = `${numericFromGid(orderGid)}/${orderData.lineItemNumeric}`;
        }
        orderShipping = orderData.shipping || null;
      } else {
        console.log("[returns.submit] No access_token found for shop:", SHOPIFY_SHOP);
      }
    }

    // 3. Create Zoho Desk ticket
    let zohoTicketId  = null;
    // Zoho's own record id — required to patch the ticket or reply on it.
    let zohoTicketRef = null;
    let zohoToken     = null;
    try {
      zohoToken          = await getZohoAccessToken();
      const departmentId = domainToZohoDepartmentId(shopDomain);
      const returnType   = intentToReturnType(intent);
      const note         = buildNote({ reasonLabel, subReasonLabel, tagCondition, details, notes, imageUrls: uploadedImages.map((i) => i.url), selectedItems });

      const subject     = `[${returnType}] Order ${marketplaceId}${customerName ? ` – ${customerName}` : ""}`;
      const description = note || `${returnType} request for order ${marketplaceId}`;

      const ticket = await createZohoTicket({
        accessToken:  zohoToken,
        subject,
        description,
        email:        customerEmail,
        customerName,
        departmentId,
      });
      zohoTicketId  = ticket.ticketNumber;
      zohoTicketRef = ticket.id;
      console.log("[zoho] Ticket created:", zohoTicketId, "| id:", ticket.id);
    } catch (zohoErr) {
      console.error("[zoho] Ticket creation failed (non-fatal):", zohoErr.message);
    }

    // 4. Create return case
    const returnApiAuth = buildReturnApiAuth();
    const note = buildNote({ reasonLabel, subReasonLabel, tagCondition, details, notes, imageUrls: uploadedImages.map((i) => i.url), selectedItems });

    // A label is only worth requesting when the portal cleared the reason AND
    // the SKU qualifies. Asking for one on an ineligible SKU is harmless (the
    // API reports "skipped"), but the address fields below are only added when
    // we actually expect a label, so the payload stays as it is today
    // for every manual case.
    const shipping = orderShipping || {};
    // The Return V2 API rejects the whole request with 400 when the label flag
    // is set but customer data is incomplete — losing the return case over a
    // missing phone number is far worse than issuing the label by hand, so we
    // only ask for one when every required field is present.
    const hasLabelAddress =
      Boolean(shipping.firstName && shipping.lastName && shipping.address1 &&
              shipping.city && shipping.zip && shipping.countryCode && shipping.phone) &&
      // State is mandatory for US addresses only.
      (shipping.countryCode !== "US" || Boolean(shipping.state));

    // The Return V2 API decides for itself whether the SKU qualifies and
    // reports "skipped" when it does not; we only withhold the request when the
    // customer data it needs is incomplete, because that is a hard 400.
    const wantsLabel = autoLabel && hasLabelAddress;

    if (autoLabel && !wantsLabel) {
      console.log("[label] Skipping automatic label — incomplete customer data:", {
        hasLabelAddress,
        sku,
      });
    }

    const casePayload = {
      original_order_id: "xxx",
      return_type:       intentToReturnType(intent),
      status:            "Open",
      channel:           domainToChannel(shopDomain),
      tags:              [PORTAL_TAG],
      ...(sku                && { sku }),
      ...(customerName       && { customer_name:         customerName }),
      ...(marketplaceId      && { marketplace_id:        marketplaceId }),
      ...(sourceOrderLineKey && { source_order_line_key: sourceOrderLineKey }),
      ...(note               && { customer_note:         note }),
      ...(zohoTicketId       && { zoho_ticket_id:        String(zohoTicketId) }),
      ...(wantsLabel && {
        createAutomaticBillOfLading: true,
        // The UPS label needs a destination: where the parcel travels back to.
        return_warehouse:     RETURN_WAREHOUSE,
        customer_first_name:  shipping.firstName,
        customer_last_name:   shipping.lastName,
        customer_address_line1: shipping.address1,
        ...(shipping.address2 && { customer_address_line2: shipping.address2 }),
        customer_city:        shipping.city,
        ...(shipping.state && { customer_state: shipping.state }),
        customer_zip_code:    shipping.zip,
        customer_country_code: shipping.countryCode,
        customer_phone:       shipping.phone,
        ...(customerEmail && { customer_email: customerEmail }),
      }),
    };

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

    let caseRes = await postReturnCase(casePayload);

    // The label request is the only part of this payload that can be rejected
    // on its own (incomplete or unusable customer data). Losing the return case
    // over it would be far worse than shipping the label by hand, so retry once
    // without the label fields before giving up.
    if (!caseRes.ok && wantsLabel) {
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

    const caseData = await caseRes.json();
    const returnCase = caseData.data || {};

    // 5. Save attachments
    if (uploadedImages.length > 0) {
      await Promise.all(
        uploadedImages.map(({ url, path, name }, idx) =>
          fetch(`${RETURN_API_BASE}/return-cases/${returnCase.id}/attachments`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: returnApiAuth,
            },
            body: JSON.stringify({
              file_name:      name,
              file_url:       url,
              file_type:      uploadedImages[idx]?.type || "image/jpeg",
              storage_bucket: "renart",
              storage_path:   path,
            }),
          })
        )
      );
    }

    // 5b. Automatic shipping label. The Return V2 API already created it as
    // part of the return-case call; here we only hand it to the customer.
    // Every failure is non-fatal — the case and ticket exist, and an agent can
    // still send the label by hand.
    let shippingLabel = null;
    // The API nests this under data.meta and names the link "signed_url"; the
    // tracking number lives on the case itself, not inside the bol block.
    const bol =
      returnCase.meta?.automatic_bill_of_lading ||
      caseData.meta?.automatic_bill_of_lading ||
      caseData.automatic_bill_of_lading ||
      null;

    if (bol) console.log("[label] Bill of lading status:", bol.status);
    else if (wantsLabel) console.log("[label] No bill of lading block in response");

    const labelUrl = bol?.signed_url || bol?.url || "";

    if (bol?.status === "created" && labelUrl) {
      shippingLabel = {
        labelUrl,
        trackingNumber: returnCase.return_tracking_number || bol.tracking_number || "",
        carrier:        "UPS",
      };

      if (zohoTicketRef && zohoToken) {
        try {
          await updateZohoTicketWithLabel({
            accessToken: zohoToken,
            ticketId:    zohoTicketRef,
            label:       shippingLabel,
          });
          console.log("[label] Zoho ticket updated with label:", zohoTicketId);
        } catch (updErr) {
          console.error("[label] Zoho ticket update failed (non-fatal):", updErr.message);
        }

        if (customerEmail) {
          try {
            await sendZohoLabelEmail({
              accessToken:   zohoToken,
              ticketId:      zohoTicketRef,
              toEmail:       customerEmail,
              customerName,
              marketplaceId,
              label:         shippingLabel,
              language:      resolveEmailLanguage(locale),
            });
            console.log("[label] Label email sent to:", customerEmail);
          } catch (mailErr) {
            console.error("[label] Label email failed (non-fatal):", mailErr.message);
          }
        }
      }
    }

    // 6. Supabase'e kaydet (duplicate engellemek + takip için)
    if (shopRow0?.id) {
      const { error: dbErr } = await supabase
        .schema("eternate")
        .from("returns")
        .insert({
          shop_id:        shopRow0.id,
          order_id:       orderId,
          customer_email: customerEmail || null,
          type:           intent || "return",
          status:         "pending",
          reason:         reasonLabel || null,
          notes:          [subReasonLabel, tagCondition && `Tag: ${tagCondition}`, details, notes].filter(Boolean).join(" | ") || null,
          file_urls:      uploadedImages.map((i) => i.url),
        });

      if (dbErr) {
        console.error("[returns.submit] Supabase insert failed (non-fatal):", dbErr.message);
      }
    }

    return new Response(
      JSON.stringify({
        success:      true,
        returnCaseId: returnCase.id,
        rmaNumber:    returnCase.rma_number,
        zohoTicketId,
        autoLabel,
        labelUrl:      shippingLabel?.labelUrl || null,
        trackingNumber: shippingLabel?.trackingNumber || null,
        imageUrls:    uploadedImages.map((i) => i.url),
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[api.returns.submit] Error:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};
