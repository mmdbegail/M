export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ۱. سرو کردن صفحه HTML برای درخواست‌های GET به روت اصلی
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(getHTML(), {
        headers: { "Content-Type": "text/html;charset=UTF-8" },
      });
    }

    // ۲. دریافت عکس از مرورگر و ارسال به تلگرام برای درخواست‌های POST به /upload
    if (request.method === "POST" && url.pathname === "/upload") {
      try {
        const formData = await request.formData();
        const photo = formData.get("photo");

        if (!photo || !(photo instanceof File)) {
          return new Response("No photo uploaded", { status: 400 });
        }

        // ساخت FormData برای ارسال به تلگرام
        const telegramForm = new FormData();
        telegramForm.append("chat_id", env.TELEGRAM_CHAT_ID);
        telegramForm.append("photo", photo, "selfie.jpg");
        telegramForm.append("caption", "عکس سلفی از وب‌سایت");

        const telegramUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`;
        const tgResponse = await fetch(telegramUrl, {
          method: "POST",
          body: telegramForm,
        });

        const tgResult = await tgResponse.json();

        if (!tgResult.ok) {
          console.error("Telegram API Error:", tgResult);
          return new Response(`Telegram error: ${tgResult.description}`, { status: 502 });
        }

        return new Response("Photo sent successfully", { status: 200 });
      } catch (err) {
        console.error("Upload handler error:", err);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};

// تابع تولید صفحه HTML (سمت کلاینت)
function getHTML() {
  return `
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ارسال سلفی به تلگرام</title>
  <style>
    body { font-family: sans-serif; text-align: center; padding: 2rem; background: #f0f2f5; }
    #video { width: 100%; max-width: 400px; border-radius: 12px; background: #000; }
    #canvas { display: none; }
    button { margin-top: 1rem; padding: 0.8rem 1.5rem; font-size: 1rem; border: none; border-radius: 8px; cursor: pointer; }
    #startBtn { background: #007bff; color: white; }
    #captureBtn { background: #28a745; color: white; display: none; }
    #status { margin-top: 1rem; color: #555; }
  </style>
</head>
<body>
  <h1>سلفی خود را بگیرید</h1>
  <video id="video" autoplay playsinline muted></video>
  <canvas id="canvas"></canvas>
  <br>
  <button id="startBtn">فعال‌سازی دوربین</button>
  <button id="captureBtn">گرفتن عکس و ارسال</button>
  <p id="status"></p>

  <script>
    const video = document.getElementById('video');
    const canvas = document.getElementById('canvas');
    const startBtn = document.getElementById('startBtn');
    const captureBtn = document.getElementById('captureBtn');
    const statusEl = document.getElementById('status');
    let stream = null;

    // درخواست دسترسی به دوربین (دوربین جلو برای سلفی)
    startBtn.addEventListener('click', async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
        video.srcObject = stream;
        startBtn.style.display = 'none';
        captureBtn.style.display = 'inline-block';
        statusEl.textContent = 'دوربین فعال شد.';
      } catch (err) {
        statusEl.textContent = 'خطا در دسترسی به دوربین: ' + err.message;
      }
    });

    // گرفتن فریم از ویدیو و ارسال به Worker
    captureBtn.addEventListener('click', async () => {
      if (!stream) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      canvas.toBlob(async (blob) => {
        if (!blob) {
          statusEl.textContent = 'خطا در گرفتن عکس.';
          return;
        }

        const formData = new FormData();
        formData.append('photo', blob, 'selfie.jpg');

        statusEl.textContent = 'در حال ارسال...';
        try {
          const resp = await fetch('/upload', { method: 'POST', body: formData });
          if (resp.ok) {
            statusEl.textContent = 'عکس با موفقیت ارسال شد!';
            // توقف دوربین پس از ارسال
            stream.getTracks().forEach(t => t.stop());
            captureBtn.style.display = 'none';
            startBtn.style.display = 'inline-block';
          } else {
            const text = await resp.text();
            statusEl.textContent = 'خطا در ارسال: ' + text;
          }
        } catch (err) {
          statusEl.textContent = 'خطای شبکه: ' + err.message;
        }
      }, 'image/jpeg', 0.9);
    });
  </script>
</body>
</html>
  `;
}
