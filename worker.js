const MAX_BODY_SIZE = 16_384;
const MAX_AUTH_AGE = 60 * 60;
const encoder = new TextEncoder();
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }
    if (url.pathname === "/api/auth") {
      if (request.method !== "POST") {
        return json({ ok: false, error: "Method not allowed" }, 405);
      }
      if (!env.BOT_TOKEN) {
        return json({ ok: false, error: "Server configuration error" }, 500);
      }
      const contentType = request.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("application/json")) {
        return json({ ok: false, error: "Invalid content type" }, 415);
      }
      const declaredLength = Number(request.headers.get("content-length") || 0);
      if (declaredLength > MAX_BODY_SIZE) {
        return json({ ok: false, error: "Request too large" }, 413);
      }
      let body;
      try {
        const raw = await request.text();
        if (encoder.encode(raw).length > MAX_BODY_SIZE) {
          return json({ ok: false, error: "Request too large" }, 413);
        }
        body = JSON.parse(raw);
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }
      if (!body || typeof body.initData !== "string" || !body.initData) {
        return json({ ok: false, error: "Telegram initData is missing" }, 400);
      }
      try {
        const user = await validateTelegramInitData(
          body.initData,
          env.BOT_TOKEN
        );
        return json({
          ok: true,
          user: {
            id: user.id,
            first_name: user.first_name || "",
            last_name: user.last_name || "",
            full_name: [user.first_name, user.last_name]
              .filter(Boolean)
              .join(" "),
            username: user.username || null,
            language_code: user.language_code || null,
            is_premium: user.is_premium === true,
            allows_write_to_pm: user.allows_write_to_pm === true,
            photo_url: user.photo_url || null,
          },
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Authentication failed";
        const status =
          message === "Expired initData" ||
          message === "Invalid authentication data"
            ? 401
            : 400;
        return json({ ok: false, error: message }, status);
      }
    }
    if (url.pathname === "/health") {
      return json({ ok: true, service: "Telegram Mini App" });
    }
    if (url.pathname !== "/") {
      return new Response("Not found", {
        status: 404,
        headers: securityHeaders(),
      });
    }
    return new Response(HTML, {
      headers: {
        "content-type": "text/html; charset=UTF-8",
        "cache-control": "no-store",
        ...securityHeaders(),
      },
    });
  },
};
async function validateTelegramInitData(initData, botToken) {
  if (initData.length > 12_000) {
    throw new Error("Authentication data too large");
  }
  const params = new URLSearchParams(initData);
  const entries = [...params.entries()];
  // Reject duplicate fields to avoid ambiguous validation.
  const seen = new Set();
  for (const [key] of entries) {
    if (seen.has(key)) throw new Error("Invalid authentication data");
    seen.add(key);
  }
  const receivedHash = params.get("hash");
  const authDateString = params.get("auth_date");
  const userString = params.get("user");
  if (
    !receivedHash ||
    !/^[a-f0-9]{64}$/i.test(receivedHash) ||
    !authDateString ||
    !/^\d+$/.test(authDateString) ||
    !userString
  ) {
    throw new Error("Invalid authentication data");
  }
  const authDate = Number(authDateString);
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(authDate) ||
    authDate > now + 30 ||
    now - authDate > MAX_AUTH_AGE
  ) {
    throw new Error("Expired initData");
  }
  const dataCheckString = entries
    .filter(([key]) => key !== "hash" && key !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  // Telegram Mini App validation:
  // secret_key = HMAC_SHA256("WebAppData", bot_token)
  const secretKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const secret = await crypto.subtle.sign(
    "HMAC",
    secretKey,
    encoder.encode(botToken)
  );
  const validationKey = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const calculatedHash = bytesToHex(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        validationKey,
        encoder.encode(dataCheckString)
      )
    )
  );
  if (!constantTimeEqual(calculatedHash, receivedHash.toLowerCase())) {
    throw new Error("Invalid authentication data");
  }
  let user;
  try {
    user = JSON.parse(userString);
  } catch {
    throw new Error("Invalid user data");
  }
  if (
    !user ||
    typeof user !== "object" ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0
  ) {
    throw new Error("Invalid user data");
  }
  return user;
}
function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  const headers = {
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "vary": "Origin",
  };
  // Same-origin requests do not need CORS. Permit Telegram Web only
  // when cross-origin access is needed.
  if (/^https:\/\/web\.telegram\.org$/i.test(origin)) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}
function securityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy":
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://telegram.org; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' https: data:; " +
      "connect-src 'self'; " +
      "base-uri 'none'; form-action 'none';",
  };
}
const HTML = String.raw`<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#090b16">
  <title>Telegram Profile</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root {
      color-scheme: dark;
      --bg: #090b16;
      --panel: rgba(255,255,255,.055);
      --border: rgba(255,255,255,.11);
      --muted: #989bb6;
      --purple: #9b7bff;
      --blue: #55c7ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      min-height: 100dvh;
      padding: 24px 16px calc(24px + env(safe-area-inset-bottom));
      background:
        radial-gradient(ellipse at 15% 0%, rgba(110,65,255,.22), transparent 45%),
        radial-gradient(ellipse at 100% 70%, rgba(40,150,255,.12), transparent 40%),
        var(--bg);
      color: #f6f5ff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Tahoma, sans-serif;
    }
    .container { width: 100%; max-width: 480px; margin: 0 auto; }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 26px;
    }
    .brand { display: flex; align-items: center; gap: 11px; }
    .logo {
      display: grid;
      place-items: center;
      width: 42px;
      height: 42px;
      border: 1px solid rgba(255,255,255,.18);
      border-radius: 15px;
      background: linear-gradient(135deg, #8968ff, #3a8cff);
      font-size: 20px;
      font-weight: 900;
      box-shadow: 0 6px 30px rgba(113,86,255,.25);
    }
    .brand-title { font-weight: 800; letter-spacing: .3px; }
    .brand-subtitle { color: var(--muted); font-size: 11px; margin-top: 4px; }
    .status {
      padding: 7px 10px;
      border: 1px solid rgba(86,224,166,.22);
      border-radius: 20px;
      color: #70e8b0;
      background: rgba(86,224,166,.07);
      font-size: 11px;
    }
    .hero {
      position: relative;
      overflow: hidden;
      padding: 27px 20px 23px;
      text-align: center;
      border: 1px solid var(--border);
      border-radius: 26px;
      background: linear-gradient(145deg, rgba(255,255,255,.085), rgba(255,255,255,.025));
      box-shadow: 0 20px 65px rgba(0,0,0,.22);
      backdrop-filter: blur(18px);
    }
    .hero::before {
      content: "";
      position: absolute;
      width: 180px;
      height: 180px;
      top: -120px;
      left: calc(50% - 90px);
      border-radius: 50%;
      background: rgba(133,96,255,.3);
      filter: blur(45px);
      pointer-events: none;
    }
    .avatar {
      position: relative;
      width: 100px;
      height: 100px;
      display: grid;
      place-items: center;
      margin: 0 auto 16px;
      border-radius: 32px;
      border: 2px solid rgba(255,255,255,.2);
      background: linear-gradient(135deg, #8968ff, #39a7ff);
      box-shadow: 0 10px 36px rgba(112,91,255,.3);
      font-size: 36px;
      font-weight: 800;
      object-fit: cover;
    }
    .name { margin: 0; font-size: 23px; font-weight: 800; overflow-wrap: anywhere; }
    .username { color: var(--muted); margin-top: 7px; font-size: 13px; direction: ltr; }
    .badges { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; margin-top: 17px; }
    .badge {
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 7px 11px;
      background: rgba(255,255,255,.04);
      color: #c7c4e4;
      font-size: 11px;
    }
    .badge.premium {
      border-color: rgba(255,202,95,.25);
      color: #ffd77a;
      background: rgba(255,202,95,.07);
    }
    .section-title { margin: 25px 2px 12px; font-size: 13px; font-weight: 700; color: #c8c5e5; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .item {
      min-width: 0;
      padding: 15px 14px;
      border: 1px solid var(--border);
      border-radius: 17px;
      background: var(--panel);
    }
    .label { color: var(--muted); font-size: 11px; margin-bottom: 10px; }
    .value { font-size: 14px; font-weight: 700; overflow-wrap: anywhere; direction: ltr; text-align: right; }
    .wide { grid-column: 1 / -1; }
    button {
      width: 100%;
      margin-top: 18px;
      padding: 15px;
      border: 0;
      border-radius: 15px;
      color: white;
      background: linear-gradient(100deg, #795cff, #438eff);
      font: inherit;
      font-weight: 800;
      cursor: pointer;
      box-shadow: 0 8px 26px rgba(95,91,255,.2);
    }
    button:active { transform: scale(.99); }
    button:disabled { opacity: .5; cursor: default; }
    .message {
      margin-top: 14px;
      padding: 13px;
      border: 1px solid var(--border);
      border-radius: 13px;
      background: rgba(255,255,255,.04);
      color: #b8b8d2;
      text-align: center;
      font-size: 12px;
      line-height: 1.8;
      overflow-wrap: anywhere;
    }
    .message.error { color: #ff9fba; border-color: rgba(255,90,130,.22); }
    .footer { text-align: center; color: #696b87; font-size: 10px; margin-top: 24px; }
    .hidden { display: none !important; }
    .loading { opacity: .7; }
  </style>
</head>
<body>
  <main class="container">
    <header class="header">
      <div class="brand">
        <div class="logo">B</div>
        <div>
          <div class="brand-title">BEGAIL</div>
          <div class="brand-subtitle">TELEGRAM MINI APP</div>
        </div>
      </div>
      <div class="status">● Secure session</div>
    </header>
    <section class="hero">
      <img id="avatar" class="avatar hidden" alt="Profile photo" referrerpolicy="no-referrer">
      <div id="avatarFallback" class="avatar">?</div>
      <h1 id="name" class="name">در حال اتصال...</h1>
      <div id="username" class="username">@telegram</div>
      <div class="badges">
        <span id="premiumBadge" class="badge premium hidden">✦ Telegram Premium</span>
        <span id="verifiedBadge" class="badge">✓ تأیید اطلاعات از تلگرام</span>
      </div>
    </section>
    <div class="section-title">اطلاعات حساب</div>
    <section class="grid">
      <div class="item">
        <div class="label">Telegram User ID</div>
        <div id="userId" class="value">—</div>
      </div>
      <div class="item">
        <div class="label">Language</div>
        <div id="language" class="value">—</div>
      </div>
      <div class="item">
        <div class="label">Account Type</div>
        <div id="accountType" class="value">—</div>
      </div>
      <div class="item">
        <div class="label">Telegram Platform</div>
        <div id="platform" class="value">—</div>
      </div>
      <div class="item wide">
        <div class="label">Mini App Version</div>
        <div id="version" class="value">—</div>
      </div>
    </section>
    <button id="copyButton" disabled>کپی کردن شناسه کاربری</button>
    <div id="message" class="message">در حال بررسی نشست امن تلگرام...</div>
    <div class="footer">BEGAIL DEVELOPMENT · Telegram Web Apps</div>
  </main>
  <script>
    (() => {
      "use strict";
      const $ = (id) => document.getElementById(id);
      const tg = window.Telegram && window.Telegram.WebApp;
      let currentUserId = null;
      if (tg) {
        try {
          tg.ready();
          tg.expand();
          if (tg.setHeaderColor) tg.setHeaderColor("#090b16");
          if (tg.setBackgroundColor) tg.setBackgroundColor("#090b16");
        } catch (_) {}
      }
      $("platform").textContent = tg && tg.platform ? tg.platform : "Browser";
      $("version").textContent = tg && tg.version ? tg.version : "Unavailable";
      function showMessage(text, isError = false) {
        $("message").textContent = text;
        $("message").classList.toggle("error", isError);
      }
      function showUser(user) {
        currentUserId = user.id;
        const fullName = user.full_name || "Telegram User";
        $("name").textContent = fullName;
        $("username").textContent = user.username
          ? "@" + user.username
          : "نام کاربری تنظیم نشده";
        $("userId").textContent = String(user.id);
        $("language").textContent = user.language_code || "نامشخص";
        $("accountType").textContent = user.is_premium ? "Premium" : "Standard";
        if (user.is_premium) $("premiumBadge").classList.remove("hidden");
        if (user.photo_url) {
          $("avatar").src = user.photo_url;
          $("avatar").classList.remove("hidden");
          $("avatarFallback").classList.add("hidden");
          $("avatar").onerror = () => {
            $("avatar").classList.add("hidden");
            $("avatarFallback").classList.remove("hidden");
          };
        } else {
          $("avatarFallback").textContent =
            Array.from(fullName)[0] || "?";
        }
        $("copyButton").disabled = false;
        showMessage("اطلاعات حساب با موفقیت تأیید شد.");
      }
      async function authenticate() {
        if (!tg || !tg.initData) {
          $("name").textContent = "Mini App باز نشده";
          $("username").textContent = "Telegram initData در دسترس نیست";
          showMessage(
            "این صفحه را از دکمه Web App داخل ربات تلگرام باز کن؛ باز کردن مستقیم لینک در مرورگر کافی نیست.",
            true
          );
          return;
        }
        $("message").classList.add("loading");
        try {
          const response = await fetch("/api/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            body: JSON.stringify({ initData: tg.initData }),
          });
          const result = await response.json();
          if (!response.ok || !result.ok || !result.user) {
            throw new Error(result.error || "احراز هویت ناموفق بود.");
          }
          showUser(result.user);
        } catch (error) {
          $("name").textContent = "اتصال ناموفق";
          $("username").textContent = "اطلاعات حساب دریافت نشد";
          showMessage(error.message || "خطای ناشناخته", true);
        } finally {
          $("message").classList.remove("loading");
        }
      }
      $("copyButton").addEventListener("click", async () => {
        if (!currentUserId) return;
        try {
          await navigator.clipboard.writeText(String(currentUserId));
          $("copyButton").textContent = "✓ شناسه کپی شد";
          if (tg && tg.HapticFeedback) {
            tg.HapticFeedback.notificationOccurred("success");
          }
          setTimeout(() => {
            $("copyButton").textContent = "کپی کردن شناسه کاربری";
          }, 1800);
        } catch (_) {
          showMessage("کپی خودکار انجام نشد؛ شناسه را دستی کپی کن.", true);
        }
      });
      authenticate();
    })();
  </script>
</body>
</html>`;