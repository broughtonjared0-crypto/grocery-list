// Groceries API: a small Cloudflare Worker in front of Kroger's public Product + Locations APIs.
//
//   GET /stores?zip=40475                 -> [{ locationId, name, chain, address }]
//   GET /search?q=milk&locationId=…       -> [{ productId, upc, name, brand, size, price, promo, image, imageUrl }]
//   GET /img?u=<https://…kroger.com/…>    -> the image bytes (kroger.com hosts only)
//
// Secrets (never sent to the browser): KROGER_CLIENT_ID, KROGER_CLIENT_SECRET.
// Vars: ALLOWED_ORIGIN (comma-separated; "*" may stand for a port, e.g. http://localhost:*).
//       KROGER_BASE (optional, only for local tests against a mock).

import indexHtml from '../../site/index.html';
import manifest from '../../site/manifest.webmanifest';
import iconSvg from '../../site/icon.svg';
import icon192 from '../../site/icon-192.png';
import icon512 from '../../site/icon-512.png';
import iconMask from '../../site/icon-maskable-512.png';
import touchIcon from '../../site/apple-touch-icon.png';
import swJs from '../../site/sw.js';

// The app's own files, served from the Worker's URL.
const SITE = {
  '/': [indexHtml, 'text/html; charset=utf-8', 300],
  '/index.html': [indexHtml, 'text/html; charset=utf-8', 300],
  '/manifest.webmanifest': [manifest, 'application/manifest+json', 86400],
  '/icon.svg': [iconSvg, 'image/svg+xml', 86400],
  '/icon-192.png': [icon192, 'image/png', 86400],
  '/icon-512.png': [icon512, 'image/png', 86400],
  '/icon-maskable-512.png': [iconMask, 'image/png', 86400],
  '/apple-touch-icon.png': [touchIcon, 'image/png', 86400],
  '/sw.js': [swJs, 'text/javascript; charset=utf-8', 0],
};

const DEFAULT_BASE = 'https://api.kroger.com/v1';
const SCOPE = 'product.compact';
const SEARCH_TTL = 6 * 3600;   // seconds
const STORES_TTL = 24 * 3600;
const IMG_TTL = 30 * 86400;

let token = null;              // { value, exp } kept for the life of this isolate
const mem = new Map();         // small in-isolate result cache: key -> { exp, data }

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    const allowed = matchOrigin(origin, env.ALLOWED_ORIGIN);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: allowed ? 204 : 403, headers: corsHeaders(allowed) });
    }
    const isSync = url.pathname.startsWith('/sync/');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(isSync && req.method === 'PUT')) return json({ error: 'Method not allowed' }, 405, allowed);
    // Browsers always send Origin on cross-site fetch(); block other sites. <img> loads send none.
    if (origin && !allowed && url.pathname !== '/img') return json({ error: 'Origin not allowed' }, 403, null);

    const file = SITE[url.pathname];
    if (file && req.method === 'GET') return new Response(file[0], { headers: { 'Content-Type': file[1], 'Cache-Control': file[2] ? `public, max-age=${file[2]}` : 'no-cache' } });

    try {
      if (isSync) return await syncRoute(req, url, env, allowed);
      switch (url.pathname) {
        case '/api': return json({ ok: true, routes: ['/stores?zip=', '/search?q=&locationId=', '/img?u='] }, 200, allowed);
        case '/stores': return await stores(url, env, ctx, allowed);
        case '/search': return await search(url, env, ctx, allowed);
        case '/img': return await image(url);
        default: return json({ error: 'Not found' }, 404, allowed);
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 502;
      const msg = e instanceof HttpError ? e.message : 'Something went wrong talking to Kroger';
      if (!(e instanceof HttpError)) console.error(e && e.stack || e);
      return json({ error: msg }, status, allowed);
    }
  },
};

/* ---------------- routes ---------------- */

async function stores(url, env, ctx, allowed) {
  const zip = (url.searchParams.get('zip') || '').trim();
  if (!/^\d{5}$/.test(zip)) throw new HttpError(400, 'Enter a 5-digit ZIP code');
  const data = await cached(`stores:${zip}`, STORES_TTL, url, ctx, async () => {
    const r = await kroger(env, ctx, '/locations', { 'filter.zipCode.near': zip, 'filter.limit': '10' });
    return (r.data || []).map(l => ({
      locationId: l.locationId,
      name: l.name || '',
      chain: l.chain || '',
      address: fmtAddress(l.address),
    }));
  });
  return json(data, 200, allowed, STORES_TTL);
}

