// GYM backend bootstrap — all public assets continue to be served by Cloudflare.
// No admin writes, credentials, or D1 migrations are activated in this stage.
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/api/health") {
      return new Response(JSON.stringify({
        ok: true,
        service: "gym",
        databaseConfigured: Boolean(env.DB),
      }), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (path === "/api" || path.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
