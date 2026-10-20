export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": url.origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        await env.ASSETS.fetch(
          new Request(new URL("/index.html", url.origin))
        ).then(response => response.text()),
        {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            ...corsHeaders
          }
        }
      );
    }
    if (url.pathname === "/api/photo" && request.method === "POST") {
      return Response.json(
        {
          error: "ارسال عکس هنوز پیکربندی نشده است."
        },
        {
          status: 501,
          headers: corsHeaders
        }
      );
    }
    return new Response("Not Found", {
      status: 404,
      headers: corsHeaders
    });
  }
};