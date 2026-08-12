const MAX_HTML_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/extract-recipe') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      return extractRecipeRequest(request);
    }
    if (url.pathname === '/') {
      const response = await env.ASSETS.fetch(request);
      const type = response.headers.get('content-type') || '';
      if (!type.includes('text/html')) return response;
      return new HTMLRewriter()
        .on('.navlinks', {
          element(element) {
            element.append('<a href="/recipe-scaler.html">Recipe Scaler</a>', { html: true });
          }
        })
        .on('.resources-grid', {
          element(element) {
            element.append('<a class="resource-card" href="/recipe-scaler.html"><strong>Recipe URL Ingredient Scaler</strong><span>Paste a recipe URL, extract its ingredient list, scale quantities for your family size, and add it to the weekly planner.</span></a>', { html: true });
          }
        })
        .transform(response);
    }
    return env.ASSETS.fetch(request);
  }
};

async function extractRecipeRequest(request) {
  try {
    const body = await request.json();
    const target = validateTargetUrl(body?.url);
    const { html, finalUrl } = await fetchHtml(target);
    const recipe = extractRecipeFromHtml(html);
    if (!recipe) {
      return json({ error: 'No structured recipe data was found on that page. Try the direct recipe page rather than a homepage, search page, or social-media link.' }, 422);
    }

    const ingredients = normalizeIngredients(recipe.recipeIngredient || recipe.ingredients);
    if (!ingredients.length) return json({ error: 'A recipe was found, but it did not expose an ingredient list.' }, 422);

    return json({
      name: cleanText(recipe.name) || extractTitle(html) || 'Imported recipe',
      sourceUrl: finalUrl,
      recipeYield: normalizeYield(recipe.recipeYield),
      servings: parseServings(recipe.recipeYield),
      ingredients: ingredients.slice(0, 100)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to import that recipe.';
    const status = message.startsWith('INVALID_URL:') ? 400 : message.startsWith('FETCH_') ? 502 : 500;
    return json({ error: message.replace(/^[A-Z_]+:/, '') }, status);
  }
}

function validateTargetUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('INVALID_URL: Enter a valid recipe URL.');
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error('INVALID_URL: Enter a complete URL beginning with http:// or https://.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('INVALID_URL: Only http and https recipe URLs are supported.');
  if (url.username || url.password) throw new Error('INVALID_URL: URLs containing usernames or passwords are not allowed.');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('INVALID_URL: Non-standard ports are not allowed.');

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    throw new Error('INVALID_URL: That host is not allowed.');
  }
  return url;
}

async function fetchHtml(initialUrl) {
  let current = initialUrl;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const response = await fetch(current.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'User-Agent': 'FamilyMealPlanningToolsRecipeImporter/1.0 (+https://familymealplanningtools.com/recipe-scaler.html)'
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (i === MAX_REDIRECTS) throw new Error('FETCH_REDIRECT: Too many redirects while opening that recipe.');
      const location = response.headers.get('location');
      if (!location) throw new Error('FETCH_REDIRECT: The recipe site returned an invalid redirect.');
      current = validateTargetUrl(new URL(location, current).toString());
      continue;
    }

    if (!response.ok) throw new Error(`FETCH_HTTP: The recipe site returned HTTP ${response.status}.`);
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      throw new Error('FETCH_TYPE: The URL did not return an HTML recipe page.');
    }
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_HTML_BYTES) throw new Error('FETCH_SIZE: The recipe page is too large to import safely.');
    const html = await readLimitedText(response.body, MAX_HTML_BYTES);
    return { html, finalUrl: current.toString() };
  }
  throw new Error('FETCH_REDIRECT: Unable to resolve the recipe URL.');
}

async function readLimitedText(stream, limit) {
  if (!stream) throw new Error('FETCH_BODY: The recipe site returned an empty response.');
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error('FETCH_SIZE: The recipe page is too large to import safely.');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function extractRecipeFromHtml(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of scripts) {
    const raw = decodeBasicEntities(match[1].trim()).replace(/^<!--|-->$/g, '').trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const recipe = findRecipeNode(parsed);
      if (recipe) return recipe;
    } catch {}
  }

  const ingredientMatch = html.match(/["']recipeIngredient["']\s*:\s*(\[[\s\S]{1,100000}?\])/i);
  if (ingredientMatch) {
    try {
      const ingredients = JSON.parse(ingredientMatch[1]);
      return { name: extractTitle(html), recipeIngredient: ingredients };
    } catch {}
  }
  return null;
}

function findRecipeNode(node) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipeNode(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;

  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  if (types.some(type => String(type).toLowerCase() === 'recipe')) return node;

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const found = findRecipeNode(value);
      if (found) return found;
    }
  }
  return null;
}

function normalizeIngredients(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (typeof item === 'string') return cleanText(item);
    if (item && typeof item === 'object') return cleanText(item.text || item.name || item.value);
    return '';
  }).filter(Boolean).map(item => item.slice(0, 500));
}

function normalizeYield(value) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean).join(', ') || null;
  if (value == null) return null;
  return cleanText(String(value)) || null;
}

function parseServings(value) {
  const text = normalizeYield(value);
  if (!text) return null;
  const match = text.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const servings = Number(match[1]);
  return servings > 0 && servings <= 100 ? servings : null;
}

function extractTitle(html) {
  const og = html.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i) || html.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["'][^>]*>/i);
  if (og) return cleanText(decodeBasicEntities(og[1]));
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? cleanText(decodeBasicEntities(title[1])) : '';
}

function decodeBasicEntities(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function cleanText(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });
}
