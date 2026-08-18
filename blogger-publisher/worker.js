const QUEUE_URL = "https://raw.githubusercontent.com/blogthisorthat/Family-Meal-Planning-Resources-site/main/blogger-publisher/queue/current.json";
const RAW_REPO_BASE = "https://raw.githubusercontent.com/blogthisorthat/Family-Meal-Planning-Resources-site/main";
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
        version: "2.0",
        imageGuard: true,
        imageStorage: "r2",
        imageUpload: true,
        queueBoundImageIngest: true,
        legacyGetRun: true,
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

    if (url.pathname === "/ingest-queue-image" && request.method === "POST") {
      try {
        return json(await ingestQueueImage(request, env));
      } catch (error) {
        return json({ ok: false, error: String(error?.message || error) }, 400);
      }
    }

    if (url.pathname === "/run" && (request.method === "GET" || request.method === "POST")) {
      if (request.method === "POST" && env.PUBLISH_API_KEY && !authorized(request, env)) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }
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

async function fetchQueueItem() {
  const response = await fetch(`${QUEUE_URL}?t=${Date.now()}`, {
    headers: { "cache-control": "no-cache", "user-agent": "ManThatCooksPublisher/2.0" }
  });
  if (!response.ok) throw new Error(`Queue fetch failed: ${response.status}`);
  const item = await response.json();
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Queue JSON must be an object");
  return item;
}

function requireR2(env) {
  if (!env.RECIPE_IMAGES || typeof env.RECIPE_IMAGES.put !== "function") {
    throw new Error("RECIPE_IMAGES R2 binding is missing");
  }
}

async function uploadImage(request, env, url) {
  requireR2(env);

  const rawName = url.pathname.slice("/upload-image/".length);
  if (!rawName || rawName.includes("/") || rawName.includes("\\")) throw new Error("Invalid filename");
  const filename = decodeURIComponent(rawName);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(filename)) throw new Error("Invalid filename");

  const contentType = normalizeContentType(request.headers.get("content-type"));
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) throw new Error("Only JPG, PNG, and WebP images are allowed");

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_IMAGE_BYTES) throw new Error("Image exceeds 10 MB limit");

  const bytes = await request.arrayBuffer();
  validateImageBytes(bytes, contentType);

  const key = `recipes/${filename}`;
  await putImage(env, key, bytes, contentType, "direct-upload");

  return {
    ok: true,
    action: "uploaded",
    key,
    bytes: bytes.byteLength,
    contentType,
    url: `${R2_PUBLIC_BASE}/${key}`
  };
}

async function ingestQueueImage(request, env) {
  requireR2(env);

  let payload = {};
  try {
    payload = await request.json();
  } catch {
    throw new Error("Request body must be JSON");
  }

  const requestedQueueId = String(payload?.queueId || "");
  if (!requestedQueueId) throw new Error("queueId is required");

  const item = await fetchQueueItem();
  if (String(item.queueId || "") !== requestedQueueId) throw new Error("queueId does not match the current queue item");
  if (item.blog !== "cooking") throw new Error("Queue item is not for the cooking blog");
  if (item.enabled) throw new Error("Queue must remain disabled until its staged image is prepared");
  if (item.imageStatus === "ready") throw new Error("Queue image is already ready");

  const sourcePath = String(item.imageSourcePath || "");
  if (!/^blogger-publisher\/staging\/[A-Za-z0-9][A-Za-z0-9._-]{2,199}\.(?:jpe?g|png|webp)$/i.test(sourcePath)) {
    throw new Error("Queue has an invalid imageSourcePath");
  }
  const filename = sourcePath.split("/").pop();
  const stem = filename.replace(/\.(?:jpe?g|png|webp)$/i, "");
  if (stem !== requestedQueueId) throw new Error("Staged image filename must match queueId");

  const expectedSourceUrl = `${RAW_REPO_BASE}/${sourcePath.split("/").map(encodeURIComponent).join("/")}`;
  if (item.imageSourceUrl && item.imageSourceUrl !== expectedSourceUrl) {
    throw new Error("imageSourceUrl does not match imageSourcePath");
  }

  const source = await fetch(`${expectedSourceUrl}?t=${Date.now()}`, {
    headers: { "cache-control": "no-cache", "user-agent": "ManThatCooksPublisher/2.0" }
  });
  if (!source.ok) throw new Error(`Staged image fetch failed: ${source.status}`);

  const contentType = normalizeContentType(source.headers.get("content-type")) || contentTypeFromFilename(filename);
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) throw new Error(`Staged image has unsupported content type: ${contentType || "missing"}`);

  const declaredLength = Number(source.headers.get("content-length") || 0);
  if (declaredLength > MAX_IMAGE_BYTES) throw new Error("Staged image exceeds 10 MB limit");

  const bytes = await source.arrayBuffer();
  validateImageBytes(bytes, contentType);

  const extension = extensionForContentType(contentType);
  const key = `recipes/${requestedQueueId}.${extension}`;
  await putImage(env, key, bytes, contentType, "queue-bound-github-ingest");

  return {
    ok: true,
    action: "ingested",
    queueId: requestedQueueId,
    sourceUrl: expectedSourceUrl,
    key,
    bytes: bytes.byteLength,
    contentType,
    url: `${R2_PUBLIC_BASE}/${key}`
  };
}

