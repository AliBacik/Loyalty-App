import { useLoaderData, useNavigate, useNavigation, Link } from "@remix-run/react";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";
import {
  Page,
  AppProvider,
} from "@shopify/polaris";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from "recharts";

const useAnimatedDots = (interval = 600) => {
  const [dots, setDots] = useState('');
  useEffect(() => {
    const timer = setInterval(() => {
      setDots(d => d.length >= 3 ? '' : d + '.');
    }, interval);
    return () => clearInterval(timer);
  }, [interval]);
  return dots;
};

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  const { data: shopData } = await supabase
    .from("shops")
    .select("*")
    .eq("shopify_domain", session.shop)
    .single();

  const now = new Date();
  const url = new URL(request.url);

  // Default: last 30 days
  const defaultFrom = new Date(now);
  defaultFrom.setDate(defaultFrom.getDate() - 30);
  const fromParam = url.searchParams.get("from") || defaultFrom.toISOString().split("T")[0];
  const toParam = url.searchParams.get("to") || now.toISOString().split("T")[0];

  const fromISO = new Date(fromParam).toISOString();
  const toDate = new Date(toParam);
  toDate.setHours(23, 59, 59, 999);
  const toISO = toDate.toISOString();

  const analytics = {
    total_members: 0,
    activated_accounts: 0,
    generated_codes: 0,
    used_codes: null,
    total_order_value: null,
    tier_counts: {},
    aov_members: null,
    aov_non_members: null,
  };

  // Run Supabase queries in parallel
  const [
    { count: totalMembersCount },
    { count: activatedCount },
    { data: tierRows },
    { count: generatedCount },
  ] = await Promise.all([
    // Total members (all-time, unfiltered)
    supabase
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shopData?.id)
      .eq("status", "active"),
    // New members in date range
    supabase
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shopData?.id)
      .eq("status", "active")
      .not("status_changed_timestamp", "is", null)
      .gte("status_changed_timestamp", fromISO)
      .lte("status_changed_timestamp", toISO),
    // Tier distribution (all-time)
    supabase
      .from("customers")
      .select("tier")
      .eq("shop_id", shopData?.id)
      .eq("status", "active"),
    // Generated Discount Codes
    supabase
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shopData?.id)
      .eq("event_type", "Create Coupon")
      .gte("created_at", fromISO)
      .lte("created_at", toISO),
  ]);

  analytics.total_members = totalMembersCount || 0;
  analytics.activated_accounts = activatedCount || 0;
  analytics.generated_codes = generatedCount || 0;

  // Tier counts
  const tierCounts = {};
  for (const row of (tierRows || [])) {
    const t = row.tier || "Circle";
    tierCounts[t] = (tierCounts[t] || 0) + 1;
  }
  analytics.tier_counts = tierCounts;


  // ── LTV by tier (server-side) ───────────────────────────────────────────────
  const ltvByTier = {};
  try {
    const PAGE_SIZE = 2000;
    let allMembers = [];
    let ltvFrom = 0;
    while (true) {
      const { data, error } = await supabase
        .from("customers")
        .select("shopify_customer_id, tier")
        .eq("shop_id", shopData?.id)
        .eq("status", "active")
        .not("shopify_customer_id", "is", null)
        .range(ltvFrom, ltvFrom + PAGE_SIZE - 1);
      if (error || !data || data.length === 0) break;
      allMembers.push(...data);
      if (data.length < PAGE_SIZE) break;
      ltvFrom += PAGE_SIZE;
    }
    if (allMembers.length > 0) {
      const BATCH_SIZE = 50;
      const tierSpend = {};
      const tierCount = {};
      for (let i = 0; i < allMembers.length; i += BATCH_SIZE) {
        const batch = allMembers.slice(i, i + BATCH_SIZE);
        const fields = batch
          .map((c, idx) => `c${idx}: customer(id: "gid://shopify/Customer/${c.shopify_customer_id}") { amountSpent { amount } }`)
          .join("\n");
        try {
          const response = await admin.graphql(`query LTVBatch { ${fields} }`);
          const result = await response.json();
          if (result.data) {
            for (let j = 0; j < batch.length; j++) {
              const cData = result.data[`c${j}`];
              if (!cData) continue;
              const spend = parseFloat(cData.amountSpent?.amount || "0");
              const tier = batch[j].tier || "Circle";
              tierSpend[tier] = (tierSpend[tier] || 0) + spend;
              tierCount[tier] = (tierCount[tier] || 0) + 1;
            }
          }
        } catch (e) {
          console.error("[LTV] Shopify batch error:", e);
        }
      }
      for (const tier of Object.keys(tierSpend)) {
        ltvByTier[tier] = Math.round((tierSpend[tier] / tierCount[tier]) * 100) / 100;
      }
    }
  } catch (e) {
    console.error("[Analytics] LTV calculation failed:", e);
  }

  // ── Gift engagement counts ──────────────────────────────────────────────────
  // Gifts that create events directly (event_type=Earn, event_desc=giftKey)
  const directGiftKeys = ['join', 'birthdayadded', 'instagram', 'tiktok'];
  // Gifts that go through pending rewards table
  const pendingGiftKeys = ['newsletter', 'review', 'tagsocialmedia', 'customerstory'];

  const [directGiftResults, pendingGiftResults] = await Promise.all([
    Promise.all(
      directGiftKeys.map(key =>
        supabase
          .from('events')
          .select('id', { count: 'exact', head: true })
          .eq('shop_id', shopData?.id)
          .eq('event_type', 'Earn')
          .eq('event_desc', key)
          .gte('created_at', fromISO)
          .lte('created_at', toISO)
      )
    ),
    Promise.all(
      pendingGiftKeys.map(key =>
        supabase
          .from('customer_pending_rewards')
          .select('id', { count: 'exact', head: true })
          .eq('shop_id', shopData?.id)
          .eq('gift_key', key)
          .gte('created_at', fromISO)
          .lte('created_at', toISO)
      )
    ),
  ]);

  const giftCounts = {};
  directGiftKeys.forEach((key, i) => { giftCounts[key] = directGiftResults[i].count || 0; });
  pendingGiftKeys.forEach((key, i) => { giftCounts[key] = pendingGiftResults[i].count || 0; });

  return { analytics, fromParam, toParam, ltvByTier, giftCounts };
};

