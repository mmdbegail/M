const HTML = String.raw`

<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0915">
<title>Identity | Telegram</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{color-scheme:dark;--purple:#a78bfa;--muted:#9994ad;--border:rgba(255,255,255,.09)}
body{min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Tahoma,sans-serif;background:radial-gradient(ellipse at 90% 0%,rgba(126,87,255,.19),transparent 45%),radial-gradient(ellipse at 0% 100%,rgba(80,65,200,.13),transparent 40%),#0b0915;color:white;padding:25px 18px}
.container{max-width:440px;margin:auto}
.header{display:flex;justify-content:space-between;align-items:center;margin:12px 0 30px}
.brand{font-size:15px;font-weight:800}
.badge{font-size:10px;color:#c4b5fd;background:rgba(167,139,250,.12);border:1px solid rgba(167,139,250,.2);padding:7px 10px;border-radius:30px}
.profile{text-align:center;padding:27px 20px 24px;border:1px solid var(--border);background:linear-gradient(145deg,rgba(255,255,255,.075),rgba(255,255,255,.025));border-radius:25px;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);box-shadow:0 20px 70px rgba(0,0,0,.18)}
.avatar{width:94px;height:94px;border-radius:30px;margin:0 auto 18px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#8b5cf6,#4f46e5);border:1px solid rgba(255,255,255,.2);box-shadow:0 10px 35px rgba(124,58,237,.28);font-size:35px;font-weight:800;overflow:hidden}
.avatar img{width:100%;height:100%;object-fit:cover}
.name{font-size:23px;font-weight:800;overflow-wrap:anywhere}
.username{font-size:13px;color:var(--muted);margin-top:8px}
.status{display:inline-flex;align-items:center;gap:7px;margin-top:17px;padding:7px 11px;border-radius:30px;font-size:11px;color:#86efac;background:rgba(34,197,94,.09);border:1px solid rgba(34,197,94,.16)}
.dot{width:6px;height:6px;border-radius:50%;background:#4ade80}
.section-title{margin:27px 2px 13px;font-size:12px;font-weight:700;color:var(--muted)}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:11px}
.info{padding:17px 15px;background:rgba(255,255,255,.055);border:1px solid var(--border);border-radius:17px;min-width:0}
.label{font-size:11px;color:var(--muted);margin-bottom:11px}
.value{font-size:14px;font-weight:700;overflow-wrap:anywhere}
.id-card{margin-top:11px;padding:17px;background:rgba(255,255,255,.055);border:1px solid var(--border);border-radius:17px;display:flex;justify-content:space-between;align-items:center;gap:12px}
.id-number{font-size:17px;font-weight:800;direction:ltr;overflow-wrap:anywhere}
button{font-family:inherit;cursor:pointer}
.copy{flex-shrink:0;border:1px solid rgba(167,139,250,.2);background:rgba(167,139,250,.12);color:#c4b5fd;border-radius:10px;padding:10px 13px;font-size:11px}
.note{margin-top:20px;padding:14px;border:1px solid var(--border);border-radius:14px;color:var(--muted);font-size:11px;line-height:2}
.footer{text-align:center;color:#625d76;font-size:10px;margin:24px 0 10px}
#error{margin-top:30px;text-align:center;padding:22px;color:#fca5a5;line-height:2;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:16px;overflow-wrap:anywhere}
.hidden{display:none!important}
@media(max-width:350px){body{padding:16px 12px}.info-grid{gap:8px}.info{padding:13px 11px}}
</style>
</head>
<body>
<div class="container">
<header class="header">
<div class="brand">IDENTITY<span style="color:#a78bfa">.</span></div>
<div class="badge">TELEGRAM MINI APP</div>
</header>
<main id="app" class="hidden">
<section class="profile">
<div class="avatar" id="avatar">?</div>
<div class="name" id="name">—</div>
<div class="username" id="username">—</div>
<div class="status"><span class="dot"></span> اطلاعات حساب تأیید شد</div>
</section>
<div class="section-title">اطلاعات حساب</div>
<section class="info-grid">
<div class="info"><div class="label">نام</div><div class="value" id="firstName">—</div></div>
<div class="info"><div class="label">نام خانوادگی</div><div class="value" id="lastName">—</div></div>
<div class="info"><div class="label">زبان تلگرام</div><div class="value" id="language">—</div></div>
<div class="info"><div class="label">تلگرام پریمیوم</div><div class="value" id="premium">—</div></div>
<div class="info"><div class="label">پلتفرم</div><div class="value" id="platform">—</div></div>
<div class="info"><div class="label">نسخه WebApp</div><div class="value" id="version">—</div></div>
</section>
<div class="section-title">شناسه کاربری</div>
<section class="id-card">
<div style="min-width:0"><div class="label">Telegram User ID</div><div class="id-number" id="userId">—</div></div>
<button class="copy" id="copyButton">کپی شناسه</button>
</section>
<div class="note">اطلاعات کاربر پس از تأیید امضای داده‌های تلگرام در سمت سرور نمایش داده می‌شود. این برنامه شماره تلفن یا رمز عبور شما را دریافت نمی‌کند.</div>
</main>
<div id="error" class="hidden"></div>
<footer class="footer">IDENTITY SYSTEM · CLOUDFLARE WORKERS</footer>
</div>
<script>
(async function(){
  const tg = window.Telegram && window.Telegram.WebApp;
  const app = document.getElementById('app');
  const errorBox = document.getElementById('error');

function fail(message){
errorBox.textContent = message;
errorBox.classList.remove(‘hidden’);
}

function set(id,value){
document.getElementById(id).textContent =
value === undefined || value === null || value === ‘’ ? ‘—’ : String(value);
}

if(!tg){
fail(‘Telegram WebApp SDK بارگذاری نشد. اتصال اینترنت را بررسی کن.’);
return;
}

tg.ready();
tg.expand();

const initData = tg.initData || ‘’;

if(!initData){
fail(‘تلگرام داده احراز هویت ارسال نکرده است. مینی‌اپ را از داخل تلگرام باز کن.’);
return;
}

try{
const response = await fetch(’/api/auth’, {
method: ‘POST’,
headers: {‘Content-Type’:‘application/json’},
body: JSON.stringify({initData})
});

const result = await response.json();
if(!response.ok || !result.ok || !result.user){
  fail(result.error || 'اعتبارسنجی اطلاعات کاربر ناموفق بود.');
  return;
}
const user = result.user;
const fullName = [user.first_name,user.last_name].filter(Boolean).join(' ');
set('name',fullName || 'Telegram User');
set('username',user.username ? '@'+user.username : 'یوزرنیم تنظیم نشده');
set('firstName',user.first_name);
set('lastName',user.last_name);
set('language',user.language_code);
set('premium',user.is_premium ? 'فعال ✓' : 'فعال نیست');
set('platform',tg.platform);
set('version',tg.version);
set('userId',user.id);
const avatar = document.getElementById('avatar');
avatar.textContent = (user.first_name || '?').charAt(0).toUpperCase();
if(user.photo_url){
  const img = new Image();
  img.alt = 'Profile';
  img.referrerPolicy = 'no-referrer';
  img.onload = ()=>{avatar.textContent='';avatar.appendChild(img)};
  img.src = user.photo_url;
}
document.getElementById('copyButton').addEventListener('click',async function(){
  try{
    await navigator.clipboard.writeText(String(user.id));
    this.textContent = 'کپی شد ✓';
  }catch(e){
    this.textContent = String(user.id);
  }
  const button=this;
  setTimeout(()=>button.textContent='کپی شناسه',1800);
});
app.classList.remove('hidden');

}catch(e){
fail(‘ارتباط با سرور برقرار نشد. صفحه را دوباره باز کن.’);
}
})();
</body>
</html>`;

