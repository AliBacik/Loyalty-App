import { useLoaderData, Link } from "@remix-run/react";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import {
  Page,
  Layout,
  Text,
  Card,
  BlockStack,
  DataTable,
  AppProvider,
} from "@shopify/polaris";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  // 1. Check Supabase Connection & Shop Data
  const { data: shopData, error: shopError } = await supabase
    .from("shops")
    .select("*")
    .eq("shopify_domain", session.shop)
    .single();


  // Read URL params and pagination
  const url = new URL(request.url);
  const pageParam = Number(url.searchParams.get("page") || "1");
  const page = Math.max(1, pageParam);
  const pageSize = 50;
  const start = (page - 1) * pageSize;
  const end = start + pageSize - 1;

  // email filter (partial, case-insensitive)
  const emailFilter = (url.searchParams.get("email") || "").trim();

  // Sorting
  const allowedSorts = ["email", "redeemable_points", "lifetime_points", "tier"];
  const sortParam = url.searchParams.get("sort") || "email";
  const dirParam = url.searchParams.get("dir") || "asc";
  const sortBy = allowedSorts.includes(sortParam) ? sortParam : "email";
  const isAsc = dirParam !== "desc";

  // Build customers query with optional email filter
  let customersBuilder = supabase
    .from("customers")
    .select("id,email,redeemable_points,lifetime_points,shopify_customer_id,tier")
    .eq("shop_id", shopData?.id);

  if (emailFilter) {
    customersBuilder = customersBuilder.ilike("email", `%${emailFilter}%`);
  }

  const { data: customers = [], error: custErr } = await customersBuilder
    .order(sortBy, { ascending: isAsc })
    .range(start, end);

  // Count with same filter
  let countBuilder = supabase
    .from("customers")
    .select("id", { count: 'exact', head: true })
    .eq("shop_id", shopData?.id);

  if (emailFilter) {
    countBuilder = countBuilder.ilike("email", `%${emailFilter}%`);
  }

  const { count } = await countBuilder;

  const totalPages = Math.max(1, Math.ceil((count || 0) / pageSize));

  // Read selected customer from URL (if present)
  const selectedCustomerId = url.searchParams.get("customerId");

  let selectedCustomer = null;
  let customerEvents = [];

  if (selectedCustomerId) {
    const { data: custData } = await supabase
      .from("customers")
      .select("id,email,redeemable_points,lifetime_points,shopify_customer_id,tier")
      .eq("id", selectedCustomerId)
      .eq("shop_id", shopData?.id)
      .single();

    selectedCustomer = custData || null;

    const { data: eventsForCustomer = [] } = await supabase
      .from("events")
      .select("event_type,points,created_at,remaining_points,expires_at")
      .eq("customer_id", selectedCustomerId)
      .eq("shop_id", shopData?.id)
      .order("created_at", { ascending: false })
      .limit(100);

    customerEvents = eventsForCustomer;
  }

  // 2. Fetch Recent Events (To prove Webhooks are working)
  const { data: events, error: eventError } = await supabase
    .from("events")
    .select("event_type, points, created_at, customer:customers(email)")
    .eq("shop_id", shopData?.id)
    .order("created_at", { ascending: false })
    .limit(5);

  // Analytics moved to /app/analytics page
  const klaviyoApiKey = process.env.KLAVIYO_API_KEY; // kept for reference but analytics logic moved
  
  return {
    shop: session.shop,
    dbStatus: shopData ? "Connected ✅" : "Error ❌",
    shopInfo: shopData,
    recentEvents: events || [],
    customers,
    selectedCustomer,
    customerEvents,
    selectedCustomerId,
    page,
    totalPages,
    emailFilter,
    errors: { shopError, eventError, custErr },
  };
};

