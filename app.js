"use strict";

const cfg = window.APP_CONFIG || {};
const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

const LABELS = { clock_in: "出勤", break_start: "休憩開始", break_end: "休憩終了", clock_out: "退勤" };
const STATUS_TEXT = { none: "未出勤", working: "勤務中", on_break: "休憩中", done: "退勤済み" };
const ALLOWED = { none: ["clock_in", "clock_out"], working: ["clock_out"], on_break: ["clock_out"], done: [] };
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
  let hintText = status !== "done"
    ? (hasToken ? "QRコードを読み取り済みです。ボタンを押してください。" : "ボタンを押すと、カメラが起動します。院内のQRコードを読み取ってください。")
    : "";
  if (status === "none") hintText += "出勤の打刻を忘れたときも、「退勤」を押せます。出勤の時刻は、あとで「打刻を忘れたとき」から申請してください。";
  hint.textContent = hintText;

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
      const kind = !cin ? "clock_in" : "clock_out";
      tr.lastChild.textContent = !cin ? "出勤なし" : "退勤なし";
      tr.lastChild.className = "flag tap";
      tr.lastChild.addEventListener("click", () => prefillCorrection(day, kind));
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
  let ask = LABELS[type] + "を打刻します(現在 " + jstTime(Date.now()) + ")。よろしいですか?";
  if (type === "clock_in" && Number(jstTime(Date.now()).slice(0, 2)) >= 12) {
    ask += "\n\n朝の出勤を忘れた場合は、キャンセルして「退勤」を押してください。";
  }
  if (!confirm(ask)) return;
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

// ---- 打刻の修正の申請 ----
const CORR_STATUS = { pending: "申請中", approved: "承認", rejected: "却下" };
function prefillCorrection(day, type) {
  $("corr-date").value = day;
  $("corr-type").value = type;
  $("corr-card").open = true;
  setMsg("corr-msg", "");
  $("corr-card").scrollIntoView({ behavior: "smooth", block: "start" });
}
async function refreshCorrections() {
  const { data, error } = await db
    .from("correction_requests")
    .select("work_date, event_type, requested_time, final_time, status, decision_note")
    .order("created_at", { ascending: false })
    .limit(15);
  if (error) throw error;
  const tbody = $("corr-list");
  tbody.replaceChildren();
  if (!data || !data.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.textContent = "申請はまだありません";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const r of data) {
    const tr = document.createElement("tr");
    const t = (r.final_time || r.requested_time || "").slice(0, 5);
    const cells = [r.work_date.slice(5).replace("-", "/"), LABELS[r.event_type], t];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    const st = document.createElement("td");
    st.textContent = CORR_STATUS[r.status] + (r.status === "rejected" && r.decision_note ? "(" + r.decision_note + ")" : "");
    st.className = "st-" + r.status;
    tr.appendChild(st);
    tbody.appendChild(tr);
  }
}
function initCorrectionForm() {
  const today = todayJst();
  const min = new Date(Date.now() - 45 * 86400000);
  $("corr-date").max = today;
  $("corr-date").min = jstDate(min);
  if (!$("corr-date").value) $("corr-date").value = today;
}
let submittingCorr = false;
$("corr-btn").addEventListener("click", async () => {
  if (submittingCorr) return;
  const day = $("corr-date").value;
  const type = $("corr-type").value;
  const time = $("corr-time").value;
  const reason = $("corr-reason").value.trim();
  if (!day || !time) { setMsg("corr-msg", "日付と時刻を入力してください。", "err"); return; }
  if (!reason) { setMsg("corr-msg", "理由を入力してください。", "err"); return; }
  if (!confirm(day.replace(/-/g, "/") + " の" + LABELS[type] + "を " + time + " として申請します。よろしいですか?")) return;
  submittingCorr = true;
  setMsg("corr-msg", "送信中…");
  const { error } = await db.rpc("request_correction", { p_date: day, p_type: type, p_time: time, p_reason: reason });
  submittingCorr = false;
  if (error) { setMsg("corr-msg", error.message, "err"); return; }
  setMsg("corr-msg", "申請しました。管理者の確認をお待ちください。", "ok");
  $("corr-reason").value = "";
  $("corr-time").value = "";
  try { await refreshCorrections(); } catch (e) { /* 一覧は次回の表示で更新される */ }
});