async function validateTelegramInitData(initData, botToken) {
if (typeof initData !== “string” || !initData || initData.length > 16384) {
return null;
}

const params = new URLSearchParams(initData);
const receivedHash = params.get(“hash”);

if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
return null;
}

// Reject duplicate security-critical fields.
if (params.getAll(“hash”).length !== 1 ||
params.getAll(“auth_date”).length !== 1 ||
params.getAll(“user”).length !== 1) {
return null;
}

const authDate = Number(params.get(“auth_date”));
const now = Math.floor(Date.now() / 1000);

// Only accept recently issued authentication data.
if (!Number.isSafeInteger(authDate) || authDate > now + 30 || now - authDate > 3600) {
return null;
}

const entries = [];
for (const [key, value] of params.entries()) {
if (key !== “hash”) entries.push([key, value]);
}

entries.sort(([a], [b]) => a.localeCompare(b));

const dataCheckString = entries
.map(([key, value]) => ${key}=${value})
.join(”\n”);

const encoder = new TextEncoder();

// Telegram Mini Apps: secret_key = HMAC_SHA256(key=“WebAppData”, message=bot_token)
const secretKey = await crypto.subtle.importKey(
“raw”,
encoder.encode(“WebAppData”),
{ name: “HMAC”, hash: “SHA-256” },
false,
[“sign”]
);