// ─── tier palette ────────────────────────────────────────────────────────────
const TIER_PALETTE = {
  'Circle':       '#8b8b8b',
  'Inner Circle': '#D4AF37',
  'Legacy Circle':'#1E90FF',
};
const tierColor = (t) => TIER_PALETTE[t] || '#8b8b8b';

// ─── reusable small components ────────────────────────────────────────────────
const KpiCard = ({ label, value, sub, onClick, accent, dots }) => {
  const isLoading = value === null || value === undefined;
  return (
    <div
      onClick={onClick}
      style={{
        flex: '1 1 180px', minWidth: 160,
        background: '#fff', border: '1px solid #e3e3e3',
        borderRadius: 12, padding: '20px 22px',
        cursor: onClick && !isLoading ? 'pointer' : 'default',
        transition: 'box-shadow .15s',
        boxShadow: '0 1px 3px rgba(0,0,0,.06)',
      }}
      onMouseEnter={e => { if (onClick && !isLoading) e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,.10)'; }}
      onMouseLeave={e => { e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,.06)'; }}
    >
      <div style={{ fontSize: '0.78em', fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: '2em', fontWeight: 700, color: accent || '#1a1a1a', lineHeight: 1.15, minHeight: '2.4em', display: 'flex', alignItems: 'center' }}>
        {isLoading ? `Calculating${dots}` : value}
      </div>
      {sub && <div style={{ fontSize: '0.8em', color: '#aaa', marginTop: 4 }}>{sub}</div>}
      {onClick && !isLoading && <div style={{ fontSize: '0.75em', color: '#1a6dd6', marginTop: 6 }}>View details →</div>}
    </div>
  );
};

const SectionTitle = ({ children }) => (
  <div style={{ fontSize: '0.72em', fontWeight: 700, color: '#999', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 14 }}>
    {children}
  </div>
);

// ─── custom tooltip for recharts ─────────────────────────────────────────────
const ChartTooltip = ({ active, payload, label, dollar }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 8, padding: '8px 14px', fontSize: '0.85em', boxShadow: '0 2px 8px rgba(0,0,0,.08)' }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color || '#333' }}>
          {p.name}: <strong>{dollar ? `$${Number(p.value).toLocaleString()}` : p.value.toLocaleString()}</strong>
        </div>
      ))}
    </div>
  );
};

