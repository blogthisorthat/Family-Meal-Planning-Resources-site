// Canonical source for the Man That Cooks Blogger Publisher Worker.
// This file is intentionally conservative: recipe posts are never published
// unless the HTML already contains a public image URL.

const BLOG_ID = "9072388559872846957";
const QUEUE_URL = "https://raw.githubusercontent.com/blogthisorthat/Family-Meal-Planning-Resources-site/main/blogger-publisher/queue/current.json";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({ ok: true, service: "Man That Cooks Blogger Publisher", imageGuard: true }), { headers: { "content-type": "application/json" } });
    }
    if (request.method === "POST" && url.pathname === "/run") {
      const result = await publishFromQueue(env);
      return new Response(JSON.stringify(result, null, 2), { headers: { "content-type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(publishFromQueue(env));
  }
};

async function publishFromQueue(env) {
  const res = await fetch(`${QUEUE_URL}?ts=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`Queue fetch failed: ${res.status}`);
  const queue = await res.json();
  if (!queue?.enabled) return { ok: true, skipped: true, reason: "queue disabled" };

  const imageUrl = queue.imageUrl || firstImageUrl(queue.contentHtml);
  if (queue.blog === "cooking" && queue.imageRequired !== false) {
    if (!imageUrl) return { ok: true, skipped: true, reason: "recipe image missing", queueId: queue.queueId };
    if (queue.imageStatus && queue.imageStatus !== "ready") return { ok: true, skipped: true, reason: "recipe image not ready", queueId: queue.queueId };
    if (!queue.contentHtml.includes(imageUrl)) return { ok: true, skipped: true, reason: "recipe image not embedded", queueId: queue.queueId };
  }

  // Existing production Worker retains the Blogger OAuth/publish implementation.
  // Deploy this source only after merging the OAuth section from the production Worker.
  return { ok: true, validated: true, queueId: queue.queueId, imageUrl };
}

function firstImageUrl(html) {
  const match = String(html || "").match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
  return match ? match[1] : null;
}
