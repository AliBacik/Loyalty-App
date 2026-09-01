import { useState } from "react";
import { authenticate } from "../shopify.server";
import { Page, AppProvider } from "@shopify/polaris";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return {};
};

// ─── tier palette ─────────────────────────────────────────────────────────────
const TIER_PALETTE = {
  Circle:        '#8b8b8b',
  'Inner Circle': '#D4AF37',
  'Legacy Circle':'#1E90FF',
};
const tierColor = (t) => TIER_PALETTE[t] || '#8b8b8b';

const SectionTitle = ({ children }) => (
  <div style={{ fontSize: '0.78em', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: '#bbb', marginBottom: 10, paddingLeft: 2 }}>
    {children}
  </div>
);

export default function Tools() {
  // ── Klaviyo sync ────────────────────────────────────────────────────────────
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  const handleKlaviyoSync = async () => {
    setSyncing(true); setSyncResult(null);
    try {
      const res = await fetch('/api/admin/sync_klaviyo_status', { method: 'POST' });
      const json = await res.json();
      setSyncResult({ ok: res.ok, ...json });
    } catch (err) {
      setSyncResult({ ok: false, error: String(err) });
    } finally {
      setSyncing(false);
    }
  };

  // ── Drawer (Email Subscribed — Unused Code) ─────────────────────────────────
  const [drawer, setDrawer] = useState(false);
  const [drawerRows, setDrawerRows] = useState([]);
  const [drawerLoading, setDrawerLoading] = useState(false);

  const openDrawer = async () => {
    setDrawer(true); setDrawerRows([]); setDrawerLoading(true);
    try {
      const res = await fetch('/api/analytics/eligible_subscribers');
      const json = await res.json();
      setDrawerRows(json.customers || []);
    } catch { setDrawerRows([]); }
    finally { setDrawerLoading(false); }
  };
  const closeDrawer = () => { setDrawer(false); setDrawerRows([]); };

  const exportCSV = (rows) => {
    const header = 'Email,Tier,Status,Redeemable Points,Discount Codes';
    const lines = rows.map(r =>
      [r.email, r.tier || 'Circle', r.status || '', r.redeemable_points ?? 0, (r.discount_codes || []).join(' | ')]
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    );
    const csv = [header, ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eligible_subscribers_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── styles ─────────────────────────────────────────────────────────────────
  const cardStyle = {
    background: '#fff', border: '1px solid #e3e3e3',
    borderRadius: 12, padding: '24px',
    boxShadow: '0 1px 3px rgba(0,0,0,.06)',
  };

  return (
    <AppProvider>
      <Page title="Tools" backAction={{ content: 'Dashboard', url: '/app' }}>

        {/* ── DRAWER ─────────────────────────────────────────────────────────── */}
        {drawer && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}>
            <div onClick={closeDrawer} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)' }} />
            <div style={{ position: 'relative', width: 500, maxWidth: '95vw', height: '100%', background: '#fff', boxShadow: '-4px 0 24px rgba(0,0,0,.15)', display: 'flex', flexDirection: 'column', zIndex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: '1px solid #eee' }}>
                <div style={{ fontWeight: 700, fontSize: '1.1em' }}>Email Subscribed — Unused Code</div>
                <button onClick={closeDrawer} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.4em', color: '#555' }}>✕</button>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
                {drawerLoading ? (
                  <div style={{ color: '#888', marginTop: 40, textAlign: 'center' }}>Loading…</div>
                ) : drawerRows.length === 0 ? (
                  <div style={{ color: '#888', marginTop: 40, textAlign: 'center' }}>No customers found.</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88em' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #ddd', textAlign: 'left' }}>
                        <th style={{ padding: '8px 6px' }}>Email</th>
                        <th style={{ padding: '8px 6px' }}>Tier</th>
                        <th style={{ padding: '8px 6px' }}>Status</th>
                        <th style={{ padding: '8px 6px' }}>Discount Codes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {drawerRows.map((r, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                          <td style={{ padding: '8px 6px' }}>{r.email}</td>
                          <td style={{ padding: '8px 6px', color: tierColor(r.tier) }}>{r.tier || 'Circle'}</td>
                          <td style={{ padding: '8px 6px' }}>{r.status || '-'}</td>
                          <td style={{ padding: '8px 6px', fontFamily: 'monospace', fontSize: '0.82em', color: '#555' }}>
                            {(r.discount_codes || []).join(', ')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              {!drawerLoading && drawerRows.length > 0 && (
                <div style={{ padding: '12px 24px', borderTop: '1px solid #eee', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '0.85em', color: '#888' }}>{drawerRows.length} record{drawerRows.length !== 1 ? 's' : ''}</span>
                  <button onClick={() => exportCSV(drawerRows)} style={{ background: 'black', color: '#fff', border: 'none', padding: '7px 14px', borderRadius: 5, cursor: 'pointer', fontWeight: 600, fontSize: '0.85em' }}>
                    Export CSV
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── PAGE BODY ──────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, paddingBottom: 40 }}>

          {/* ── Klaviyo Sync ───────────────────────────────────────────────── */}
          <div>
            <SectionTitle>Klaviyo</SectionTitle>
            <div style={cardStyle}>
              <div style={{ fontWeight: 700, fontSize: '0.95em', marginBottom: 6 }}>Sync Klaviyo status → DB</div>
              <p style={{ fontSize: '0.85em', color: '#777', margin: '0 0 14px', lineHeight: 1.5 }}>
                Fetches all customers from Klaviyo whose status became &ldquo;active&rdquo;, then writes their
                activation timestamp into <code>status_changed_timestamp</code> in Supabase (earliest date wins).
              </p>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <button onClick={handleKlaviyoSync} disabled={syncing}
                  style={{ background: syncing ? '#666' : '#1a1a1a', color: '#fff', border: 'none', padding: '9px 18px', borderRadius: 6, cursor: syncing ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '0.9em' }}>
                  {syncing ? 'Syncing…' : 'Run Sync'}
                </button>
                {syncing && <span style={{ fontSize: '0.82em', color: '#aaa' }}>Fetching all Klaviyo pages…</span>}
              </div>
              {syncResult && (
                <div style={{ marginTop: 12, padding: '12px 16px', borderRadius: 8, background: syncResult.ok ? '#f0faf0' : '#fff0f0', border: `1px solid ${syncResult.ok ? '#b2dfb2' : '#f5c6c6'}` }}>
                  {syncResult.ok ? (
                    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: '0.85em' }}>
                      <span>✓ Sync complete</span>
                      <span>Klaviyo active: <strong>{syncResult.unique_emails?.toLocaleString()}</strong></span>
                      <span>Updated in DB: <strong style={{ color: '#1a7f37' }}>{syncResult.updated?.toLocaleString()}</strong></span>
                      <span>Not in DB: <strong style={{ color: '#888' }}>{syncResult.not_found?.toLocaleString()}</strong>
                        {syncResult.not_found_emails?.length > 0 && (
                          <details style={{ display: 'inline', marginLeft: 6 }}>
                            <summary style={{ cursor: 'pointer', color: '#555', fontSize: '0.85em' }}>show</summary>
                            <div style={{ marginTop: 6, maxHeight: 180, overflowY: 'auto', background: '#f7f7f7', border: '1px solid #ddd', borderRadius: 4, padding: '6px 10px' }}>
                              {syncResult.not_found_emails.map(e => <div key={e} style={{ fontFamily: 'monospace', fontSize: '0.85em', padding: '1px 0' }}>{e}</div>)}
                            </div>
                          </details>
                        )}
                      </span>
                      {syncResult.errors > 0 && <span>DB errors: <strong style={{ color: '#c21f1f' }}>{syncResult.errors}</strong></span>}
                    </div>
                  ) : (
                    <span style={{ color: '#c21f1f', fontSize: '0.85em' }}>Error: {syncResult.error || 'Sync failed'}</span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── Email Subscribed — Unused Code ─────────────────────────────── */}
          <div>
            <SectionTitle>Email Marketing</SectionTitle>
            <div style={cardStyle}>
              <div style={{ fontWeight: 700, fontSize: '0.95em', marginBottom: 6 }}>Email Subscribed — Unused Code</div>
              <p style={{ fontSize: '0.85em', color: '#777', margin: '0 0 14px', lineHeight: 1.5 }}>
                Members who have a generated but unused discount code and are actively subscribed to email marketing on Shopify.
              </p>
              <button onClick={openDrawer}
                style={{ background: '#1a1a1a', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: '0.9em' }}>
                View List
              </button>
            </div>
          </div>

        </div>
      </Page>
    </AppProvider>
  );
}