async function search(url, env, ctx, allowed) {
  const q = cleanTerm(url.searchParams.get('q'));
  if (q.length < 2) throw new HttpError(400, 'Type at least 2 letters to search');
  const loc = (url.searchParams.get('locationId') || '').trim();
  if (loc && !/^[A-Za-z0-9]{1,16}$/.test(loc)) throw new HttpError(400, 'Bad locationId');
  let limit = parseInt(url.searchParams.get('limit') || '20', 10);
  limit = Math.min(50, Math.max(1, Number.isFinite(limit) ? limit : 20));

  const data = await cached(`search:${loc}:${limit}:${q.toLowerCase()}`, SEARCH_TTL, url, ctx, async () => {
    const params = { 'filter.term': q, 'filter.limit': String(limit) };
    if (loc) params['filter.locationId'] = loc;
    const r = await kroger(env, ctx, '/products', params);
    return (r.data || []).map(p => mapProduct(p, url.origin)).filter(p => p.productId && p.name);
  });
  return json(data, 200, allowed, SEARCH_TTL);
}

async function image(url) {
  const raw = url.searchParams.get('u') || '';
  let t;
  try { t = new URL(raw); } catch { t = null; }
  if (!t || t.protocol !== 'https:' || !isKrogerHost(t.hostname)) {
    return json({ error: 'Only https kroger.com images are allowed' }, 400, null);
  }
  const r = await fetch(t.toString(), {
    headers: { Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
    cf: { cacheEverything: true, cacheTtl: IMG_TTL },
  });
  // Re-check where any redirect ended up.
  if (r.url && !isKrogerHost(new URL(r.url).hostname)) return new Response('Bad redirect', { status: 502 });
  if (!r.ok) return new Response('Image not found', { status: r.status === 404 ? 404 : 502 });
  const type = r.headers.get('Content-Type') || '';
  if (!type.startsWith('image/')) return new Response('Not an image', { status: 415 });
  return new Response(r.body, {
    headers: {
      'Content-Type': type,
      'Cache-Control': `public, max-age=${IMG_TTL}, immutable`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/* ---------------- sync ---------------- */
// One JSON document per sync code: { at: <ms of last change>, data: <app state> }. Last write wins.
const MAX_SYNC = 6 * 1024 * 1024;
async function syncRoute(req, url, env, allowed) {
  if (!env.SYNC) throw new HttpError(500, 'Sync storage is not set up on the Worker');
  const code = url.pathname.slice(6);
  if (!/^[A-Z2-9]{12}$/.test(code)) throw new HttpError(400, 'Bad sync code');
  if (req.method === 'PUT') {
    const text = await req.text();
    if (text.length > MAX_SYNC) throw new HttpError(413, 'Your list is too big to sync — remove some photos');
    let body;
    try { body = JSON.parse(text); } catch { throw new HttpError(400, 'Bad sync data'); }
    if (!body || typeof body.at !== 'number' || !body.data || !Array.isArray(body.data.list)) throw new HttpError(400, 'Bad sync data');
    await env.SYNC.put(code, text);
    return json({ ok: true, at: body.at }, 200, allowed);
  }
  const text = await env.SYNC.get(code);
  if (!text) return json({ error: 'No list saved under that code' }, 404, allowed);
  return new Response(text, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(allowed) } });
}

/* ---------------- Kroger ---------------- */

async function kroger(env, ctx, path, params) {
  const base = (env.KROGER_BASE || DEFAULT_BASE).replace(/\/$/, '');
  const u = `${base}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await getToken(env, ctx, attempt > 0);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' } });
    if (r.status === 401 && attempt === 0) { token = null; continue; }   // token revoked/expired early: refresh once
    if (r.status === 400) throw new HttpError(400, 'Kroger didn’t accept that search. Try simpler words.');
    if (r.status === 429) throw new HttpError(429, 'Kroger is busy (daily limit). Try again later.');
    if (!r.ok) throw new HttpError(502, `Kroger answered ${r.status}`);
    return r.json();
  }
  throw new HttpError(502, 'Kroger rejected the access token');
}

async function getToken(env, ctx, force) {
  const now = Date.now();
  if (!force && token && token.exp - 60_000 > now) return token.value;

  const cache = globalThis.caches && caches.default;
  const key = new Request(`https://token.cache.internal/kroger?scope=${SCOPE}`);
  if (!force && cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const j = await hit.json();
        if (j && j.value && j.exp - 60_000 > now) { token = j; return j.value; }
      }
    } catch { /* cache is best-effort */ }
  }

  if (!env.KROGER_CLIENT_ID || !env.KROGER_CLIENT_SECRET) {
    throw new HttpError(500, 'Kroger credentials are not set on the Worker');
  }
  const base = (env.KROGER_BASE || DEFAULT_BASE).replace(/\/$/, '');
  const r = await fetch(`${base}/connect/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.KROGER_CLIENT_ID}:${env.KROGER_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`,
  });
  if (!r.ok) throw new HttpError(502, `Kroger sign-in failed (${r.status}). Check the Worker’s Kroger secrets.`);
  const j = await r.json();
  if (!j.access_token) throw new HttpError(502, 'Kroger sign-in returned no token');
  const ttl = Math.max(60, Number(j.expires_in) || 1800);
  token = { value: j.access_token, exp: now + ttl * 1000 };
  if (cache) {
    const res = new Response(JSON.stringify(token), { headers: { 'Cache-Control': `max-age=${ttl - 60}` } });
    ctx.waitUntil(cache.put(key, res).catch(() => {}));
  }
  return token.value;
}

