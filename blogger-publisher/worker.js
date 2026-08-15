const QUEUE_URL = "https://raw.githubusercontent.com/blogthisorthat/Family-Meal-Planning-Resources-site/main/blogger-publisher/queue/current.json";
const R2_PUBLIC_BASE = "https://pub-343f7a8e174e49de9b9c66bc76af0229.r2.dev";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const BLOGS = {
  cooking: "9072388559872846957"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "Man That Cooks Blogger Publisher",
        imageGuard: true,
        imageStorage: "r2",
        imageUpload: true,
        r2PublicBase: R2_PUBLIC_BASE
      });
    }

    if (url.pathname.startsWith("/upload-image/") && request.method === "PUT") {
      if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
      try {
        return json(await uploadImage(request, env, url));
      } catch (error) {
        return json({ ok: false, error: String(error?.message || error) }, 400);
      }
    }

    if (url.pathname === "/run" && request.method === "POST") {
      if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
      try {
        return json(await processQueue(env));
      } catch (error) {
        return json({ ok: false, error: String(error?.message || error) }, 500);
      }
    }

    return json({ ok: false, error: "Not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processQueue(env));
  }
};

function authorized(request, env) {
  return Boolean(env.PUBLISH_API_KEY) && request.headers.get("authorization") === `Bearer ${env.PUBLISH_API_KEY}`;
}

async function uploadImage(request, env, url) {
  if (!env.RECIPE_IMAGES || typeof env.RECIPE_IMAGES.put !== "function") {
    throw new Error("RECIPE_IMAGES R2 binding is missing");
  }

  const rawName = url.pathname.slice("/upload-image/".length);
  if (!rawName || rawName.includes("/") || rawName.includes("\\")) throw new Error("Invalid filename");
  const filename = decodeURIComponent(rawName);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(filename)) throw new Error("Invalid filename");

  const contentType = (request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) throw new Error("Only JPG, PNG, and WebP images are allowed");

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_IMAGE_BYTES) throw new Error("Image exceeds 10 MB limit");

  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) throw new Error("Image body is empty");
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Image exceeds 10 MB limit");

  const key = `recipes/${filename}`;
  await env.RECIPE_IMAGES.put(key, bytes, {
    httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { source: "man-that-cooks-publisher" }
  });

  return {
    ok: true,
    action: "uploaded",
    key,
    bytes: bytes.byteLength,
    contentType,
    url: `${R2_PUBLIC_BASE}/${key}`
  };
}

async function processQueue(env) {
  const r = await fetch(`${QUEUE_URL}?t=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
  if (!r.ok) throw new Error(`Queue fetch failed: ${r.status}`);
  const item = await r.json();

  if (!item.enabled) return { ok: true, action: "none", reason: "queue disabled" };
  if (!item.queueId || !item.blog || !item.title || !item.contentHtml) throw new Error("Queue item is missing required fields");

  const blogId = BLOGS[item.blog];
  if (!blogId) throw new Error(`Unknown blog alias: ${item.blog}`);

  if (item.blog === "cooking" && item.imageRequired !== false) {
    const imageUrl = item.imageUrl || firstImageUrl(item.contentHtml);
    if (!imageUrl) return { ok: true, action: "none", reason: "recipe image missing", queueId: item.queueId };
    if (item.imageStatus !== "ready") return { ok: true, action: "none", reason: "recipe image not ready", queueId: item.queueId, imageStatus: item.imageStatus || "missing" };
    if (!String(item.contentHtml).includes(imageUrl)) return { ok: true, action: "none", reason: "recipe image not embedded", queueId: item.queueId };
    if (!/^https:\/\//i.test(imageUrl)) return { ok: true, action: "none", reason: "recipe image is not public HTTPS", queueId: item.queueId };

    const imageCheck = await fetch(imageUrl, { method: "HEAD" });
    if (!imageCheck.ok) return { ok: true, action: "none", reason: `recipe image unavailable: ${imageCheck.status}`, queueId: item.queueId };
    const imageType = (imageCheck.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (imageType && !ALLOWED_IMAGE_TYPES.has(imageType)) return { ok: true, action: "none", reason: `recipe image has invalid content type: ${imageType}`, queueId: item.queueId };
  }

  const token = await getAccessToken(env);
  const marker = `<span style="display:none" data-blogger-queue-id="${escapeAttr(item.queueId)}"></span>`;
  const duplicate = await alreadyPublished(blogId, item.queueId, token);
  if (duplicate) return { ok: true, action: "none", reason: "already published", queueId: item.queueId, url: duplicate.url };

  const post = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(blogId)}/posts`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ kind: "blogger#post", title: item.title, content: `${item.contentHtml}\n${marker}`, labels: Array.isArray(item.labels) ? item.labels : [] })
  });

  const result = await post.json();
  if (!post.ok) throw new Error(`Blogger rejected post: ${post.status} ${JSON.stringify(result)}`);
  return { ok: true, action: "published", queueId: item.queueId, id: result.id, title: result.title, url: result.url, published: result.published, imageUrl: item.imageUrl || firstImageUrl(item.contentHtml) };
}

async function alreadyPublished(blogId, queueId, token) {
  const needle = `data-blogger-queue-id="${queueId}"`;
  let pageToken = "";
  for (let page = 0; page < 3; page++) {
    const params = new URLSearchParams({ fetchBodies: "true", maxResults: "50", orderBy: "published", status: "live", view: "ADMIN" });
    if (pageToken) params.set("pageToken", pageToken);
    const r = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(blogId)}/posts?${params}`, { headers: { authorization: `Bearer ${token}` } });
    const data = await r.json();
    if (!r.ok) throw new Error(`Duplicate check failed: ${r.status} ${JSON.stringify(data)}`);
    const found = (data.items || []).find((p) => (p.content || "").includes(needle));
    if (found) return found;
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return null;
}

async function getAccessToken(env) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token" })
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) throw new Error(`Google token refresh failed: ${r.status} ${JSON.stringify(data)}`);
  return data.access_token;
}

function firstImageUrl(html) {
  const match = String(html || "").match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=UTF-8" } });
}

function escapeAttr(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
