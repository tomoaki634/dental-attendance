"use strict";

const cfg = window.APP_CONFIG || {};
const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

const INTERVAL_MS = 30 * 1000;   // QRを切り替える間隔
const VALID_MS = 45 * 1000;      // サーバー側の有効期限(30秒+読み取りの余裕15秒)

// スタッフ用の画面のアドレス(この画面の場所から作る)
const BASE = location.origin + location.pathname.replace(/[^/]*$/, "");

let currentToken = null;
let issuedAt = 0;       // 最後にQRを発行できた時刻
let lastTry = 0;        // 最後に発行を試した時刻
let inFlight = false;
let ticking = null;
let wakeLock = null;

function show(view) {
  $("login-view").classList.toggle("hidden", view !== "login");
  $("qr-view").classList.toggle("hidden", view !== "qr");
}

// ---- QRコードの描画 ----
function drawQr() {
  const box = $("qr");
  box.replaceChildren();
  if (!currentToken) return;
  const size = Math.max(200, Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.6));
  new window.QRCode(box, {
    text: BASE + "#q=" + currentToken,
    width: size,
    height: size,
    colorDark: "#000000",
    colorLight: "#ffffff",
    correctLevel: window.QRCode.CorrectLevel.M,
  });
}

// ---- 新しいQRコードをサーバーから受け取る ----
async function issue() {
  inFlight = true;
  lastTry = Date.now();
  try {
    const { data, error } = await db.rpc("issue_qr");
    if (error) throw error;
    currentToken = data.token;
    issuedAt = Date.now();
    drawQr();
    $("qr-msg").textContent = "";
  } catch (e) {
    const msg = (e && e.message) || "";
    if (msg.indexOf("QR表示用") >= 0) {
      await db.auth.signOut();
      stop();
      show("login");
      $("login-msg").textContent = "このアカウントは、QR表示用ではありません。";
      return;
    }
    $("qr-msg").textContent = "通信できません。再接続を待っています…";
    if (Date.now() - issuedAt > VALID_MS) {
      currentToken = null;
      $("qr").replaceChildren();
    }
  } finally {
    inFlight = false;
  }
}

// ---- 1秒ごとの確認 ----
function tick() {
  const now = Date.now();
  const elapsed = now - issuedAt;
  if ((issuedAt === 0 || elapsed >= INTERVAL_MS) && !inFlight && now - lastTry >= 4000) {
    issue();
  }
  const remain = issuedAt === 0 ? 0 : Math.max(0, Math.ceil((INTERVAL_MS - elapsed) / 1000));
  $("count").textContent = currentToken ? "あと " + remain + " 秒で切り替わります" : "";
  $("bar-fill").style.width = (issuedAt === 0 ? 0 : Math.max(0, 100 - (elapsed / INTERVAL_MS) * 100)) + "%";
}

function start() {
  show("qr");
  issuedAt = 0;
  currentToken = null;
  if (ticking) clearInterval(ticking);
  ticking = setInterval(tick, 1000);
  tick();
  requestWake();
}
function stop() {
  if (ticking) clearInterval(ticking);
  ticking = null;
  currentToken = null;
  $("qr").replaceChildren();
}

// ---- 画面を消さない(対応している端末のみ) ----
async function requestWake() {
  try {
    if (navigator.wakeLock && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch (e) { /* 対応していない端末では何もしない */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && ticking) requestWake();
});
window.addEventListener("resize", () => { if (currentToken) drawQr(); });

// ---- ログイン ----
$("login-btn").addEventListener("click", async () => {
  $("login-msg").textContent = "";
  const { error } = await db.auth.signInWithPassword({
    email: $("email").value.trim(),
    password: $("password").value,
  });
  if (error) {
    $("login-msg").textContent = "ログインできませんでした。メールアドレスとパスワードをご確認ください。";
    return;
  }
  $("password").value = "";
  start();
});
(async function init() {
  const { data } = await db.auth.getSession();
  if (data && data.session) start(); else show("login");
})();
