import { useEffect, useState, useCallback } from "react";
import { useNavigate, useLoaderData } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import { AppProvider, Page } from "@shopify/polaris";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, PieChart, Pie,
  LineChart, Line,
} from "recharts";

import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import dashboardStyles from "../styles/dashboard.css?url";

export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: dashboardStyles },
];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  return { shopDomain: session.shop };
};

// ── palette ──────────────────────────────────────────────────────────────────
const COLORS = [
  "#1a1a1a", "#2563eb", "#16a34a", "#dc2626", "#9333ea",
  "#ea580c", "#0891b2", "#ca8a04", "#db2777", "#65a30d",
  "#7c3aed", "#0284c7", "#b45309", "#be185d", "#166534",
  "#1e40af", "#9a3412", "#1d4ed8", "#15803d", "#7e22ce",
];

const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8,
      padding: "8px 14px", fontSize: "0.85em", boxShadow: "0 2px 8px rgba(0,0,0,.08)",
      maxWidth: 280,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 2, wordBreak: "break-word" }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.fill || "#333" }}>
          Wishlist count: <strong>{p.value.toLocaleString()}</strong>
        </div>
      ))}
    </div>
  );
};

const SectionTitle = ({ children }) => (
  <div style={{
    fontSize: "0.72em", fontWeight: 700, color: "#999",
    textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 14,
  }}>
    {children}
  </div>
);

const cardStyle = {
  background: "#fff", border: "1px solid #e3e3e3",
  borderRadius: 12, padding: "24px",
  boxShadow: "0 1px 3px rgba(0,0,0,.06)",
};

// Truncate long labels for bar chart axes
const truncate = (str, n = 22) => str && str.length > n ? str.slice(0, n) + "…" : str;

// Custom axis tick for long product names
const CustomXTick = ({ x, y, payload }) => (
  <g transform={`translate(${x},${y})`}>
    <text
      x={0} y={0} dy={12}
      textAnchor="end"
      transform="rotate(-35)"
      fill="#666"
      fontSize={10}
    >
      {truncate(payload.value, 20)}
    </text>
  </g>
);

