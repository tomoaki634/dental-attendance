"use strict";

const cfg = window.APP_CONFIG || {};
const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

const LABELS = { clock_in: "出勤", break_start: "休憩開始", break_end: "休憩終了", clock_out: "退勤" };
const STATUS_TEXT = { none: "未出勤", working: "勤務中", on_break: "休憩中", done: "退勤済み" };
const ALLOWED = { none: ["clock_in"], working: ["clock_out"], on_break: ["clock_out"], done: [] };
const BUTTONS = ["clock_in", "clock_out"];
// 休憩の時間帯(日本時間)。出勤〜退勤の時間のうち、この時間帯と重なる分だけを、勤務時間から自動で引く
const BREAK_START = cfg.BREAK_START || "13:00";
const BREAK_END = cfg.BREAK_END || "14:30";
function breakOverlapMin(day, cinTs, coutTs) {
  const s = new Date(day + "T" + BREAK_START + ":00+09:00").getTime();
  const e = new Date(day + "T" + BREAK_END + ":00+09:00").getTime();
  const a = Math.max(s, new Date(cinTs).getTime());
  const b = Math.min(e, new Date(coutTs).getTime());
  return Math.max(0, (b - a) / 60000);
}

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
  for (const type of BUTTONS) {
    $("b-" + type).disabled = !ALLOWED[status].includes(type);
  }
  let hint = $("qr-hint");
  if (!hint) {
    hint = document.createElement("div");
    hint.id = "qr-hint";
    hint.className = "note";
    hint.style.textAlign = "center";
    $("status").after(hint);
  }
  hint.textContent = status !== "done"
    ? (hasToken ? "QRコードを読み取り済みです。ボタンを押してください。" : "ボタンを押すと、カメラが起動します。院内のQRコードを読み取ってください。")
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
      breakMin = breakOverlapMin(day, cin.occurred_at, cout.occurred_at); // 休憩の時間帯と重なった分を引く
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

// ---- アプリ内のカメラで、院内のQRコードを読み取る ----
function loadJsQr() {
  if (window.jsQR) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";
    s.onload = () => (window.jsQR ? resolve() : reject(new Error("jsqr")));
    s.onerror = () => reject(new Error("jsqr"));
    document.head.appendChild(s);
  });
}
async function scanQr() {
  await loadJsQr();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("camera");
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });

  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;inset:0;z-index:1000;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:16px;";
  const video = document.createElement("video");
  video.setAttribute("playsinline", "");
  video.muted = true;
  video.style.cssText = "width:100%;max-width:480px;max-height:65vh;object-fit:cover;border-radius:12px;";
  const text = document.createElement("div");
  text.textContent = "院内のQRコードを、画面に映してください";
  text.style.cssText = "color:#fff;font-size:16px;text-align:center;";
  const cancel = document.createElement("button");
  cancel.textContent = "キャンセル";
  cancel.style.cssText = "font-size:16px;padding:12px 28px;border:0;border-radius:12px;background:#fff;color:#223;";
  wrap.append(video, text, cancel);
  document.body.appendChild(wrap);
  video.srcObject = stream;
  video.play().catch(() => {});

  return new Promise((resolve, reject) => {
    let done = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const started = Date.now();
    function finish(fn) {
      if (done) return;
      done = true;
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      wrap.remove();
      fn();
    }
    cancel.addEventListener("click", () => finish(() => reject(new Error("cancel"))));
    const timer = setInterval(() => {
      if (Date.now() - started > 90000) { finish(() => reject(new Error("cancel"))); return; }
      if (video.readyState < 2 || !video.videoWidth) return;
      const w = Math.min(640, video.videoWidth);
      const h = Math.round((video.videoHeight * w) / video.videoWidth);
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(video, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      const r = window.jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
      if (r && r.data) {
        const m = /[#&]q=([0-9a-f]{20,128})$/.exec(r.data);
        if (m) finish(() => resolve(m[1]));
      }
    }, 250);
  });
}

// ---- 打刻 ----
let punching = false;
async function punch(type) {
  if (punching) return;
  punching = true;
  try {
    await doPunch(type);
  } finally {
    punching = false;
  }
}
async function doPunch(type) {
  let token = loadToken();
  if (!token) {
    setMsg("punch-msg", "");
    try {
      token = await scanQr();
      saveToken(token);
    } catch (e) {
      if (e && e.message === "cancel") return;
      setMsg("punch-msg", "カメラを使えませんでした。ブラウザのカメラの許可をご確認いただくか、スマートフォン標準のカメラで、院内のQRコードを読み取ってください。", "err");
      return;
    }
  }
  if (!confirm(LABELS[type] + "を打刻します。よろしいですか?")) return;
  setMsg("punch-msg", "送信中…");
  for (const t of BUTTONS) $("b-" + t).disabled = true;
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
for (const type of BUTTONS) {
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