const secret = await crypto.subtle.sign(
“HMAC”,
secretKey,
encoder.encode(botToken)
);

const hmacKey = await crypto.subtle.importKey(
“raw”,
secret,
{ name: “HMAC”, hash: “SHA-256” },
false,
[“sign”]
);

const calculated = new Uint8Array(
await crypto.subtle.sign(“HMAC”, hmacKey, encoder.encode(dataCheckString))
);

const expectedHash = Array.from(calculated)
.map(byte => byte.toString(16).padStart(2, “0”))
.join(””);

// Constant-time comparison.
let diff = 0;
for (let i = 0; i < 64; i++) {
diff |= expectedHash.charCodeAt(i) ^ receivedHash.toLowerCase().charCodeAt(i);
}

if (diff !== 0) return null;

let user;
try {
user = JSON.parse(params.get(“user”));
} catch {
return null;
}

if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return null;

// Return only the fields used by the UI.
return {
id: user.id,
first_name: typeof user.first_name === “string” ? user.first_name : “”,
last_name: typeof user.last_name === “string” ? user.last_name : “”,
username: typeof user.username === “string” ? user.username : “”,
language_code: typeof user.language_code === “string” ? user.language_code : “”,
is_premium: user.is_premium === true,
photo_url: typeof user.photo_url === “string” ? user.photo_url : “”
};
}

export default {
async fetch(request, env) {
const url = new URL(request.url);

if (url.pathname === "/api/auth") {
  if (request.method !== "POST") {
    return Response.json(
      { ok: false, error: "Method Not Allowed" },
      { status: 405, headers: { Allow: "POST" } }
    );
  }
  if (!env.BOT_TOKEN) {
    return Response.json(
      { ok: false, error: "Secret با نام BOT_TOKEN در Cloudflare تنظیم نشده است." },
      { status: 500 }
    );
  }
  let body;
  try {
    if (Number(request.headers.get("content-length") || 0) > 20000) {
      return Response.json({ ok: false, error: "درخواست بیش از حد بزرگ است." }, { status: 413 });
    }
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "درخواست نامعتبر است." }, { status: 400 });
  }
  const user = await validateTelegramInitData(body?.initData, env.BOT_TOKEN);
  if (!user) {
    return Response.json(
      { ok: false, error: "اعتبارسنجی اطلاعات تلگرام ناموفق بود. مینی‌اپ را دوباره باز کن." },
      { status: 401 }
    );
  }
  return Response.json(
    { ok: true, user },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      }
    }
  );
}
if (url.pathname !== "/" || request.method !== "GET") {
  return new Response("Not Found", { status: 404 });
}
return new Response(HTML, {
  headers: {
    "Content-Type": "text/html; charset=UTF-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'unsafe-inline' https://telegram.org; style-src 'unsafe-inline'; img-src https: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org"
  }
});

}
};
