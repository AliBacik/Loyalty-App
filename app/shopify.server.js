import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
  DeliveryMethod,
} from "@shopify/shopify-app-remix/server";
import { MemorySessionStorage } from "@shopify/shopify-app-session-storage-memory";
// 1. IMPORT THE RAW SUPABASE LIBRARY
import { createClient } from "@supabase/supabase-js";

// 2. CREATE A "SUDO" ADMIN CLIENT (Bypasses RLS)
// Ensure these exist in your .env file!
const supabaseUrl = process.env.SUPABASE_URL_STOREFRONT;
const supabaseServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY_STOREFRONT; // ⚠️ MUST BE SERVICE_ROLE, NOT ANON

if (!supabaseUrl || !supabaseServiceRole) {
  throw new Error(
    "❌ MISSING SUPABASE VARS: Check .env for SUPABASE_URL_STOREFRONT and SUPABASE_SERVICE_ROLE_KEY_STOREFRONT",
  );
}

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRole, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January25,
  //
  hooks: {
    afterAuth: async ({ session }) => {
      console.log("🔄 Updating Access Token for:", session.shop);

      // 1. Upsert the new token into Supabase
      const { error } = await supabaseAdmin
        .schema("loyalty")
        .from("shops")
        .upsert(
          {
            shopify_domain: session.shop,
            access_token: session.accessToken,
            // Make sure you include any other required columns for your 'shops' table
            // e.g., is_active: true
          },
          { onConflict: "shopify_domain" },
        );

      if (error) {
        console.error("❌ Failed to update token in DB:", error);
      } else {
        console.log("✅ Token refreshed in DB!");
      }

      // 2. Register Webhooks (Standard practice)
      shopify.registerWebhooks({ session });
    },
  },
  webhooks: {
    ORDERS_CREATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/orders/create",
    },
    REFUNDS_CREATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/refunds/create",
    }, // <--- NEW
    CUSTOMERS_CREATE: {
      deliveryMethod: DeliveryMethod.Http,
      callbackUrl: "/webhooks/customers/create",
    }, // <--- NEW
  },
  //
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  // Sessions live in memory: shop access tokens are persisted to the Supabase
  // `shops` table by the afterAuth hook above, so there is no local database.
  sessionStorage: new MemorySessionStorage(),
  distribution: AppDistribution.AppStore,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    removeRest: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.January25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
