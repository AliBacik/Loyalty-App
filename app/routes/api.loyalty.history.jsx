import { supabase } from "../supabase.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId");
  const shop = url.searchParams.get("shop");

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers });

  if (!customerId || !shop) {
    return new Response(
      JSON.stringify({ error: "Missing customerId or shop parameter" }),
      { status: 400, headers }
    );
  }

  try {
    // 1. Get Shop
    const { data: loyaltyShop, error: shopError } = await supabase
      .from("shops")
      .select("id, shopify_domain")
      .eq("shopify_domain", shop)
      .single();

    if (shopError || !loyaltyShop) {
      return new Response(
        JSON.stringify({ error: "Shop not found" }),
        { status: 404, headers }
      );
    }

    // 2. Resolve incoming customerId to internal customer.id
    // Try matching as shopify_customer_id first; if not found, treat as internal customers.id
    let customer = null;
    let customerError = null;

    const { data: byShopify, error: errShopify } = await supabase
      .from("customers")
      .select("id")
      .eq("shopify_customer_id", customerId)
      .eq("shop_id", loyaltyShop.id)
      .single();

    customer = byShopify;
    customerError = errShopify;

    if (!customer) {
      const { data: byId, error: errById } = await supabase
        .from("customers")
        .select("id")
        .eq("id", customerId)
        .eq("shop_id", loyaltyShop.id)
        .single();

      customer = byId;
      customerError = errById;
    }

    if (customerError || !customer) {
      return new Response(
        JSON.stringify({ error: "Customer not found", activities: [] }),
        { status: 404, headers }
      );
    }

    // 3. Get all events for this customer
    const { data: eventsData, error: eventsError } = await supabase
      .from("events")
      .select("*")
      .eq("customer_id", customer.id)
      .order("created_at", { ascending: false });

    if (eventsError) {
      console.error("Error fetching events:", eventsError);
      return new Response(
        JSON.stringify({ error: "Failed to fetch events" }),
        { status: 500, headers }
      );
    }

    const events = eventsData || [];

    // 5. Process events and build activities array
    const activities = events.map((event) => {
      return {
        id: event.id,
        date: event.created_at,
        expiredDate: event.expires_at,
        eventType: event.event_type,
        eventDesc: event.event_desc || null,
        points: event.points,
        status: determineStatus(event),
        orderName: event.shopify_order_name || null,
        shopifyOrderId: event.shopify_order_id,
        redeemedCode: event.redeemed_code || null,
      };
    });

    return new Response(
      JSON.stringify({
        success: true,
        activities,
      }),
      { status: 200, headers }
    );
  } catch (error) {
    console.error("Unexpected error in loyalty history API:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", details: error.message || String(error) }),
      { status: 500, headers }
    );
  }
};

/**
 * Determines the status of an activity based on event data
 * @param {Object} event - The event from database
 * @returns {string} - "Available" or "Removed"
 */
function determineStatus(event) {
  const now = new Date();
  const expiresAt = event.expires_at ? new Date(event.expires_at) : null;

  // If event type is Expire, status is Removed
  if (event.event_type === "Expire") {
    return "Removed";
  }

  // If points are negative (redemption/coupon creation), status is Removed
  if (event.points < 0) {
    return "Removed";
  }

  // If remaining_points is 0, it means points are fully used or expired
  if (event.remaining_points === 0) {
    return "Removed";
  }

  // If there's an expiry date and it's in the past
  if (expiresAt && expiresAt < now) {
    return "Removed";
  }

  // Otherwise, points are available
  return "Available";
}
