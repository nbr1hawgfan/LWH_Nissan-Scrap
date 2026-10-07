/* =============================================================
   Nissan Scrap Analytics - PWA
   Sign-in: shared customer-inventory function (customer NISSAN)
   Data:    nissan-scrap function (daily rollup + scrap loads)
   All KPI math happens here from the daily rows, so switching
   the unit type never needs another server call.
   ============================================================= */
(() => {
  "use strict";

  const CFG = window.APP_CONFIG;
  const SESSION_KEY = "nissanScrapSession";
  const TYPES_ALL = ["ENGINE", "TRANSMISSION"];
  const TYPE_LABEL = { ENGINE: "Engines", TRANSMISSION: "Transmissions", BOTH: "Engines + transmissions" };

  // daily row layout from nissan_scrap_dashboard
  const R = { d: 0, t: 1, inb: 2, sl: 3, sr: 4, sh: 5, ad: 6, oh: 7, cs: 8, co: 9, csd: 10 };

  const state = {
    token: null, name: "",
    from: null, to: null, type: "BOTH", tab: "overview",
    dash: null, loads: null, loadsKey: "", unitRows: [], unitTitle: "",
    charts: {}, reqId: 0,
  };

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (n == null || !isFinite(n)) ? "-" : Math.round(n).toLocaleString("en-US");
  const fmt1 = (n) => (n == null || !isFinite(n)) ? "-" : n.toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const pct = (a, b) => (!b) ? "-" : (100 * a / b).toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + "%";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------------- dates (all handled as UTC calendar days) ---------------- */
  const toDate = (iso) => new Date(iso + "T00:00:00Z");
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (isoStr, n) => { const d = toDate(isoStr); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
  const weekStart = (isoStr) => { const d = toDate(isoStr); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return iso(d); };
  const monthStart = (isoStr) => isoStr.slice(0, 8) + "01";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const shortDate = (isoStr) => { const d = toDate(isoStr); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
  const longDate = (isoStr) => { const d = toDate(isoStr); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
  const usDate = (isoStr) => { const d = toDate(isoStr); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`; };
  function localToday() {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    return p; // en-CA gives YYYY-MM-DD
  }

  function presetRange(preset, today) {
    const y = today.slice(0, 4);
    switch (preset) {
      case "7":   return [addDays(today, -6), today];
      case "30":  return [addDays(today, -29), today];
      case "90":  return [addDays(today, -89), today];
      case "365": return [addDays(today, -364), today];
      case "mtd": return [monthStart(today), today];
      case "ytd": return [`${y}-01-01`, today];
      case "lastmonth": {
        const end = addDays(monthStart(today), -1);
        return [monthStart(end), end];
      }
      default: return [state.from, state.to];
    }
  }

  /* ---------------- session ---------------- */
  function loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (s && s.token && s.exp > Date.now()) { state.token = s.token; state.name = s.name || ""; return true; }
    } catch (_) { /* storage blocked */ }
    return false;
  }
  function saveSession() {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ token: state.token, name: state.name, exp: Date.now() + 8 * 3600000 })); } catch (_) {}
  }
  function clearSession() {
    state.token = null; state.name = "";
    try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
  }

  async function post(url, body) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (res.status === 401 && data && data.error === "SESSION_EXPIRED") {
      clearSession(); showLogin("Your session ended. Please sign in again.");
      throw new Error("SESSION_EXPIRED");
    }
    if (!res.ok) throw new Error((data && data.error) || "Something went wrong. Please try again.");
    return data;
  }
  const api = (action, extra) => post(CFG.dataUrl, Object.assign({ action, token: state.token }, extra || {}));

  /* ---------------- views ---------------- */
  function showLogin(msg) {
    $("appView").hidden = true; $("headerUser").hidden = true; $("loginView").hidden = false;
    $("loginError").textContent = msg || "";
    $("pinInput").value = ""; setTimeout(() => $("pinInput").focus(), 50);
  }
  function showApp() {
    $("loginView").hidden = true; $("appView").hidden = false; $("headerUser").hidden = false;
    $("userName").textContent = state.name;
  }

  async function doLogin(e) {
    e.preventDefault();
    const pin = $("pinInput").value.trim();
    if (!/^\d{6,8}$/.test(pin)) { $("loginError").textContent = "Enter your 6 to 8 digit PIN."; return; }
    $("loginBtn").disabled = true; $("loginError").textContent = "";
    try {
      const r = await post(CFG.loginUrl, { action: "login", customer: CFG.customer, pin });
      state.token = r.token; state.name = r.name; saveSession();
      showApp(); initRange(); await refresh();
    } catch (err) {
      $("loginError").textContent = err.message;
    } finally { $("loginBtn").disabled = false; }
  }

  async function doLogout() {
    const t = state.token; clearSession();
    try { await post(CFG.loginUrl, { action: "logout", token: t }); } catch (_) {}
    showLogin();
  }

  /* ---------------- filters ---------------- */
  function initRange() {
    const today = localToday();
    $("presetSelect").value = CFG.defaultRange;
    [state.from, state.to] = presetRange(CFG.defaultRange, today);
    $("fromDate").value = state.from; $("toDate").value = state.to;
    $("fromDate").max = today; $("toDate").max = today;
  }

  function onPreset() {
    const p = $("presetSelect").value;
    if (p === "custom") { $("fromDate").focus(); return; }
    const today = (state.dash && state.dash.meta && state.dash.meta.today) || localToday();
    [state.from, state.to] = presetRange(p, today);
    $("fromDate").value = state.from; $("toDate").value = state.to;
    refresh();
  }

  function onDates() {
    const f = $("fromDate").value, t = $("toDate").value;
    if (!f || !t) return;
    $("presetSelect").value = "custom";
    if (f > t) { showError("The From date must be on or before the To date."); return; }
    if (daysBetween(f, t) > 1095) { showError("Choose a range of 3 years or less."); return; }
    state.from = f; state.to = t; refresh();
  }

  function onType(e) {
    const b = e.target.closest(".seg"); if (!b) return;
    state.type = b.dataset.type;
    document.querySelectorAll(".seg").forEach((s) => {
      const on = s === b; s.classList.toggle("active", on); s.setAttribute("aria-checked", on ? "true" : "false");
    });
    render();
  }

  function onTab(e) {
    const b = e.target.closest(".tab"); if (!b) return;
    state.tab = b.dataset.tab;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === b));
    ["overview", "weekly", "loads"].forEach((t) => { $("tab-" + t).hidden = t !== state.tab; });
    if (state.tab === "loads") ensureLoads(); else render();
  }

  function showError(msg) { const el = $("appError"); el.textContent = msg; el.hidden = !msg; }

  /* ---------------- data ---------------- */
  async function refresh() {
    const id = ++state.reqId;
    showError(""); $("loading").hidden = false;
    try {
      const d = await api("dashboard", { from: state.from, to: state.to });
      if (id !== state.reqId) return;
      state.dash = d; state.loads = null; state.loadsKey = "";
      render();
      if (state.tab === "loads") ensureLoads();
    } catch (err) {
      if (err.message !== "SESSION_EXPIRED" && id === state.reqId) showError(err.message);
    } finally { if (id === state.reqId) $("loading").hidden = true; }
  }

  async function ensureLoads() {
    const key = state.from + "|" + state.to;
    if (state.loads && state.loadsKey === key) { renderLoads(); return; }
    $("loading").hidden = false;
    try {
      state.loads = await api("loads", { from: state.from, to: state.to });
      state.loadsKey = key; renderLoads();
    } catch (err) {
      if (err.message !== "SESSION_EXPIRED") showError(err.message);
    } finally { $("loading").hidden = true; }
  }

  function selectedTypes() { return state.type === "BOTH" ? TYPES_ALL : [state.type]; }

  /** Sum the daily rows for the given types into one object per date. */
  function byDate(types) {
    const map = new Map();
    for (const r of state.dash.daily || []) {
      if (!types.includes(r[R.t])) continue;
      let o = map.get(r[R.d]);
      if (!o) { o = { d: r[R.d], inb: 0, scrap: 0, sl: 0, sr: 0, sh: 0, ad: 0, oh: 0, cs: 0, co: 0, csd: 0 }; map.set(r[R.d], o); }
      o.inb += r[R.inb]; o.sl += r[R.sl]; o.sr += r[R.sr]; o.scrap += r[R.sl] + r[R.sr];
      o.sh += r[R.sh]; o.ad += r[R.ad]; o.oh += r[R.oh];
      o.cs += r[R.cs]; o.co += r[R.co]; o.csd += Number(r[R.csd]);
    }
    return [...map.values()].sort((a, b) => a.d < b.d ? -1 : 1);
  }

  function summarize(types) {
    const days = byDate(types);
    const s = { received: 0, scrapped: 0, sl: 0, sr: 0, cs: 0, co: 0, csd: 0, opDays: 0, days: days.length, ohSum: 0, endOH: 0, startOH: 0 };
    for (const o of days) {
      s.received += o.inb; s.scrapped += o.scrap; s.sl += o.sl; s.sr += o.sr;
      s.cs += o.cs; s.co += o.co; s.csd += o.csd; s.ohSum += o.oh;
      if (o.inb > 0 || o.scrap > 0 || o.sh > 0) s.opDays++;
    }
    s.endOH = days.length ? days[days.length - 1].oh : 0;
    s.avgOH = days.length ? s.ohSum / days.length : 0;
    const soh = state.dash.start_on_hand || {};
    s.startOH = types.reduce((a, t) => a + (Number(soh[t]) || 0), 0);
    s.available = s.startOH + s.received;
    s.avgDays = s.cs ? s.csd / s.cs : null;
    return { s, days };
  }

  function rangeDeveloping() {
    const today = (state.dash.meta && state.dash.meta.today) || localToday();
    return daysBetween(state.to, today) < CFG.matureDays;
  }

  /* ---------------- render ---------------- */
  function render() {
    if (!state.dash) return;
    renderFreshness();
    if (state.tab === "overview") renderOverview();
    if (state.tab === "weekly") renderWeekly();
    if (state.tab === "loads") renderLoads();
  }

  function renderFreshness() {
    const m = state.dash.meta;
    if (!m || !m.last_synced_at) { $("freshness").textContent = "Data has not been loaded yet."; return; }
    const t = new Date(m.last_synced_at);
    const when = t.toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    $("freshness").textContent = `${TYPE_LABEL[state.type]} | ${usDate(state.from)} to ${usDate(state.to)} | Data updated ${when}`;
  }

  function kpi(label, value, sub, accent, badge) {
    return `<div class="kpi${accent ? " accent" : ""}">
      <div class="kpi-label">${esc(label)}${badge || ""}</div>
      <div class="kpi-value">${value}</div>
      <div class="kpi-sub">${sub}</div></div>`;
  }

  function renderOverview() {
    const { s, days } = summarize(selectedTypes());
    const dev = rangeDeveloping();
    const devBadge = dev ? `<span class="badge">Developing</span>` : "";
    const stillOn = s.received ? pct(s.received - s.co, s.received) : "-";

    $("kpis").innerHTML = [
      kpi("Units received", fmt(s.received), `avg ${fmt1(s.opDays ? s.received / s.opDays : null)} per operating day`),
      kpi("Units scrapped", fmt(s.scrapped), `avg ${fmt1(s.opDays ? s.scrapped / s.opDays : null)} per operating day`, true),
      kpi("Scrapped vs received", pct(s.scrapped, s.received), `${fmt(s.scrapped)} scrapped / ${fmt(s.received)} received`, true),
      kpi("Received-unit scrap rate", pct(s.cs, s.received), `${fmt(s.cs)} of ${fmt(s.received)} received went to scrap; ${stillOn} still on hand`, false, devBadge),
      kpi("Scrap share of inventory", pct(s.scrapped, s.available), `of ${fmt(s.available)} available (${fmt(s.startOH)} on hand at start + received)`),
      kpi("On hand at end", fmt(s.endOH), `avg ${fmt(s.avgOH)} on hand during range`),
      kpi("Avg days to scrap", s.avgDays == null ? "-" : fmt1(s.avgDays), `received to scrapped, units received in range`),
      kpi("Operating days", fmt(s.opDays), `of ${fmt(s.days)} calendar days in range`),
    ].join("");

    renderFlow(days);
    renderOnHand(days);
    renderTypeTable();
  }

  function bucketize(days) {
    const span = days.length;
    const mode = span <= 62 ? "day" : span <= 366 ? "week" : "month";
    const keyOf = mode === "day" ? (d) => d : mode === "week" ? weekStart : monthStart;
    const map = new Map();
    for (const o of days) {
      const k = keyOf(o.d);
      let b = map.get(k);
      if (!b) { b = { k, inb: 0, scrap: 0, first: o.d, last: o.d }; map.set(k, b); }
      b.inb += o.inb; b.scrap += o.scrap; b.last = o.d;
    }
    const label = (b) => mode === "day" ? shortDate(b.k)
      : mode === "week" ? "Wk " + shortDate(b.k)
      : MONTHS[toDate(b.k).getUTCMonth()] + " " + String(toDate(b.k).getUTCFullYear()).slice(2);
    return { mode, buckets: [...map.values()], label };
  }

  function chartBase() {
    return {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#111", titleFont: { size: 14, weight: "700" }, bodyFont: { size: 14 },
          padding: 10, boxPadding: 4, usePointStyle: true,
          callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y)}` },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#6b6a66", font: { size: 12 }, maxRotation: 0, autoSkipPadding: 12 } },
        y: { beginAtZero: true, grid: { color: "#ebeae6" }, border: { display: false },
             ticks: { color: "#6b6a66", font: { size: 12 }, callback: (v) => Number(v).toLocaleString("en-US") } },
      },
    };
  }

  function renderFlow(days) {
    if (!window.Chart) return;
    const { mode, buckets, label } = bucketize(days);
    $("flowTitle").textContent = `Received vs scrapped, by ${mode}`;
    const css = getComputedStyle(document.documentElement);
    const data = {
      labels: buckets.map(label),
      datasets: [
        { label: "Received", data: buckets.map((b) => b.inb), backgroundColor: css.getPropertyValue("--series-in").trim(),
          borderRadius: 4, borderSkipped: "start", categoryPercentage: 0.75, barPercentage: 0.9 },
        { label: "Scrapped", data: buckets.map((b) => b.scrap), backgroundColor: css.getPropertyValue("--series-scrap").trim(),
          borderRadius: 4, borderSkipped: "start", categoryPercentage: 0.75, barPercentage: 0.9 },
      ],
    };
    const opts = chartBase();
    opts.plugins.tooltip.callbacks.title = (items) => {
      const b = buckets[items[0].dataIndex];
      return mode === "day" ? longDate(b.k) : `${longDate(b.first)} - ${longDate(b.last)}`;
    };
    opts.plugins.tooltip.callbacks.footer = (items) => {
      const b = buckets[items[0].dataIndex];
      return b.inb ? `Scrapped vs received: ${pct(b.scrap, b.inb)}` : "";
    };
    drawChart("flow", "flowChart", "bar", data, opts);

    // table view of the same numbers
    const rows = buckets.map((b) => `<tr><td>${esc(mode === "day" ? usDate(b.k) : usDate(b.first) + " - " + usDate(b.last))}</td>
      <td>${fmt(b.inb)}</td><td>${fmt(b.scrap)}</td><td>${pct(b.scrap, b.inb)}</td></tr>`).reverse().join("");
    $("flowTable").innerHTML = buckets.length
      ? `<table><thead><tr><th>Period</th><th>Received</th><th>Scrapped</th><th>Scrap / recv</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="empty">No activity in this range.</div>`;
  }

  function renderOnHand(days) {
    if (!window.Chart) return;
    const css = getComputedStyle(document.documentElement);
    const color = css.getPropertyValue("--series-oh").trim();
    const data = {
      labels: days.map((o) => shortDate(o.d)),
      datasets: [{ label: "On hand", data: days.map((o) => o.oh), borderColor: color, backgroundColor: color,
        borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHitRadius: 12, tension: 0 }],
    };
    const opts = chartBase();
    opts.scales.y.beginAtZero = false;
    opts.plugins.tooltip.callbacks.title = (items) => longDate(days[items[0].dataIndex].d);
    drawChart("onhand", "onHandChart", "line", data, opts);
  }

  function drawChart(key, canvasId, type, data, options) {
    if (state.charts[key]) state.charts[key].destroy();
    state.charts[key] = new Chart($(canvasId), { type, data, options });
  }

  function renderTypeTable() {
    const dev = rangeDeveloping();
    const row = (label, types, cls) => {
      const { s } = summarize(types);
      return `<tr class="${cls || ""}"><td>${label}</td><td>${fmt(s.received)}</td><td>${fmt(s.scrapped)}</td>
        <td>${pct(s.scrapped, s.received)}</td><td>${pct(s.cs, s.received)}</td>
        <td>${pct(s.scrapped, s.available)}</td><td>${fmt(s.endOH)}</td></tr>`;
    };
    $("typeTable").innerHTML = `<table><thead><tr><th>Type</th><th>Received</th><th>Scrapped</th>
      <th>Scrap / recv</th><th>Recv scrap rate${dev ? "*" : ""}</th><th>Share of inv</th><th>On hand</th></tr></thead>
      <tbody>${row("Engines", ["ENGINE"])}${row("Transmissions", ["TRANSMISSION"])}${row("Total", TYPES_ALL, "total")}</tbody></table>
      ${dev ? `<p class="muted small">* Still developing: the range ends less than ${CFG.matureDays} days ago.</p>` : ""}`;
  }

  /* ---------- weekly ---------- */
  function weeklyRows() {
    const days = byDate(selectedTypes());
    const today = (state.dash.meta && state.dash.meta.today) || localToday();
    const map = new Map();
    for (const o of days) {
      const k = weekStart(o.d);
      let w = map.get(k);
      if (!w) { w = { k, inb: 0, scrap: 0, sl: 0, sr: 0, cs: 0, co: 0, csd: 0, n: 0 }; map.set(k, w); }
      w.inb += o.inb; w.scrap += o.scrap; w.sl += o.sl; w.sr += o.sr; w.cs += o.cs; w.co += o.co; w.csd += o.csd; w.n++;
    }
    return [...map.values()].map((w) => {
      const end = addDays(w.k, 6);
      const age = daysBetween(end, today);
      return Object.assign(w, { end, partial: w.n < 7, status: age >= CFG.matureDays ? "Mature" : "Developing" });
    }).sort((a, b) => a.k < b.k ? 1 : -1);
  }

  function renderWeekly() {
    const weeks = weeklyRows();
    if (!weeks.length) { $("weeklyTable").innerHTML = `<div class="empty">No activity in this range.</div>`; return; }
    const t = weeks.reduce((a, w) => { a.inb += w.inb; a.scrap += w.scrap; a.cs += w.cs; a.csd += w.csd; return a; }, { inb: 0, scrap: 0, cs: 0, csd: 0 });
    const rows = weeks.map((w) => `<tr>
      <td>${usDate(w.k)} - ${usDate(w.end)}${w.partial ? " <span class=\"muted\">(partial)</span>" : ""}</td>
      <td>${fmt(w.inb)}</td><td>${fmt(w.scrap)}</td><td>${pct(w.scrap, w.inb)}</td>
      <td>${fmt(w.cs)}</td><td>${pct(w.cs, w.inb)}</td><td>${w.cs ? fmt1(w.csd / w.cs) : "-"}</td>
      <td class="left"><span class="badge ${w.status === "Mature" ? "ok" : ""}">${w.status}</span></td></tr>`).join("");
    $("weeklyTable").innerHTML = `<table><thead><tr><th>Week</th><th>Received</th><th>Scrapped</th><th>Scrap / recv</th>
      <th>Cohort scrapped</th><th>Cohort scrap %</th><th>Avg days</th><th class="left">Status</th></tr></thead>
      <tbody>${rows}<tr class="total"><td>Total</td><td>${fmt(t.inb)}</td><td>${fmt(t.scrap)}</td><td>${pct(t.scrap, t.inb)}</td>
      <td>${fmt(t.cs)}</td><td>${pct(t.cs, t.inb)}</td><td>${t.cs ? fmt1(t.csd / t.cs) : "-"}</td><td></td></tr></tbody></table>`;
  }

  function exportWeekly() {
    const weeks = weeklyRows();
    const lines = [["Week Start", "Week End", "Partial", "Received", "Scrapped", "Scrapped vs Received %", "Cohort Scrapped", "Cohort Scrap %", "Avg Days to Scrap", "Status"]];
    for (const w of weeks) {
      lines.push([w.k, w.end, w.partial ? "Y" : "", w.inb, w.scrap, w.inb ? (100 * w.scrap / w.inb).toFixed(1) : "",
        w.cs, w.inb ? (100 * w.cs / w.inb).toFixed(1) : "", w.cs ? (w.csd / w.cs).toFixed(1) : "", w.status]);
    }
    downloadCsv(`nissan_scrap_weekly_${state.type.toLowerCase()}_${state.from}_${state.to}.csv`, lines, "Exported weekly scrap");
  }

  /* ---------- loads ---------- */
  function loadRows() {
    const t = state.type;
    return (state.loads || []).map((l) => Object.assign({}, l, {
      units: t === "ENGINE" ? l.engines : t === "TRANSMISSION" ? l.trans : l.engines + l.trans,
    })).filter((l) => l.units > 0);
  }

  function renderLoads() {
    if (!state.loads) { $("loadsTable").innerHTML = `<div class="empty">Loading loads...</div>`; return; }
    const rows = loadRows();
    if (!rows.length) { $("loadsTable").innerHTML = `<div class="empty">No scrap loads in this range.</div>`; return; }
    const tot = rows.reduce((a, l) => { a.e += l.engines; a.t += l.trans; a.u += l.units; return a; }, { e: 0, t: 0, u: 0 });
    const body = rows.map((l, i) => `<tr class="click" tabindex="0" data-i="${i}">
      <td>${usDate(l.out_date)}</td><td>${fmt(l.units)}</td><td>${fmt(l.engines)}</td><td>${fmt(l.trans)}</td>
      <td class="left">${esc(l.ref_num || "")}</td><td>${esc(l.out_pro)}</td>
      <td class="left">${l.scrap_source === "SCRAP OUT LOAD" ? "Scrap out load" : "Scrap reference"}</td>
      <td>${l.avg_days == null ? "-" : fmt1(Number(l.avg_days))}</td></tr>`).join("");
    $("loadsTable").innerHTML = `<table><thead><tr><th>Date</th><th>Units</th><th>Engines</th><th>Trans</th><th class="left">Reference</th><th>Pro</th>
      <th class="left">Route</th><th>Avg days</th></tr></thead>
      <tbody>${body}<tr class="total"><td>${fmt(rows.length)} loads</td><td>${fmt(tot.u)}</td>
      <td>${fmt(tot.e)}</td><td>${fmt(tot.t)}</td><td></td><td></td><td></td><td></td></tr></tbody></table>`;
    $("loadsTable").querySelectorAll("tr.click").forEach((tr) => {
      const open = () => openLoad(rows[Number(tr.dataset.i)]);
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
  }

  function exportLoads() {
    const lines = [["Scrap Date", "Pro", "Reference", "Route", "Engines", "Transmissions", "Units", "Avg Days to Scrap"]];
    for (const l of loadRows()) {
      lines.push([l.out_date, l.out_pro, l.ref_num || "", l.scrap_source === "SCRAP OUT LOAD" ? "Scrap out load" : "Scrap reference",
        l.engines, l.trans, l.units, l.avg_days ?? ""]);
    }
    downloadCsv(`nissan_scrap_loads_${state.from}_${state.to}.csv`, lines, "Exported scrap loads");
  }

  async function openLoad(l) {
    state.unitTitle = `Pro ${l.out_pro}${l.ref_num ? " | " + l.ref_num : ""} | ${usDate(l.out_date)}`;
    $("unitTitle").textContent = state.unitTitle;
    $("unitTable").innerHTML = `<div class="empty">Loading units...</div>`;
    $("unitModal").hidden = false;
    try {
      let units = await api("load_units", { pro: l.out_pro });
      if (state.type !== "BOTH") units = units.filter((u) => u.type === state.type);
      state.unitRows = units;
      $("unitTable").innerHTML = units.length ? `<table><thead><tr><th>LWH ID</th><th class="left">Item</th><th class="left">Description</th>
        <th class="left">Type</th><th>Received</th><th>Scrapped</th><th>Days</th></tr></thead><tbody>${units.map((u) => `<tr>
        <td>${esc(u.lwh_id)}</td><td class="left">${esc(u.item)}</td><td class="left">${esc(u.desc)}</td>
        <td class="left">${u.type === "ENGINE" ? "Engine" : u.type === "TRANSMISSION" ? "Transmission" : "Other"}</td>
        <td>${usDate(u.received)}</td><td>${usDate(u.scrapped)}</td><td>${fmt(u.days)}</td></tr>`).join("")}</tbody></table>`
        : `<div class="empty">No units found for this load.</div>`;
    } catch (err) {
      if (err.message !== "SESSION_EXPIRED") $("unitTable").innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  function exportUnits() {
    const lines = [["LWH ID", "Item", "Description", "Type", "Received", "Scrapped", "Days to Scrap", "Reference"]];
    for (const u of state.unitRows) lines.push([u.lwh_id, u.item, u.desc, u.type, u.received, u.scrapped, u.days, u.ref || ""]);
    downloadCsv(`nissan_scrap_units_${state.unitTitle.split(" ")[1]}.csv`, lines, "Exported units for " + state.unitTitle);
  }

  /* ---------- CSV ---------- */
  function downloadCsv(name, lines, logNote) {
    const csv = lines.map((r) => r.map((v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    if (logNote) api("log", { note: logNote }).catch(() => {});
  }

  /* =============================================================
     EXPORTS
     All exports follow the selected dates and unit type.
     ============================================================= */
  const XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
  let xlsxPromise = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!xlsxPromise) {
      xlsxPromise = new Promise((resolve, reject) => {
        const sc = document.createElement("script");
        sc.src = XLSX_URL;
        sc.onload = () => resolve(window.XLSX);
        sc.onerror = () => { xlsxPromise = null; reject(new Error("Could not load the Excel library. Check your connection and try again.")); };
        document.head.appendChild(sc);
      });
    }
    return xlsxPromise;
  }

  const fileTag = () => `${state.type === "BOTH" ? "all" : state.type.toLowerCase()}_${state.from}_${state.to}`;
  const xDate = (isoStr) => { if (!isoStr) return null; const [y, m, d] = isoStr.split("-").map(Number); return new Date(y, m - 1, d); };
  const ratio = (a, b) => b ? a / b : null;
  const STATUS = { "SCRAP": "Scrapped", "SHIPPED": "Shipped", "ADJUSTED": "Adjusted", "ON HAND": "On hand" };
  const TYPE_NAME = { ENGINE: "Engine", TRANSMISSION: "Transmission", OTHER: "Other" };

  /** Build a worksheet. cols: [{h: header, w: width, f: 'int'|'pct'|'dec'|'date'|'text'}] */
  function sheet(X, cols, rows, pre) {
    const top = pre || [];
    const aoa = top.concat([cols.map((c) => c.h)], rows);
    const ws = X.utils.aoa_to_sheet(aoa, { cellDates: true });
    const fmt = { int: "#,##0", pct: "0.0%", dec: "0.0", date: "m/d/yyyy" };
    const first = top.length + 1;
    for (let r = first; r < aoa.length; r++) {
      cols.forEach((c, ci) => {
        const cell = ws[X.utils.encode_cell({ r, c: ci })];
        if (cell && fmt[c.f] && cell.t !== "s") cell.z = fmt[c.f];
      });
    }
    ws["!cols"] = cols.map((c) => ({ wch: c.w || 12 }));
    ws["!autofilter"] = { ref: X.utils.encode_range({ r: top.length, c: 0 }, { r: aoa.length - 1, c: cols.length - 1 }) };
    return ws;
  }

  function scopeLines() {
    const m = (state.dash && state.dash.meta) || {};
    const synced = m.last_synced_at
      ? new Date(m.last_synced_at).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
      : "-";
    return [
      ["Nissan Scrap Analytics - Logistics Warehouse, Inc."],
      ["Date range", `${usDate(state.from)} to ${usDate(state.to)}`],
      ["Unit type", TYPE_LABEL[state.type]],
      ["Data updated", synced],
      ["Exported", new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }) + (state.name ? " by " + state.name : "")],
      [],
    ];
  }

  /* ---------- daily rows (shared by sheet + CSV) ---------- */
  const DAILY_COLS = [
    { h: "Date", w: 12, f: "date" }, { h: "Received", f: "int" },
    { h: "Engines received", w: 16, f: "int" }, { h: "Transmissions received", w: 20, f: "int" },
    { h: "Scrapped", f: "int" }, { h: "Scrapped - scrap out loads", w: 22, f: "int" }, { h: "Scrapped - scrap references", w: 24, f: "int" },
    { h: "Engines scrapped", w: 16, f: "int" }, { h: "Transmissions scrapped", w: 20, f: "int" },
    { h: "Shipped", f: "int" }, { h: "Adjusted", f: "int" }, { h: "On hand (end of day)", w: 18, f: "int" },
    { h: "Scrapped vs received", w: 18, f: "pct" }, { h: "Cohort scrapped", w: 15, f: "int" }, { h: "Cohort scrap %", w: 14, f: "pct" },
  ];
  function dailyRows() {
    const types = selectedTypes();
    const eng = new Map(byDate(["ENGINE"]).map((o) => [o.d, o]));
    const trn = new Map(byDate(["TRANSMISSION"]).map((o) => [o.d, o]));
    const z = { inb: 0, scrap: 0 };
    return byDate(types).map((o) => {
      const e = types.includes("ENGINE") ? (eng.get(o.d) || z) : z;
      const t = types.includes("TRANSMISSION") ? (trn.get(o.d) || z) : z;
      return [o.d, o.inb, e.inb, t.inb, o.scrap, o.sl, o.sr, e.scrap, t.scrap, o.sh, o.ad, o.oh,
        ratio(o.scrap, o.inb), o.cs, ratio(o.cs, o.inb)];
    });
  }

  const WEEKLY_COLS = [
    { h: "Week start", w: 12, f: "date" }, { h: "Week end", w: 12, f: "date" }, { h: "Partial week", w: 12 },
    { h: "Received", f: "int" }, { h: "Scrapped", f: "int" }, { h: "Scrapped vs received", w: 18, f: "pct" },
    { h: "Cohort scrapped", w: 15, f: "int" }, { h: "Cohort scrap %", w: 14, f: "pct" },
    { h: "Avg days to scrap", w: 16, f: "dec" }, { h: "Status", w: 12 },
  ];
  const weeklyData = () => weeklyRows().map((w) => [xDate(w.k), xDate(w.end), w.partial ? "Yes" : "", w.inb, w.scrap,
    ratio(w.scrap, w.inb), w.cs, ratio(w.cs, w.inb), w.cs ? w.csd / w.cs : null, w.status]);

  const LOAD_COLS = [
    { h: "Scrap date", w: 12, f: "date" }, { h: "Pro", w: 10 }, { h: "Reference", w: 26 }, { h: "Route", w: 16 },
    { h: "Engines", f: "int" }, { h: "Transmissions", w: 14, f: "int" }, { h: "Units", f: "int" }, { h: "Avg days to scrap", w: 16, f: "dec" },
  ];
  const loadData = () => loadRows().map((l) => [xDate(l.out_date), l.out_pro, l.ref_num || "",
    l.scrap_source === "SCRAP OUT LOAD" ? "Scrap out load" : "Scrap reference",
    l.engines, l.trans, l.units, l.avg_days == null ? null : Number(l.avg_days)]);

  async function ensureLoadsQuiet() {
    const key = state.from + "|" + state.to;
    if (state.loads && state.loadsKey === key) return;
    state.loads = await api("loads", { from: state.from, to: state.to });
    state.loadsKey = key;
  }

  /* ---------- summary workbook ---------- */
  async function exportWorkbook() {
    const X = await loadXlsx();
    await ensureLoadsQuiet();
    const { s } = summarize(selectedTypes());
    const dev = rangeDeveloping();
    const wb = X.utils.book_new();

    const kpiRows = [
      ["Units received", s.received, "units", `avg ${fmt1(s.opDays ? s.received / s.opDays : null)} per operating day`],
      ["Units scrapped", s.scrapped, "units", `avg ${fmt1(s.opDays ? s.scrapped / s.opDays : null)} per operating day`],
      ["  Scrap out loads", s.sl, "units", ""],
      ["  Scrap references", s.sr, "units", ""],
      ["Scrapped vs received", ratio(s.scrapped, s.received), "%", "Units scrapped in range / units received in range"],
      ["Received-unit scrap rate", ratio(s.cs, s.received), "%", (dev ? "DEVELOPING - " : "") + "Of units received in range, share scrapped so far"],
      ["Received units still on hand", ratio(s.received - s.co, s.received), "%", ""],
      ["Scrap share of inventory", ratio(s.scrapped, s.available), "%", `Scrapped / ${fmt(s.available)} available (on hand at start + received)`],
      ["On hand at start", s.startOH, "units", ""],
      ["On hand at end", s.endOH, "units", ""],
      ["Average on hand", s.avgOH, "units", ""],
      ["Avg days to scrap", s.avgDays, "days", "Received to scrapped, units received in range"],
      ["Operating days", s.opDays, "days", `of ${s.days} calendar days in range`],
    ];
    const pre = scopeLines();
    const sum = X.utils.aoa_to_sheet(pre.concat([["Metric", "Value", "Notes"]], kpiRows.map((r) => [r[0], r[1], r[3]])));
    kpiRows.forEach((r, i) => {
      const c = sum[X.utils.encode_cell({ r: pre.length + 1 + i, c: 1 })];
      if (c && c.t === "n") c.z = r[2] === "%" ? "0.0%" : r[0] === "Avg days to scrap" ? "0.0" : "#,##0";
    });
    sum["!cols"] = [{ wch: 30 }, { wch: 14 }, { wch: 70 }];
    X.utils.book_append_sheet(wb, sum, "Summary");

    // by type (always both types)
    const typeRow = (label, types) => {
      const t = summarize(types).s;
      return [label, t.received, t.scrapped, ratio(t.scrapped, t.received), ratio(t.cs, t.received),
        ratio(t.scrapped, t.available), t.startOH, t.endOH, t.avgDays];
    };
    X.utils.book_append_sheet(wb, sheet(X, [
      { h: "Type", w: 16 }, { h: "Received", f: "int" }, { h: "Scrapped", f: "int" },
      { h: "Scrapped vs received", w: 18, f: "pct" }, { h: "Received-unit scrap rate", w: 22, f: "pct" },
      { h: "Scrap share of inventory", w: 22, f: "pct" }, { h: "On hand at start", w: 15, f: "int" },
      { h: "On hand at end", w: 14, f: "int" }, { h: "Avg days to scrap", w: 16, f: "dec" },
    ], [typeRow("Engines", ["ENGINE"]), typeRow("Transmissions", ["TRANSMISSION"]), typeRow("Total", TYPES_ALL)],
    scopeLines()), "By Type");

    X.utils.book_append_sheet(wb, sheet(X, DAILY_COLS, dailyRows().map((r) => [xDate(r[0])].concat(r.slice(1))), scopeLines()), "Daily");
    X.utils.book_append_sheet(wb, sheet(X, WEEKLY_COLS, weeklyData(), scopeLines()), "Weekly");
    X.utils.book_append_sheet(wb, sheet(X, LOAD_COLS, loadData(), scopeLines()), "Scrap Loads");

    X.writeFile(wb, `nissan_scrap_summary_${fileTag()}.xlsx`, { compression: true });
    api("log", { note: `Exported summary workbook ${state.from} to ${state.to}` }).catch(() => {});
  }

  /* ---------- daily ---------- */
  async function exportDaily(asXlsx) {
    const rows = dailyRows();
    if (asXlsx) {
      const X = await loadXlsx();
      const wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, sheet(X, DAILY_COLS, rows.map((r) => [xDate(r[0])].concat(r.slice(1))), scopeLines()), "Daily");
      X.writeFile(wb, `nissan_scrap_daily_${fileTag()}.xlsx`, { compression: true });
      api("log", { note: `Exported daily data ${state.from} to ${state.to}` }).catch(() => {});
    } else {
      const pctTxt = (v) => v == null ? "" : (100 * v).toFixed(1);
      downloadCsv(`nissan_scrap_daily_${fileTag()}.csv`,
        [DAILY_COLS.map((c) => c.h)].concat(rows.map((r) => r.map((v, i) => DAILY_COLS[i].f === "pct" ? pctTxt(v) : v))),
        `Exported daily data ${state.from} to ${state.to}`);
    }
  }

  /* ---------- unit level ---------- */
  const UNIT_COLS = [
    { h: "LWH ID", w: 11 }, { h: "Item", w: 16 }, { h: "Description", w: 22 }, { h: "Type", w: 13 },
    { h: "Received", w: 11, f: "date" }, { h: "Status", w: 10 }, { h: "Out date", w: 11, f: "date" },
    { h: "Days to out", w: 11, f: "int" }, { h: "Pro", w: 10 }, { h: "Reference", w: 26 }, { h: "Scrap route", w: 16 },
  ];
  async function exportUnitsRange(mode, asXlsx) {
    const raw = await api("units_export", { from: state.from, to: state.to, mode });
    const types = selectedTypes();
    const rows = raw.filter((u) => types.includes(u[3])).map((u) => [
      u[0], u[1] || "", u[2] || "", TYPE_NAME[u[3]] || u[3], u[4], STATUS[u[5]] || u[5], u[6], u[7], u[8] ?? "", u[9] || "", u[10] || "",
    ]);
    const name = `nissan_${mode}_units_${fileTag()}`;
    if (!rows.length) throw new Error(`No ${mode} units in this range.`);
    if (asXlsx) {
      const X = await loadXlsx();
      const wb = X.utils.book_new();
      const data = rows.map((r) => [r[0], r[1], r[2], r[3], xDate(r[4]), r[5], xDate(r[6]), r[7], r[8], r[9], r[10]]);
      X.utils.book_append_sheet(wb, sheet(X, UNIT_COLS, data, scopeLines()), mode === "scrapped" ? "Scrapped Units" : "Received Units");
      X.writeFile(wb, name + ".xlsx", { compression: true });
    } else {
      downloadCsv(name + ".csv", [UNIT_COLS.map((c) => c.h)].concat(rows), null);
    }
    return rows.length;
  }

  /* ---------- print / PDF ---------- */
  function printReport() {
    const { s } = summarize(selectedTypes());
    $("printHead").innerHTML = `<h1>Nissan Scrap Analytics</h1>
      <div>${esc(TYPE_LABEL[state.type])} | ${usDate(state.from)} to ${usDate(state.to)} | ${esc($("freshness").textContent.split("|").pop().trim())}</div>
      <div>Logistics Warehouse, Inc. | Printed ${new Date().toLocaleDateString("en-US")}${state.name ? " by " + esc(state.name) : ""} | ${fmt(s.received)} received, ${fmt(s.scrapped)} scrapped</div>`;
    renderOverview(); renderWeekly();
    $("exportModal").hidden = true;
    api("log", { note: `Printed report ${state.from} to ${state.to}` }).catch(() => {});
    setTimeout(() => window.print(), 150);
  }
  window.addEventListener("beforeprint", () => {
    Object.values(state.charts).forEach((c) => { try { c.resize(700, c.canvas.id === "onHandChart" ? 140 : 200); } catch (_) {} });
  });
  window.addEventListener("afterprint", () => {
    Object.values(state.charts).forEach((c) => { try { c.resize(); } catch (_) {} });
  });

  /* ---------- export menu ---------- */
  function openExport() {
    $("exportScope").textContent = `Exports use the current filters: ${TYPE_LABEL[state.type]}, ${usDate(state.from)} to ${usDate(state.to)}.`;
    setExportStatus("");
    $("exportModal").hidden = false;
  }
  function setExportStatus(msg, isErr) {
    const el = $("exportStatus"); el.textContent = msg || ""; el.classList.toggle("err", !!isErr);
  }
  let exporting = false;
  async function onExportClick(e) {
    const b = e.target.closest("[data-export]"); if (!b || exporting) return;
    if (!state.dash) { setExportStatus("Data is still loading. Try again in a moment.", true); return; }
    const kind = b.dataset.export;
    if (kind === "print") { printReport(); return; }
    exporting = true;
    document.querySelectorAll("[data-export]").forEach((x) => { x.disabled = true; });
    setExportStatus("Preparing your file...");
    try {
      let msg = "Download started.";
      if (kind === "workbook") await exportWorkbook();
      else if (kind === "daily-csv") await exportDaily(false);
      else if (kind === "daily-xlsx") await exportDaily(true);
      else {
        const [mode, ext] = kind.split("-");
        const n = await exportUnitsRange(mode, ext === "xlsx");
        msg = `Download started: ${fmt(n)} units.`;
      }
      setExportStatus(msg);
    } catch (err) {
      if (err.message !== "SESSION_EXPIRED") setExportStatus(err.message, true);
    } finally {
      exporting = false;
      document.querySelectorAll("[data-export]").forEach((x) => { x.disabled = false; });
    }
  }

  /* ---------------- wire up ---------------- */
  function init() {
    $("loginForm").addEventListener("submit", doLogin);
    $("signOutBtn").addEventListener("click", doLogout);
    $("presetSelect").addEventListener("change", onPreset);
    $("fromDate").addEventListener("change", onDates);
    $("toDate").addEventListener("change", onDates);
    document.querySelector(".segmented").addEventListener("click", onType);
    document.querySelector(".tabs").addEventListener("click", onTab);
    $("flowTableBtn").addEventListener("click", () => {
      const t = $("flowTable"); t.hidden = !t.hidden;
      $("flowTableBtn").textContent = t.hidden ? "Show table" : "Hide table";
    });
    $("weeklyCsvBtn").addEventListener("click", exportWeekly);
    $("loadsCsvBtn").addEventListener("click", exportLoads);
    $("unitCsvBtn").addEventListener("click", exportUnits);
    $("unitCloseBtn").addEventListener("click", () => { $("unitModal").hidden = true; });
    $("unitModal").addEventListener("click", (e) => { if (e.target.id === "unitModal") $("unitModal").hidden = true; });
    $("exportBtn").addEventListener("click", openExport);
    $("exportCloseBtn").addEventListener("click", () => { $("exportModal").hidden = true; });
    $("exportModal").addEventListener("click", (e) => { if (e.target.id === "exportModal") $("exportModal").hidden = true; else onExportClick(e); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { $("unitModal").hidden = true; $("exportModal").hidden = true; } });

    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

    if (loadSession()) { showApp(); initRange(); refresh(); }
    else showLogin();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
