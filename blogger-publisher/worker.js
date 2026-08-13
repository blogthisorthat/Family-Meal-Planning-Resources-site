const QUEUE_URL = "https://raw.githubusercontent.com/blogthisorthat/Family-Meal-Planning-Resources-site/main/blogger-publisher/queue/current.json";

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
        imageStorage: "github"
      });
    }

    if (url.pathname === "/run" && request.method === "POST") {
      if (request.headers.get("authorization") !== `Bearer ${env.PUBLISH_API_KEY}`) {
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

async function processQueue(env) {
  const r = await fetch(`${QUEUE_URL}?t=${Date.now()}`, {
    headers: { "cache-control": "no-cache" }
  });

  if (!r.ok) throw new Error(`Queue fetch failed: ${r.status}`);

  const item = await r.json();

  if (!item.enabled) {
    return { ok: true, action: "none", reason: "queue disabled" };
  }

  if (!item.queueId || !item.blog || !item.title || !item.contentHtml) {
    throw new Error("Queue item is missing required fields");
  }

  const blogId = BLOGS[item.blog];
  if (!blogId) throw new Error(`Unknown blog alias: ${item.blog}`);

  // Recipe posts are fail-closed: no public embedded image means no publish.
  if (item.blog === "cooking" && item.imageRequired !== false) {
    const imageUrl = item.imageUrl || firstImageUrl(item.contentHtml);

    if (!imageUrl) {
      return {
        ok: true,
        action: "none",
        reason: "recipe image missing",
        queueId: item.queueId
      };
    }

    if (item.imageStatus !== "ready") {
      return {
        ok: true,
        action: "none",
        reason: "recipe image not ready",
        queueId: item.queueId,
        imageStatus: item.imageStatus || "missing"
      };
    }

    if (!String(item.contentHtml).includes(imageUrl)) {
      return {
        ok: true,
        action: "none",
        reason: "recipe image not embedded",
        queueId: item.queueId
      };
    }

    if (!/^https:\/\//i.test(imageUrl)) {
      return {
        ok: true,
        action: "none",
        reason: "recipe image is not public HTTPS",
        queueId: item.queueId
      };
    }

    const imageCheck = await fetch(imageUrl, { method: "HEAD" });
    if (!imageCheck.ok) {
      return {
        ok: true,
        action: "none",
        reason: `recipe image unavailable: ${imageCheck.status}`,
        queueId: item.queueId
      };
    }
  }

  const token = await getAccessToken(env);
  const marker = `<span style="display:none" data-blogger-queue-id="${escapeAttr(item.queueId)}"></span>`;

  const duplicate = await alreadyPublished(blogId, item.queueId, token);
  if (duplicate) {
    return {
      ok: true,
      action: "none",
      reason: "already published",
      queueId: item.queueId,
      url: duplicate.url
    };
  }

  const post = await fetch(
    `https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(blogId)}/posts`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8"
      },
      body: JSON.stringify({
        kind: "blogger#post",
        title: item.title,
        content: `${item.contentHtml}\n${marker}`,
        labels: Array.isArray(item.labels) ? item.labels : []
      })
    }
  );

  const result = await post.json();
  if (!post.ok) {
    throw new Error(`Blogger rejected post: ${post.status} ${JSON.stringify(result)}`);
  }

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

    const r = await fetch(
      `https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(blogId)}/posts?${params}`,
      { headers: { authorization: `Bearer ${token}` } }
    );

    const data = await r.json();
    if (!r.ok) {
      throw new Error(`Duplicate check failed: ${r.status} ${JSON.stringify(data)}`);
    }

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
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });

  const data = await r.json();
  if (!r.ok || !data.access_token) {
    throw new Error(`Google token refresh failed: ${r.status} ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

function firstImageUrl(html) {
  const match = String(html || "").match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" }
  });
}

function escapeAttr(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
