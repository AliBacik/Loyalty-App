import { useLoaderData, Link, useRevalidator } from "@remix-run/react";
import { useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import {
  Page,
  Layout,
  Text,
  Card,
  BlockStack,
  AppProvider,
  TextField,
  Button,
  ButtonGroup,
} from "@shopify/polaris";

import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import dashboardStyles from "../styles/dashboard.css?url";

export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: dashboardStyles },
];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const page = url.searchParams.get("page") || "1";
  if (!id) return new Response(JSON.stringify({ error: "Customer ID is required" }), { status: 400 });

  const { data: shopRow } = await supabase
    .from("shops")
    .select("id")
    .eq("shopify_domain", shop)
    .single();

  if (!shopRow) {
    return new Response(JSON.stringify({ error: "Shop not found" }), { status: 404 });
  }

  // Scope by shop_id so one store can never open another store's customer record.
  const { data: customer } = await supabase
    .from("customers")
    .select("id,email,redeemable_points,lifetime_points,shopify_customer_id,tier,discount_codes,status")
    .eq("id", id)
    .eq("shop_id", shopRow.id)
    .single();

  const { data: events = [] } = await supabase
    .from("events")
    .select("event_type,points,created_at,remaining_points,expires_at,redeemed_code,event_desc")
    .eq("customer_id", id)
    .eq("shop_id", shopRow.id)
    .order("created_at", { ascending: false })
    .limit(100);

  // The browser can't read process.env, and window.location.hostname resolves to
  // admin.shopify.com inside the embedded admin — so both must come from the loader.
  return { customer, events, page, shop, appUrl: process.env.SHOPIFY_APP_URL || "" };
};

