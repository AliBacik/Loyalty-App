// CORS Headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export const loader = async () => {
  return new Response(null, { headers: corsHeaders });
};

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }

  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: corsHeaders }
      );
    }

    const { recipient_email, sender_email, sender_name, note, send_copy, product_title, product_url, product_image } = body;

    if (!recipient_email || !sender_email || !sender_name) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: recipient_email, sender_email, sender_name" }),
        { status: 400, headers: corsHeaders }
      );
    }

    const klaviyoApiKey = process.env.KLAVIYO_API_KEY;
    if (!klaviyoApiKey) {
      return new Response(
        JSON.stringify({ error: "Klaviyo API key not configured" }),
        { status: 500, headers: corsHeaders }
      );
    }

    // Track "Drop a Hint Received" event on the recipient's Klaviyo profile
    // This is the profile that will trigger the Klaviyo flow and receive the email
    const recipientPayload = {
      data: {
        type: "event",
        attributes: {
          metric: {
            data: {
              type: "metric",
              attributes: { name: "Drop a Hint Received" }
            }
          },
          profile: {
            data: {
              type: "profile",
              attributes: { email: recipient_email }
            }
          },
          properties: {
            product_title:  product_title  || "",
            product_url:    product_url    || "",
            product_image:  product_image  || "",
            sender_name:    sender_name,
            sender_email:   sender_email,
            note:           note           || "",
          },
          time: new Date().toISOString(),
        }
      }
    };

    const klaviyoRes = await fetch("https://a.klaviyo.com/api/events/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Klaviyo-API-Key ${klaviyoApiKey}`,
        "revision": "2023-12-15",
      },
      body: JSON.stringify(recipientPayload),
    });

    if (!klaviyoRes.ok) {
      const errText = await klaviyoRes.text();
      console.error("[drop-hint] Klaviyo recipient event failed:", klaviyoRes.status, errText);
      return new Response(
        JSON.stringify({ error: "Failed to send hint", detail: errText }),
        { status: 500, headers: corsHeaders }
      );
    }

    console.log(`[drop-hint] Sent "Drop a Hint Received" event to recipient: ${recipient_email}`);

    // If sender wants a copy, track a separate event on their profile
    if (send_copy && sender_email) {
      const senderPayload = {
        data: {
          type: "event",
          attributes: {
            metric: {
              data: {
                type: "metric",
                attributes: { name: "Drop a Hint Sent" }
              }
            },
            profile: {
              data: {
                type: "profile",
                attributes: { email: sender_email }
              }
            },
            properties: {
              product_title:    product_title    || "",
              product_url:      product_url      || "",
              product_image:    product_image    || "",
              recipient_email:  recipient_email,
              note:             note             || "",
            },
            time: new Date().toISOString(),
          }
        }
      };

      const senderRes = await fetch("https://a.klaviyo.com/api/events/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Klaviyo-API-Key ${klaviyoApiKey}`,
          "revision": "2023-12-15",
        },
        body: JSON.stringify(senderPayload),
      });

      if (!senderRes.ok) {
        const errText = await senderRes.text();
        console.warn("[drop-hint] Klaviyo sender copy event failed:", senderRes.status, errText);
        // Don't fail the whole request — recipient event already succeeded
      } else {
        console.log(`[drop-hint] Sent "Drop a Hint Sent" copy event to sender: ${sender_email}`);
      }
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: corsHeaders }
    );
  } catch (err) {
    console.error("[drop-hint] Unhandled error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error", detail: err?.message }),
      { status: 500, headers: corsHeaders }
    );
  }
};
