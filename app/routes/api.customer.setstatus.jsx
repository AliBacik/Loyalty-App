import { supabase } from "../supabase.server";

// CORS Headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// Helper: Add "active" tag to customer in Shopify
async function addActiveTagToShopifyCustomer(shopDomain, accessToken, shopifyCustomerId) {
  try {
    console.log("[debug] Adding 'loyalty_active' tag to Shopify customer:", shopifyCustomerId);
    
    const mutation = `
      mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer {
            id
            tags
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          input: {
            id: `gid://shopify/Customer/${shopifyCustomerId}`,
            tags: ["loyalty_active"]
          }
        }
      })
    });

    const result = await response.json();
    
    if (result.data?.customerUpdate?.userErrors?.length > 0) {
      console.error("[debug] Shopify customerUpdate errors:", result.data.customerUpdate.userErrors);
      return { success: false, errors: result.data.customerUpdate.userErrors };
    }

    console.log("[debug] Successfully added 'loyalty_active' tag to customer");
    return { success: true, tags: result.data?.customerUpdate?.customer?.tags };
  } catch (error) {
    console.error("[debug] Error adding tag to Shopify customer:", error);
    return { success: false, error: error.message };
  }
}

// Handle CORS preflight (OPTIONS)
export const loader = async () => {
  return new Response(null, { headers: corsHeaders });
};

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }

  try {
    const { customerId, shop, email } = await request.json();
    console.log("[debug] api.customer.setstatus - payload:", { customerId, shop, email });

    if (!customerId || !shop) {
      return new Response(JSON.stringify({ error: "Missing required fields: customerId, shop" }), { status: 400, headers: corsHeaders });
    }

    // Get shop and access token from Supabase
    const { data: loyaltyShop } = await supabase
      .from("shops")
      .select("id, access_token, shopify_domain")
      .eq("shopify_domain", shop)
      .single();
    console.log("[debug] api.customer.setstatus - loyaltyShop:", loyaltyShop);

    if (!loyaltyShop?.id || !loyaltyShop?.access_token) {
      return new Response(JSON.stringify({ error: "Shop not found or missing access token" }), { status: 404, headers: corsHeaders });
    }

    // 1. If email provided, check if a customer exists with same email but NO shopify_customer_id
    let existingCustomer = null;
    if (email) {
      const { data: customerByEmail } = await supabase
        .from("customers")
        .select("id, status, shopify_customer_id")
        .eq("email", email)
        .eq("shop_id", loyaltyShop.id)
        .maybeSingle();

      console.log("[debug] api.customer.setstatus - customerByEmail:", customerByEmail);

      // If found and shopify_customer_id is missing, update it
      if (customerByEmail && !customerByEmail.shopify_customer_id) {
        console.log("[debug] api.customer.setstatus - Found existing customer by email, updating shopify_customer_id");
        const isActivating = customerByEmail.status !== "active";
        const mergePayload = {
          shopify_customer_id: customerId,
          status: "active",
          ...(isActivating ? { status_changed_timestamp: new Date().toISOString() } : {}),
        };
        const { data: updated, error: updateError } = await supabase
          .from("customers")
          .update(mergePayload)
          .eq("id", customerByEmail.id)
          .select("id, status");

        if (updateError) {
          console.error("❌ Supabase update error:", updateError);
          return new Response(JSON.stringify({ error: updateError.message }), { status: 500, headers: corsHeaders });
        }

        const updatedCustomer = Array.isArray(updated) ? updated[0] : updated;
        console.log("[debug] api.customer.setstatus - Updated customer with customerId:", updatedCustomer);
        
        // Insert Status Changed event (merged by email)
        try {
          const { error: evtErr } = await supabase.from("events").insert({
            shop_id: loyaltyShop.id,
            customer_id: updatedCustomer.id,
            event_type: "Status Changed",
            points: null,
          });
          if (evtErr) console.warn("[setstatus] Event insert error (merged):", evtErr);
        } catch (e) {
          console.warn("[setstatus] Exception inserting event (merged):", e?.message || e);
        }

        // Add "active" tag to Shopify customer
        await addActiveTagToShopifyCustomer(loyaltyShop.shopify_domain, loyaltyShop.access_token, customerId);

        return new Response(JSON.stringify({ success: true, status: updatedCustomer?.status || "active", merged: true }), { status: 200, headers: corsHeaders });
      }

      // If found with existing shopify_customer_id, use it
      if (customerByEmail && customerByEmail.shopify_customer_id) {
        existingCustomer = customerByEmail;
      }
    }

    // 2. Check if customer exists by shopify_customer_id (if not already found by email)
    if (!existingCustomer) {
      const { data: customerById } = await supabase
        .from("customers")
        .select("id, status")
        .eq("shopify_customer_id", customerId)
        .eq("shop_id", loyaltyShop.id)
        .maybeSingle();

      console.log("[debug] api.customer.setstatus - customerById:", customerById);
      existingCustomer = customerById;
    }

    // 3. If still no customer found, create new one
    if (!existingCustomer) {
      const { data: newCustomer, error: insertError } = await supabase
        .from("customers")
        .insert({
          shopify_customer_id: customerId,
          shop_id: loyaltyShop.id,
          email: email || null,
          status: "active",
          status_changed_timestamp: new Date().toISOString(),
          tier: "Circle",
          redeemable_points: 0,
          lifetime_points: 0,
        })
        .select("id, status")
        .single();

      if (insertError) {
        console.error("❌ Supabase insert error:", insertError);
        return new Response(JSON.stringify({ error: insertError.message }), { status: 500, headers: corsHeaders });
      }

      console.log("[debug] api.customer.setstatus - created new customer:", newCustomer);
      
      // Insert Status Changed event (new customer)
      try {
        const { error: evtErr } = await supabase.from("events").insert({
          shop_id: loyaltyShop.id,
          customer_id: newCustomer.id,
          event_type: "Status Changed",
          points: null,
        });
        if (evtErr) console.warn("[setstatus] Event insert error (created):", evtErr);
      } catch (e) {
        console.warn("[setstatus] Exception inserting event (created):", e?.message || e);
      }

      // Add "active" tag to Shopify customer
      await addActiveTagToShopifyCustomer(loyaltyShop.shopify_domain, loyaltyShop.access_token, customerId);

      return new Response(JSON.stringify({ success: true, status: newCustomer.status, created: true }), { status: 200, headers: corsHeaders });
    }

    // 4. Customer exists - update status to active
    const isActivating = existingCustomer.status !== "active";
    const updatePayload = {
      status: "active",
      ...(isActivating ? { status_changed_timestamp: new Date().toISOString() } : {}),
    };
    const { data, error } = await supabase
      .from("customers")
      .update(updatePayload)
      .eq("id", existingCustomer.id)
      .select("id, status");

    console.log("[debug] api.customer.setstatus - supabase update returned:", { data, error });

    if (error) {
      console.error("❌ Supabase update error:", error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }

    // Supabase may return an array of rows for update/select; handle both cases.
    const updated = Array.isArray(data) ? data[0] : data;

    if (Array.isArray(data) && data.length > 1) {
      console.warn("⚠️ Supabase update returned multiple rows; using the first one.", { count: data.length });
    }

    if (!updated) {
      return new Response(JSON.stringify({ success: false, message: "Customer not found or not updated" }), { status: 200, headers: corsHeaders });
    }

    // Add "active" tag to Shopify customer
    // Insert Status Changed event (updated existing)
    try {
      const { error: evtErr } = await supabase.from("events").insert({
        shop_id: loyaltyShop.id,
        customer_id: updated.id,
        event_type: "Status Changed",
        points: null,
      });
      if (evtErr) console.warn("[setstatus] Event insert error (updated):", evtErr);
    } catch (e) {
      console.warn("[setstatus] Exception inserting event (updated):", e?.message || e);
    }

    await addActiveTagToShopifyCustomer(loyaltyShop.shopify_domain, loyaltyShop.access_token, customerId);

    return new Response(JSON.stringify({ success: true, status: updated.status || "Active", created: false }), { status: 200, headers: corsHeaders });
  } catch (error) {
    console.error("❌ Error in api.customer.setstatus:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
};
