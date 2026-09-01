import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server"; // 👈 Import Supabase

export const action = async ({ request }) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);
  const current = payload.current;

  if (session) {
    // Update the scope in Supabase
    const { error } = await supabase
      .from("session")
      .update({ scope: current.toString() })
      .eq("id", session.id);

    if (error) console.error("❌ Failed to update scope:", error);
    else console.log("✅ Session scope updated");
  }

  return new Response();
};
