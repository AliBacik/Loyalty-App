import { supabase } from "../supabase.server";

// CORS Headers
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
};

// Map gift keys to points (adjustable)
const GIFT_POINTS = {
    join: 100,
    birthdayadded: 150,
    newsletter: 150,
    instagram: 100,
    review: 150,
    tagsocialmedia: 150,
    tiktok: 100,
    customerstory: 200,
};

export const loader = async () => {
    return new Response(null, { headers: corsHeaders });
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

    const shop = body.shop;
    if (!shop) {
        return new Response(JSON.stringify({ error: 'Missing required field: shop' }), { status: 400, headers: corsHeaders });
    }

    const { email, gift } = body;
    console.log(`[point_gifts] REQUEST — shop: ${shop} | email: ${email} | gift: ${gift}`);

    if (!email || !gift) return new Response(JSON.stringify({ error: 'Missing required fields: email, gift' }), { status: 400, headers: corsHeaders });

    const giftKey = String(gift).toLowerCase();
    if (!Object.keys(GIFT_POINTS).includes(giftKey)) {
        console.warn(`[point_gifts] Unknown gift key: "${giftKey}" | shop: ${shop} | email: ${email}`);
        return new Response(JSON.stringify({ error: 'Unknown gift type' }), { status: 400, headers: corsHeaders });
    }
    console.log(`[point_gifts] Gift resolved — key: ${giftKey} | pts: ${GIFT_POINTS[giftKey]} | shop: ${shop}`);

    const pts = Number(GIFT_POINTS[giftKey]);

    // Find shop row (include access_token for Shopify checks)
    const { data: shopRow } = await supabase.from('shops').select('id,access_token').eq('shopify_domain', shop).single();
    if (!shopRow) return new Response(JSON.stringify({ error: 'Shop not found' }), { status: 404, headers: corsHeaders });

    // If this is a newsletter gift, log Shopify email marketing consent state (do NOT block — gift must always be recorded in Supabase).
    if (giftKey === 'newsletter') {
        try {
            const accessToken = shopRow?.access_token;
            if (accessToken) {
                const searchQuery = `
                  query FindCustomerByEmail($query: String!) {
                    customers(first:1, query: $query) { edges { node { id email emailMarketingConsent { marketingState } } } }
                  }
                `;
                const qres = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Shopify-Access-Token': accessToken,
                    },
                    body: JSON.stringify({ query: searchQuery, variables: { query: `email:${email}` } }),
                });
                const qjson = await qres.json().catch(() => null);
                const node = qjson?.data?.customers?.edges?.[0]?.node;
                const state = node?.emailMarketingConsent?.marketingState;
                console.log(`[point_gifts] Newsletter Shopify check — email: ${email} | marketingState: ${state ?? 'not found'}`);
                // NOTE: We intentionally do NOT return early here even if already SUBSCRIBED.
                // The gift must always be recorded as pending in Supabase so the pending reward is created.
            }
        } catch (e) {
            console.error('[point_gifts] Shopify subscription check failed', e);
        }
    }

    // Find or create customer (include gifts column)
    const { data: existingCustomer } = await supabase.from('customers').select('id,email,redeemable_points,lifetime_points,tier,gifts').eq('email', email).eq('shop_id', shopRow.id).single();

    let customer = existingCustomer;
    if (!customer) {
        const insert = await supabase.from('customers').insert({ shop_id: shopRow.id, email: email, redeemable_points: 0, lifetime_points: 0, tier: 'Circle', gifts: {} }).select().single();
        if (insert.error) {
            console.error('[point_gifts] Failed to create customer', insert.error);
            return new Response(JSON.stringify({ error: 'Failed to create customer' }), { status: 500, headers: corsHeaders });
        }
        customer = insert.data;
    }

    // Ensure gifts is an object
    let gifts = customer.gifts || {};
    if (typeof gifts === 'string') {
        try { gifts = JSON.parse(gifts); } catch (e) { gifts = {}; }
    }

    console.log(`[point_gifts] Current gifts — email: ${email} | gifts: ${JSON.stringify(gifts)}`);

    // If already granted, return without awarding.
    // For birthday: 'pending' means the flag is set but we still check if a pending reward actually exists —
    // if not (e.g. a previous insert failed), clear the flag and re-process.
    if (gifts[giftKey]) {
        if (giftKey === 'birthday' && gifts[giftKey] === 'pending') {
            const { data: existingPending } = await supabase
                .from('customer_pending_rewards')
                .select('id')
                .eq('customer_id', customer.id)
                .eq('gift_key', 'birthday')
                .eq('processed', false)
                .maybeSingle();
            if (!existingPending) {
                console.log(`[point_gifts] Birthday flag was pending but no reward row found — resetting | email: ${email}`);
                gifts['birthday'] = null;
                delete gifts['birthday'];
                await supabase.from('customers').update({ gifts }).eq('id', customer.id);
                // fall through to re-process
            } else {
                console.log(`[point_gifts] Birthday already pending (reward row exists) — skipping | email: ${email}`);
                return new Response(JSON.stringify({ success: true, message: 'Gift already granted', gift: giftKey }), { status: 200, headers: corsHeaders });
            }
        } else {
            console.log(`[point_gifts] Already granted — gift: ${giftKey} | email: ${email} | shop: ${shop}`);
            return new Response(JSON.stringify({ success: true, message: 'Gift already granted', gift: giftKey }), { status: 200, headers: corsHeaders });
        }
    }

    // Compute expiry and remaining points
    const isPositive = pts > 0;
    let expiresAt = null;
    let remainingPoints = 0;
    if (isPositive) { const d = new Date(); d.setMonth(d.getMonth() + 6); expiresAt = d.toISOString(); remainingPoints = Math.abs(pts); }

    console.log(`[point_gifts] Processing — gift: ${giftKey} | email: ${email} | customerId: ${customer.id} | pts: ${pts}`);

    if (giftKey === 'review') {
        // review is reviewed manually via the Pending Rewards dashboard — same flow as tagsocialmedia.
        try {
            const extra = body?.review || null;
            if (extra) gifts['review_meta'] = extra;
        } catch (e) { /* ignore */ }
        gifts['review'] = 'pending';
        console.log(`[point_gifts] review — marked pending | email: ${email} | meta: ${JSON.stringify(gifts['review_meta'] || null)}`);

        const { error: upErr } = await supabase.from('customers').update({ gifts }).eq('id', customer.id);
        if (upErr) {
            console.error('[point_gifts] Failed to mark review submitted', upErr);
            return new Response(JSON.stringify({ error: 'Failed to save review submission' }), { status: 500, headers: corsHeaders });
        }
    } else if (giftKey === 'customerstory') {
        // customerstory is reviewed manually via the Pending Rewards dashboard — same flow as review/tagsocialmedia.
        try {
            const extra = body?.customerstory || null;
            if (extra) gifts['customerstory_meta'] = extra;
        } catch (e) { /* ignore */ }
        gifts['customerstory'] = 'pending';
        console.log(`[point_gifts] customerstory — marked pending | email: ${email} | meta: ${JSON.stringify(gifts['customerstory_meta'] || null)}`);

        const { error: upErr } = await supabase.from('customers').update({ gifts }).eq('id', customer.id);
        if (upErr) {
            console.error('[point_gifts] Failed to mark customerstory submitted', upErr);
            return new Response(JSON.stringify({ error: 'Failed to save customerstory submission' }), { status: 500, headers: corsHeaders });
        }
    } else if (giftKey === 'tagsocialmedia') {
        // tagsocialmedia is reviewed manually via the Pending Rewards dashboard.
        // Just store the submission meta and mark the flag — no points awarded here.
        // Admin clicks "Submit" in the drawer which calls award_by_email to give points.
        try {
            const extra = body?.tagsocialmedia || body?.tags_socialmedia || null;
            if (extra) gifts['tagsocialmedia_meta'] = extra;
        } catch (e) { /* ignore */ }
        gifts['tagsocialmedia'] = 'pending';
        console.log(`[point_gifts] tagsocialmedia — marked pending | email: ${email} | meta: ${JSON.stringify(gifts['tagsocialmedia_meta'] || null)}`);

        const { error: upErr } = await supabase.from('customers').update({ gifts }).eq('id', customer.id);
        if (upErr) {
            console.error('[point_gifts] Failed to mark tagsocialmedia submitted', upErr);
            return new Response(JSON.stringify({ error: 'Failed to save submission' }), { status: 500, headers: corsHeaders });
        }
    } else if (giftKey !== 'newsletter') {
        // Immediate award for non-newsletter, non-tagsocialmedia gifts
        const { error: evErr } = await supabase.from('events').insert({ shop_id: shopRow.id, customer_id: customer.id, event_type: 'Earn', points: pts, remaining_points: remainingPoints, expires_at: expiresAt, event_desc: giftKey }).select();
        if (evErr) {
            console.error('[point_gifts] Failed to insert event', evErr);
            return new Response(JSON.stringify({ error: 'Failed to create event' }), { status: 500, headers: corsHeaders });
        }

        gifts[giftKey] = true;
        const newRedeemable = (customer.redeemable_points || 0) + pts;
        const newLifetime = (customer.lifetime_points || 0) + pts;
        console.log(`[point_gifts] Points awarded — gift: ${giftKey} | email: ${email} | pts: +${pts} | redeemable: ${newRedeemable} | lifetime: ${newLifetime} | gifts: ${JSON.stringify(gifts)}`);

        const { error: custUpdateErr } = await supabase.from('customers').update({ gifts, redeemable_points: newRedeemable, lifetime_points: newLifetime }).eq('id', customer.id);
        if (custUpdateErr) {
            console.error(`[point_gifts] Failed to update customer — gift: ${giftKey} | email: ${email} | error:`, custUpdateErr);
            return new Response(JSON.stringify({ error: 'Failed to update customer' }), { status: 500, headers: corsHeaders });
        }
        console.log(`[point_gifts] Customer updated — gift: ${giftKey} | email: ${email} | gifts written: ${JSON.stringify(gifts)}`);

        // Tier check
        const { data: freshCustomer } = await supabase.from('customers').select('lifetime_points, tier').eq('id', customer.id).single();
        let newTier = freshCustomer?.tier || 'Circle';
        const lifetimePoints = freshCustomer?.lifetime_points || 0;
        if (lifetimePoints >= 2500) newTier = 'Legacy Circle'; else if (lifetimePoints >= 1000) newTier = 'Inner Circle'; else newTier = 'Circle';
        if (newTier !== freshCustomer?.tier) {
            await supabase.from('customers').update({ tier: newTier }).eq('id', customer.id);
        }

        // If birthdayadded: also create the annual birthday pending reward (500 pts on their birthday each year)
        if (giftKey === 'birthdayadded') {
            const birthdayPts = 500;
            let birthdayAvailableAt = new Date().toISOString(); // fallback: today
            const accessToken = shopRow?.access_token;
            if (accessToken) {
                try {
                    const birthdayQuery = `
                      query FindCustomerBirthday($query: String!) {
                        customers(first: 1, query: $query) {
                          edges { node { metafields(first: 20) { edges { node { namespace key value } } } } }
                        }
                      }
                    `;
                    const bres = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
                        body: JSON.stringify({ query: birthdayQuery, variables: { query: `email:${email}` } }),
                    });
                    const bjson = await bres.json().catch(() => null);
                    const metafields = bjson?.data?.customers?.edges?.[0]?.node?.metafields?.edges || [];
                    const rawBirthday = metafields.find(e => e.node.key === 'birthday')?.node?.value;
                    console.log(`[point_gifts] birthdayadded — birthday metafield | email: ${email} | raw: ${rawBirthday ?? 'not found'}`);
                    if (rawBirthday && /^\d{4}-\d{2}-\d{2}$/.test(rawBirthday)) {
                        const [, month, day] = rawBirthday.split('-');
                        const now2 = new Date();
                        const thisYear = now2.getUTCFullYear();
                        const thisYearDate = new Date(`${thisYear}-${month}-${day}T00:00:00.000Z`);
                        const targetDate = thisYearDate <= now2
                            ? new Date(`${thisYear + 1}-${month}-${day}T00:00:00.000Z`)
                            : thisYearDate;
                        birthdayAvailableAt = targetDate.toISOString();
                        console.log(`[point_gifts] birthdayadded — birthday pending | email: ${email} | available_at: ${birthdayAvailableAt}`);
                    }
                } catch (e) {
                    console.error('[point_gifts] birthdayadded — birthday metafield fetch failed', e);
                }
            }

            // Check if a birthday pending reward already exists (avoid duplicates)
            const { data: existingBirthdayReward } = await supabase
                .from('customer_pending_rewards')
                .select('id')
                .eq('customer_id', customer.id)
                .eq('gift_key', 'birthday')
                .eq('processed', false)
                .maybeSingle();

            if (existingBirthdayReward) {
                console.log(`[point_gifts] birthdayadded — birthday pending reward already exists, skipping | email: ${email}`);
            } else {
                // Re-fetch latest gifts before writing birthday:pending to avoid race condition
                const { data: freshForBirthday } = await supabase.from('customers').select('gifts').eq('id', customer.id).single();
                const latestGifts = freshForBirthday?.gifts || gifts;
                if (typeof latestGifts === 'object') latestGifts['birthday'] = 'pending';
                await supabase.from('customers').update({ gifts: latestGifts }).eq('id', customer.id);

                const { error: bpendErr } = await supabase.from('customer_pending_rewards').insert({
                    shop_id: shopRow.id,
                    customer_id: customer.id,
                    email: customer.email,
                    points: birthdayPts,
                    available_at: birthdayAvailableAt,
                    gift_key: 'birthday',
                    processed: false,
                }).select();
                if (bpendErr) {
                    console.error('[point_gifts] birthdayadded — failed to create birthday pending reward', bpendErr);
                } else {
                    console.log(`[point_gifts] birthdayadded — birthday pending reward created | email: ${email} | pts: ${birthdayPts} | available_at: ${birthdayAvailableAt}`);
                }
            }
        }
    } else {
        // Newsletter: create a pending reward (do NOT award points now)
        // Check if a pending reward already exists to avoid duplicates
        const { data: existingNewsletterReward } = await supabase
            .from('customer_pending_rewards')
            .select('id')
            .eq('customer_id', customer.id)
            .eq('gift_key', 'newsletter')
            .eq('processed', false)
            .maybeSingle();

        if (existingNewsletterReward) {
            console.log(`[point_gifts] Newsletter — pending reward already exists, skipping insert | email: ${email}`);
            // Ensure the gifts flag is still set even if reward row already existed
            if (!gifts['newsletter']) {
                gifts['newsletter'] = 'pending';
                await supabase.from('customers').update({ gifts }).eq('id', customer.id);
            }
        } else {
            gifts[giftKey] = 'pending';
            const { error: updErr } = await supabase.from('customers').update({ gifts }).eq('id', customer.id);
            if (updErr) {
                console.error('[point_gifts] Failed to mark newsletter gift as pending on customer', updErr);
                return new Response(JSON.stringify({ error: 'Failed to mark gift pending' }), { status: 500, headers: corsHeaders });
            }

            const availableAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
            console.log(`[point_gifts] Newsletter — pending reward created | email: ${email} | pts: ${pts} | available_at: ${availableAt}`);
            const { error: pendErr } = await supabase.from('customer_pending_rewards').insert({ shop_id: shopRow.id, customer_id: customer.id, email: customer.email, points: pts, available_at: availableAt, gift_key: giftKey, processed: false }).select();
            if (pendErr) {
                console.error('[point_gifts] Failed to insert pending reward', pendErr);
                return new Response(JSON.stringify({ error: 'Failed to create pending reward', details: pendErr }), { status: 500, headers: corsHeaders });
            }
        }
    }

    // If this was a newsletter gift and customer wasn't subscribed on Shopify,
    // set subscription on Shopify and update Supabase timestamp. Klaviyo will be sent when the pending reward is granted.
    if (giftKey === 'newsletter') {
        try {
            // Attempt to find the Shopify customer ID via admin GraphQL
            const accessToken = shopRow?.access_token;
            let shopifyCustomerGid = null;
            if (accessToken && customer.email) {
                const searchQuery = `
                  query FindCustomerByEmail($query: String!) {
                    customers(first:1, query: $query) { edges { node { id email emailMarketingConsent { marketingState } } } }
                  }
                `;
                const qres = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Shopify-Access-Token': accessToken,
                    },
                    body: JSON.stringify({ query: searchQuery, variables: { query: `email:${customer.email}` } }),
                });
                const qjson = await qres.json().catch(() => null);
                const node = qjson?.data?.customers?.edges?.[0]?.node;
                shopifyCustomerGid = node?.id || null;

                // If we found the customer on Shopify, try to set their marketing consent
                if (shopifyCustomerGid) {
                    try {
                        const mutation = `
                          mutation customerEmailMarketingConsentUpdate($input: CustomerEmailMarketingConsentUpdateInput!) {
                            customerEmailMarketingConsentUpdate(input: $input) {
                              customer { id emailMarketingConsent { marketingState } }
                              userErrors { field message }
                            }
                          }
                        `;
                        const mres = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-Shopify-Access-Token': accessToken,
                            },
                            body: JSON.stringify({
                                query: mutation,
                                variables: { input: { customerId: shopifyCustomerGid, emailMarketingConsent: { marketingState: 'SUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN' } } },
                            }),
                        });
                        const mjson = await mres.json().catch(() => null);
                        const userErrors = mjson?.data?.customerEmailMarketingConsentUpdate?.userErrors || [];
                        const updatedState = mjson?.data?.customerEmailMarketingConsentUpdate?.customer?.emailMarketingConsent?.marketingState;
                        if (userErrors.length > 0) {
                            console.warn('[point_gifts] Shopify customerEmailMarketingConsentUpdate userErrors:', userErrors);
                        }
                        if (updatedState === 'SUBSCRIBED') {
                            console.log(`[point_gifts] Shopify marketing consent set to SUBSCRIBED | email: ${email}`);
                            try {
                                const { error: upErr } = await supabase.from('customers').update({ status_changed_timestamp: new Date().toISOString() }).eq('id', customer.id);
                                if (upErr) console.warn('[point_gifts] Failed to update status_changed_timestamp in Supabase', upErr);
                            } catch (e) {
                                console.warn('[point_gifts] Supabase update exception for subscription timestamp', e);
                            }
                        } else {
                            console.warn('[point_gifts] Shopify marketing consent update did not result in SUBSCRIBED', updatedState);
                        }
                    } catch (e) {
                        console.warn('[point_gifts] Shopify customerEmailMarketingConsentUpdate exception:', e);
                    }
                }
            }
        } catch (e) {
            console.error('[point_gifts] Error while attempting to subscribe customer on Shopify:', e);
        }

        // Send Klaviyo event regardless of Shopify mutation success (we already attempted to subscribe)
        const klaviyoApiKey = process.env.KLAVIYO_API_KEY;
        if (klaviyoApiKey && customer.email) {
            try {
                const klaviyoPayload = {
                    data: {
                        type: 'event',
                        attributes: {
                            metric: {
                                data: {
                                    type: 'metric',
                                    attributes: { name: 'Subscribed to Email Marketing' }
                                }
                            },
                            profile: {
                                data: {
                                    type: 'profile',
                                    attributes: { email: customer.email }
                                }
                            },
                            properties: {
                                points_awarded: pts,
                                source: 'point_gifts',
                                email: customer.email
                            },
                            time: new Date().toISOString(),
                        }
                    }
                };

                const res = await fetch('https://a.klaviyo.com/api/events/', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Klaviyo-API-Key ${klaviyoApiKey}`,
                        'revision': '2023-12-15',
                    },
                    body: JSON.stringify(klaviyoPayload),
                });

                if (!res.ok) {
                    const txt = await res.text().catch(() => '');
                    console.warn('[point_gifts] Klaviyo event failed:', res.status, txt);
                } else {
                    console.log(`[point_gifts] Klaviyo 'Subscribed to Email Marketing' event sent for ${customer.email}`);
                }
            } catch (e) {
                console.warn('[point_gifts] Klaviyo event exception:', e);
            }
        }
    }

    // Refresh final customer state (reflects pending flag or awarded points)
    const { data: finalCustomer } = await supabase.from('customers').select('redeemable_points, lifetime_points, tier, gifts').eq('id', customer.id).single();
    console.log(`[point_gifts] DONE — gift: ${giftKey} | email: ${email} | tier: ${finalCustomer?.tier} | redeemable: ${finalCustomer?.redeemable_points} | lifetime: ${finalCustomer?.lifetime_points}`);

    return new Response(JSON.stringify({ success: true, customerId: customer.id, email: customer.email, gift: giftKey, points_awarded: giftKey === 'newsletter' ? 0 : pts, redeemable_points: finalCustomer?.redeemable_points || 0, lifetime_points: finalCustomer?.lifetime_points || 0, tier: finalCustomer?.tier || 'Circle', gifts: finalCustomer?.gifts || {} }), { status: 200, headers: corsHeaders });
};
