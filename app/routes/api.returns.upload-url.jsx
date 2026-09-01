import { Storage } from "@google-cloud/storage";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return new Response(null, { status: 405, headers: corsHeaders });
};

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { files, orderId } = await request.json();
    // files: [{ name, type, size }]

    if (!files?.length || !orderId) {
      return new Response(JSON.stringify({ error: "Missing files or orderId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const credentials = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
    const storage     = new Storage({ credentials });
    const bucket      = storage.bucket("return-portal");

    const safeOrderId = String(orderId).replace(/[^a-zA-Z0-9_-]/g, "_");
    const timestamp   = Date.now();

    const signedUrls = await Promise.all(
      files.map(async ({ name, type }, idx) => {
        const safeName    = name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const destination = `returns/${safeOrderId}/${timestamp}-${idx}-${safeName}`;
        const file        = bucket.file(destination);

        const [signedUrl] = await file.generateSignedPostPolicyV4({
          expires: Date.now() + 15 * 60 * 1000, // 15 dakika
          conditions: [
            ["content-length-range", 0, 1 * 1024 * 1024 * 1024],
            ["eq", "$Content-Type", type],
          ],
          fields: { "Content-Type": type },
        });

        return {
          signedUrl,
          publicUrl: `https://storage.googleapis.com/return-portal/${destination}`,
          destination,
          name,
          type,
        };
      })
    );

    return new Response(JSON.stringify({ success: true, signedUrls }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[api.returns.upload-url] Error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
};
