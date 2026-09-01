const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url    = new URL(request.url);
  const code   = url.searchParams.get("code");
  const error  = url.searchParams.get("error");

  if (error) {
    return new Response(
      JSON.stringify({ error: `Zoho OAuth error: ${error}` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!code) {
    return new Response(
      JSON.stringify({ error: "Missing authorization code" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const clientId     = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const redirectUri  = process.env.ZOHO_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return new Response(
      JSON.stringify({ error: "Zoho OAuth env vars not configured (ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REDIRECT_URI)" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const tokenRes = await fetch("https://accounts.zoho.eu/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "authorization_code",
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      code,
    }),
  });

  const tokenData = await tokenRes.json();

  if (tokenData.error) {
    return new Response(
      JSON.stringify({ error: tokenData.error, details: tokenData }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { access_token, refresh_token, expires_in } = tokenData;

  console.log("=== ZOHO OAUTH TOKENS ===");
  console.log("ZOHO_ACCESS_TOKEN=" + access_token);
  console.log("ZOHO_REFRESH_TOKEN=" + refresh_token);
  console.log("expires_in:", expires_in);
  console.log("=========================");

  return new Response(
    JSON.stringify({
      success:       true,
      message:       "Tokens received. Copy these into your .env file.",
      access_token,
      refresh_token,
      expires_in,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
};