export default function CustomerPage() {
  const { customer, events, page, shop, appUrl } = useLoaderData();
  const app = useAppBridge();
  const revalidator = useRevalidator();
  const [redeemDelta, setRedeemDelta] = useState(0);
  const [cancellingCode, setCancellingCode] = useState(null);

  if (!customer) return <div style={{ padding: 20 }}>Customer not found</div>;

  const getSessionToken = async () => {
    try {
      return await app.idToken();
    } catch (e) {
      console.error('Failed to get session token:', e);
      return null;
    }
  };

  const postAdjust = async (pointsDelta) => {
    if (pointsDelta === 0) return alert('Enter a value to adjust');
    if (!confirm(`Redeemable: ${pointsDelta > 0 ? '+' : ''}${pointsDelta} points?`)) return;
    try {
      const sessionToken = await getSessionToken();
      if (!sessionToken) return alert('Failed to get session token');

      const res = await fetch(`${appUrl}/api/loyalty/adjust`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          shop,
          customerId: customer.shopify_customer_id,
          points: pointsDelta,
          reason: 'Admin adjust (redeemable)',
        }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert('Adjust failed: ' + (json.error || res.statusText));
      } else {
        alert('Adjustment successful');
        setRedeemDelta(0);
        try { revalidator.revalidate(); } catch (e) { window.location.reload(); }
      }
    } catch (e) {
      console.error(e);
      alert('Request failed: ' + e.message);
    }
  };

  const clearDiscounts = async () => {
    if (!confirm('Remove all discount codes for this customer?')) return;
    try {
      const sessionToken = await getSessionToken();
      if (!sessionToken) return alert('Failed to get session token');

      const res = await fetch(`${appUrl}/api/admin/clear_discounts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ shop, customerId: customer.shopify_customer_id })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) alert('Failed: ' + (json.error || res.statusText));
      else { alert('Discount codes cleared'); try { revalidator.revalidate(); } catch (e) { window.location.reload(); } }
    } catch (e) { console.error(e); alert('Request failed: ' + e.message); }
  };

  const cancelDiscount = async (code) => {
    if (!confirm(`Cancel discount code "${code}"? Points will be refunded.`)) return;
    setCancellingCode(code);
    try {
      const sessionToken = await getSessionToken();
      if (!sessionToken) { alert('Failed to get session token'); return; }

      const res = await fetch(`${appUrl}/api/admin/cancel_discount`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ shop, customerId: customer.shopify_customer_id, code }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) alert('Failed: ' + (json.error || res.statusText));
      else {
        alert(`Code "${code}" cancelled. ${json.refundedPoints || 0} points refunded.`);
        try { revalidator.revalidate(); } catch (e) { window.location.reload(); }
      }
    } catch (e) {
      console.error(e);
      alert('Request failed: ' + e.message);
    } finally {
      setCancellingCode(null);
    }
  };

  const resetCustomer = async () => {
    if (!confirm('Reset customer completely? This will delete allocations, events and set points to 0.')) return;
    try {
      const sessionToken = await getSessionToken();
      if (!sessionToken) return alert('Failed to get session token');

      const res = await fetch(`${appUrl}/api/admin/reset_customer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ shop, customerId: customer.shopify_customer_id })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) alert('Failed: ' + (json.error || res.statusText));
      else { alert('Customer reset complete'); try { revalidator.revalidate(); } catch (e) { window.location.reload(); } }
    } catch (e) { console.error(e); alert('Request failed: ' + e.message); }
  };

  return (
    <AppProvider>
      <Page title={`Customer: ${customer.email}`}>
        <BlockStack gap="200">
          <div style={{ marginBottom: 8 }}>
            <Link to={`/app?page=${page}`} style={{ textDecoration: 'none', background:'black',borderRadius:4, padding:'8px 8px', color:'white'}}>
              ← Back to Customers
            </Link>
          </div>
          {/* CUSTOMER INFO CARD */}
          <Layout>
            <Layout.Section variant="oneThird">
              <Card>
                <BlockStack gap="400">
                  <BlockStack gap="200">
                    <Text as="h2" variant="headingMd">
                      Customer Details
                    </Text>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: 'left', padding: 8, textTransform: 'uppercase', fontWeight: 700, color: '#111' }}>Email</th>
                            <th style={{ textAlign: 'left', padding: 8, textTransform: 'uppercase', fontWeight: 700, color: '#111' }}>Status</th>
                            <th style={{ textAlign: 'right', padding: 8, textTransform: 'uppercase', fontWeight: 700, color: '#111' }}>Redeemable</th>
                            <th style={{ textAlign: 'right', padding: 8, textTransform: 'uppercase', fontWeight: 700, color: '#111' }}>Lifetime</th>
                            <th style={{ textAlign: 'left', padding: 8, textTransform: 'uppercase', fontWeight: 700, color: '#111' }}>Tier</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr style={{ borderTop: '1px solid #eee' }}>
                            <td style={{ padding: 8 }}>{customer.email}</td>
                            <td style={{ padding: 8 }}>{customer.status ?? 'unknown'}</td>
                            <td style={{ padding: 8, textAlign: 'right' }}>{customer.redeemable_points ?? 0}</td>
                            <td style={{ padding: 8, textAlign: 'right' }}>{customer.lifetime_points ?? 0}</td>
                            <td style={{ padding: 8 }}>
                              <span style={{ color: customer.tier === 'Inner Circle' ? '#D4AF37' : customer.tier === 'Legacy Circle' ? '#1E90FF' : 'inherit' }}>
                                {customer.tier ?? 'Circle'}
                              </span>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </BlockStack>
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>

          {/* ADJUST CONTROLS CARD */}
          <Layout>
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Adjust Points
                  </Text>

                  <BlockStack gap="300">
                    {/* Redeemable Points Section */}
                    <div>
                      <BlockStack gap="200">
                        <Text as="h3" variant="headingMd">
                          Redeemable
                        </Text>
                        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
                          <TextField
                            label="Amount"
                            type="number"
                            value={String(redeemDelta)}
                            onChange={(val) => setRedeemDelta(Number(val) || 0)}
                            placeholder="0"
                            autoComplete="off"
                            style={{ width: '100px' }}
                          />
                          <ButtonGroup>
                            <Button onClick={() => postAdjust(redeemDelta, 'redeemable')}>
                              Add
                            </Button>
                            <Button onClick={() => postAdjust(-redeemDelta, 'redeemable')} tone="critical">
                              Remove
                            </Button>
                          </ButtonGroup>
                        </div>
                      </BlockStack>
                    </div>
                  </BlockStack>

                  {/* Admin Actions Section */}
                  <div style={{ borderTop: '1px solid #e0e0e0', paddingTop: 16 }}>
                    <BlockStack gap="200">
                      <Text as="h3" variant="headingMd">
                        Admin Actions
                      </Text>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <Button onClick={clearDiscounts} tone="warning">
                          Clear Discount Codes
                        </Button>
                        <Button onClick={resetCustomer} tone="critical">
                          Reset Customer
                        </Button>
                      </div>
                    </BlockStack>
                  </div>
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>

          {/* DISCOUNT CODES CARD */}
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Discount Codes
                </Text>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: 8, textTransform: 'uppercase', fontWeight: 700, color: '#111' }}>Code</th>
                        <th style={{ textAlign: 'right', padding: 8, textTransform: 'uppercase', fontWeight: 700, color: '#111' }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(customer.discount_codes || []).length ? (customer.discount_codes || []).map(code => (
                        <tr key={code} style={{ borderTop: '1px solid #eee' }}>
                          <td style={{ padding: 8, fontFamily: 'monospace' }}>{code}</td>
                          <td style={{ padding: 8, textAlign: 'right' }}>
                            <Button
                              size="slim"
                              tone="critical"
                              onClick={() => cancelDiscount(code)}
                              loading={cancellingCode === code}
                              disabled={cancellingCode !== null}
                            >
                              Cancel
                            </Button>
                          </td>
                        </tr>
                      )) : (
                        <tr><td colSpan={2} style={{ padding: 8, color: '#888' }}>No active discount codes</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* RECENT EVENTS CARD */}
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Recent Events
                </Text>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: 8, textTransform: 'uppercase', fontWeight: 700, color: '#111' }}>Date</th>
                        <th style={{ textAlign: 'left', padding: 8, textTransform: 'uppercase', fontWeight: 700, color: '#111' }}>Type</th>
                        <th style={{ textAlign: 'right', padding: 8, textTransform: 'uppercase', fontWeight: 700, color: '#111' }}>Points</th>
                        <th style={{ textAlign: 'right', padding: 8, textTransform: 'uppercase', fontWeight: 700, color: '#111' }}>Remaining</th>
                      </tr>
                    </thead>
                    <tbody>
                      {events.length ? events.map(ev => (
                        <tr key={ev.created_at + ev.event_type} style={{ borderTop: '1px solid #eee' }}>
                          <td style={{ padding: 8 }}>{new Date(ev.created_at).toLocaleString()}</td>
                          <td style={{ padding: 8, color: ev.event_type === 'Earn' ? '#1a7f37' : ev.event_type === 'Refund' ? '#c21f1f' : 'inherit' }}>
                            {ev.event_type === 'Earn' && ev.event_desc ? ev.event_desc : ev.event_type}
                          </td>
                          <td style={{ padding: 8, textAlign: 'right' }}>{ev.points}</td>
                          <td style={{ padding: 8, textAlign: 'right' }}>{ev.remaining_points ?? ''}</td>
                        </tr>
                      )) : (
                        <tr><td colSpan={4} style={{ padding: 8 }}>No events found</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </BlockStack>
            </Card>
          </Layout.Section>
        </BlockStack>
      </Page>
    </AppProvider>
  );
}

