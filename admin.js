"use strict";

const cfg = window.APP_CONFIG || {};
const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

const STATUS_TEXT = { none: "未出勤", working: "勤務中", on_break: "休憩中", done: "退勤済み" };
const NEXT_STATUS = { clock_in: "working", break_start: "on_break", break_end: "working", clock_out: "done" };

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

// 時間外労働の開始時刻(日本時間)。これを過ぎた分が「時間外」になる
const OT_START = cfg.OVERTIME_START || "19:00";
function overtimeMin(day, cinTs, coutTs) {
  const s = new Date(day + "T" + OT_START + ":00+09:00").getTime();
  const a = Math.max(s, new Date(cinTs).getTime());
  const b = new Date(coutTs).getTime();
  return Math.max(0, (b - a) / 60000);
}

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
  let otMin = null;
  if (cin && cout) {
    otMin = overtimeMin(sorted[0].work_date, cin.occurred_at, cout.occurred_at);
    breakMin = breakOverlapMin(sorted[0].work_date, cin.occurred_at, cout.occurred_at); // 休憩の時間帯と重なった分を引く
    workMin = (new Date(cout.occurred_at) - new Date(cin.occurred_at)) / 60000 - breakMin;
  }
  const status = sorted.length ? NEXT_STATUS[sorted[sorted.length - 1].event_type] : "none";
  const incomplete = sorted.length > 0 && (!cin || !cout || bs !== null);
  return { cin, cout, bsEv, beEv, breakMin, workMin, otMin, status, incomplete };
}

const TYPE_TEXT = { clock_in: "出勤", clock_out: "退勤" };
// 1日の状況の文字と色(過去の日の欠け・勤務が短すぎる・修正あり)
function dayFlag(evs, s, isPast) {
  if (isPast && s.incomplete) {
    if (!s.cin) return { text: "出勤なし", cls: "flag" };
    if (!s.cout) return { text: "退勤なし", cls: "flag" };
    return { text: "打刻漏れ", cls: "flag" };
  }
  if (s.workMin != null && s.workMin < 30) return { text: "要確認(勤務が短い)", cls: "flag" };
  if (evs.some((e) => e.source === "correction")) return { text: "修正あり", cls: "" };
  return null;
}

