"use strict";

const cfg = window.APP_CONFIG || {};
const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

const STATUS_TEXT = { none: "未出勤", working: "勤務中", on_break: "休憩中", done: "退勤済み" };
const NEXT_STATUS = { clock_in: "working", break_start: "on_break", break_end: "working", clock_out: "done" };

let staff = [];        // { id, name, role }
let monthOffset = 0;

// ---- 日時 ----
function jstDate(ts) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date(ts));
}
function jstTime(ts) {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ts));
}
function todayJst() { return jstDate(Date.now()); }
function pad(n) { return String(n).padStart(2, "0"); }
function fmtMinutes(m) {
  if (m == null) return "";
  const r = Math.round(m);
  return Math.floor(r / 60) + ":" + pad(r % 60);
}
function staffName(p) { return p.name || "(名前未設定)"; }

// ---- 表を作る道具(文字は必ず textContent で入れる) ----
function addRow(tbody, cells) {
  const tr = document.createElement("tr");
  cells.forEach((c, i) => {
    const td = document.createElement("td");
    const text = typeof c === "object" && c !== null ? c.text : c;
    td.textContent = text == null ? "" : text;
    if (c && typeof c === "object" && c.cls) td.className = c.cls;
    if (i === 0 && c && c.left !== false && tbody.dataset.leftFirst) td.classList.add("left");
    tr.appendChild(td);
  });
  tbody.appendChild(tr);
}
function setMsg(id, text) { $(id).textContent = text || ""; }

// ---- 1日分の集計 ----
function dayStats(evs) {
  const sorted = evs;
  const cin = sorted.find((e) => e.event_type === "clock_in");
  const cout = [...sorted].reverse().find((e) => e.event_type === "clock_out");
  const bsEv = sorted.find((e) => e.event_type === "break_start");
  const beEv = [...sorted].reverse().find((e) => e.event_type === "break_end");
  let breakMin = 0;
  let bs = null;
  for (const e of sorted) {
    if (e.event_type === "break_start") bs = new Date(e.occurred_at);
    if (e.event_type === "break_end" && bs) {
      breakMin += (new Date(e.occurred_at) - bs) / 60000;
      bs = null;
    }
  }
  let workMin = null;
  if (cin && cout) workMin = (new Date(cout.occurred_at) - new Date(cin.occurred_at)) / 60000 - breakMin;
  const status = sorted.length ? NEXT_STATUS[sorted[sorted.length - 1].event_type] : "none";
  const incomplete = sorted.length > 0 && (!cin || !cout || bs !== null);
  return { cin, cout, bsEv, beEv, breakMin, workMin, status, incomplete };
}

// ---- データ取得 ----
async function loadEvents(fromDay, toDay) {
  const { data, error } = await db
    .from("attendance_events")
    .select("user_id, event_type, occurred_at, work_date")
    .gte("work_date", fromDay)
    .lte("work_date", toDay)
    .order("occurred_at", { ascending: true })
    .order("id", { ascending: true })
    .range(0, 4999);
  if (error) throw error;
  const map = {}; // map[userId][day] = [events]
  for (const e of data || []) {
    if (!map[e.user_id]) map[e.user_id] = {};
    if (!map[e.user_id][e.work_date]) map[e.user_id][e.work_date] = [];
    map[e.user_id][e.work_date].push(e);
  }
  return map;
}

// ---- 画面: 本日 ----
async function renderToday() {
  const day = todayJst();
  const map = await loadEvents(day, day);
  const counts = { none: 0, working: 0, on_break: 0, done: 0 };
  const tbody = $("today-body");
  tbody.replaceChildren();
  tbody.dataset.leftFirst = "1";
  for (const p of staff) {
    const s = dayStats((map[p.id] && map[p.id][day]) || []);
    counts[s.status] += 1;
    addRow(tbody, [
      staffName(p),
      STATUS_TEXT[s.status],
      s.cin ? jstTime(s.cin.occurred_at) : "",
      s.bsEv ? jstTime(s.bsEv.occurred_at) : "",
      s.beEv ? jstTime(s.beEv.occurred_at) : "",
      s.cout ? jstTime(s.cout.occurred_at) : "",
    ]);
  }
  for (const k of Object.keys(counts)) $("c-" + k).textContent = String(counts[k]);
}

// ---- 画面: 日別 ----
async function renderDay() {
  const day = $("day-input").value || todayJst();
  const map = await loadEvents(day, day);
  const tbody = $("day-body");
  tbody.replaceChildren();
  tbody.dataset.leftFirst = "1";
  const isPast = day < todayJst();
  for (const p of staff) {
    const s = dayStats((map[p.id] && map[p.id][day]) || []);
    let state = STATUS_TEXT[s.status];
    let cls = "";
    if (s.incomplete && isPast) { state = "打刻漏れ"; cls = "flag"; }
    addRow(tbody, [
      staffName(p),
      s.cin ? jstTime(s.cin.occurred_at) : "",
      s.bsEv ? jstTime(s.bsEv.occurred_at) : "",
      s.beEv ? jstTime(s.beEv.occurred_at) : "",
      s.cout ? jstTime(s.cout.occurred_at) : "",
      fmtMinutes(s.workMin),
      { text: state, cls },
    ]);
  }
}

