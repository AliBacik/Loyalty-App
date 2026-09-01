import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

export const action = async ({ request }) => {
  console.log("-----------------------------------------");
  console.log("⚡️ WEBHOOK RECEIVED: CUSTOMERS_CREATE");

  try {
    const { topic, shop, payload } = await authenticate.webhook(request);
    if (topic === "CUSTOMERS_CREATE") {
      // 1. Get Shop ID
      const { data: loyaltyShop, error: shopError } = await supabase
        .from("shops")
        .select("id")
        .eq("shopify_domain", shop)
        .single();

      if (shopError || !loyaltyShop) {
        console.error("❌ DB ERROR: Could not find shop.", shopError);
        return new Response();
      }

      console.log(`✅ Shop Found: ${loyaltyShop.id}`);

      // -------------------------------------------------------------
      // LOGIC UPDATE: CASE PURPLE & GREEN
      // "Account = Enrolled". Marketing just determines if they are "aware".
      // We save EVERYONE who creates an account as 'active'.
      // -------------------------------------------------------------

      console.log(`🚀 Processing Account Creation for: ${payload.email}`);

      const { data, error: upsertError } = await supabase
        .from("customers")
        .upsert(
          {
            shop_id: loyaltyShop.id,
            shopify_customer_id: payload.id,
            email: payload.email,
            tier: "Circle",
            status: "pending", // Always active because they have an account
          },
          { onConflict: "shop_id, shopify_customer_id" },
        )
        .select();

      if (upsertError) {
        console.error("❌ DB UPSERT ERROR:", upsertError);
      } else {
        console.log("✅ SUCCESS! User enrolled (Active).");
      }
    }
  } catch (error) {
    console.error("🔥 CRITICAL ERROR:", error);
  }

  return new Response();
};