/* ---------------- helpers ---------------- */

// In-isolate memory first, then the Cache API (shared per data centre). Either may miss; Kroger is the source of truth.
async function cached(name, ttl, url, ctx, load) {
  const now = Date.now();
  const m = mem.get(name);
  if (m && m.exp > now) return m.data;

  const cache = globalThis.caches && caches.default;
  const key = new Request(`${url.origin}/__cache/${encodeURIComponent(name)}`);
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) { const data = await hit.json(); remember(name, data, ttl); return data; }
    } catch { /* ignore */ }
  }
  const data = await load();
  remember(name, data, ttl);
  if (cache) {
    const res = new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` } });
    ctx.waitUntil(cache.put(key, res).catch(() => {}));
  }
  return data;
}
function remember(name, data, ttl) {
  if (mem.size > 500) mem.delete(mem.keys().next().value);
  mem.set(name, { exp: Date.now() + ttl * 1000, data });
}

function mapProduct(p, origin) {
  const item = (Array.isArray(p.items) && p.items[0]) || {};
  const pr = item.price || {};
  const price = num(pr.regular);
  let promo = num(pr.promo);
  if (!(promo > 0 && price > 0 && promo < price)) promo = null;   // Kroger sends promo: 0 when there's no sale
  const imageUrl = pickImage(p.images);
  return {
    productId: p.productId || '',
    upc: p.upc || '',
    name: p.description || '',
    brand: p.brand || '',
    size: item.size || '',
    price,
    promo,
    image: imageUrl ? `${origin}/img?u=${encodeURIComponent(imageUrl)}` : null,
    imageUrl,
  };
}

const SIZE_PREF = ['medium', 'large', 'xlarge', 'small', 'thumbnail'];
function pickImage(images) {
  if (!Array.isArray(images) || !images.length) return null;
  const img = images.find(i => i.featured) || images.find(i => i.perspective === 'front') || images[0];
  const sizes = Array.isArray(img.sizes) ? img.sizes : [];
  for (const s of SIZE_PREF) {
    const hit = sizes.find(x => x.size === s && x.url);
    if (hit) return hit.url;
  }
  const any = sizes.find(x => x.url);
  return any ? any.url : null;
}

function fmtAddress(a) {
  if (!a) return '';
  const cityLine = [a.city, [a.state, a.zipCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [a.addressLine1, cityLine].filter(Boolean).join(', ');
}

// Kroger's term filter wants plain words (max 8).
function cleanTerm(q) {
  return String(q || '')
    .replace(/[^\p{L}\p{N}%'&.\- ]+/gu, ' ')
    .split(/\s+/).filter(Boolean).slice(0, 8).join(' ')
    .slice(0, 100);
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : (v != null && v !== '' && Number.isFinite(+v) ? +v : null));
const isKrogerHost = h => h === 'kroger.com' || h.endsWith('.kroger.com');

function matchOrigin(origin, list) {
  if (!origin || !list) return null;
  for (const pat of String(list).split(',').map(s => s.trim()).filter(Boolean)) {
    if (pat === origin) return origin;
    if (pat.includes('*')) {
      const re = new RegExp('^' + pat.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[0-9]+') + '$');
      if (re.test(origin)) return origin;
    }
  }
  return null;
}

function corsHeaders(origin) {
  const h = { Vary: 'Origin' };
  if (origin) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, PUT, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function json(data, status, origin, maxAge = 0) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200 && maxAge ? `public, max-age=${Math.min(maxAge, 3600)}` : 'no-store',
      ...corsHeaders(origin),
    },
  });
}