$("prev-month").addEventListener("click", async () => { monthOffset -= 1; await refreshHistory(); });
$("next-month").addEventListener("click", async () => { if (monthOffset < 0) { monthOffset += 1; await refreshHistory(); } });

async function refreshAll() {
  try {
    await refreshToday();
    await refreshHistory();
    await refreshCorrections();
    await refreshLeaves();
  } catch (e) {
    setMsg("punch-msg", "データを読み込めませんでした。通信状況をご確認ください。", "err");
  }
}

// ---- パスワードの変更(画面の部品は、ここで作る) ----
function initPasswordCard() {
  if ($("pw-card")) return;
  const card = document.createElement("details");
  card.id = "pw-card";
  card.className = "card";
  const mk = (tag, props, text) => { const e = document.createElement(tag); Object.assign(e, props || {}); if (text) e.textContent = text; return e; };
  card.appendChild(mk("summary", {}, "パスワードを変更する"));
  card.appendChild(mk("p", { className: "note" }, "最初に渡されたパスワードから、自分だけが知っているパスワードに変えられます。8文字以上で入力してください。"));
  card.appendChild(mk("label", { htmlFor: "pw-new" }, "新しいパスワード"));
  card.appendChild(mk("input", { id: "pw-new", type: "password", autocomplete: "new-password" }));
  card.appendChild(mk("label", { htmlFor: "pw-new2" }, "もう一度、同じパスワード"));
  card.appendChild(mk("input", { id: "pw-new2", type: "password", autocomplete: "new-password" }));
  card.appendChild(mk("button", { id: "pw-btn", className: "primary" }, "パスワードを変更する"));
  card.appendChild(mk("div", { id: "pw-msg", className: "msg" }));
  const anchor = $("corr-card");
  anchor.parentNode.insertBefore(card, anchor.nextSibling);
  $("pw-btn").addEventListener("click", async () => {
    const a = $("pw-new").value, b = $("pw-new2").value;
    if (a.length < 8) { setMsg("pw-msg", "パスワードは8文字以上にしてください。", "err"); return; }
    if (a !== b) { setMsg("pw-msg", "2回の入力が一致しません。", "err"); return; }
    $("pw-btn").disabled = true;
    setMsg("pw-msg", "変更中…");
    const { error } = await db.auth.updateUser({ password: a });
    $("pw-btn").disabled = false;
    if (error) { setMsg("pw-msg", "変更できませんでした: " + error.message, "err"); return; }
    $("pw-new").value = ""; $("pw-new2").value = "";
    setMsg("pw-msg", "パスワードを変更しました。次回から、新しいパスワードでログインしてください。", "ok");
  });
}