// ---- 画面: 月別 ----
function targetMonth() {
  const [y, m] = todayJst().split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + monthOffset, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

async function renderMonth() {
  const { year, month } = targetMonth();
  $("month-label").textContent = year + "年" + month + "月";
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const first = year + "-" + pad(month) + "-01";
  const last = year + "-" + pad(month) + "-" + pad(lastDay);
  const map = await loadEvents(first, last);
  const today = todayJst();

  const sum = $("month-summary");
  sum.replaceChildren();
  sum.dataset.leftFirst = "1";
  for (const p of staff) {
    let days = 0, total = 0, missing = 0;
    const byDay = map[p.id] || {};
    for (const d of Object.keys(byDay)) {
      const s = dayStats(byDay[d]);
      if (s.cin) days += 1;
      if (s.workMin != null) total += s.workMin;
      if (s.incomplete && d < today) missing += 1;
    }
    addRow(sum, [
      staffName(p),
      days + "日",
      fmtMinutes(total),
      { text: missing ? missing + "件" : "なし", cls: missing ? "flag" : "" },
    ]);
  }

  const sel = $("staff-select");
  const chosen = sel.value || (staff[0] && staff[0].id);
  const detail = $("month-detail");
  detail.replaceChildren();
  const byDay = (map[chosen] || {});
  const days = Object.keys(byDay).sort();
  if (!days.length) {
    addRow(detail, [{ text: "この月の記録はありません" }]);
    detail.firstChild.firstChild.colSpan = 6;
    return;
  }
  for (const d of days) {
    const s = dayStats(byDay[d]);
    const miss = s.incomplete && d < today;
    addRow(detail, [
      Number(d.slice(8)) + "日",
      s.cin ? jstTime(s.cin.occurred_at) : "",
      s.cout ? jstTime(s.cout.occurred_at) : "",
      fmtMinutes(s.breakMin),
      fmtMinutes(s.workMin),
      { text: miss ? "打刻漏れ" : "", cls: miss ? "flag" : "" },
    ]);
  }
}

// ---- タブ ----
let currentTab = "today";
async function showTab(name) {
  currentTab = name;
  for (const t of ["today", "day", "month"]) {
    $("tab-" + t).classList.toggle("hidden", t !== name);
  }
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  await refresh();
}
async function refresh() {
  setMsg("app-msg", "");
  try {
    if (currentTab === "today") await renderToday();
    if (currentTab === "day") await renderDay();
    if (currentTab === "month") await renderMonth();
  } catch (e) {
    setMsg("app-msg", "データを読み込めませんでした。通信状況をご確認ください。");
  }
}
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
$("day-input").addEventListener("change", refresh);
$("staff-select").addEventListener("change", refresh);
$("prev-month").addEventListener("click", async () => { monthOffset -= 1; await refresh(); });
$("next-month").addEventListener("click", async () => { if (monthOffset < 0) { monthOffset += 1; await refresh(); } });

// ---- ログイン ----
function show(view) {
  $("login-view").classList.toggle("hidden", view !== "login");
  $("app-view").classList.toggle("hidden", view !== "app");
}
$("login-btn").addEventListener("click", async () => {
  setMsg("login-msg", "");
  const { error } = await db.auth.signInWithPassword({
    email: $("email").value.trim(),
    password: $("password").value,
  });
  if (error) {
    setMsg("login-msg", "ログインできませんでした。メールアドレスとパスワードをご確認ください。");
    return;
  }
  await start();
});
$("logout-btn").addEventListener("click", async () => {
  await db.auth.signOut();
  $("password").value = "";
  show("login");
});

// ---- 起動 ----
async function start() {
  const { data } = await db.auth.getSession();
  if (!data.session) { show("login"); return; }
  const { data: me } = await db.from("profiles").select("role").eq("id", data.session.user.id).maybeSingle();
  if (!me || me.role !== "admin") {
    await db.auth.signOut();
    show("login");
    setMsg("login-msg", "このアカウントは管理者ではありません。");
    return;
  }
  const { data: list, error } = await db.from("profiles").select("id, name, role").neq("role", "display").order("name", { ascending: true });
  if (error) { show("login"); setMsg("login-msg", "スタッフ一覧を読み込めませんでした。"); return; }
  staff = list || [];

  const sel = $("staff-select");
  sel.replaceChildren();
  for (const p of staff) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = staffName(p);
    sel.appendChild(o);
  }
  $("day-input").value = todayJst();
  show("app");
  await showTab("today");
}
start();