export default function Index() {
  const { shop, dbStatus, shopInfo, recentEvents, customers = [], page, totalPages, sort, dir, selectedCustomerId, emailFilter } = useLoaderData();

  

  const makeSortLinkWithDir = (col, direction) => {
    const params = new URLSearchParams(window.location.search);
    params.set("page", "1");
    params.set("sort", col);
    params.set("dir", direction === 'desc' ? 'desc' : 'asc');
    return `?${params.toString()}`;
  };

  const [openMenu, setOpenMenu] = useState(null);

  // Email filter state and handlers
  const [filterEmail, setFilterEmail] = useState(emailFilter || '');

  const applyFilter = () => {
    const params = new URLSearchParams(window.location.search);
    params.set('page', '1');
    if (filterEmail && filterEmail.trim() !== '') {
      params.set('email', filterEmail.trim());
    } else {
      params.delete('email');
    }
    if (selectedCustomerId) params.set('customerId', selectedCustomerId);
    window.location.search = params.toString();
  };

  const clearFilter = () => {
    setFilterEmail('');
    const params = new URLSearchParams(window.location.search);
    params.set('page', '1');
    params.delete('email');
    if (selectedCustomerId) params.set('customerId', selectedCustomerId);
    window.location.search = params.toString();
  };

  // Debounced auto-filter: when user types, wait then apply filter (600ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      // only navigate if the current URL email differs from state
      const currentEmail = (new URLSearchParams(window.location.search)).get('email') || '';
      if ((currentEmail || '').trim() === (filterEmail || '').trim()) return;
      const params = new URLSearchParams(window.location.search);
      params.set('page', '1');
      if (filterEmail && filterEmail.trim() !== '') {
        params.set('email', filterEmail.trim());
      } else {
        params.delete('email');
      }
      if (selectedCustomerId) params.set('customerId', selectedCustomerId);
      window.location.search = params.toString();
    }, 600);

    return () => clearTimeout(timer);
  }, [filterEmail, selectedCustomerId]);

  // Award form state
  const [awardEmail, setAwardEmail] = useState('');
  const [awardPoints, setAwardPoints] = useState(0);
  const [awardStatus, setAwardStatus] = useState(null);
  const [isAwarding, setIsAwarding] = useState(false);

  // Bulk import state
  const [bulkFile, setBulkFile] = useState(null);
  const [bulkProgress, setBulkProgress] = useState(null);
  const [bulkResults, setBulkResults] = useState([]);

  // Button disabled state flags
  const isPrevDisabled = page <= 1;
  const isNextDisabled = page >= totalPages;

  // Join Points Award state
  const [joinAwardStatus, setJoinAwardStatus] = useState(null); // null | 'loading' | { ok, msg }

  const handleAwardJoinPoints = async () => {
    if (!confirm('status=active olan ama henüz join hediyesi almamış tüm kullanıcılara 100 puan vermek istediğinize emin misiniz?')) return;
    setJoinAwardStatus('loading');
    try {
      const res = await fetch('/api/admin/award_join_points', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Request failed');
      setJoinAwardStatus({ ok: true, msg: `✅ ${json.awarded} müşteriye 100 puan verildi (${json.failed} hata, ${json.eligible} uygun)` });
    } catch (err) {
      setJoinAwardStatus({ ok: false, msg: '❌ ' + String(err?.message || err) });
    }
  };

  // Pending Rewards Drawer state
  const [pendingDrawerOpen, setPendingDrawerOpen] = useState(false);
  const [pendingTagsocial, setPendingTagsocial] = useState([]);
  const [pendingReview, setPendingReview] = useState([]);
  const [pendingCustomerstory, setPendingCustomerstory] = useState([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [pendingError, setPendingError] = useState(null);
  // Track awarded status per customer id in this session
  const [awardedIds, setAwardedIds] = useState({});
  const [awardingIds, setAwardingIds] = useState({});

  const openPendingDrawer = async () => {
    setPendingDrawerOpen(true);
    setPendingLoading(true);
    setPendingError(null);
    try {
      const res = await fetch(`/api/loyalty/tagsocialmedia_receive?shop=${encodeURIComponent(shop)}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load');
      setPendingTagsocial(json.tagsocial || []);
      setPendingReview(json.review || []);
      setPendingCustomerstory(json.customerstory || []);
    } catch (err) {
      setPendingError(String(err?.message || err));
    } finally {
      setPendingLoading(false);
    }
  };

  const handleAwardPending = async (customer, giftKey, points) => {
    setAwardingIds(prev => ({ ...prev, [`${customer.id}_${giftKey}`]: true }));
    try {
      // First approve (mark pending -> true)
      const approveRes = await fetch('/api/loyalty/tagsocialmedia_receive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'approve', customerId: customer.id, gift_key: giftKey }),
      });
      const approveJson = await approveRes.json();
      if (!approveRes.ok) throw new Error(approveJson.error || 'Approve failed');

      // Then award points
      const res = await fetch('/api/loyalty/award_by_email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shop, email: customer.email, points, gift: giftKey }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Award failed');

      setAwardedIds(prev => ({ ...prev, [`${customer.id}_${giftKey}`]: true }));
    } catch (err) {
      alert('Award failed: ' + String(err?.message || err));
    } finally {
      setAwardingIds(prev => ({ ...prev, [`${customer.id}_${giftKey}`]: false }));
    }
  };

  // Handle bulk CSV/Excel import — sends rows in 500-row chunks to /api/loyalty/award_bulk
  // so the browser makes ceil(N/500) requests instead of N requests.
  const BULK_CHUNK_SIZE = 500;

  const handleBulkImport = async (file) => {
    if (!file) return;
    setBulkProgress({ current: 0, total: 0 });
    setBulkResults([]);

    try {
      const text = await file.text();
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      if (lines.length === 0) {
        alert('File is empty');
        setBulkProgress(null);
        return;
      }

      // Parse CSV: expect 'email,points' or header row
      let startIndex = 0;
      const firstLine = lines[0].toLowerCase();
      if (firstLine.includes('email') && firstLine.includes('points')) {
        startIndex = 1; // skip header
      }

      const parsedRows = [];
      for (let i = startIndex; i < lines.length; i++) {
        const parts = lines[i].split(',').map(p => p.trim());
        if (parts.length >= 2) {
          const email = parts[0];
          const points = Number(parts[1]);
          if (email && !isNaN(points)) {
            parsedRows.push({ email, points });
          }
        }
      }

      if (parsedRows.length === 0) {
        alert('No valid rows found. Expected format: email,points');
        setBulkProgress(null);
        return;
      }

      // Split into chunks
      const chunks = [];
      for (let i = 0; i < parsedRows.length; i += BULK_CHUNK_SIZE) {
        chunks.push(parsedRows.slice(i, i + BULK_CHUNK_SIZE));
      }

      setBulkProgress({ current: 0, total: parsedRows.length });

      let processedSoFar = 0;
      const chunkResults = [];

      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        const chunkLabel = `Chunk ${ci + 1}/${chunks.length} (rows ${processedSoFar + 1}–${processedSoFar + chunk.length})`;
        try {
          const res = await fetch('/api/loyalty/award_bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shop, rows: chunk }),
          });
          const json = await res.json();
          if (res.ok) {
            chunkResults.push({
              label: chunkLabel,
              rows: chunk.length,
              status: json.errors > 0 ? 'partial' : 'success',
              customers_created: json.customers_created ?? 0,
              customers_updated: json.customers_updated ?? 0,
              events_inserted: json.events_inserted ?? 0,
              errors: json.errors ?? 0,
              message: json.errors > 0 ? `${json.errors} DB error(s)` : '',
            });
          } else {
            chunkResults.push({
              label: chunkLabel,
              rows: chunk.length,
              status: 'error',
              customers_created: 0,
              customers_updated: 0,
              events_inserted: 0,
              errors: chunk.length,
              message: json.error || 'Chunk failed',
            });
          }
        } catch (err) {
          chunkResults.push({
            label: chunkLabel,
            rows: chunk.length,
            status: 'error',
            customers_created: 0,
            customers_updated: 0,
            events_inserted: 0,
            errors: chunk.length,
            message: String(err),
          });
        }
        processedSoFar += chunk.length;
        setBulkProgress({ current: processedSoFar, total: parsedRows.length });
        setBulkResults([...chunkResults]);
      }

      setBulkProgress(null);
    } catch (err) {
      alert('Failed to process file: ' + String(err));
      setBulkProgress(null);
    }
  };

  // Prepare Event Data for Table 
  const rows = recentEvents.map((event, idx) => {
    const typeText = String(event.event_type || '').toLowerCase();
    const typeColor = typeText === 'earn' ? '#1a7f37' : typeText === 'refund' ? '#c21f1f' : 'inherit';
    return [
      new Date(event.created_at).toLocaleString(),
      <span key={`event-type-${idx}`} style={{ color: typeColor }}>{event.event_type}</span>,
      event.customer?.email || "Unknown",
      `${event.points > 0 ? "+" : ""}${event.points}`,
    ];
  });

  return (
    <AppProvider>
      <Page title="Loyalty System Status">
        <BlockStack gap="200">
          {/* STATUS CARDS */}
          <Layout>
            <Layout.Section variant="oneHalf">
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Database Status
                  </Text>
                  <Text as="p" tone={shopInfo ? "success" : "critical"}>
                    Supabase: <strong>{dbStatus}</strong>
                  </Text>
                  {shopInfo && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Token ID: {shopInfo.access_token?.substring(0, 10)}...
                    </Text>
                  )}
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section variant="oneHalf">
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Current Shop
                  </Text>
                  <Text as="p">{shop}</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    If this is correct, Auth is working.
                  </Text>
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>

          {/* ANALYTICS + PENDING REWARDS BUTTONS */}
          <Layout.Section>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <Link
                to="/app/analytics"
                style={{ textDecoration: 'none' }}
              >
                <button
                  style={{
                    background: 'black',
                    color: '#fff',
                    border: 'none',
                    padding: '10px 24px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: '1em',
                    fontWeight: 600,
                  }}
                >
                  Analytics
                </button>
              </Link>

              <Link
                to="/app/birthday-customers"
                style={{ textDecoration: 'none' }}
              >
                <button
                  style={{
                    background: '#1a7f37',
                    color: '#fff',
                    border: 'none',
                    padding: '10px 24px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: '1em',
                    fontWeight: 600,
                  }}
                >
                  🎂 Birthday Customers
                </button>
              </Link>

              <button
                onClick={openPendingDrawer}
                style={{
                  background: '#7c3aed',
                  color: '#fff',
                  border: 'none',
                  padding: '10px 24px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: '1em',
                  fontWeight: 600,
                }}
              >
                Pending Social Media Rewards
              </button>

              <button
                onClick={handleAwardJoinPoints}
                disabled={joinAwardStatus === 'loading'}
                style={{
                  background: joinAwardStatus === 'loading' ? '#d1d5db' : '#059669',
                  color: '#fff',
                  border: 'none',
                  padding: '10px 24px',
                  borderRadius: 6,
                  cursor: joinAwardStatus === 'loading' ? 'not-allowed' : 'pointer',
                  fontSize: '1em',
                  fontWeight: 600,
                }}
              >
                {joinAwardStatus === 'loading' ? 'Veriliyor…' : 'Give 100 Points to Active Accounts'}
              </button>

              {joinAwardStatus && joinAwardStatus !== 'loading' && (
                <span style={{ color: joinAwardStatus.ok ? '#059669' : '#dc2626', fontSize: '0.92em', fontWeight: 500 }}>
                  {joinAwardStatus.msg}
                </span>
              )}
            </div>
          </Layout.Section>

          {/* PENDING REWARDS DRAWER */}
          {pendingDrawerOpen && (
            <div
              style={{
                position: 'fixed', inset: 0, zIndex: 9999,
                background: 'rgba(0,0,0,0.45)',
                display: 'flex', justifyContent: 'flex-end',
              }}
              onClick={(e) => { if (e.target === e.currentTarget) setPendingDrawerOpen(false); }}
            >
              <div
                style={{
                  width: '100%', maxWidth: 760,
                  background: '#fff',
                  height: '100%',
                  overflowY: 'auto',
                  boxShadow: '-4px 0 24px rgba(0,0,0,0.18)',
                  display: 'flex', flexDirection: 'column',
                }}
              >
                {/* Drawer Header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: '1px solid #e5e7eb' }}>
                  <span style={{ fontWeight: 700, fontSize: '1.15em' }}>Pending Rewards</span>
                  <button
                    onClick={() => setPendingDrawerOpen(false)}
                    style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', lineHeight: 1, color: '#374151' }}
                    aria-label="Close drawer"
                  >
                    ✕
                  </button>
                </div>

                {/* Drawer Body */}
                <div style={{ flex: 1, padding: '20px 24px' }}>
                  {pendingLoading && (
                    <p style={{ color: '#6b7280', textAlign: 'center', marginTop: 40 }}>Loading...</p>
                  )}
                  {pendingError && (
                    <p style={{ color: '#dc2626' }}>Error: {pendingError}</p>
                  )}
                  {!pendingLoading && !pendingError && pendingTagsocial.length === 0 && pendingReview.length === 0 && pendingCustomerstory.length === 0 && (
                    <p style={{ color: '#6b7280', textAlign: 'center', marginTop: 40 }}>No pending rewards found.</p>
                  )}

                  {/* Pending Table renderer — shared by tagsocial and review */}
                  {[
                    { label: 'Tag Social Media', giftKey: 'tagsocialmedia', pts: 150, rows: pendingTagsocial, color: '#7c3aed' },
                    { label: 'Review', giftKey: 'review', pts: 150, rows: pendingReview, color: '#0369a1' },
                    { label: 'Customer Story', giftKey: 'customerstory', pts: 200, rows: pendingCustomerstory, color: '#b45309' },
                  ].map(({ label, giftKey, pts, rows, color }) => !pendingLoading && !pendingError && rows.length > 0 && (
                    <div key={giftKey} style={{ overflowX: 'auto', marginBottom: 32 }}>
                      <p style={{ color: '#6b7280', marginBottom: 16, fontSize: '0.92em' }}>
                        <strong>{label}</strong> — {rows.length} pending. Click Submit to award {pts} points.
                      </p>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9em' }}>
                        <thead>
                          <tr style={{ background: '#f9fafb' }}>
                            <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>Email</th>
                            <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>Platform</th>
                            <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>Username</th>
                            <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>URL / Link</th>
                            <th style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>Other Info</th>
                            <th style={{ textAlign: 'center', padding: '8px 10px', borderBottom: '1px solid #e5e7eb' }}>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((c) => {
                            const meta = c.meta || {};
                            const { platform, username } = meta;
                            const urlCandidates = ['url','link','post_url','postUrl','postLink','post','media_url','profile_url'];
                            let displayUrl = null;
                            for (const key of urlCandidates) {
                              if (meta[key]) { displayUrl = meta[key]; break; }
                            }
                            const displayUsername = username || meta.user || meta.handle || null;
                            const excludedKeys = new Set(['shop','username','platform','user','handle', ...urlCandidates]);
                            const otherKeys = Object.keys(meta).filter(k => !excludedKeys.has(k));
                            const rowKey = `${c.id}_${giftKey}`;
                            const isAwarded = awardedIds[rowKey];
                            const isAwarding = awardingIds[rowKey];
                            return (
                              <tr key={rowKey} style={{ borderBottom: '1px solid #f3f4f6', background: isAwarded ? '#f0fdf4' : undefined }}>
                                <td style={{ padding: '8px 10px', wordBreak: 'break-all' }}>{c.email}</td>
                                <td style={{ padding: '8px 10px' }}>
                                  {platform ? (
                                    <span style={{ background: '#ede9fe', color: '#5b21b6', borderRadius: 4, padding: '2px 8px', fontWeight: 600, fontSize: '0.85em' }}>
                                      {platform}
                                    </span>
                                  ) : <span style={{ color: '#9ca3af' }}>—</span>}
                                </td>
                                <td style={{ padding: '8px 10px', color: '#374151', fontWeight: 600 }}>{displayUsername || <span style={{ color: '#9ca3af' }}>—</span>}</td>
                                <td style={{ padding: '8px 10px', maxWidth: 180, wordBreak: 'break-all' }}>
                                  {displayUrl ? (
                                    <a href={displayUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb', fontSize: '0.88em' }}>
                                      {displayUrl.length > 40 ? displayUrl.slice(0, 40) + '…' : displayUrl}
                                    </a>
                                  ) : <span style={{ color: '#9ca3af' }}>—</span>}
                                </td>
                                <td style={{ padding: '8px 10px', fontSize: '0.85em', color: '#374151', maxWidth: 160 }}>
                                  {otherKeys.length > 0 ? (
                                    otherKeys.map(k => (
                                      <div key={k}><strong>{k}:</strong> {String(meta[k])}</div>
                                    ))
                                  ) : <span style={{ color: '#9ca3af' }}>—</span>}
                                </td>
                                <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                                  {isAwarded ? (
                                    <span style={{ color: '#16a34a', fontWeight: 600 }}>✓ Awarded</span>
                                  ) : (
                                    <button
                                      onClick={() => handleAwardPending(c, giftKey, pts)}
                                      disabled={!!isAwarding}
                                      style={{
                                        background: isAwarding ? '#d1d5db' : color,
                                        color: '#fff',
                                        border: 'none',
                                        padding: '5px 14px',
                                        borderRadius: 5,
                                        cursor: isAwarding ? 'not-allowed' : 'pointer',
                                        fontWeight: 600,
                                        fontSize: '0.88em',
                                      }}
                                    >
                                      {isAwarding ? 'Awarding…' : `Submit (+${pts} pts)`}
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* WEBHOOK LOGS */}
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Recent Webhook Activity (Last 5 Events)
                </Text>
                {rows.length > 0 ? (
                  <DataTable
                    columnContentTypes={["text", "text", "text", "numeric"]}
                    headings={["Date", "Type", "Customer", "Points"]}
                    rows={rows}
                  />
                ) : (
                  <Text as="p" tone="subdued">
                    No events found yet. Make a purchase or redeem points to see
                    data here!
                  </Text>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* INSERT POINTS FORM */}
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Insert Points By Email
                </Text>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input
                    placeholder="customer@example.com"
                    value={awardEmail}
                    onChange={(e) => setAwardEmail(e.target.value)}
                    style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', minWidth: 260 }}
                  />

                  <input
                    type="number"
                    placeholder="Points (e.g. 50)"
                    value={awardPoints}
                    onChange={(e) => setAwardPoints(Number(e.target.value))}
                    style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', width: 120 }}
                  />

                  {/* reason field removed: awards are quick actions without required notes */}

                  <button
                    onClick={async () => {
                      setIsAwarding(true);
                      setAwardStatus(null);
                      try {
                        const res = await fetch('/api/loyalty/award_by_email', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ shop, email: awardEmail, points: awardPoints }),
                        });
                        const ct = res.headers.get('content-type') || '';
                        let json = null;
                        if (ct.includes('application/json')) {
                          json = await res.json();
                        } else {
                          const text = await res.text();
                          throw new Error(`Expected JSON response but got: ${text.slice(0,200)}`);
                        }
                        if (!res.ok) throw new Error(json?.error || 'Request failed');
                        setAwardStatus({ ok: true, msg: `Awarded ${json.redeemable_points} redeemable / ${json.lifetime_points} lifetime` });
                        setAwardEmail(''); setAwardPoints(0);
                      } catch (err) {
                        setAwardStatus({ ok: false, msg: String(err?.message || err) });
                      } finally { setIsAwarding(false); }
                    }}
                    disabled={isAwarding}
                    style={{ background: 'black', color: '#fff', border: 'none', padding: '8px 12px', borderRadius: 6, cursor: 'pointer' }}
                  >
                    {isAwarding ? 'Submitting...' : 'Award Points'}
                  </button>
                </div>

                {awardStatus && (
                  <Text as="p" tone={awardStatus.ok ? 'success' : 'critical'}>
                    {awardStatus.msg}
                  </Text>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* BULK IMPORT SECTION */}
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Bulk Import Points (CSV)
                </Text>
                
                <Text as="p" tone="subdued">
                  Upload a CSV file with format: email,points (e.g., user@example.com,1000)
                </Text>

                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="file"
                    accept=".csv,.txt"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        setBulkFile(file);
                        setBulkResults([]);
                      }
                    }}
                    style={{ padding: 8 }}
                  />

                  <button
                    onClick={() => bulkFile && handleBulkImport(bulkFile)}
                    disabled={!bulkFile || bulkProgress !== null}
                    style={{
                      background: (!bulkFile || bulkProgress !== null) ? '#ddd' : 'black',
                      color: (!bulkFile || bulkProgress !== null) ? '#666' : '#fff',
                      border: 'none',
                      padding: '8px 16px',
                      borderRadius: 6,
                      cursor: (!bulkFile || bulkProgress !== null) ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {bulkProgress ? 'Processing...' : 'Start Import'}
                  </button>

                  {bulkProgress && (
                    <Text as="span">
                      Progress: {bulkProgress.current} / {bulkProgress.total}
                    </Text>
                  )}
                </div>

                {bulkResults.length > 0 && (() => {
                  const totalUpdated = bulkResults.reduce((s, r) => s + r.customers_updated, 0);
                  const totalCreated = bulkResults.reduce((s, r) => s + r.customers_created, 0);
                  const totalEvents  = bulkResults.reduce((s, r) => s + r.events_inserted, 0);
                  const totalErrors  = bulkResults.reduce((s, r) => s + r.errors, 0);
                  return (
                    <div style={{ marginTop: 16, maxHeight: 320, overflowY: 'auto', border: '1px solid #ddd', borderRadius: 4, padding: 8 }}>
                      <Text as="h3" variant="headingSm" style={{ marginBottom: 6 }}>
                        Summary — updated: {totalUpdated}, created: {totalCreated}, events: {totalEvents}, errors: {totalErrors}
                      </Text>
                      <table style={{ width: '100%', fontSize: '0.85em', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ background: '#f9f9f9', textAlign: 'left' }}>
                            <th style={{ padding: 4 }}>Chunk</th>
                            <th style={{ padding: 4 }}>Rows</th>
                            <th style={{ padding: 4 }}>Status</th>
                            <th style={{ padding: 4 }}>Created</th>
                            <th style={{ padding: 4 }}>Updated</th>
                            <th style={{ padding: 4 }}>Events</th>
                            <th style={{ padding: 4 }}>Errors</th>
                            <th style={{ padding: 4 }}>Message</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bulkResults.map((r, idx) => (
                            <tr key={idx} style={{ borderTop: '1px solid #eee' }}>
                              <td style={{ padding: 4 }}>{r.label}</td>
                              <td style={{ padding: 4 }}>{r.rows}</td>
                              <td style={{ padding: 4, color: r.status === 'success' ? 'green' : r.status === 'partial' ? '#b45309' : 'red' }}>
                                {r.status === 'success' ? '✅' : r.status === 'partial' ? '⚠️' : '❌'}
                              </td>
                              <td style={{ padding: 4 }}>{r.customers_created}</td>
                              <td style={{ padding: 4 }}>{r.customers_updated}</td>
                              <td style={{ padding: 4 }}>{r.events_inserted}</td>
                              <td style={{ padding: 4 }}>{r.errors}</td>
                              <td style={{ padding: 4, fontSize: '0.85em' }}>{r.message || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* CUSTOMER SELECTION */}
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Customers (Page {page} / {totalPages})
                </Text>

                <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    placeholder="Filter by email"
                    value={filterEmail}
                    onChange={(e) => setFilterEmail(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') applyFilter(); }}
                    style={{ padding: 8, borderRadius: 4, border: '1px solid #ddd', minWidth: 220 }}
                  />
                  <button
                    onClick={applyFilter}
                    style={{ background: 'black', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: 6 }}
                  >
                    Filter
                  </button>
                  <button
                    onClick={clearFilter}
                    disabled={!filterEmail}
                    style={{ background: '#eee', color: '#333', border: 'none', padding: '6px 10px', borderRadius: 6 }}
                  >
                    Clear
                  </button>
                  {emailFilter && <span style={{ marginLeft: 8, color: '#666' }}>Active: {emailFilter}</span>}
                </div>

                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: 8, textTransform: 'uppercase' }}>Email</th>
                        <th style={{ textAlign: 'right', padding: 8, textTransform: 'uppercase', position: 'relative' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ textDecoration: 'none', color: 'inherit' }}>
                              Redeemable {sort === 'redeemable_points' ? (dir === 'desc' ? '▼' : '▲') : ''}
                            </span>
                            <button
                              aria-label="Redeemable sort options"
                              onClick={() => setOpenMenu(openMenu === 'redeemable_points' ? null : 'redeemable_points')}
                              style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2 }}
                            >
                              ▾
                            </button>
                          </span>
                          {openMenu === 'redeemable_points' && (
                            <div style={{ position: 'absolute', right: 8, top: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: 4, boxShadow: '0 6px 18px rgba(0,0,0,0.08)', zIndex: 20 }}>
                              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 160 }}>
                                <Link to={makeSortLinkWithDir('redeemable_points', 'asc')} style={{ padding: '8px 12px', textDecoration: 'none', color: 'inherit' }} onClick={() => setOpenMenu(null)}>Sort ascending</Link>
                                <Link to={makeSortLinkWithDir('redeemable_points', 'desc')} style={{ padding: '8px 12px', textDecoration: 'none', color: 'inherit' }} onClick={() => setOpenMenu(null)}>Sort descending</Link>
                              </div>
                            </div>
                          )}
                        </th>
                        <th style={{ textAlign: 'right', padding: 8, textTransform: 'uppercase', position: 'relative' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ textDecoration: 'none', color: 'inherit' }}>
                              Lifetime {sort === 'lifetime_points' ? (dir === 'desc' ? '▼' : '▲') : ''}
                            </span>
                            <button
                              aria-label="Lifetime sort options"
                              onClick={() => setOpenMenu(openMenu === 'lifetime_points' ? null : 'lifetime_points')}
                              style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2 }}
                            >
                              ▾
                            </button>
                          </span>
                          {openMenu === 'lifetime_points' && (
                            <div style={{ position: 'absolute', right: 8, top: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: 4, boxShadow: '0 6px 18px rgba(0,0,0,0.08)', zIndex: 20 }}>
                              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 160 }}>
                                <Link to={makeSortLinkWithDir('lifetime_points', 'asc')} style={{ padding: '8px 12px', textDecoration: 'none', color: 'inherit' }} onClick={() => setOpenMenu(null)}>Sort ascending</Link>
                                <Link to={makeSortLinkWithDir('lifetime_points', 'desc')} style={{ padding: '8px 12px', textDecoration: 'none', color: 'inherit' }} onClick={() => setOpenMenu(null)}>Sort descending</Link>
                              </div>
                            </div>
                          )}
                        </th>
                        <th style={{ textAlign: 'left', padding: 8, textTransform: 'uppercase' }}>Tier</th>
                        <th style={{ padding: 8, textTransform: 'uppercase' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {customers.length ? customers.map(c => (
                        <tr key={c.id} style={{ borderTop: '1px solid #eee' }}>
                          <td style={{ padding: 8 }}>{c.email}</td>
                          <td style={{ padding: 8, textAlign: 'right' }}>{c.redeemable_points ?? 0}</td>
                          <td style={{ padding: 8, textAlign: 'right' }}>{c.lifetime_points ?? 0}</td>
                          <td style={{ padding: 8, color: c.tier === 'Inner Circle' ? '#D4AF37' : c.tier === 'Legacy Circle' ? '#1E90FF' : 'inherit' }}>{c.tier ?? 'Circle'}</td>
                          <td style={{ padding: 8, textAlignLast: 'center' }}>
                            <Link
                              to={`/customer?id=${c.id}&page=${page}`}
                              style={{ height: 28, display: 'inline-block', textDecoration: 'none', padding: '4px 8px', borderRadius: 4, background: 'black', color: '#fff' }}
                            >
                              Details
                            </Link>
                          </td>
                        </tr>
                      )) : (
                        <tr><td colSpan={5} style={{ padding: 8 }}>No customers found</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button
                    style={{
                      background: isPrevDisabled ? '#ddd' : 'black',
                      color: isPrevDisabled ? '#666' : '#fff',
                      height: 28,
                      borderRadius: 4,
                      padding: '4px 8px',
                      border: 'none',
                      cursor: isPrevDisabled ? 'not-allowed' : 'pointer',
                      opacity: isPrevDisabled ? 0.6 : 1,
                    }}
                    type="button"
                    onClick={() => {
                      const p = Math.max(1, page - 1);
                      const params = new URLSearchParams(window.location.search);
                      params.set('page', String(p));
                      params.delete('customerId');
                      window.location.search = params.toString();
                    }}
                    disabled={isPrevDisabled}
                  >
                    Prev
                  </button>

                  <button
                    style={{
                      background: isNextDisabled ? '#ddd' : 'black',
                      color: isNextDisabled ? '#666' : '#fff',
                      height: 28,
                      borderRadius: 4,
                      padding: '4px 8px',
                      border: 'none',
                      cursor: isNextDisabled ? 'not-allowed' : 'pointer',
                      opacity: isNextDisabled ? 0.6 : 1,
                    }}
                    type="button"
                    onClick={() => {
                      const p = Math.min(totalPages, page + 1);
                      const params = new URLSearchParams(window.location.search);
                      params.set('page', String(p));
                      params.delete('customerId');
                      window.location.search = params.toString();
                    }}
                    disabled={isNextDisabled}
                  >
                    Next
                  </button>
                </div>
              </BlockStack>
            </Card>
          </Layout.Section>
        </BlockStack>
      </Page>
    </AppProvider>
  );
}
