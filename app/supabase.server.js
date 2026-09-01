import { createClient } from "@supabase/supabase-js";

// Initialize Supabase with the 'loyalty' schema
// Make sure these are in your .env file
const supabaseUrl = process.env.SUPABASE_URL_STOREFRONT;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY_STOREFRONT;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Supabase URL and Key must be provided in .env");
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  db: { schema: "loyalty" },
});