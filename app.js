"use strict";

const cfg = window.APP_CONFIG || {};
const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

const LABELS = { clock_in: "出勤", break_start: "休憩開始", break_end: "休憩終了", clock_out: "退勤" };
const STATUS_TEXT = { none: "未出勤", working: "勤務中", on_break: "休憩中", done: "退勤済み" };
const ALLOWED = { none: ["clock_in"], working: ["break_start", "clock_out"], on_break: ["break_end"], done: [] };

let currentUser = null;
let monthOffset = 0;

// ---- 院内QRコードの文字列(スマホのカメラで読み取ると、アドレスの後ろに付いてくる) ----
let memToken = null;
function saveToken(t) {
  memToken = t;
  try { sessionStorage.setItem("qrToken", t); } catch (e) { /* 保存できない端末でも動くようにする */ }
}
function loadToken() {
  try { return sessionStorage.getItem("qrToken") || memToken; } catch (e) { return memToken; }
}
function clearToken() {
  memToken = null;
  try { sessionStorage.removeItem("qrToken"); } catch (e) { /* 何もしない */ }
}
(function captureToken() {
  const m = /[#&]q=([0-9a-f]{20,128})/.exec(location.hash);
  if (m) {
    saveToken(m[1]);
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* 何もしない */ }
  }
})();

// ---- 日時の表示(日本時間) ----
function jstDate(ts) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date(ts)); // YYYY-MM-DD
}
function jstTime(ts) {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ts));
}
function fmtMinutes(m) {
  if (m == null) return "";
  return Math.floor(m / 60) + ":" + String(Math.round(m % 60)).padStart(2, "0");
}
function todayJst() { return jstDate(Date.now()); }

function targetMonth() {
  const [y, m] = todayJst().split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + monthOffset, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}
function pad(n) { return String(n).padStart(2, "0"); }