export default function Analytics() {
  const { analytics: initialAnalytics, fromParam, toParam, ltvByTier, giftCounts } = useLoaderData();
  const navigate = useNavigate();

  const [fromDate, setFromDate] = useState(fromParam);
  const [toDate, setToDate] = useState(toParam);
  const [applying, setApplying] = useState(false);
  const [analytics, setAnalytics] = useState(initialAnalytics);
  const navigation = useNavigation();
  const dots = useAnimatedDots();

  useEffect(() => {
    if (navigation.state === 'idle') {
      setApplying(false);
      setAnalytics(initialAnalytics);
    }
  }, [navigation.state, initialAnalytics]);

  // Fetch heavy metrics asynchronously
  useEffect(() => {
    setAnalytics(prev => ({
      ...initialAnalytics,
      used_codes: null,
      total_order_value: null,
      aov_members: null,
      aov_non_members: null,
    }));

    const fetchHeavyMetrics = async () => {
      try {
        const res = await fetch(`/api/analytics/heavy?from=${fromParam}&to=${toParam}`);
        const data = await res.json();
        if (res.ok) {
          setAnalytics(prev => ({
            ...prev,
            used_codes: data.used_codes,
            total_order_value: data.total_order_value,
            aov_members: data.aov_members,
            aov_non_members: data.aov_non_members,
          }));
        }
      } catch (e) {
        console.error("Failed to fetch heavy metrics:", e);
      }
    };

    fetchHeavyMetrics();
  }, [fromParam, toParam, initialAnalytics]);

  const applyDateRange = () => { setApplying(true); navigate(`?from=${fromDate}&to=${toDate}`); };

  const applyPreset = (days) => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days);
    const toStr = to.toISOString().split('T')[0];
    const fromStr = from.toISOString().split('T')[0];
    setFromDate(fromStr);
    setToDate(toStr);
    navigate(`?from=${fromStr}&to=${toStr}`);
  };

  // Drawer
  const [drawer, setDrawer] = useState(null);
  const [drawerRows, setDrawerRows] = useState([]);
  const [drawerLoading, setDrawerLoading] = useState(false);

  const openDrawer = async (metric, title) => {
    setDrawer({ metric, title }); setDrawerRows([]); setDrawerLoading(true);
    try {
      const res = await fetch(`/api/analytics/drawer?metric=${metric}&from=${fromParam}&to=${toParam}`);
      const json = await res.json();
      setDrawerRows(json.customers || []);
    } catch { setDrawerRows([]); }
    finally { setDrawerLoading(false); }
  };
  const closeDrawer = () => { setDrawer(null); setDrawerRows([]); };

  // ── derived chart data ──────────────────────────────────────────────────────
  const tierPieData = Object.entries(analytics.tier_counts || {}).map(([name, value]) => ({ name, value }));
  const aovBarData = [
    { name: 'Members',     aov: analytics.aov_members },
    { name: 'Non-Members', aov: analytics.aov_non_members },
  ];
  const redemptionRate = analytics.generated_codes > 0 && analytics.used_codes !== null
    ? Math.round((analytics.used_codes / analytics.generated_codes) * 100)
    : 0;

  const ltvBarData = Object.entries(ltvByTier || {}).map(([tier, avg]) => ({ tier, avg }));

  // ── styles ──────────────────────────────────────────────────────────────────
  const cardStyle = {
    background: '#fff', border: '1px solid #e3e3e3',
    borderRadius: 12, padding: '24px',
    boxShadow: '0 1px 3px rgba(0,0,0,.06)',
  };
  const rowStyle = { display: 'flex', gap: 16, flexWrap: 'wrap' };
  const halfCard = { ...cardStyle, flex: '1 1 340px', minWidth: 280 };

  return (
    <AppProvider>
      <Page title="Loyalty Analytics" backAction={{ content: 'Dashboard', onAction: () => navigate('/app') }}>

        {/* ── DRAWER ─────────────────────────────────────────────────────────── */}
        {drawer && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}>
            <div onClick={closeDrawer} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)' }} />
            <div style={{ position: 'relative', width: 500, maxWidth: '95vw', height: '100%', background: '#fff', boxShadow: '-4px 0 24px rgba(0,0,0,.15)', display: 'flex', flexDirection: 'column', zIndex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: '1px solid #eee' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '1.1em' }}>{drawer.title}</div>
                  <div style={{ fontSize: '0.82em', color: '#888', marginTop: 2 }}>{fromParam} — {toParam}</div>
                </div>
                <button onClick={closeDrawer} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.4em', color: '#555' }}>✕</button>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
                {drawerLoading ? (
                  <div style={{ color: '#888', marginTop: 40, textAlign: 'center' }}>Loading…</div>
                ) : drawerRows.length === 0 ? (
                  <div style={{ color: '#888', marginTop: 40, textAlign: 'center' }}>No customers found.</div>
                ) : drawer.metric?.startsWith('gift_') ? (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88em' }}>
                    <thead><tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
                      <th style={{ padding: '8px 6px' }}>Email</th>
                      <th style={{ padding: '8px 6px', textAlign: 'right' }}>Date</th>
                    </tr></thead>
                    <tbody>
                      {drawerRows.map((r, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                          <td style={{ padding: '8px 6px' }}>{r.email}</td>
                          <td style={{ padding: '8px 6px', textAlign: 'right', color: '#666' }}>{new Date(r.created_at).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : drawer.metric === 'activated_accounts' ? (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88em' }}>
                    <thead><tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
                      <th style={{ padding: '8px 6px' }}>Email</th>
                      <th style={{ padding: '8px 6px' }}>Tier</th>
                      <th style={{ padding: '8px 6px', textAlign: 'right' }}>Activated At</th>
                    </tr></thead>
                    <tbody>
                      {drawerRows.map((r, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                          <td style={{ padding: '8px 6px' }}>{r.email}</td>
                          <td style={{ padding: '8px 6px', color: tierColor(r.tier) }}>{r.tier || 'Circle'}</td>
                          <td style={{ padding: '8px 6px', textAlign: 'right', color: '#666' }}>{new Date(r.status_changed_timestamp).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88em' }}>
                    <thead><tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
                      <th style={{ padding: '8px 6px' }}>Email</th>
                      <th style={{ padding: '8px 6px' }}>Code</th>
                      <th style={{ padding: '8px 6px', textAlign: 'right' }}>Order Value</th>
                      <th style={{ padding: '8px 6px', textAlign: 'right' }}>Date</th>
                    </tr></thead>
                    <tbody>
                      {drawerRows.map((r, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                          <td style={{ padding: '8px 6px' }}>{r.email}</td>
                          <td style={{ padding: '8px 6px', fontFamily: 'monospace', fontSize: '0.85em' }}>{r.discount_code}</td>
                          <td style={{ padding: '8px 6px', textAlign: 'right', color: '#1a7f37', fontWeight: 600 }}>${r.order_value?.toLocaleString()}</td>
                          <td style={{ padding: '8px 6px', textAlign: 'right', color: '#666' }}>{new Date(r.created_at).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              {!drawerLoading && drawerRows.length > 0 && (
                <div style={{ padding: '12px 24px', borderTop: '1px solid #eee', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '0.85em', color: '#888' }}>{drawerRows.length} record{drawerRows.length !== 1 ? 's' : ''}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── PAGE BODY ──────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, paddingBottom: 40 }}>

          {/* ── TAB NAV ────────────────────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 4 }}>
            <button style={{
              background: '#1a1a1a', color: '#fff', border: '1px solid #1a1a1a',
              padding: '7px 16px', borderRadius: 8, cursor: 'default',
              fontSize: '0.88em', fontWeight: 600,
            }}>
              Loyalty
            </button>
            <Link to="/app/wishlist-analytics" style={{ textDecoration: 'none' }}>
              <button style={{
                background: '#fff', color: '#555', border: '1px solid #ddd',
                padding: '7px 16px', borderRadius: 8, cursor: 'pointer',
                fontSize: '0.88em', fontWeight: 600,
              }}>
                Wishlist
              </button>
            </Link>
          </div>

          {/* ── DATE RANGE PICKER ──────────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* From pill */}
            <label style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: '#fff', border: '1px solid #ddd', borderRadius: 8,
              padding: '7px 14px', cursor: 'pointer', fontSize: '0.9em', fontWeight: 500,
              boxShadow: '0 1px 2px rgba(0,0,0,.06)',
            }}>
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="#888" strokeWidth="1.8">
                <rect x="2" y="3" width="16" height="15" rx="2"/>
                <line x1="6" y1="1" x2="6" y2="5"/><line x1="14" y1="1" x2="14" y2="5"/>
                <line x1="2" y1="8" x2="18" y2="8"/>
              </svg>
              <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
                style={{ border: 'none', outline: 'none', fontSize: '0.95em', fontWeight: 500, color: '#1a1a1a', background: 'transparent', cursor: 'pointer', width: 120 }} />
            </label>

            <span style={{ color: '#bbb', fontSize: '0.9em' }}>→</span>

            {/* To pill */}
            <label style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: '#fff', border: '1px solid #ddd', borderRadius: 8,
              padding: '7px 14px', cursor: 'pointer', fontSize: '0.9em', fontWeight: 500,
              boxShadow: '0 1px 2px rgba(0,0,0,.06)',
            }}>
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="#888" strokeWidth="1.8">
                <rect x="2" y="3" width="16" height="15" rx="2"/>
                <line x1="6" y1="1" x2="6" y2="5"/><line x1="14" y1="1" x2="14" y2="5"/>
                <line x1="2" y1="8" x2="18" y2="8"/>
              </svg>
              <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
                style={{ border: 'none', outline: 'none', fontSize: '0.95em', fontWeight: 500, color: '#1a1a1a', background: 'transparent', cursor: 'pointer', width: 120 }} />
            </label>

            {/* Apply */}
            <button onClick={applyDateRange} disabled={applying}
              style={{ background: applying ? '#888' : '#1a1a1a', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 8, cursor: applying ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '0.88em', boxShadow: '0 1px 2px rgba(0,0,0,.08)' }}>
              {applying ? '…' : 'Apply'}
            </button>

            {/* Presets */}
            <div style={{ display: 'flex', gap: 4, marginLeft: 4 }}>
              {[7, 14, 30, 90].map(d => (
                <button key={d} onClick={() => applyPreset(d)}
                  style={{ background: '#fff', color: '#555', border: '1px solid #ddd', padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: '0.83em', fontWeight: 600, boxShadow: '0 1px 2px rgba(0,0,0,.04)' }}>
                  {d}d
                </button>
              ))}
            </div>
          </div>

          {/* ── ROW 1 · KPI CARDS (date-filtered) ──────────────────────────── */}
          <div>
            <SectionTitle>Period metrics · {fromParam} — {toParam}</SectionTitle>
            <div style={rowStyle}>
              <KpiCard
                label="New Members"
                value={analytics.activated_accounts.toLocaleString()}
                sub="Activated in period"
                onClick={() => openDrawer('activated_accounts', 'New Members')}
                dots={dots}
              />
              <KpiCard
                label="Generated Codes"
                value={analytics.generated_codes.toLocaleString()}
                sub="Discount codes issued"
                dots={dots}
              />
              <KpiCard
                label="Used Codes"
                value={analytics.used_codes === null ? null : analytics.used_codes.toLocaleString()}
                sub={`Redemption rate: ${redemptionRate}%`}
                onClick={() => openDrawer('used_codes', 'Used Discount Codes')}
                accent="#1a7f37"
                dots={dots}
              />
              <KpiCard
                label="Loyalty Order Value"
                value={analytics.total_order_value === null ? null : `$${analytics.total_order_value.toLocaleString()}`}
                sub="Orders with LOYALTY code"
                accent="#1a7f37"
                dots={dots}
              />
            </div>
          </div>

          {/* ── ROW 2 · MEMBERSHIP TOTALS (always unfiltered) ──────────────── */}
          <div>
            <SectionTitle>Membership overview · all-time</SectionTitle>
            <div style={rowStyle}>

              {/* Total Members + Tier Donut */}
              <div style={halfCard}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
                  <div>
                    <div style={{ fontSize: '0.78em', fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '.04em' }}>Total Members</div>
                    <div style={{ fontSize: '2.4em', fontWeight: 700, color: '#1a1a1a', lineHeight: 1.1 }}>{analytics.total_members.toLocaleString()}</div>
                  </div>
                </div>
                {tierPieData.length > 0 ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
                    <ResponsiveContainer width={160} height={160}>
                      <PieChart>
                        <Pie data={tierPieData} dataKey="value" cx="50%" cy="50%" innerRadius={46} outerRadius={72} paddingAngle={3}>
                          {tierPieData.map((entry) => (
                            <Cell key={entry.name} fill={tierColor(entry.name)} />
                          ))}
                        </Pie>
                        <Tooltip content={<ChartTooltip />} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {tierPieData.map(({ name, value }) => (
                        <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 10, height: 10, borderRadius: '50%', background: tierColor(name), flexShrink: 0 }} />
                          <div>
                            <div style={{ fontSize: '0.82em', color: '#555', fontWeight: 600 }}>{name}</div>
                            <div style={{ fontSize: '1em', fontWeight: 700, color: '#1a1a1a' }}>
                              {value.toLocaleString()}
                              <span style={{ fontSize: '0.75em', color: '#aaa', marginLeft: 4 }}>
                                ({Math.round(value / analytics.total_members * 100)}%)
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: '0.85em', color: '#bbb', marginTop: 8 }}>No tier data yet.</div>
                )}
              </div>

              {/* AOV Members vs Non-Members */}
              <div style={halfCard}>
                <div style={{ fontSize: '0.78em', fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 16 }}>
                  Avg. Order Value · Members vs Non-Members
                </div>
                <div style={{ display: 'flex', gap: 24, marginBottom: 20 }}>
                  <div>
                    <div style={{ fontSize: '0.78em', color: '#aaa' }}>Members</div>
                    <div style={{ fontSize: '1.8em', fontWeight: 700, color: '#1a7f37' }}>
                      {analytics.aov_members === null ? `Calculating${dots}` : `$${analytics.aov_members.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', fontSize: '1.3em', color: '#ccc', fontWeight: 300 }}>vs</div>
                  <div>
                    <div style={{ fontSize: '0.78em', color: '#aaa' }}>Non-Members</div>
                    <div style={{ fontSize: '1.8em', fontWeight: 700, color: '#1a1a1a' }}>
                      {analytics.aov_non_members === null ? `Calculating${dots}` : `$${analytics.aov_non_members.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    </div>
                  </div>
                  {analytics.aov_non_members > 0 && analytics.aov_members > 0 && (
                    <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 4 }}>
                      <div style={{ background: analytics.aov_members >= analytics.aov_non_members ? '#e6f4ea' : '#fce8e8', color: analytics.aov_members >= analytics.aov_non_members ? '#1a7f37' : '#c0392b', borderRadius: 6, padding: '3px 8px', fontSize: '0.8em', fontWeight: 700 }}>
                        {analytics.aov_members >= analytics.aov_non_members ? '+' : ''}{Math.round((analytics.aov_members / analytics.aov_non_members - 1) * 100)}%
                      </div>
                    </div>
                  )}
                </div>
                {analytics.aov_members !== null && analytics.aov_non_members !== null && (analytics.aov_members > 0 || analytics.aov_non_members > 0) ? (
                  <ResponsiveContainer width="100%" height={140}>
                    <BarChart data={aovBarData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} barSize={44}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#888' }} axisLine={false} tickLine={false} />
                      <YAxis hide />
                      <Tooltip content={<ChartTooltip dollar />} />
                      <Bar dataKey="aov" name="AOV" radius={[6, 6, 0, 0]}>
                        {aovBarData.map((entry, i) => (
                          <Cell key={i} fill={i === 0 ? '#1a7f37' : '#1a1a1a'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ fontSize: '0.85em', color: '#bbb' }}>No order data for selected period.</div>
                )}
              </div>

            </div>
          </div>

          {/* ── ROW · POINT GIFTS ──────────────────────────────────────────── */}
          <div>
            <SectionTitle>Point gifts · {fromParam} — {toParam}</SectionTitle>
            <div style={rowStyle}>
              {[
                { key: 'join',           label: 'Join',           pts: 100 },
                { key: 'birthdayadded',  label: 'Birthday Added', pts: 150 },
                { key: 'newsletter',     label: 'Newsletter',     pts: 150 },
                { key: 'instagram',      label: 'Instagram',      pts: 100 },
                { key: 'review',         label: 'Review',         pts: 150 },
                { key: 'tagsocialmedia', label: 'Tag Social',     pts: 150 },
                { key: 'tiktok',         label: 'TikTok',         pts: 100 },
                { key: 'customerstory',  label: 'Customer Story', pts: 200 },
              ].map(({ key, label, pts }) => (
                <KpiCard
                  key={key}
                  label={label}
                  value={giftCounts[key]?.toLocaleString() ?? '0'}
                  sub={`+${pts} pts each`}
                  onClick={() => openDrawer(`gift_${key}`, `${label} — Customers`)}
                  dots={dots}
                />
              ))}
            </div>
          </div>

          {/* ── ROW 3 · LTV (full-width) ────────────────────────────────────── */}
          <div>
            <SectionTitle>Customer value</SectionTitle>
            <div style={cardStyle}>
              <div style={{ fontSize: '0.78em', fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 16 }}>
                Avg. Lifetime Value by Tier
              </div>
              {ltvBarData.length > 0 ? (
                <>
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart data={ltvBarData} layout="vertical" margin={{ top: 0, right: 40, left: 8, bottom: 0 }} barSize={22}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f0f0f0" />
                      <XAxis type="number" tick={{ fontSize: 10, fill: '#aaa' }} axisLine={false} tickLine={false}
                        tickFormatter={v => `$${v >= 1000 ? `${(v/1000).toFixed(1)}k` : v}`} />
                      <YAxis type="category" dataKey="tier" tick={{ fontSize: 11, fill: '#555' }} axisLine={false} tickLine={false} width={90} />
                      <Tooltip content={<ChartTooltip dollar />} />
                      <Bar dataKey="avg" name="Avg LTV" radius={[0, 6, 6, 0]}>
                        {ltvBarData.map((entry) => (
                          <Cell key={entry.tier} fill={tierColor(entry.tier)} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 12 }}>
                    {ltvBarData.map(({ tier, avg }) => (
                      <div key={tier}>
                        <div style={{ fontSize: '0.75em', color: tierColor(tier), fontWeight: 600 }}>{tier}</div>
                        <div style={{ fontSize: '1.1em', fontWeight: 700, color: '#1a1a1a' }}>
                          ${avg.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: '0.85em', color: '#bbb', marginTop: 8 }}>No member data available.</div>
              )}
            </div>
          </div>

        </div>
      </Page>
    </AppProvider>
  );
}