// ---- データ取得 ----
async function loadEvents(fromDay, toDay) {
  const { data, error } = await db
    .from("attendance_events")
    .select("user_id, event_type, occurred_at, work_date, source")
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

// ---- QR表示の状態(管理画面の「本日」に出す) ----
async function updateQrStatus() {
  const el = $("qr-status");
  if (!el) return;
  try {
    const { data, error } = await db.rpc("qr_status");
    if (error) throw error;
    if (data && data.seconds_ago != null && data.seconds_ago <= 75) {
      el.className = "qrs ok";
      el.textContent = "QR表示:正常(" + data.seconds_ago + "秒前に更新)";
    } else {
      el.className = "qrs ng";
      el.textContent = data && data.last_issued
        ? "QR表示:停止中です(最後の更新 " + jstDate(data.last_issued).slice(5).replace("-", "/") + " " + jstTime(data.last_issued) + ")。院内のタブレットをご確認ください。"
        : "QR表示:停止中です(直近の記録がありません)。院内のタブレットをご確認ください。";
    }
  } catch (e) {
    el.className = "qrs";
    el.textContent = "QR表示:状態を確認できませんでした";
  }
}
setInterval(() => { if (currentTab === "today" && document.visibilityState === "visible") updateQrStatus(); }, 15000);

// ---- 画面: 本日 ----
async function renderToday() {
  const day = todayJst();
  const map = await loadEvents(day, day);
  const counts = { none: 0, working: 0, done: 0 };
  const tbody = $("today-body");
  tbody.replaceChildren();
  tbody.dataset.leftFirst = "1";
  for (const p of staff) {
    const s = dayStats((map[p.id] && map[p.id][day]) || []);
    counts[s.status === "on_break" ? "working" : s.status] += 1;
    const noIn = !s.cin && s.status === "done";
    addRow(tbody, [
      staffName(p),
      noIn ? { text: "退勤済み(出勤なし)", cls: "flag" } : STATUS_TEXT[s.status],
      s.cin ? jstTime(s.cin.occurred_at) : "",
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
    const evs = (map[p.id] && map[p.id][day]) || [];
    const s = dayStats(evs);
    let state = STATUS_TEXT[s.status];
    let cls = "";
    const fl = dayFlag(evs, s, isPast);
    if (fl) { state = fl.text; cls = fl.cls; }
    addRow(tbody, [
      staffName(p),
      s.cin ? jstTime(s.cin.occurred_at) : "",
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
    let days = 0, total = 0, ot = 0, missing = 0;
    const byDay = map[p.id] || {};
    for (const d of Object.keys(byDay)) {
      const s = dayStats(byDay[d]);
      if (s.cin) days += 1;
      if (s.workMin != null) { total += Math.round(s.workMin); ot += Math.round(s.otMin); }
      if (s.incomplete && d < today) missing += 1;
    }
    addRow(sum, [
      staffName(p),
      days + "日",
      fmtMinutes(total),
      fmtMinutes(ot),
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
    detail.firstChild.firstChild.colSpan = 7;
    return;
  }
  for (const d of days) {
    const s = dayStats(byDay[d]);
    const fl = dayFlag(byDay[d], s, d < today);
    addRow(detail, [
      Number(d.slice(8)) + "日",
      s.cin ? jstTime(s.cin.occurred_at) : "",
      s.cout ? jstTime(s.cout.occurred_at) : "",
      fmtMinutes(s.breakMin),
      fmtMinutes(s.workMin),
      s.workMin == null ? "" : fmtMinutes(Math.round(s.otMin)),
      { text: fl ? fl.text : "", cls: fl ? fl.cls : "" },
    ]);
  }
}

// ---- 画面: 修正申請 ----
function nameOf(id) {
  const p = staff.find((x) => x.id === id);
  return p ? staffName(p) : "(不明)";
}
function shortDate(d) { return d.slice(5).replace("-", "/"); }
function cell(tr, text, cls) {
  const td = document.createElement("td");
  td.textContent = text == null ? "" : text;
  if (cls) td.className = cls;
  tr.appendChild(td);
  return td;
}
async function updateCorrBadge() {
  const { count, error } = await db.from("correction_requests").select("id", { count: "exact", head: true }).eq("status", "pending");
  const b = $("corr-badge");
  if (error || !count) { b.classList.add("hidden"); return; }
  b.textContent = String(count);
  b.classList.remove("hidden");
}
async function decide(id, approve, time) {
  let note = null;
  if (!approve) {
    note = prompt("却下の理由(スタッフに表示されます。空欄でも構いません)");
    if (note === null) return;
  } else if (!confirm("この内容で承認して、記録に反映します。よろしいですか?")) {
    return;
  }
  setMsg("app-msg", "");
  const { error } = await db.rpc("decide_correction", { p_id: id, p_approve: approve, p_time: time || null, p_note: note });
  if (error) { setMsg("app-msg", error.message); return; }
  await renderCorr();
}
async function renderCorr() {
  const { data: pend, error: e1 } = await db
    .from("correction_requests")
    .select("id, user_id, work_date, event_type, requested_time, reason")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(100);
  if (e1) throw e1;
  const pb = $("corr-pending");
  pb.replaceChildren();
  if (!pend || !pend.length) {
    const tr = document.createElement("tr");
    const td = cell(tr, "申請中のものはありません");
    td.colSpan = 6;
    pb.appendChild(tr);
  }
  for (const r of pend || []) {
    const tr = document.createElement("tr");
    cell(tr, nameOf(r.user_id), "left");
    cell(tr, shortDate(r.work_date));
    cell(tr, TYPE_TEXT[r.event_type]);
    const tdTime = document.createElement("td");
    const ti = document.createElement("input");
    ti.type = "time";
    ti.value = (r.requested_time || "").slice(0, 5);
    tdTime.appendChild(ti);
    tr.appendChild(tdTime);
    cell(tr, r.reason, "wrap");
    const tdAct = document.createElement("td");
    const ok = document.createElement("button");
    ok.className = "sm ok"; ok.textContent = "承認";
    ok.addEventListener("click", () => decide(r.id, true, ti.value));
    const ng = document.createElement("button");
    ng.className = "sm ng"; ng.textContent = "却下";
    ng.addEventListener("click", () => decide(r.id, false, null));
    tdAct.append(ok, ng);
    tr.appendChild(tdAct);
    pb.appendChild(tr);
  }

  const { data: done, error: e2 } = await db
    .from("correction_requests")
    .select("user_id, work_date, event_type, requested_time, final_time, status, decided_by, decision_note")
    .neq("status", "pending")
    .order("decided_at", { ascending: false })
    .limit(30);
  if (e2) throw e2;
  const dbody = $("corr-done");
  dbody.replaceChildren();
  if (!done || !done.length) {
    const tr = document.createElement("tr");
    const td = cell(tr, "処理済みのものはありません");
    td.colSpan = 6;
    dbody.appendChild(tr);
  }
  for (const r of done || []) {
    const tr = document.createElement("tr");
    cell(tr, nameOf(r.user_id), "left");
    cell(tr, shortDate(r.work_date));
    cell(tr, TYPE_TEXT[r.event_type]);
    cell(tr, (r.final_time || r.requested_time || "").slice(0, 5));
    cell(tr, r.status === "approved" ? "承認" : "却下" + (r.decision_note ? "(" + r.decision_note + ")" : ""), "st-" + r.status);
    cell(tr, r.decided_by ? nameOf(r.decided_by) : "", "left");
    dbody.appendChild(tr);
  }
  await updateCorrBadge();
}
let adding = false;
$("add-btn").addEventListener("click", async () => {
  if (adding) return;
  const uid = $("add-staff").value, day = $("add-date").value, type = $("add-type").value, time = $("add-time").value, note = $("add-note").value.trim();
  if (!uid || !day || !time) { setMsg("add-msg", "スタッフ・日付・時刻を入力してください。"); $("add-msg").className = "msg err"; return; }
  if (!note) { setMsg("add-msg", "理由を入力してください。"); $("add-msg").className = "msg err"; return; }
  if (!confirm(nameOf(uid) + " さんの " + day.replace(/-/g, "/") + " の" + TYPE_TEXT[type] + "を " + time + " として追加します。よろしいですか?")) return;
  adding = true;
  setMsg("add-msg", "送信中…"); $("add-msg").className = "msg";
  const { error } = await db.rpc("admin_add_event", { p_user: uid, p_date: day, p_type: type, p_time: time, p_note: note });
  adding = false;
  if (error) { setMsg("add-msg", error.message); $("add-msg").className = "msg err"; return; }
  setMsg("add-msg", "追加しました。"); $("add-msg").className = "msg";
  $("add-note").value = ""; $("add-time").value = "";
});

// ---- タブ ----
let currentTab = "today";
async function showTab(name) {
  currentTab = name;
  for (const t of ["today", "day", "month", "corr"]) {
    $("tab-" + t).classList.toggle("hidden", t !== name);
  }
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  await refresh();
}
async function refresh() {
  setMsg("app-msg", "");
  try {
    if (currentTab === "today") { updateQrStatus(); await renderToday(); }
    if (currentTab === "day") await renderDay();
    if (currentTab === "month") await renderMonth();
    if (currentTab === "corr") await renderCorr(); else updateCorrBadge();
  } catch (e) {
    console.error(e);
    setMsg("app-msg", "データを読み込めませんでした。通信状況をご確認ください。" + (e && e.message ? "(" + e.message + ")" : ""));
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
// ---- バックアップ(全記録をCSVで保存) ----
const BK_KEY = "kintai_last_backup";
function bkLast() { try { return localStorage.getItem(BK_KEY); } catch (e) { return null; } }
function updateBackupStatus() {
  const el = $("bk-status");
  if (!el) return;
  const last = bkLast();
  if (!last) { el.className = "qrs ng"; el.textContent = "最後のバックアップ:この端末では記録がありません"; return; }
  const days = Math.floor((new Date(todayJst() + "T00:00:00Z") - new Date(last + "T00:00:00Z")) / 86400000);
  el.className = days > 7 ? "qrs ng" : "qrs ok";
  el.textContent = "最後のバックアップ:" + last + "(" + (days <= 0 ? "きょう" : days + "日前") + ")" + (days > 7 ? " 1週間以上たっています" : "");
}
function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
async function downloadBackup() {
  const btn = $("bk-btn");
  btn.disabled = true;
  setMsg("bk-msg", "読み込み中…");
  try {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("attendance_events")
        .select("id, user_id, event_type, occurred_at, work_date, source, note")
        .order("id", { ascending: true })
        .range(from, from + 999);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const names = {};
    for (const p of staff) names[p.id] = staffName(p);
    const kind = { clock_in: "出勤", clock_out: "退勤", break_start: "休憩開始", break_end: "休憩終了" };
    const lines = [["ID", "スタッフ", "日付", "種類", "時刻(日本時間)", "作り方", "メモ"].map(csvCell).join(",")];
    for (const e of rows) {
      lines.push([
        e.id, names[e.user_id] || e.user_id, e.work_date, kind[e.event_type] || e.event_type,
        jstDate(e.occurred_at) + " " + jstTime(e.occurred_at),
        e.source === "correction" ? "修正" : "打刻", e.note || ""
      ].map(csvCell).join(","));
    }
    const blob = new Blob(["\uFEFF" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "kintai_backup_" + todayJst().replace(/-/g, "") + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    try { localStorage.setItem(BK_KEY, todayJst()); } catch (e) {}
    updateBackupStatus();
    setMsg("bk-msg", rows.length + "件を保存しました。ダウンロードのフォルダを確認してください。");
  } catch (e) {
    setMsg("bk-msg", "失敗しました: " + (e.message || e));
  } finally {
    btn.disabled = false;
  }
}
$("bk-btn").addEventListener("click", downloadBackup);

// ---- 月別CSV(給与計算用) ----
function saveCsv(filename, lines) {
  const blob = new Blob(["\uFEFF" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function downloadMonthCsv(kind) {
  setMsg("csv-msg", "読み込み中…");
  try {
    const { year, month } = targetMonth();
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const first = year + "-" + pad(month) + "-01", last = year + "-" + pad(month) + "-" + pad(lastDay);
    const map = await loadEvents(first, last);
    const today = todayJst();
    const ym = year + "-" + pad(month);
    const lines = [];
    if (kind === "sum") {
      lines.push(["対象月", "スタッフ", "出勤日数", "勤務時間(分)", "勤務時間(時:分)", "勤務時間(時間・小数)", "うち時間外(分)", "うち時間外(時:分)", "打刻漏れ(件)"].map(csvCell).join(","));
      for (const p of staff) {
        let days = 0, total = 0, ot = 0, missing = 0;
        const byDay = map[p.id] || {};
        for (const d of Object.keys(byDay)) {
          const s = dayStats(byDay[d]);
          if (s.cin) days += 1;
          if (s.workMin != null) { total += Math.round(s.workMin); ot += Math.round(s.otMin); }
          if (s.incomplete && d < today) missing += 1;
        }
        lines.push([ym, staffName(p), days, total, fmtMinutes(total), (total / 60).toFixed(2), ot, fmtMinutes(ot), missing].map(csvCell).join(","));
      }
    } else {
      lines.push(["スタッフ", "日付", "出勤", "退勤", "休憩(分)", "勤務時間(分)", "勤務時間(時:分)", "うち時間外(分)", "状況"].map(csvCell).join(","));
      for (const p of staff) {
        const byDay = map[p.id] || {};
        for (const d of Object.keys(byDay).sort()) {
          const s = dayStats(byDay[d]);
          const fl = dayFlag(byDay[d], s, d < today);
          const w = s.workMin == null ? "" : Math.round(s.workMin);
          lines.push([
            staffName(p), d, s.cin ? jstTime(s.cin.occurred_at) : "", s.cout ? jstTime(s.cout.occurred_at) : "",
            s.workMin == null ? "" : Math.round(s.breakMin), w, s.workMin == null ? "" : fmtMinutes(s.workMin), s.workMin == null ? "" : Math.round(s.otMin), fl ? fl.text : ""
          ].map(csvCell).join(","));
        }
      }
    }
    saveCsv("kintai_" + (kind === "sum" ? "goukei_" : "meisai_") + ym.replace("-", "") + ".csv", lines);
    setMsg("csv-msg", year + "年" + month + "月の" + (kind === "sum" ? "合計" : "日別明細") + "を保存しました。");
  } catch (e) {
    setMsg("csv-msg", "失敗しました: " + (e.message || e));
  }
}
$("csv-sum").addEventListener("click", () => downloadMonthCsv("sum"));
$("csv-detail").addEventListener("click", () => downloadMonthCsv("detail"));

async function start() {
  const { data } = await db.auth.getSession();
  if (!data.session) { show("login"); return; }
  const { data: me } = await db.from("profiles").select("role").eq("id", data.session.user.id).maybeSingle();
  if (!me || me.role !== "admin") {
    await db.auth.signOut({ scope: "local" }); // 他の端末のログインは切らない
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
  const addSel = $("add-staff");
  addSel.replaceChildren();
  for (const p of staff) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = staffName(p);
    addSel.appendChild(o);
  }
  $("add-date").value = todayJst();
  $("add-date").max = todayJst();
  $("day-input").value = todayJst();
  updateBackupStatus();
  show("app");
  await showTab("today");
}
start();
