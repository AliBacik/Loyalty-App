import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server"; // 👈 Import Supabase

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Clean up sessions from Supabase
  if (shop) {
    const { error } = await supabase
      .from("session") // Ensure this matches your table name
      .delete()
      .eq("shop", shop);

    if (error) console.error("❌ Failed to delete sessions:", error);
    else console.log("✅ Sessions deleted for uninstalled shop");
  }

  return new Response();
};
