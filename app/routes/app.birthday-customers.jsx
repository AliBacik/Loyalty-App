import { useLoaderData, useNavigate, Link, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { supabase } from "../supabase.server";

import { Page, AppProvider } from "@shopify/polaris";

const getDaysUntilServer = (val) => {
  if (!val || !/^\d{4}-\d{2}-\d{2}$/.test(val)) return 999;
  const [, month, day] = val.split("-");
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thisYear = now.getFullYear();
  let next = new Date(thisYear, parseInt(month, 10) - 1, parseInt(day, 10));
  if (next < today) next = new Date(thisYear + 1, parseInt(month, 10) - 1, parseInt(day, 10));
  return Math.round((next - today) / (1000 * 60 * 60 * 24));
};

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const search = (url.searchParams.get("search") || "").trim().toLowerCase();
  const sortKey = url.searchParams.get("sort") || "upcoming";
  const sortDir = url.searchParams.get("dir") || "asc";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));

  // Get shop + access token
  const { data: shopRow } = await supabase
    .from("shops")
    .select("id, access_token")
    .eq("shopify_domain", shop)
    .single();

  if (!shopRow?.access_token) throw new Error("Shop access token not found");

  // Step 1: Get all customers with birthdayadded from Supabase
  const { data: supabaseCustomers, error } = await supabase
    .from("customers")
    .select("email, shopify_customer_id")
    .eq("shop_id", shopRow.id)
    .not("gifts->birthdayadded", "is", null);

  if (error) throw new Error(`Supabase error: ${error.message}`);

  console.log(`[birthday-customers] Supabase birthdayadded count: ${supabaseCustomers?.length ?? 0}`);

  if (!supabaseCustomers?.length) {
    return { customers: [], totalCount: 0, totalPages: 1, page, todayCount: 0, search, sortKey, sortDir };
  }

  // Step 2: Fetch name, email and the birthday metafield together via GraphQL.
  //
  // Two earlier approaches failed here:
  //   1. Two REST calls per customer (544 for 272) at 20 in-flight requests blew past
  //      Shopify's 2 req/s REST limit; the 429s were swallowed by `return null`, so the
  //      total silently changed on every load (117, 203, ...).
  //   2. The bulk REST /metafields.json endpoint only returns SHOP-level metafields —
  //      it ignores owner_resource=customer — so it found 1 instead of ~272.
  //
  // GraphQL aliases let us pull 50 customers *and* their metafield per request, which is
  // both correct and ~6 calls total for 272 customers.
  const withRetry = async (fn, label) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const throttled = /throttl|429|exceeded/i.test(e?.message || "");
        if (!throttled || attempt === 4) throw e;
        const waitMs = 500 * Math.pow(2, attempt);
        console.warn(`[birthday-customers] ${label} throttled — retrying in ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw new Error(`${label} failed after retries`);
  };

  const enrolled = supabaseCustomers.filter((c) => c.shopify_customer_id);
  const allCustomers = [];
  const BATCH = 50;

  for (let i = 0; i < enrolled.length; i += BATCH) {
    const batch = enrolled.slice(i, i + BATCH);
    const fields = batch
      .map(
        (c, idx) =>
          `c${idx}: customer(id: "gid://shopify/Customer/${c.shopify_customer_id}") { id firstName lastName email metafield(namespace: "loyalty_program", key: "birthday") { value } }`,
      )
      .join("\n");

    const gqlJson = await withRetry(async () => {
      const res = await admin.graphql(`query BatchCustomers { ${fields} }`);
      const body = await res.json();
      if (body?.errors?.length) {
        throw new Error(body.errors.map((e) => e.message).join("; "));
      }
      return body;
    }, `batch ${i / BATCH + 1}`);

    batch.forEach((c, j) => {
      const cData = gqlJson?.data?.[`c${j}`];
      const birthday = cData?.metafield?.value;
      if (!birthday) return;
      allCustomers.push({
        id: c.shopify_customer_id,
        firstName: cData?.firstName || "",
        lastName: cData?.lastName || "",
        email: cData?.email || c.email || "",
        birthday,
      });
    });
  }

  console.log(
    `[birthday-customers] enrolled: ${enrolled.length}, with birthday metafield: ${allCustomers.length}`,
  );

  const todayCount = allCustomers.filter(c => getDaysUntilServer(c.birthday) === 0).length;

  let filtered = allCustomers;
  if (search) {
    filtered = allCustomers.filter(c =>
      c.email.toLowerCase().includes(search) ||
      c.firstName.toLowerCase().includes(search) ||
      c.lastName.toLowerCase().includes(search) ||
      c.birthday.includes(search)
    );
  }

  filtered.sort((a, b) => {
    let va, vb;
    if (sortKey === "upcoming" || sortKey === "birthday") {
      va = getDaysUntilServer(a.birthday); vb = getDaysUntilServer(b.birthday);
    } else if (sortKey === "email") {
      va = a.email.toLowerCase(); vb = b.email.toLowerCase();
    } else {
      va = `${a.firstName} ${a.lastName}`.trim().toLowerCase();
      vb = `${b.firstName} ${b.lastName}`.trim().toLowerCase();
    }
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return sortDir === "desc" ? -cmp : cmp;
  });

  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / 50));
  const paginated = filtered.slice((page - 1) * 50, page * 50);

  return { customers: paginated, totalCount, totalPages, page, todayCount, search, sortKey, sortDir };
};

export default function BirthdayCustomers() {
  const { customers, totalCount, totalPages, page, todayCount, search: initialSearch, sortKey, sortDir } = useLoaderData();
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState(initialSearch);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState(null);

  const buildUrl = (params) => {
    const p = new URLSearchParams({ search: initialSearch, sort: sortKey, dir: sortDir, page: String(page), ...params });
    return `?${p.toString()}`;
  };

  const handleSearch = (e) => { e.preventDefault(); navigate(buildUrl({ search: searchInput, page: "1" })); };
  const handleSort = (key) => {
    const newDir = sortKey === key && sortDir === "asc" ? "desc" : "asc";
    navigate(buildUrl({ sort: key, dir: newDir, page: "1" }));
  };
  const sortArrow = (key) => {
    if (sortKey !== key) return <span style={{ color: "#ccc", marginLeft: 4 }}>↕</span>;
    return <span style={{ marginLeft: 4 }}>{sortDir === "asc" ? "↑" : "↓"}</span>;
  };

  const handleSendBirthdayMails = async () => {
    if (!confirm(`Send Birthday Mail Klaviyo event to ${todayCount} customer${todayCount !== 1 ? "s" : ""} with birthday today?`)) return;
    setSending(true); setSendResult(null);
    try {
      const res = await fetch("/api/birthday/send_klaviyo", { method: "POST" });
      const json = await res.json();
      const today = new Date().toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric" });
      setSendResult({ ...json, sentToday: !json.error, sentDate: today });
    } catch (e) { setSendResult({ error: String(e) }); }
    finally { setSending(false); }
  };

  const formatBirthday = (val) => {
    if (!val) return "—";
    const parts = val.split("-");
    if (parts.length === 3) { const [year, month, day] = parts; return `${day}/${month}/${year}`; }
    return val;
  };

  const daysUntil = (val) => {
    if (!val || !/^\d{4}-\d{2}-\d{2}$/.test(val)) return null;
    const [, month, day] = val.split("-");
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thisYear = now.getFullYear();
    let next = new Date(thisYear, parseInt(month, 10) - 1, parseInt(day, 10));
    if (next < today) next = new Date(thisYear + 1, parseInt(month, 10) - 1, parseInt(day, 10));
    return Math.round((next - today) / (1000 * 60 * 60 * 24));
  };

  const thStyle = (key) => ({
    padding: "10px 12px", textAlign: "left", fontWeight: 700, fontSize: "0.78em",
    textTransform: "uppercase", letterSpacing: ".05em", color: "#555",
    cursor: "pointer", userSelect: "none", whiteSpace: "nowrap",
    borderBottom: "2px solid #e8e8e8", background: "#fafafa",
  });

  return (
    <AppProvider>
      <Page
        title="Birthday Customers"
        subtitle={`${totalCount} customer${totalCount !== 1 ? "s" : ""} with birthday set`}
        backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 20, paddingBottom: 40 }}>

          <div style={{ display: "flex", gap: 4 }}>
            <Link to="/app" style={{ textDecoration: "none" }}>
              <button style={{ background: "#fff", color: "#555", border: "1px solid #ddd", padding: "7px 16px", borderRadius: 8, cursor: "pointer", fontSize: "0.88em", fontWeight: 600 }}>Dashboard</button>
            </Link>
            <Link to="/app/analytics" style={{ textDecoration: "none" }}>
              <button style={{ background: "#fff", color: "#555", border: "1px solid #ddd", padding: "7px 16px", borderRadius: 8, cursor: "pointer", fontSize: "0.88em", fontWeight: 600 }}>Analytics</button>
            </Link>
            <button style={{ background: "#1a7f37", color: "#fff", border: "1px solid #1a7f37", padding: "7px 16px", borderRadius: 8, cursor: "default", fontSize: "0.88em", fontWeight: 600 }}>
              🎂 Birthday Customers
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              onClick={handleSendBirthdayMails}
              disabled={sending || todayCount === 0}
              style={{
                background: todayCount === 0 ? "#f5f5f5" : sending ? "#888" : "#1a7f37",
                color: todayCount === 0 ? "#bbb" : "#fff",
                border: "none", padding: "9px 20px", borderRadius: 8,
                cursor: todayCount === 0 || sending ? "not-allowed" : "pointer",
                fontWeight: 700, fontSize: "0.9em",
                boxShadow: todayCount > 0 && !sending ? "0 1px 4px rgba(0,0,0,.12)" : "none",
              }}
            >
              {sending ? "Sending…" : `🎂 Send Birthday Mails Today (${todayCount})`}
            </button>
            {sendResult && (
              <div style={{
                fontSize: "0.85em", fontWeight: 600,
                color: sendResult.error ? "#c21f1f" : sendResult.failed > 0 ? "#854d0e" : "#1a7f37",
                background: sendResult.error ? "#fce8e8" : sendResult.failed > 0 ? "#fef9c3" : "#e6f4ea",
                borderRadius: 7, padding: "6px 14px",
                border: sendResult.sentToday ? "1px solid #86efac" : "none",
              }}>
                {sendResult.error
                  ? `Hata: ${sendResult.error}`
                  : sendResult.sentToday
                    ? `✓ Bugün gönderildi (${sendResult.sentDate}) · ${sendResult.sent ?? 0} kişi${sendResult.failed > 0 ? ` · ${sendResult.failed} başarısız` : ""}`
                    : sendResult.message || `✓ Gönderildi`}
              </div>
            )}
          </div>

          <form onSubmit={handleSearch} style={{ display: "flex", gap: 8 }}>
            <input type="text" value={searchInput} onChange={e => setSearchInput(e.target.value)}
              placeholder="Search by name, email or date…"
              style={{ flex: 1, maxWidth: 360, padding: "8px 14px", border: "1px solid #ddd", borderRadius: 8, fontSize: "0.9em", outline: "none" }} />
            <button type="submit" style={{ background: "#1a1a1a", color: "#fff", border: "none", padding: "8px 18px", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontSize: "0.88em" }}>Search</button>
            {initialSearch && (
              <button type="button" onClick={() => { setSearchInput(""); navigate(buildUrl({ search: "", page: "1" })); }}
                style={{ background: "#fff", color: "#555", border: "1px solid #ddd", padding: "8px 14px", borderRadius: 8, cursor: "pointer", fontSize: "0.88em" }}>Clear</button>
            )}
          </form>

          <div style={{ background: "#fff", border: "1px solid #e3e3e3", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,.06)" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thStyle("name")} onClick={() => handleSort("name")}>Name {sortArrow("name")}</th>
                    <th style={thStyle("email")} onClick={() => handleSort("email")}>Email {sortArrow("email")}</th>
                    <th style={{ ...thStyle("birthday"), textAlign: "center" }} onClick={() => handleSort("birthday")}>Birthday {sortArrow("birthday")}</th>
                    <th style={{ ...thStyle("upcoming"), textAlign: "center", cursor: "default" }}>Days Until</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.length === 0 ? (
                    <tr><td colSpan={4} style={{ padding: "40px", textAlign: "center", color: "#bbb", fontSize: "0.9em" }}>
                      {initialSearch ? "No customers match your search." : "No customers with birthday set."}
                    </td></tr>
                  ) : customers.map((c, i) => {
                    const days = daysUntil(c.birthday);
                    const isToday = days === 0;
                    const isSoon = days !== null && days > 0 && days <= 7;
                    return (
                      <tr key={c.id} style={{ borderTop: "1px solid #f0f0f0", background: i % 2 === 0 ? "#fff" : "#fafafa" }}>
                        <td style={{ padding: "10px 12px", fontWeight: 500 }}>
                          {c.firstName || c.lastName ? `${c.firstName} ${c.lastName}`.trim() : <span style={{ color: "#bbb" }}>—</span>}
                        </td>
                        <td style={{ padding: "10px 12px", color: "#444", fontSize: "0.9em" }}>{c.email || <span style={{ color: "#bbb" }}>—</span>}</td>
                        <td style={{ padding: "10px 12px", textAlign: "center", fontWeight: 500 }}>{formatBirthday(c.birthday)}</td>
                        <td style={{ padding: "10px 12px", textAlign: "center" }}>
                          {days === null ? <span style={{ color: "#bbb" }}>—</span>
                            : isToday ? <span style={{ background: "#fff3cd", color: "#856404", borderRadius: 6, padding: "2px 8px", fontSize: "0.82em", fontWeight: 700 }}>🎂 Today!</span>
                            : isSoon ? <span style={{ background: "#e6f4ea", color: "#1a7f37", borderRadius: 6, padding: "2px 8px", fontSize: "0.82em", fontWeight: 700 }}>{days}d</span>
                            : <span style={{ color: "#888", fontSize: "0.9em" }}>{days}d</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderTop: "1px solid #eee", background: "#fafafa" }}>
                <span style={{ fontSize: "0.85em", color: "#888" }}>Page {page} of {totalPages} · {totalCount} total</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button disabled={page <= 1} onClick={() => navigate(buildUrl({ page: String(page - 1) }))}
                    style={{ background: page <= 1 ? "#f5f5f5" : "#fff", color: page <= 1 ? "#bbb" : "#1a1a1a", border: "1px solid #ddd", padding: "6px 14px", borderRadius: 7, cursor: page <= 1 ? "not-allowed" : "pointer", fontSize: "0.86em", fontWeight: 600 }}>
                    ← Prev
                  </button>
                  <button disabled={page >= totalPages} onClick={() => navigate(buildUrl({ page: String(page + 1) }))}
                    style={{ background: page >= totalPages ? "#f5f5f5" : "#fff", color: page >= totalPages ? "#bbb" : "#1a1a1a", border: "1px solid #ddd", padding: "6px 14px", borderRadius: 7, cursor: page >= totalPages ? "not-allowed" : "pointer", fontSize: "0.86em", fontWeight: 600 }}>
                    Next →
                  </button>
                </div>
              </div>
            )}
          </div>

        </div>
      </Page>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  let title = "Error", message = "An unexpected error occurred.";
  if (isRouteErrorResponse(error)) { title = `HTTP ${error.status}`; message = typeof error.data === "string" ? error.data : JSON.stringify(error.data); }
  else if (error instanceof Error) { title = error.name; message = error.message; }
  return (
    <AppProvider>
      <Page title="Birthday Customers — Error" backAction={{ content: "Dashboard", onAction: () => window.history.back() }}>
        <div style={{ padding: 24 }}>
          <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10, padding: "20px 24px" }}>
            <div style={{ fontWeight: 700, color: "#dc2626", marginBottom: 8 }}>{title}</div>
            <div style={{ color: "#7f1d1d", whiteSpace: "pre-wrap", fontSize: "0.93em" }}>{message}</div>
          </div>
        </div>
      </Page>
    </AppProvider>
  );
}