// ---- 有給の申請(画面の部品は、ここで作る) ----
const LEAVE_KIND = { full: "全日", am: "午前休(半日)", pm: "午後休(半日)" };
const LEAVE_STATUS = { pending: "申請中", approved: "承認", rejected: "却下", cancelled: "取り消し" };
function initLeaveCard() {
  if ($("lv-card")) return;
  const mk = (tag, props, text) => { const e = document.createElement(tag); Object.assign(e, props || {}); if (text) e.textContent = text; return e; };
  const card = mk("details", { id: "lv-card", className: "card" });
  card.appendChild(mk("summary", {}, "有給休暇の申請"));
  card.appendChild(mk("p", { className: "note" }, "休みたい日を選んで申請します。管理者が確認して、承認されると有給になります。"));
  card.appendChild(mk("label", { htmlFor: "lv-date" }, "日付"));
  card.appendChild(mk("input", { id: "lv-date", type: "date" }));
  card.appendChild(mk("label", { htmlFor: "lv-kind" }, "種類"));
  const sel = mk("select", { id: "lv-kind" });
  for (const k of ["full", "am", "pm"]) sel.appendChild(mk("option", { value: k }, LEAVE_KIND[k]));
  card.appendChild(sel);
  card.appendChild(mk("label", { htmlFor: "lv-reason" }, "理由(書かなくても大丈夫です)"));
  card.appendChild(mk("textarea", { id: "lv-reason", maxLength: 300 }));
  card.appendChild(mk("button", { id: "lv-btn", className: "primary" }, "申請する"));
  card.appendChild(mk("div", { id: "lv-msg", className: "msg" }));
  card.appendChild(mk("h2", {}, "申請の状況"));
  const table = mk("table");
  const thead = mk("thead");
  const trh = mk("tr");
  for (const t of ["日付", "種類", "状況", ""]) trh.appendChild(mk("th", {}, t));
  thead.appendChild(trh);
  table.appendChild(thead);
  table.appendChild(mk("tbody", { id: "lv-list" }));
  card.appendChild(table);
  const anchor = $("pw-card") || $("corr-card");
  anchor.parentNode.insertBefore(card, anchor);

  const today = jstDate(Date.now());
  const min = new Date(Date.now() - 30 * 86400000), max = new Date(Date.now() + 365 * 86400000);
  $("lv-date").min = jstDate(min); $("lv-date").max = jstDate(max); $("lv-date").value = today;

  $("lv-btn").addEventListener("click", async () => {
    const day = $("lv-date").value, kind = $("lv-kind").value, reason = $("lv-reason").value.trim();
    if (!day) { setMsg("lv-msg", "日付を入力してください。", "err"); return; }
    if (!confirm(day.replace(/-/g, "/") + " を、有給(" + LEAVE_KIND[kind] + ")として申請します。よろしいですか?")) return;
    $("lv-btn").disabled = true;
    setMsg("lv-msg", "送信中…");
    const { error } = await db.rpc("request_leave", { p_date: day, p_kind: kind, p_reason: reason || null });
    $("lv-btn").disabled = false;
    if (error) { setMsg("lv-msg", error.message, "err"); return; }
    $("lv-reason").value = "";
    setMsg("lv-msg", "申請しました。管理者の確認をお待ちください。", "ok");
    await refreshLeaves();
  });
}
async function refreshLeaves() {
  const body = $("lv-list");
  if (!body) return;
  const { data, error } = await db
    .from("leave_requests")
    .select("id, leave_date, kind, status, decision_note")
    .order("leave_date", { ascending: false })
    .limit(15);
  if (error) { body.replaceChildren(); return; }
  body.replaceChildren();
  if (!data || !data.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4; td.textContent = "申請はまだありません";
    tr.appendChild(td); body.appendChild(tr);
    return;
  }
  for (const r of data) {
    const tr = document.createElement("tr");
    const add = (t, cls) => { const td = document.createElement("td"); td.textContent = t; if (cls) td.className = cls; tr.appendChild(td); return td; };
    add(r.leave_date.slice(5).replace("-", "/"));
    add(LEAVE_KIND[r.kind]);
    add(LEAVE_STATUS[r.status] + (r.status === "rejected" && r.decision_note ? "(" + r.decision_note + ")" : ""),
        "st-" + (r.status === "pending" ? "pending" : r.status === "approved" ? "approved" : r.status === "rejected" ? "rejected" : ""));
    const td = document.createElement("td");
    if (r.status === "pending") {
      const b = document.createElement("button");
      b.className = "link"; b.textContent = "取り消す";
      b.addEventListener("click", async () => {
        if (!confirm("この申請を取り消します。よろしいですか?")) return;
        const { error: e2 } = await db.rpc("cancel_leave", { p_id: r.id, p_note: null });
        if (e2) { setMsg("lv-msg", e2.message, "err"); return; }
        await refreshLeaves();
      });
      td.appendChild(b);
    }
    tr.appendChild(td);
    body.appendChild(tr);
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
  initCorrectionForm();
  initPasswordCard();
  initLeaveCard();
  await refreshAll();
}
start();