async function putImage(env, key, bytes, contentType, source) {
  await env.RECIPE_IMAGES.put(key, bytes, {
    httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { source }
  });
}

function validateImageBytes(bytes, contentType) {
  if (!bytes || !bytes.byteLength) throw new Error("Image body is empty");
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Image exceeds 10 MB limit");
  const data = new Uint8Array(bytes);
  const jpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const png = data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a;
  const webp = data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50;
  if ((contentType === "image/jpeg" && !jpeg) || (contentType === "image/png" && !png) || (contentType === "image/webp" && !webp)) {
    throw new Error(`Image bytes do not match ${contentType}`);
  }
}

function normalizeContentType(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function contentTypeFromFilename(filename) {
  if (/\.jpe?g$/i.test(filename)) return "image/jpeg";
  if (/\.png$/i.test(filename)) return "image/png";
  if (/\.webp$/i.test(filename)) return "image/webp";
  return "";
}

function extensionForContentType(contentType) {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  throw new Error(`Unsupported image content type: ${contentType}`);
}

async function processQueue(env) {
  const item = await fetchQueueItem();

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

    const imageCheck = await checkPublicImage(imageUrl, item.imageType);
    if (!imageCheck.ok) return { ok: true, action: "none", reason: imageCheck.reason, queueId: item.queueId };
  }

  const token = await getAccessToken(env);
  const marker = `<span style="display:none" data-blogger-queue-id="${escapeAttr(item.queueId)}"></span>`;
  const duplicate = await alreadyPublished(blogId, item.queueId, token);
  if (duplicate) return { ok: true, action: "none", reason: "already published", queueId: item.queueId, url: duplicate.url };

  const post = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(blogId)}/posts`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify({
      kind: "blogger#post",
      title: item.title,
      content: `${item.contentHtml}\n${marker}`,
      labels: Array.isArray(item.labels) ? item.labels : []
    })
  });

  const result = await post.json();
  if (!post.ok) throw new Error(`Blogger rejected post: ${post.status} ${JSON.stringify(result)}`);
  return {
    ok: true,
    action: "published",
    queueId: item.queueId,
    id: result.id,
    title: result.title,
    url: result.url,
    published: result.published,
    imageUrl: item.imageUrl || firstImageUrl(item.contentHtml)
  };
}

async function checkPublicImage(imageUrl, declaredType) {
  let response = await fetch(imageUrl, {
    method: "HEAD",
    headers: { "cache-control": "no-cache", "user-agent": "ManThatCooksImageCheck/2.0" }
  });

  if (!response.ok || response.status === 405) {
    response = await fetch(imageUrl, {
      method: "GET",
      headers: {
        range: "bytes=0-31",
        "cache-control": "no-cache",
        "user-agent": "ManThatCooksImageCheck/2.0"
      }
    });
  }

  if (!response.ok) return { ok: false, reason: `recipe image unavailable: ${response.status}` };
  const imageType = normalizeContentType(response.headers.get("content-type")) || contentTypeFromFilename(new URL(imageUrl).pathname);
  if (imageType && !ALLOWED_IMAGE_TYPES.has(imageType)) {
    return { ok: false, reason: `recipe image has invalid content type: ${imageType}` };
  }
  if (declaredType && imageType && declaredType !== imageType) {
    return { ok: false, reason: `recipe image type mismatch: queue says ${declaredType}, server says ${imageType}` };
  }
  return { ok: true, imageType };
}

async function alreadyPublished(blogId, queueId, token) {
  const needle = `data-blogger-queue-id="${queueId}"`;
  let pageToken = "";
  for (let page = 0; page < 3; page++) {
    const params = new URLSearchParams({
      fetchBodies: "true",
      maxResults: "50",
      orderBy: "published",
      status: "live",
      view: "ADMIN"
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(blogId)}/posts?${params}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`Duplicate check failed: ${response.status} ${JSON.stringify(data)}`);
    const found = (data.items || []).find((post) => (post.content || "").includes(needle));
    if (found) return found;
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return null;
}

async function getAccessToken(env) {
  for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]) {
    if (!env[name]) throw new Error(`Worker secret is missing: ${name}`);
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(`Google token refresh failed: ${response.status} ${JSON.stringify(data)}`);
  return data.access_token;
}

function firstImageUrl(html) {
  const match = String(html || "").match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store"
    }
  });
}

function escapeAttr(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
