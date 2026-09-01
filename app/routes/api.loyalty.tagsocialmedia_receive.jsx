import { supabase } from "../supabase.server";
import { authenticate } from "../shopify.server";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
};

export const loader = async ({ request }) => {
    try {
        const url = new URL(request.url);
        const shop = url.searchParams.get('shop') || url.searchParams.get('domain') || null;
        if (!shop) return new Response(JSON.stringify({ error: 'Missing shop param' }), { status: 400, headers: corsHeaders });

        const { data: shopRow } = await supabase.from('shops').select('id').eq('shopify_domain', shop).single();
        if (!shopRow) return new Response(JSON.stringify({ error: 'Shop not found' }), { status: 404, headers: corsHeaders });

        const parseGifts = (raw) => {
            if (!raw) return {};
            if (typeof raw === 'string') { try { return JSON.parse(raw); } catch (e) { return {}; } }
            return raw;
        };

        // Tagsocialmedia pending — same query as before (was working)
        const { data: tagsocialAll, error: tsErr } = await supabase
            .from('customers')
            .select('id, email, gifts, redeemable_points, lifetime_points, tier')
            .eq('shop_id', shopRow.id)
            .filter('gifts->>tagsocialmedia', 'eq', 'pending')
            .order('email', { ascending: true });
        if (tsErr) return new Response(JSON.stringify({ error: tsErr.message }), { status: 500, headers: corsHeaders });

        const tagsocialPending = (tagsocialAll || []).filter(c => {
            const g = parseGifts(c.gifts);
            return g?.tagsocialmedia === 'pending';
        }).map(c => {
            const g = parseGifts(c.gifts);
            return { id: c.id, email: c.email, redeemable_points: c.redeemable_points, lifetime_points: c.lifetime_points, tier: c.tier, meta: g.tagsocialmedia_meta || null };
        });

        // Review pending
        const { data: reviewAll, error: rvErr } = await supabase
            .from('customers')
            .select('id, email, gifts, redeemable_points, lifetime_points, tier')
            .eq('shop_id', shopRow.id)
            .filter('gifts->>review', 'eq', 'pending')
            .order('email', { ascending: true });
        if (rvErr) return new Response(JSON.stringify({ error: rvErr.message }), { status: 500, headers: corsHeaders });

        const reviewPending = (reviewAll || []).filter(c => {
            const g = parseGifts(c.gifts);
            return g?.review === 'pending';
        }).map(c => {
            const g = parseGifts(c.gifts);
            return { id: c.id, email: c.email, redeemable_points: c.redeemable_points, lifetime_points: c.lifetime_points, tier: c.tier, meta: g.review_meta || null };
        });

        // Customerstory pending
        const { data: customerstoryAll, error: csErr } = await supabase
            .from('customers')
            .select('id, email, gifts, redeemable_points, lifetime_points, tier')
            .eq('shop_id', shopRow.id)
            .filter('gifts->>customerstory', 'eq', 'pending')
            .order('email', { ascending: true });
        if (csErr) return new Response(JSON.stringify({ error: csErr.message }), { status: 500, headers: corsHeaders });

        const customerstoryPending = (customerstoryAll || []).filter(c => {
            const g = parseGifts(c.gifts);
            return g?.customerstory === 'pending';
        }).map(c => {
            const g = parseGifts(c.gifts);
            return { id: c.id, email: c.email, redeemable_points: c.redeemable_points, lifetime_points: c.lifetime_points, tier: c.tier, meta: g.customerstory_meta || null };
        });

        console.log(`[tagsocialmedia_receive] shop: ${shop} | tagsocial: ${tagsocialPending.length} | review: ${reviewPending.length} | customerstory: ${customerstoryPending.length}`);

        return new Response(JSON.stringify({ tagsocial: tagsocialPending, review: reviewPending, customerstory: customerstoryPending }), { status: 200, headers: corsHeaders });
    } catch (e) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }
};

export const action = async ({ request }) => {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
    }

    let body = null;
    try { body = await request.json(); } catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: corsHeaders });
    }

    // Admin approval: called from dashboard after awarding points to flip pending → true
    // Supports gift_key: 'tagsocialmedia' (default) or 'review'
    if (body.op === 'approve') {
        try {
            const { session } = await authenticate.admin(request);
            if (!session?.shop) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        } catch (e) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        }

        const { customerId, gift_key } = body;
        if (!customerId) return new Response(JSON.stringify({ error: 'Missing customerId' }), { status: 400, headers: corsHeaders });
        const keyToApprove = gift_key === 'review' ? 'review' : gift_key === 'customerstory' ? 'customerstory' : 'tagsocialmedia';

        const { data: cust } = await supabase.from('customers').select('id, gifts').eq('id', customerId).single();
        if (!cust) return new Response(JSON.stringify({ error: 'Customer not found' }), { status: 404, headers: corsHeaders });

        let gifts = cust.gifts || {};
        if (typeof gifts === 'string') { try { gifts = JSON.parse(gifts); } catch (e) { gifts = {}; } }
        gifts[keyToApprove] = true;

        const { error: upErr } = await supabase.from('customers').update({ gifts }).eq('id', cust.id);
        if (upErr) return new Response(JSON.stringify({ error: 'Failed to update' }), { status: 500, headers: corsHeaders });

        return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
    }

    const shop = body.shop;
    if (!shop) {
        return new Response(JSON.stringify({ error: 'Missing required field: shop' }), { status: 400, headers: corsHeaders });
    }

    // Body may be any JSON; we'll store it under gifts.tagsocialmedia_meta for matching customers
    const payload = body;

    // Find shop row
    const { data: shopRow } = await supabase.from('shops').select('id').eq('shopify_domain', shop).single();
    if (!shopRow) return new Response(JSON.stringify({ error: 'Shop not found' }), { status: 404, headers: corsHeaders });

    // Some Postgres installations have `gifts` as JSON (not jsonb). Select
    // customers for the shop and filter in JS to avoid DB json operator errors.
    const { data: customersAll, error: custErr } = await supabase.from('customers').select('id,gifts').eq('shop_id', shopRow.id);
    if (custErr) {
        console.error('[tagsocialmedia_receive] Failed to query customers', custErr);
        return new Response(JSON.stringify({ error: 'Failed to query customers' }), { status: 500, headers: corsHeaders });
    }

    const customers = (customersAll || []).filter(c => {
        const gifts = c.gifts || {};
        if (typeof gifts === 'string') {
            try { return JSON.parse(gifts)?.tagsocialmedia === true; } catch (e) { return false; }
        }
        return gifts?.tagsocialmedia === true;
    });

    if (!customers || customers.length === 0) {
        return new Response(JSON.stringify({ success: true, updated: 0 }), { status: 200, headers: corsHeaders });
    }

    let updated = 0;
    let failed = 0;

    for (const c of customers) {
        try {
            let gifts = c.gifts || {};
            if (typeof gifts === 'string') {
                try { gifts = JSON.parse(gifts); } catch (e) { gifts = {}; }
            }
            gifts["tagsocialmedia_meta"] = payload;
            const { error: upErr } = await supabase.from('customers').update({ gifts }).eq('id', c.id);
            if (upErr) {
                console.error('[tagsocialmedia_receive] Failed to update customer', c.id, upErr);
                failed += 1;
            } else {
                updated += 1;
            }
        } catch (e) {
            console.error('[tagsocialmedia_receive] Exception updating customer', c.id, e);
            failed += 1;
        }
    }

    return new Response(JSON.stringify({ success: true, updated, failed }), { status: 200, headers: corsHeaders });
};