// ── Customers Panel ───────────────────────────────────────────────────────────
function WishlistCustomers({ shopDomain }) {
  const [emailSearch, setEmailSearch] = useState("");
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [customerItems, setCustomerItems] = useState([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  // Export state
  const [checked, setChecked] = useState({});
  const [exportFormat, setExportFormat] = useState("csv");
  const [exporting, setExporting] = useState(false);

  const selectedCount = Object.values(checked).filter(Boolean).length;

  const toggleCheck = (idx) => setChecked(prev => ({ ...prev, [idx]: !prev[idx] }));
  const toggleAll = () => {
    if (selectedCount === customerItems.length) {
      setChecked({});
    } else {
      const all = {};
      customerItems.forEach((_, i) => { all[i] = true; });
      setChecked(all);
    }
  };

  const search = useCallback(() => {
    setLoading(true);
    setError(null);
    setSearched(true);
    setSelectedCustomer(null);
    setCustomerItems([]);
    setChecked({});
    fetch(`/api/analytics/wishlist-customers?email=${encodeURIComponent(emailSearch)}`)
      .then(r => r.json())
      .then(data => { setCustomers(data.customers || []); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [emailSearch]);

  const loadItems = (customer) => {
    setSelectedCustomer(customer);
    setItemsLoading(true);
    setCustomerItems([]);
    setChecked({});
    fetch(`/api/analytics/wishlist-customers?customerId=${encodeURIComponent(customer.id)}`)
      .then(r => r.json())
      .then(data => { setCustomerItems(data.items || []); setItemsLoading(false); })
      .catch(() => setItemsLoading(false));
  };

  const handleExport = async () => {
    const selected = customerItems.filter((_, i) => checked[i]);
    if (!selected.length) return;
    setExporting(true);
    try {
      // Fetch SKUs from Shopify for selected variants
      const variantGids = [...new Set(selected.map(item => item.variant_gid).filter(Boolean))];
      let skuMap = {};
      let priceMap = {};
      let productTitleMap = {};
      if (variantGids.length) {
        const res = await fetch("/api/analytics/wishlist-export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ variantGids }),
        });
        const data = await res.json();
        skuMap = data.skus || {};
        priceMap = data.prices || {};
        productTitleMap = data.productTitles || {};
      }

      const rows = selected.map(item => {
        const variantId = item.variant_gid
          ? item.variant_gid.replace("gid://shopify/ProductVariant/", "")
          : "";
        const sku = item.variant_gid ? (skuMap[item.variant_gid] || "") : "";
        const retailPrice = item.variant_gid ? (priceMap[item.variant_gid] || item.price || "") : (item.price || "");
        const shopifyProductTitle = item.variant_gid ? (productTitleMap[item.variant_gid] || "") : "";
        const storeLink = item.product_handle && shopDomain
          ? `https://${shopDomain}/products/${item.product_handle}`
          : "";
        const props = item.properties
          ? (typeof item.properties === "object" ? JSON.stringify(item.properties) : item.properties)
          : "";
        return { product_title: shopifyProductTitle || item.product_title || "", variant_title: item.variant_title || "", variant_sku: sku, retail_price: retailPrice, store_link: storeLink, variant_id: variantId, image_url: item.image_url || "", properties: props, db_image_url: item.image_url || "" };
      });

      if (exportFormat === "json") {
        const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
        triggerDownload(blob, `wishlist-export-${Date.now()}.json`);
      } else {
        const headers = ["product_title", "variant_title", "variant_sku", "retail_price", "store_link", "variant_id", "image_url", "properties", "db_image_url"];
        const csvLines = [
          headers.join(","),
          ...rows.map(r => headers.map(h => `"${String(r[h] ?? "").replace(/"/g, '""')}"`).join(",")),
        ];
        const blob = new Blob([csvLines.join("\n")], { type: "text/csv" });
        triggerDownload(blob, `wishlist-export-${Date.now()}.csv`);
      }
    } finally {
      setExporting(false);
    }
  };

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, paddingBottom: 40 }}>

      {/* Search bar */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          background: "#fff", border: "1px solid #ddd", borderRadius: 8,
          padding: "8px 14px", flex: 1, maxWidth: 400,
          boxShadow: "0 1px 2px rgba(0,0,0,.06)",
        }}>
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="#aaa" strokeWidth="2">
            <circle cx="8.5" cy="8.5" r="5.5"/><line x1="13" y1="13" x2="18" y2="18"/>
          </svg>
          <input
            type="text"
            placeholder="Search by email..."
            value={emailSearch}
            onChange={e => setEmailSearch(e.target.value)}
            onKeyDown={e => e.key === "Enter" && search()}
            style={{ border: "none", outline: "none", fontSize: "0.92em", color: "#1a1a1a", background: "transparent", width: "100%" }}
          />
        </div>
        <button
          onClick={search}
          disabled={loading}
          style={{ background: loading ? "#888" : "#1a1a1a", color: "#fff", border: "none", padding: "9px 18px", borderRadius: 8, cursor: loading ? "not-allowed" : "pointer", fontWeight: 600, fontSize: "0.88em" }}
        >
          {loading ? "…" : "Search"}
        </button>
        <button
          onClick={() => { setEmailSearch(""); setSearched(true); setLoading(true); setError(null); setSelectedCustomer(null); setCustomerItems([]);
            fetch("/api/analytics/wishlist-customers").then(r => r.json()).then(d => { setCustomers(d.customers || []); setLoading(false); setSearched(true); }).catch(e => { setError(e.message); setLoading(false); });
          }}
          style={{ background: "#fff", color: "#555", border: "1px solid #ddd", padding: "9px 18px", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontSize: "0.88em" }}
        >
          Show All
        </button>
      </div>

      {error && <div style={{ color: "#c0392b", padding: 12, background: "#fce8e8", borderRadius: 8, fontSize: "0.88em" }}>Error: {error}</div>}

      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>

        {/* Customer list */}
        <div style={{ flex: "0 0 380px", minWidth: 280 }}>
          {searched && !loading && customers.length === 0 && (
            <div style={{ color: "#aaa", fontSize: "0.9em", padding: "20px 0" }}>No customers found.</div>
          )}
          {!searched && (
            <div style={{ color: "#bbb", fontSize: "0.88em", padding: "20px 0" }}>Search by email or click "Show All" to list customers.</div>
          )}
          {customers.length > 0 && (
            <div style={{ background: "#fff", border: "1px solid #e3e3e3", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,.06)" }}>
              <div style={{ padding: "10px 16px", background: "#fafafa", borderBottom: "1px solid #f0f0f0", fontSize: "0.72em", fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: ".06em" }}>
                {customers.length} customer{customers.length !== 1 ? "s" : ""}
              </div>
              {customers.map((c, i) => (
                <div
                  key={c.id}
                  onClick={() => loadItems(c)}
                  style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    padding: "12px 16px", cursor: "pointer",
                    borderBottom: i < customers.length - 1 ? "1px solid #f5f5f5" : "none",
                    background: selectedCustomer?.id === c.id ? "#f0f7ff" : "#fff",
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={e => { if (selectedCustomer?.id !== c.id) e.currentTarget.style.background = "#fafafa"; }}
                  onMouseLeave={e => { if (selectedCustomer?.id !== c.id) e.currentTarget.style.background = "#fff"; }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "0.9em", color: "#1a1a1a" }}>{c.email}</div>
                    <div style={{ fontSize: "0.78em", color: "#aaa", marginTop: 2 }}>
                      {c.itemCount} item{c.itemCount !== 1 ? "s" : ""} · Last added {c.lastAdded ? new Date(c.lastAdded).toLocaleDateString() : "—"}
                    </div>
                  </div>
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke={selectedCustomer?.id === c.id ? "#2563eb" : "#ccc"} strokeWidth="2">
                    <polyline points="6 3 14 10 6 17"/>
                  </svg>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Customer detail */}
        {selectedCustomer && (
          <div style={{ flex: 1, minWidth: 300 }}>
            <div style={{ background: "#fff", border: "1px solid #e3e3e3", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,.06)" }}>
              <div style={{ padding: "14px 20px", background: "#fafafa", borderBottom: "1px solid #f0f0f0" }}>
                <div style={{ fontWeight: 700, fontSize: "0.95em", color: "#1a1a1a" }}>{selectedCustomer.email}</div>
                <div style={{ fontSize: "0.75em", color: "#aaa", marginTop: 2 }}>{selectedCustomer.itemCount} wishlist item{selectedCustomer.itemCount !== 1 ? "s" : ""}</div>
              </div>

              {itemsLoading && (
                <div style={{ padding: "24px 20px", color: "#aaa", fontSize: "0.88em" }}>Loading items…</div>
              )}

              {!itemsLoading && customerItems.length === 0 && (
                <div style={{ padding: "24px 20px", color: "#aaa", fontSize: "0.88em" }}>No items found.</div>
              )}

              {!itemsLoading && customerItems.length > 0 && (
                <div>
                  {/* Export toolbar */}
                  <div style={{
                    display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                    padding: "10px 20px", background: "#f8f9fa", borderBottom: "1px solid #f0f0f0",
                  }}>
                    <input
                      type="checkbox"
                      checked={selectedCount === customerItems.length && customerItems.length > 0}
                      onChange={toggleAll}
                      style={{ cursor: "pointer", width: 15, height: 15 }}
                      title="Select all"
                    />
                    <span style={{ fontSize: "0.8em", color: "#888", minWidth: 60 }}>
                      {selectedCount}/{customerItems.length} selected
                    </span>
                    <select
                      value={exportFormat}
                      onChange={e => setExportFormat(e.target.value)}
                      style={{
                        border: "1px solid #ddd", borderRadius: 6, padding: "5px 8px",
                        fontSize: "0.82em", background: "#fff", cursor: "pointer",
                      }}
                    >
                      <option value="csv">CSV</option>
                      <option value="json">JSON</option>
                    </select>
                    <button
                      onClick={handleExport}
                      disabled={selectedCount === 0 || exporting}
                      style={{
                        background: selectedCount === 0 ? "#f0f0f0" : "#1a1a1a",
                        color: selectedCount === 0 ? "#bbb" : "#fff",
                        border: "none", padding: "6px 14px", borderRadius: 6,
                        cursor: selectedCount === 0 ? "not-allowed" : "pointer",
                        fontWeight: 600, fontSize: "0.82em",
                      }}
                    >
                      {exporting ? "Exporting…" : `Export${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
                    </button>
                  </div>

                  {customerItems.map((item, i) => (
                    <div key={i} style={{
                      display: "flex", gap: 14, padding: "14px 20px", alignItems: "center",
                      borderBottom: i < customerItems.length - 1 ? "1px solid #f5f5f5" : "none",
                      background: checked[i] ? "#f0f7ff" : "transparent",
                      cursor: "pointer",
                    }}
                      onClick={() => toggleCheck(i)}
                    >
                      <input
                        type="checkbox"
                        checked={!!checked[i]}
                        onChange={() => toggleCheck(i)}
                        onClick={e => e.stopPropagation()}
                        style={{ cursor: "pointer", width: 15, height: 15, flexShrink: 0 }}
                      />
                      {item.image_url ? (
                        <img src={item.image_url} alt={item.product_title} style={{ width: 56, height: 56, objectFit: "contain", borderRadius: 8, border: "1px solid #f0f0f0", flexShrink: 0 }} />
                      ) : (
                        <div style={{ width: 56, height: 56, background: "#f5f5f5", borderRadius: 8, flexShrink: 0 }} />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: "0.88em", color: "#1a1a1a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {item.product_title || "—"}
                        </div>
                        {item.variant_title && item.variant_title !== "Default Title" && (
                          <div style={{ fontSize: "0.78em", color: "#888", marginTop: 1 }}>{item.variant_title}</div>
                        )}
                        {item.properties && Object.keys(item.properties).filter(k => !k.startsWith("_")).length > 0 && (
                          <div style={{ fontSize: "0.75em", color: "#aaa", marginTop: 3 }}>
                            {Object.entries(item.properties)
                              .filter(([k]) => !k.startsWith("_"))
                              .map(([k, v]) => `${k}: ${v}`)
                              .join(" · ")}
                          </div>
                        )}
                        {item.price && (
                          <div style={{ fontSize: "0.82em", fontWeight: 700, color: "#1a1a1a", marginTop: 3 }}>${item.price}</div>
                        )}
                      </div>
                      <div style={{ fontSize: "0.72em", color: "#bbb", flexShrink: 0 }}>
                        {item.added_at ? new Date(item.added_at).toLocaleDateString() : ""}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function WishlistAnalytics() {
  const { shopDomain } = useLoaderData();
  const navigate = useNavigate();

  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setDate(defaultFrom.getDate() - 30);

  const [activeTab, setActiveTab] = useState("analytics");
  const [customerType, setCustomerType] = useState("logged");
  const [fromDate, setFromDate] = useState(defaultFrom.toISOString().split("T")[0]);
  const [toDate, setToDate] = useState(now.toISOString().split("T")[0]);
  const [appliedFrom, setAppliedFrom] = useState(fromDate);
  const [appliedTo, setAppliedTo] = useState(toDate);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = (from, to, type = customerType) => {
    setLoading(true);
    setError(null);
    fetch(`/api/analytics/wishlist?from=${from}&to=${to}&customerType=${type}`)
      .then(r => r.json())
      .then(json => { setData(json); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  };

  useEffect(() => { fetchData(appliedFrom, appliedTo, customerType); }, []);

  const switchCustomerType = (type) => {
    setCustomerType(type);
    fetchData(appliedFrom, appliedTo, type);
  };

  const applyDateRange = () => {
    setAppliedFrom(fromDate);
    setAppliedTo(toDate);
    fetchData(fromDate, toDate);
  };

  const applyPreset = (days) => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days);
    const toStr = to.toISOString().split("T")[0];
    const fromStr = from.toISOString().split("T")[0];
    setFromDate(fromStr);
    setToDate(toStr);
    setAppliedFrom(fromStr);
    setAppliedTo(toStr);
    fetchData(fromStr, toStr);
  };

  return (
    <AppProvider>
      <Page
        title="Wishlist Analytics"
        backAction={{ content: "Analytics", onAction: () => navigate("/app/analytics") }}
      >
        {/* ── TAB NAV ──────────────────────────────────────────────────────── */}
        <div style={{ display: "flex", gap: 4, marginBottom: 24 }}>
          <button
            onClick={() => navigate("/app/analytics")}
            style={{
              background: "#fff", color: "#555", border: "1px solid #ddd",
              padding: "7px 16px", borderRadius: 8, cursor: "pointer",
              fontSize: "0.88em", fontWeight: 600,
            }}
          >
            Loyalty
          </button>
          {["analytics", "customers"].map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                background: activeTab === tab ? "#1a1a1a" : "#fff",
                color: activeTab === tab ? "#fff" : "#555",
                border: activeTab === tab ? "1px solid #1a1a1a" : "1px solid #ddd",
                padding: "7px 16px", borderRadius: 8,
                cursor: activeTab === tab ? "default" : "pointer",
                fontSize: "0.88em", fontWeight: 600,
                textTransform: "capitalize",
              }}
            >
              {tab === "analytics" ? "Wishlist" : "Customers"}
            </button>
          ))}
        </div>

        {activeTab === "customers" && <WishlistCustomers shopDomain={shopDomain} />}

        {activeTab === "analytics" && <>
        {/* ── CUSTOMER TYPE TOGGLE ───────────────────────────────────────────── */}
        <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
          {[
            { key: "logged", label: "Logged Customers" },
            { key: "guest", label: "Non-logged Customers" },
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => switchCustomerType(key)}
              disabled={loading}
              style={{
                background: customerType === key ? "#1a1a1a" : "#fff",
                color: customerType === key ? "#fff" : "#555",
                border: customerType === key ? "1px solid #1a1a1a" : "1px solid #ddd",
                padding: "7px 18px", borderRadius: 8,
                cursor: loading ? "not-allowed" : (customerType === key ? "default" : "pointer"),
                fontSize: "0.88em", fontWeight: 600,
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ── DATE RANGE PICKER ──────────────────────────────────────────────── */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{
            display: "flex", alignItems: "center", gap: 6,
            background: "#fff", border: "1px solid #ddd", borderRadius: 8,
            padding: "7px 14px", cursor: "pointer", fontSize: "0.9em", fontWeight: 500,
            boxShadow: "0 1px 2px rgba(0,0,0,.06)",
          }}>
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="#888" strokeWidth="1.8">
              <rect x="2" y="3" width="16" height="15" rx="2"/>
              <line x1="6" y1="1" x2="6" y2="5"/><line x1="14" y1="1" x2="14" y2="5"/>
              <line x1="2" y1="8" x2="18" y2="8"/>
            </svg>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
              style={{ border: "none", outline: "none", fontSize: "0.95em", fontWeight: 500, color: "#1a1a1a", background: "transparent", cursor: "pointer", width: 120 }} />
          </label>

          <span style={{ color: "#bbb", fontSize: "0.9em" }}>→</span>

          <label style={{
            display: "flex", alignItems: "center", gap: 6,
            background: "#fff", border: "1px solid #ddd", borderRadius: 8,
            padding: "7px 14px", cursor: "pointer", fontSize: "0.9em", fontWeight: 500,
            boxShadow: "0 1px 2px rgba(0,0,0,.06)",
          }}>
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="#888" strokeWidth="1.8">
              <rect x="2" y="3" width="16" height="15" rx="2"/>
              <line x1="6" y1="1" x2="6" y2="5"/><line x1="14" y1="1" x2="14" y2="5"/>
              <line x1="2" y1="8" x2="18" y2="8"/>
            </svg>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
              style={{ border: "none", outline: "none", fontSize: "0.95em", fontWeight: 500, color: "#1a1a1a", background: "transparent", cursor: "pointer", width: 120 }} />
          </label>

          <button onClick={applyDateRange} disabled={loading}
            style={{ background: loading ? "#888" : "#1a1a1a", color: "#fff", border: "none", padding: "8px 16px", borderRadius: 8, cursor: loading ? "not-allowed" : "pointer", fontWeight: 600, fontSize: "0.88em", boxShadow: "0 1px 2px rgba(0,0,0,.08)" }}>
            {loading ? "…" : "Apply"}
          </button>

          <div style={{ display: "flex", gap: 4, marginLeft: 4 }}>
            {[7, 14, 30, 90].map(d => (
              <button key={d} onClick={() => applyPreset(d)} disabled={loading}
                style={{ background: "#fff", color: "#555", border: "1px solid #ddd", padding: "7px 12px", borderRadius: 8, cursor: "pointer", fontSize: "0.83em", fontWeight: 600, boxShadow: "0 1px 2px rgba(0,0,0,.04)" }}>
                {d}d
              </button>
            ))}
          </div>
        </div>

        {/* ── PERIOD LABEL ───────────────────────────────────────────────────── */}
        <div style={{ fontSize: "0.72em", fontWeight: 700, color: "#999", textTransform: "uppercase", letterSpacing: ".06em" }}>
          Period · {appliedFrom} — {appliedTo}
        </div>

        {loading && (
          <div style={{ color: "#888", padding: "60px 0", textAlign: "center" }}>
            <div style={{ fontSize: "1.1em", marginBottom: 8 }}>Loading wishlist data…</div>
            <div style={{ fontSize: "0.82em", color: "#bbb" }}>
              This may take a moment while we scan all customer wishlists.
            </div>
          </div>
        )}

        {error && (
          <div style={{ color: "#c0392b", padding: 20, background: "#fce8e8", borderRadius: 8 }}>
            Error loading data: {error}
          </div>
        )}

        {data && !loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 24, paddingBottom: 40 }}>

            {/* ── KPI CARDS ──────────────────────────────────────────────── */}
            <div>
              <SectionTitle>Overview · all-time</SectionTitle>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                {[
                  {
                    label: "Total Wishlist Items",
                    value: data.totalWishlistItems.toLocaleString(),
                    sub: "Added in period",
                  },
                  {
                    label: customerType === "guest" ? "Guest Sessions" : "Customers with Wishlist",
                    value: data.totalCustomersWithWishlists.toLocaleString(),
                    sub: customerType === "guest" ? "Unique anonymous visitors" : "At least 1 saved item",
                  },
                  {
                    label: "Avg Items / Customer",
                    value: data.avgWishlistSize.toLocaleString(),
                    sub: "Wishlist size average",
                  },
                  {
                    label: "Categories",
                    value: data.topCategories.length.toLocaleString(),
                    sub: "By product type",
                  },
                ].map(({ label, value, sub }) => (
                  <div key={label} style={{
                    flex: "1 1 180px", minWidth: 160,
                    background: "#fff", border: "1px solid #e3e3e3",
                    borderRadius: 12, padding: "20px 22px",
                    boxShadow: "0 1px 3px rgba(0,0,0,.06)",
                  }}>
                    <div style={{ fontSize: "0.78em", fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 6 }}>
                      {label}
                    </div>
                    <div style={{ fontSize: "2em", fontWeight: 700, color: "#1a1a1a", lineHeight: 1.15 }}>
                      {value}
                    </div>
                    <div style={{ fontSize: "0.8em", color: "#aaa", marginTop: 4 }}>{sub}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── CHART 1: TOP PRODUCTS ──────────────────────────────────── */}
            <div>
              <SectionTitle>Top wishlisted products</SectionTitle>
              <div style={cardStyle}>
                <div style={{ fontSize: "0.78em", fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 16 }}>
                  Most saved products (by unique customers)
                </div>
                {data.topProducts.length > 0 ? (
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart
                      data={data.topProducts}
                      margin={{ top: 4, right: 16, left: 0, bottom: 80 }}
                      barSize={28}
                    >
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                      <XAxis
                        dataKey="name"
                        tick={<CustomXTick />}
                        axisLine={false}
                        tickLine={false}
                        interval={0}
                      />
                      <YAxis tick={{ fontSize: 11, fill: "#aaa" }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <Tooltip content={<ChartTooltip />} />
                      <Bar dataKey="count" name="Saves" radius={[6, 6, 0, 0]}>
                        {data.topProducts.map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ fontSize: "0.85em", color: "#bbb" }}>No wishlist data yet.</div>
                )}

                {/* Table below chart */}
                {data.topProducts.length > 0 && (
                  <div style={{ marginTop: 24, overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85em" }}>
                      <thead>
                        <tr style={{ borderBottom: "2px solid #f0f0f0" }}>
                          <th style={{ textAlign: "left", padding: "6px 8px", color: "#888", fontWeight: 600, textTransform: "uppercase", fontSize: "0.85em" }}>#</th>
                          <th style={{ textAlign: "left", padding: "6px 8px", color: "#888", fontWeight: 600, textTransform: "uppercase", fontSize: "0.85em" }}>Product</th>
                          <th style={{ textAlign: "right", padding: "6px 8px", color: "#888", fontWeight: 600, textTransform: "uppercase", fontSize: "0.85em" }}>Saves</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.topProducts.map((p, i) => (
                          <tr key={i} style={{ borderBottom: "1px solid #f8f8f8" }}>
                            <td style={{ padding: "8px 8px", color: "#bbb", fontWeight: 700 }}>{i + 1}</td>
                            <td style={{ padding: "8px 8px" }}>
                              {p.productHandle ? (
                                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: COLORS[i % COLORS.length], flexShrink: 0 }} />
                                  {p.name}
                                </span>
                              ) : (
                                <span style={{ color: "#aaa" }}>{p.name}</span>
                              )}
                            </td>
                            <td style={{ padding: "8px 8px", textAlign: "right", fontWeight: 700 }}>{p.count.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* ── CHART 2: TOP VARIANTS ──────────────────────────────────── */}
            <div>
              <SectionTitle>Top wishlisted variants</SectionTitle>
              <div style={cardStyle}>
                <div style={{ fontSize: "0.78em", fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 16 }}>
                  Most saved specific variants
                </div>
                {data.topVariants.length > 0 ? (
                  <>
                    <ResponsiveContainer width="100%" height={320}>
                      <BarChart
                        data={data.topVariants}
                        layout="vertical"
                        margin={{ top: 0, right: 40, left: 8, bottom: 0 }}
                        barSize={18}
                      >
                        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f0f0f0" />
                        <XAxis type="number" tick={{ fontSize: 10, fill: "#aaa" }} axisLine={false} tickLine={false} allowDecimals={false} />
                        <YAxis
                          type="category"
                          dataKey="name"
                          tick={{ fontSize: 10, fill: "#555" }}
                          axisLine={false}
                          tickLine={false}
                          width={200}
                          tickFormatter={v => truncate(v, 30)}
                        />
                        <Tooltip content={<ChartTooltip />} />
                        <Bar dataKey="count" name="Saves" radius={[0, 6, 6, 0]}>
                          {data.topVariants.map((_, i) => (
                            <Cell key={i} fill={COLORS[i % COLORS.length]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>

                    <div style={{ marginTop: 24, overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85em" }}>
                        <thead>
                          <tr style={{ borderBottom: "2px solid #f0f0f0" }}>
                            <th style={{ textAlign: "left", padding: "6px 8px", color: "#888", fontWeight: 600, textTransform: "uppercase", fontSize: "0.85em" }}>#</th>
                            <th style={{ textAlign: "left", padding: "6px 8px", color: "#888", fontWeight: 600, textTransform: "uppercase", fontSize: "0.85em" }}>Product</th>
                            <th style={{ textAlign: "left", padding: "6px 8px", color: "#888", fontWeight: 600, textTransform: "uppercase", fontSize: "0.85em" }}>Variant</th>
                            <th style={{ textAlign: "right", padding: "6px 8px", color: "#888", fontWeight: 600, textTransform: "uppercase", fontSize: "0.85em" }}>Saves</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.topVariants.map((v, i) => (
                            <tr key={i} style={{ borderBottom: "1px solid #f8f8f8" }}>
                              <td style={{ padding: "8px 8px", color: "#bbb", fontWeight: 700 }}>{i + 1}</td>
                              <td style={{ padding: "8px 8px", color: "#555" }}>{v.productTitle || "—"}</td>
                              <td style={{ padding: "8px 8px", fontWeight: 600 }}>
                                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: COLORS[i % COLORS.length], flexShrink: 0 }} />
                                  {v.shortName}
                                </span>
                              </td>
                              <td style={{ padding: "8px 8px", textAlign: "right", fontWeight: 700 }}>{v.count.toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: "0.85em", color: "#bbb" }}>No variant data yet.</div>
                )}
              </div>
            </div>

            {/* ── CHART 3: CATEGORIES ────────────────────────────────────── */}
            <div>
              <SectionTitle>Wishlist by category</SectionTitle>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>

                {/* Donut pie */}
                <div style={{ ...cardStyle, flex: "0 0 auto", minWidth: 280 }}>
                  <div style={{ fontSize: "0.78em", fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 16 }}>
                    Category distribution
                  </div>
                  {data.topCategories.length > 0 ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
                      <ResponsiveContainer width={180} height={180}>
                        <PieChart>
                          <Pie
                            data={data.topCategories}
                            dataKey="count"
                            nameKey="name"
                            cx="50%"
                            cy="50%"
                            innerRadius={48}
                            outerRadius={78}
                            paddingAngle={3}
                          >
                            {data.topCategories.map((_, i) => (
                              <Cell key={i} fill={COLORS[i % COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip content={<ChartTooltip />} />
                        </PieChart>
                      </ResponsiveContainer>

                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {data.topCategories.map(({ name, count }, i) => {
                          const pct = data.totalWishlistItems > 0
                            ? Math.round((count / data.totalWishlistItems) * 100)
                            : 0;
                          return (
                            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <div style={{ width: 10, height: 10, borderRadius: "50%", background: COLORS[i % COLORS.length], flexShrink: 0 }} />
                              <div>
                                <div style={{ fontSize: "0.82em", color: "#555", fontWeight: 600 }}>{name}</div>
                                <div style={{ fontSize: "0.95em", fontWeight: 700, color: "#1a1a1a" }}>
                                  {count.toLocaleString()}
                                  <span style={{ fontSize: "0.75em", color: "#aaa", marginLeft: 4 }}>({pct}%)</span>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: "0.85em", color: "#bbb" }}>No category data yet.</div>
                  )}
                </div>

                {/* Horizontal bar */}
                <div style={{ ...cardStyle, flex: "1 1 340px", minWidth: 280 }}>
                  <div style={{ fontSize: "0.78em", fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 16 }}>
                    Saves by category
                  </div>
                  {data.topCategories.length > 0 ? (
                    <ResponsiveContainer width="100%" height={Math.max(160, data.topCategories.length * 32)}>
                      <BarChart
                        data={data.topCategories}
                        layout="vertical"
                        margin={{ top: 0, right: 40, left: 8, bottom: 0 }}
                        barSize={20}
                      >
                        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f0f0f0" />
                        <XAxis type="number" tick={{ fontSize: 10, fill: "#aaa" }} axisLine={false} tickLine={false} allowDecimals={false} />
                        <YAxis
                          type="category"
                          dataKey="name"
                          tick={{ fontSize: 11, fill: "#555" }}
                          axisLine={false}
                          tickLine={false}
                          width={100}
                        />
                        <Tooltip content={<ChartTooltip />} />
                        <Bar dataKey="count" name="Saves" radius={[0, 6, 6, 0]}>
                          {data.topCategories.map((_, i) => (
                            <Cell key={i} fill={COLORS[i % COLORS.length]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div style={{ fontSize: "0.85em", color: "#bbb" }}>No category data yet.</div>
                  )}
                </div>

              </div>
            </div>


            {/* ── CHART 4: DAILY TREND ───────────────────────────────────── */}
            <div>
              <SectionTitle>Daily wishlist activity</SectionTitle>
              <div style={cardStyle}>
                <div style={{ fontSize: "0.78em", fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 16 }}>
                  Items added per day
                </div>
                {data.dailyTrend?.length > 0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={data.dailyTrend} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10, fill: "#aaa" }}
                        axisLine={false}
                        tickLine={false}
                        tickFormatter={v => {
                          const d = new Date(v);
                          return `${d.getMonth() + 1}/${d.getDate()}`;
                        }}
                        interval="preserveStartEnd"
                      />
                      <YAxis tick={{ fontSize: 10, fill: "#aaa" }} axisLine={false} tickLine={false} allowDecimals={false} width={28} />
                      <Tooltip
                        content={({ active, payload, label }) => {
                          if (!active || !payload?.length) return null;
                          return (
                            <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, padding: "8px 14px", fontSize: "0.85em", boxShadow: "0 2px 8px rgba(0,0,0,.08)" }}>
                              <div style={{ fontWeight: 600, marginBottom: 2 }}>{label}</div>
                              <div>Items added: <strong>{payload[0].value}</strong></div>
                            </div>
                          );
                        }}
                      />
                      <Line
                        type="monotone"
                        dataKey="count"
                        stroke="#2563eb"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, fill: "#2563eb" }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ fontSize: "0.85em", color: "#bbb" }}>No trend data yet.</div>
                )}
              </div>
            </div>

            {/* ── CHART 5: DAY OF WEEK ───────────────────────────────────── */}
            <div>
              <SectionTitle>Activity by day of week</SectionTitle>
              <div style={cardStyle}>
                <div style={{ fontSize: "0.78em", fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 16 }}>
                  Which days customers save the most items
                </div>
                {data.dowDistribution?.some(d => d.count > 0) ? (
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={data.dowDistribution} margin={{ top: 4, right: 16, left: 0, bottom: 0 }} barSize={36}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                      <XAxis dataKey="name" tick={{ fontSize: 12, fill: "#555" }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: "#aaa" }} axisLine={false} tickLine={false} allowDecimals={false} width={28} />
                      <Tooltip
                        content={({ active, payload, label }) => {
                          if (!active || !payload?.length) return null;
                          return (
                            <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, padding: "8px 14px", fontSize: "0.85em", boxShadow: "0 2px 8px rgba(0,0,0,.08)" }}>
                              <div style={{ fontWeight: 600, marginBottom: 2 }}>{label}</div>
                              <div>Items saved: <strong>{payload[0].value}</strong></div>
                            </div>
                          );
                        }}
                      />
                      <Bar dataKey="count" name="Saves" radius={[6, 6, 0, 0]}>
                        {data.dowDistribution.map((entry, i) => {
                          const max = Math.max(...data.dowDistribution.map(d => d.count));
                          return <Cell key={i} fill={entry.count === max ? "#1a1a1a" : "#d1d5db"} />;
                        })}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ fontSize: "0.85em", color: "#bbb" }}>No data yet.</div>
                )}
              </div>
            </div>

            {/* ── CONVERSION / SYNC METRICS ──────────────────────────────── */}
            <div>
              <SectionTitle>
                {customerType === "guest" ? "Guest → Account sync" : "Wishlist → Purchase conversion"}
              </SectionTitle>

              {/* KPI row */}
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
                {(customerType === "guest" ? ([
                  {
                    label: "Sessions Synced",
                    value: (data.totalSynced || 0).toLocaleString(),
                    sub: "Guest sessions that logged in",
                    accent: "#2563eb",
                  },
                  {
                    label: "Sync Rate",
                    value: `${data.syncRate ?? 0}%`,
                    sub: "Of all guest sessions",
                    accent: "#2563eb",
                  },
                  {
                    label: "Still Anonymous",
                    value: ((data.totalCustomersWithWishlists || 0) - (data.totalSynced || 0)).toLocaleString(),
                    sub: "Sessions never logged in",
                    accent: "#1a1a1a",
                  },
                ]) : ([
                  {
                    label: "Converted Items",
                    value: (data.totalConverted || 0).toLocaleString(),
                    sub: "Wishlisted then purchased",
                    accent: "#16a34a",
                  },
                  {
                    label: "Conversion Rate",
                    value: `${data.conversionRate ?? 0}%`,
                    sub: "Of all wishlisted items",
                    accent: data.conversionRate >= 10 ? "#16a34a" : "#1a1a1a",
                  },
                  {
                    label: "Avg. Dwell Time",
                    value: data.avgDwellDays != null ? `${data.avgDwellDays}d` : "—",
                    sub: "Days from wishlist to purchase",
                    accent: null,
                  },
                ])).map(({ label, value, sub, accent }) => (
                  <div key={label} style={{
                    flex: "1 1 180px", minWidth: 160,
                    background: "#fff", border: "1px solid #e3e3e3",
                    borderRadius: 12, padding: "20px 22px",
                    boxShadow: "0 1px 3px rgba(0,0,0,.06)",
                  }}>
                    <div style={{ fontSize: "0.78em", fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 6 }}>
                      {label}
                    </div>
                    <div style={{ fontSize: "2em", fontWeight: 700, color: accent || "#1a1a1a", lineHeight: 1.15 }}>
                      {value}
                    </div>
                    <div style={{ fontSize: "0.8em", color: "#aaa", marginTop: 4 }}>{sub}</div>
                  </div>
                ))}
              </div>

              {customerType === "guest" ? (
                /* ── Synced to account table ── */
                <div style={cardStyle}>
                  <div style={{ fontSize: "0.78em", fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>
                    Synced to account
                  </div>
                  <div style={{ fontSize: "0.78em", color: "#bbb", marginBottom: 16 }}>
                    Guest wishlist items that were later associated with a registered account
                  </div>
                  {data.syncedDetail?.length > 0 ? (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85em" }}>
                        <thead>
                          <tr style={{ borderBottom: "2px solid #f0f0f0" }}>
                            <th style={{ textAlign: "left", padding: "6px 8px", color: "#888", fontWeight: 600, textTransform: "uppercase", fontSize: "0.82em" }}>Product</th>
                            <th style={{ textAlign: "left", padding: "6px 8px", color: "#888", fontWeight: 600, textTransform: "uppercase", fontSize: "0.82em" }}>Variant</th>
                            <th style={{ textAlign: "left", padding: "6px 8px", color: "#888", fontWeight: 600, textTransform: "uppercase", fontSize: "0.82em" }}>Session</th>
                            <th style={{ textAlign: "left", padding: "6px 8px", color: "#888", fontWeight: 600, textTransform: "uppercase", fontSize: "0.82em" }}>Synced to</th>
                            <th style={{ textAlign: "right", padding: "6px 8px", color: "#888", fontWeight: 600, textTransform: "uppercase", fontSize: "0.82em" }}>Synced at</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.syncedDetail.map((row, i) => (
                            <tr key={i} style={{ borderBottom: "1px solid #f8f8f8" }}>
                              <td style={{ padding: "8px 8px", display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#2563eb", flexShrink: 0 }} />
                                {row.productTitle}
                              </td>
                              <td style={{ padding: "8px 8px", color: "#888", fontSize: "0.9em" }}>{row.variantTitle || "—"}</td>
                              <td style={{ padding: "8px 8px", color: "#aaa", fontSize: "0.8em", fontFamily: "monospace" }}>{row.sessionId || "—"}</td>
                              <td style={{ padding: "8px 8px", color: "#2563eb", fontWeight: 600 }}>{row.email || "—"}</td>
                              <td style={{ padding: "8px 8px", textAlign: "right", color: "#aaa", fontSize: "0.85em" }}>
                                {row.syncedAt ? new Date(row.syncedAt).toLocaleString() : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div style={{ fontSize: "0.85em", color: "#bbb" }}>No guest sessions have logged in yet during this period.</div>
                  )}
                </div>
              ) : (
                /* ── Logged customers: purchase conversion tables ── */
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  <div style={{ ...cardStyle, flex: "1 1 340px", minWidth: 280 }}>
                    <div style={{ fontSize: "0.78em", fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 16 }}>
                      Most purchased from wishlist
                    </div>
                    {data.topConvertedProducts?.length > 0 ? (
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85em" }}>
                        <thead>
                          <tr style={{ borderBottom: "2px solid #f0f0f0" }}>
                            <th style={{ textAlign: "left", padding: "6px 8px", color: "#888", fontWeight: 600, textTransform: "uppercase", fontSize: "0.85em" }}>#</th>
                            <th style={{ textAlign: "left", padding: "6px 8px", color: "#888", fontWeight: 600, textTransform: "uppercase", fontSize: "0.85em" }}>Product</th>
                            <th style={{ textAlign: "right", padding: "6px 8px", color: "#888", fontWeight: 600, textTransform: "uppercase", fontSize: "0.85em" }}>Conversions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.topConvertedProducts.map((p, i) => (
                            <tr key={i} style={{ borderBottom: "1px solid #f8f8f8" }}>
                              <td style={{ padding: "8px 8px", color: "#bbb", fontWeight: 700 }}>{i + 1}</td>
                              <td style={{ padding: "8px 8px", display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#16a34a", flexShrink: 0 }} />
                                {p.name}
                              </td>
                              <td style={{ padding: "8px 8px", textAlign: "right", fontWeight: 700, color: "#16a34a" }}>{p.count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div style={{ fontSize: "0.85em", color: "#bbb" }}>No conversions tracked yet. Data populates from new orders.</div>
                    )}
                  </div>

                  <div style={{ ...cardStyle, flex: "1 1 340px", minWidth: 280 }}>
                    <div style={{ fontSize: "0.78em", fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 4 }}>
                      Most wished, never purchased
                    </div>
                    <div style={{ fontSize: "0.78em", color: "#bbb", marginBottom: 16 }}>
                      High demand — consider promotion or restock
                    </div>
                    {data.mostWishedNeverBought?.length > 0 ? (
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85em" }}>
                        <thead>
                          <tr style={{ borderBottom: "2px solid #f0f0f0" }}>
                            <th style={{ textAlign: "left", padding: "6px 8px", color: "#888", fontWeight: 600, textTransform: "uppercase", fontSize: "0.85em" }}>#</th>
                            <th style={{ textAlign: "left", padding: "6px 8px", color: "#888", fontWeight: 600, textTransform: "uppercase", fontSize: "0.85em" }}>Product</th>
                            <th style={{ textAlign: "right", padding: "6px 8px", color: "#888", fontWeight: 600, textTransform: "uppercase", fontSize: "0.85em" }}>Saves</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.mostWishedNeverBought.map((p, i) => (
                            <tr key={i} style={{ borderBottom: "1px solid #f8f8f8" }}>
                              <td style={{ padding: "8px 8px", color: "#bbb", fontWeight: 700 }}>{i + 1}</td>
                              <td style={{ padding: "8px 8px", display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#ea580c", flexShrink: 0 }} />
                                {p.name}
                              </td>
                              <td style={{ padding: "8px 8px", textAlign: "right", fontWeight: 700, color: "#ea580c" }}>{p.count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div style={{ fontSize: "0.85em", color: "#bbb" }}>All wishlisted products have been purchased — great conversion!</div>
                    )}
                  </div>
                </div>
              )}
            </div>

          </div>
        )}
        </>}
      </Page>
    </AppProvider>
  );
}