// ---- 画面の切り替え ----
function show(view) {
  $("login-view").classList.toggle("hidden", view !== "login");
  $("app-view").classList.toggle("hidden", view !== "app");
}
function setMsg(id, text, kind) {
  const el = $(id);
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

// ---- ログイン ----
$("login-btn").addEventListener("click", async () => {
  setMsg("login-msg", "");
  const { error } = await db.auth.signInWithPassword({
    email: $("email").value.trim(),
    password: $("password").value,
  });
  if (error) {
    setMsg("login-msg", "ログインできませんでした。メールアドレスとパスワードをご確認ください。", "err");
    return;
  }
  await start();
});
$("logout-btn").addEventListener("click", async () => {
  await db.auth.signOut();
  currentUser = null;
  $("password").value = "";
  show("login");
});

// ---- データ取得 ----
async function loadToday() {
  const { data, error } = await db
    .from("attendance_events")
    .select("event_type, occurred_at")
    .eq("work_date", todayJst())
    .order("occurred_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;
  return data || [];
}

function statusFromEvents(events) {
  if (!events.length) return "none";
  const last = events[events.length - 1].event_type;
  return { clock_in: "working", break_start: "on_break", break_end: "working", clock_out: "done" }[last];
}

async function refreshToday() {
  const events = await loadToday();
  const status = statusFromEvents(events);
  $("status").textContent = STATUS_TEXT[status];

  const hasToken = !!loadToken();
  const hadBreak = events.some((e) => e.event_type === "break_start");
  for (const type of Object.keys(LABELS)) {
    let ok = ALLOWED[status].includes(type) && hasToken;
    if (type === "break_start" && hadBreak) ok = false;
    $("b-" + type).disabled = !ok;
  }
  let hint = $("qr-hint");
  if (!hint) {
    hint = document.createElement("div");
    hint.id = "qr-hint";
    hint.className = "note";
    hint.style.textAlign = "center";
    $("status").after(hint);
  }
  hint.textContent = (!hasToken && status !== "done")
    ? "打刻するには、院内のQRコードを、スマートフォンのカメラで読み取ってください。"
    : "";

  const tbody = $("today-list");
  tbody.replaceChildren();
  if (!events.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.textContent = "まだ打刻はありません";
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  for (const e of events) {
    const tr = document.createElement("tr");
    const a = document.createElement("td");
    a.textContent = LABELS[e.event_type];
    const b = document.createElement("td");
    b.textContent = jstTime(e.occurred_at);
    tr.append(a, b);
    tbody.appendChild(tr);
  }
}

async function refreshHistory() {
  const { year, month } = targetMonth();
  $("month-label").textContent = year + "年" + month + "月";
  const first = year + "-" + pad(month) + "-01";
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = year + "-" + pad(month) + "-" + pad(lastDay);

  const { data, error } = await db
    .from("attendance_events")
    .select("event_type, occurred_at, work_date")
    .gte("work_date", first)
    .lte("work_date", last)
    .order("occurred_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;

  const byDay = {};
  for (const e of data || []) {
    (byDay[e.work_date] = byDay[e.work_date] || []).push(e);
  }

  const tbody = $("history");
  tbody.replaceChildren();
  const days = Object.keys(byDay).sort();
  if (!days.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.textContent = "この月の記録はありません";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const day of days) {
    const evs = byDay[day];
    const cin = evs.find((e) => e.event_type === "clock_in");
    const cout = [...evs].reverse().find((e) => e.event_type === "clock_out");
    let breakMin = 0;
    let bs = null;
    for (const e of evs) {
      if (e.event_type === "break_start") bs = new Date(e.occurred_at);
      if (e.event_type === "break_end" && bs) {
        breakMin += (new Date(e.occurred_at) - bs) / 60000;
        bs = null;
      }
    }
    let workMin = null;
    if (cin && cout) {
      workMin = (new Date(cout.occurred_at) - new Date(cin.occurred_at)) / 60000 - breakMin;
    }
    const missing = day !== todayJst() && (!cin || !cout || bs);

    const tr = document.createElement("tr");
    const cells = [
      Number(day.slice(8)) + "日",
      cin ? jstTime(cin.occurred_at) : "",
      cout ? jstTime(cout.occurred_at) : "",
      fmtMinutes(breakMin),
      workMin == null ? "" : fmtMinutes(workMin),
    ];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    if (missing) {
      tr.lastChild.textContent = "打刻漏れ";
      tr.lastChild.className = "flag";
    }
    tbody.appendChild(tr);
  }
}

// ---- 打刻 ----
async function punch(type) {
  const token = loadToken();
  if (!token) {
    setMsg("punch-msg", "院内のQRコードを、スマートフォンのカメラで読み取ってください。", "err");
    await refreshAll();
    return;
  }
  if (!confirm(LABELS[type] + "を打刻します。よろしいですか?")) return;
  setMsg("punch-msg", "送信中…");
  for (const t of Object.keys(LABELS)) $("b-" + t).disabled = true;
  const { data, error } = await db.rpc("punch_qr", {
    p_token: token,
    p_type: type,
    p_device: navigator.userAgent,
  });
  if (error) {
    setMsg("punch-msg", error.message, "err");
    // QRの期限切れ・使用済みの場合は、読み取り直してもらう
    if (/QRコード/.test(error.message)) clearToken();
  } else {
    setMsg("punch-msg", LABELS[type] + "を打刻しました(" + jstTime(data.occurred_at) + ")", "ok");
    clearToken(); // 1回の打刻ごとに、QRコードを読み取り直す
  }
  await refreshAll();
}
for (const type of Object.keys(LABELS)) {
  $("b-" + type).addEventListener("click", () => punch(type));
}

$("prev-month").addEventListener("click", async () => { monthOffset -= 1; await refreshHistory(); });
$("next-month").addEventListener("click", async () => { if (monthOffset < 0) { monthOffset += 1; await refreshHistory(); } });

async function refreshAll() {
  try {
    await refreshToday();
    await refreshHistory();
  } catch (e) {
    setMsg("punch-msg", "データを読み込めませんでした。通信状況をご確認ください。", "err");
  }
}

// ---- 起動 ----
async function start() {
  const { data } = await db.auth.getSession();
  if (!data.session) { show("login"); return; }
  currentUser = data.session.user;
  const { data: prof } = await db.from("profiles").select("name").eq("id", currentUser.id).maybeSingle();
  $("user-name").textContent = (prof && prof.name) || currentUser.email;
  show("app");
  await refreshAll();
}
start();
