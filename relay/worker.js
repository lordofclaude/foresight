/* Foresight Relay — Cloudflare Worker (runs locally via `wrangler dev`, deploys via `wrangler deploy`).

   Why this exists: TxLINE's live endpoints require an Authorization JWT + X-Api-Token.
   Those must NEVER ship to a public browser page. This relay holds them server-side
   and re-emits the SAME real SSE stream to the browser, plus a football news lane.

   It mirrors TxLINE's own paths (/api/scores/stream, /api/odds/stream) so the app's
   already-tested TxReal.streamLive() client works against it with only a host swap —
   zero new browser stream code.

   Endpoints (all GET, CORS-open, read-only):
     /health                              -> { ok, host, hasCreds, version }
     /api/scores/stream?fixtureId=<id>    -> proxied real SSE (scores)
     /api/odds/stream?fixtureId=<id>      -> proxied real SSE (odds)
     /api/news?teams=England,France       -> merged football news JSON (RSS, no key)

   Secrets (wrangler secret put … ; local: relay/.dev.vars):
     TXLINE_JWT, TXLINE_API_TOKEN, TXLINE_HOST (optional, defaults devnet)
   Optional env:
     ALLOWED_ORIGINS — comma-separated origin allowlist. When set, only listed
       origins are reflected in CORS (others get no ACAO header). When unset,
       CORS stays "*" (needed for file:// local demos + the Vercel site today).

   Hardening (2026-07-18): fixtureId validation, per-IP token-bucket rate limits
   (SSE 10/min, news 30/min), concurrent-SSE cap (20), news Cache-Control.
   NOTE: rate/concurrency state is per-isolate in-memory — best-effort only.
   Cloudflare may run many isolates across PoPs, each with its own counters.
   Good enough to stop casual abuse for a hackathon; use Durable Objects or
   Cloudflare Rate Limiting rules for real global enforcement.
*/

const VERSION = "1.1.0-hardened-2026-07-18";
const DEFAULT_HOST = "https://txline-dev.txodds.com";

// ---- hardening knobs ------------------------------------------------------
const SSE_CONN_PER_MIN = 10;      // new SSE connections per IP per minute
const NEWS_REQ_PER_MIN = 30;      // /api/news requests per IP per minute
const MAX_CONCURRENT_SSE = 20;    // simultaneous SSE pass-throughs per isolate
const MAX_BUCKETS = 2000;         // bound rate-limit memory per isolate
const NEWS_CACHE_SECONDS = 60;    // Cache-Control max-age for /api/news

// Module-scoped JWT cache: lets a 401 refresh survive within a warm isolate.
let JWT_CACHE = null;

// ---- per-isolate rate limiting (best-effort, see header note) -------------
const BUCKETS = new Map(); // key "kind:ip" -> { tokens, last }

/** Token bucket: capacity = perMinute, refills continuously. True = allowed. */
function allowRate(kind, ip, perMinute) {
  const key = kind + ":" + (ip || "unknown");
  const now = Date.now();
  let b = BUCKETS.get(key);
  if (!b) {
    if (BUCKETS.size >= MAX_BUCKETS) {          // crude eviction: drop oldest entry
      const first = BUCKETS.keys().next().value;
      if (first) BUCKETS.delete(first);
    }
    b = { tokens: perMinute, last: now };
    BUCKETS.set(key, b);
  }
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.last) / 60000) * perMinute);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

let ACTIVE_SSE = 0; // concurrent SSE pass-throughs in this isolate

// ---- CORS -----------------------------------------------------------------
/** Resolve the ACAO value: "*" when no allowlist, the reflected origin when
    allowed, or null (no CORS headers → browser blocks) when denied. */
function corsOrigin(request, env) {
  const list = (env && env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!list.length) return "*";
  const origin = request.headers.get("Origin");
  return origin && list.includes(origin) ? origin : null;
}

function cors(extra, acao) {
  const h = Object.assign({
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, X-Api-Token, Last-Event-ID, Cache-Control, Content-Type",
    "Access-Control-Expose-Headers": "Last-Event-ID",
  }, extra || {});
  if (acao) { // null = origin denied by ALLOWED_ORIGINS → no ACAO header, browser blocks
    h["Access-Control-Allow-Origin"] = acao;
    if (acao !== "*") h["Vary"] = "Origin";
  }
  return h;
}

function json(obj, status, acao, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: cors(Object.assign({ "Content-Type": "application/json" }, extraHeaders || {}), acao),
  });
}

function host(env) { return (env && env.TXLINE_HOST) || DEFAULT_HOST; }
function jwt(env) { return JWT_CACHE || (env && env.TXLINE_JWT) || null; }

/** Mint a fresh 30-day guest JWT (same call txline-real.js uses). */
async function refreshJwt(env) {
  const res = await fetch(host(env) + "/auth/guest/start", { method: "POST" });
  if (!res.ok) throw new Error("guest/start " + res.status);
  const body = await res.json().catch(() => null);
  JWT_CACHE = (body && (body.token || body.jwt)) || (typeof body === "string" ? body : null);
  return JWT_CACHE;
}

function upstreamHeaders(env, req) {
  const h = {
    Authorization: "Bearer " + jwt(env),
    "X-Api-Token": env.TXLINE_API_TOKEN || "",
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
  };
  const lei = req.headers.get("Last-Event-ID");
  if (lei) h["Last-Event-ID"] = lei;
  return h;
}

/** Proxy a TxLINE SSE stream (scores|odds), refreshing the JWT once on 401. */
async function proxySSE(kind, env, req, url, acao, ctx) {
  // fixtureId: optional (the app's client may stream unfiltered), but when
  // present it must be a positive integer of at most 10 digits.
  const fixtureId = url.searchParams.get("fixtureId");
  if (fixtureId !== null && !/^[1-9]\d{0,9}$/.test(fixtureId)) {
    return json({ error: "invalid fixtureId: must be a positive integer (max 10 digits)" }, 400, acao);
  }

  const ip = req.headers.get("CF-Connecting-IP");
  if (!allowRate("sse", ip, SSE_CONN_PER_MIN)) {
    return json({ error: "rate limited: too many stream connections, retry later" }, 429, acao, { "Retry-After": "60" });
  }
  if (ACTIVE_SSE >= MAX_CONCURRENT_SSE) {
    return json({ error: "busy: too many concurrent streams, retry later" }, 503, acao, { "Retry-After": "15" });
  }

  const target = host(env) + "/api/" + kind + "/stream" + (fixtureId ? "?fixtureId=" + encodeURIComponent(fixtureId) : "");

  let up = await fetch(target, { headers: upstreamHeaders(env, req) });
  if (up.status === 401) { await refreshJwt(env); up = await fetch(target, { headers: upstreamHeaders(env, req) }); }
  if (!up.ok || !up.body) {
    const t = await up.text().catch(() => "");
    return json({ error: "upstream " + kind + " stream " + up.status, detail: t.slice(0, 200) }, 502, acao);
  }

  // Pipe through an identity TransformStream so we can count the connection
  // open/closed (client disconnects surface as a pipeTo rejection).
  ACTIVE_SSE++;
  const { readable, writable } = new TransformStream();
  const pipe = up.body.pipeTo(writable)
    .catch(() => {})
    .finally(() => { ACTIVE_SSE = Math.max(0, ACTIVE_SSE - 1); });
  if (ctx && ctx.waitUntil) ctx.waitUntil(pipe);

  return new Response(readable, {
    status: 200,
    headers: cors({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    }, acao),
  });
}

// ---- news lane: public football RSS, no API key ---------------------------
const RSS_FEEDS = [
  "https://feeds.bbci.co.uk/sport/football/rss.xml",
  "https://www.espn.com/espn/rss/soccer/news",
  "https://www.theguardian.com/football/rss",
];

function decodeEntities(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#x27;/g, "'")
    .replace(/<[^>]+>/g, "").trim();
}
function tag(block, name) {
  const m = block.match(new RegExp("<" + name + "[^>]*>([\\s\\S]*?)<\\/" + name + ">", "i"));
  return m ? decodeEntities(m[1]) : "";
}
function parseRss(xml, source) {
  const out = [];
  const items = xml.split(/<item[\s>]/i).slice(1);
  for (const raw of items) {
    const block = raw.slice(0, raw.search(/<\/item>/i) === -1 ? raw.length : raw.search(/<\/item>/i));
    const title = tag(block, "title");
    if (!title) continue;
    const link = tag(block, "link") || tag(block, "guid");
    const date = tag(block, "pubDate") || tag(block, "dc:date");
    const desc = tag(block, "description");
    out.push({ title, link, desc, date, ts: date ? Date.parse(date) || 0 : 0, source });
  }
  return out;
}

// Deterministic categorization (the "AI categorize" idea from news-aggregator
// repos, done with keywords so we never claim intelligence we don't have) and
// cross-source dedup (same story via BBC+Guardian+ESPN should print once).
const NEWS_TAGS = [
  { tag: "injury", emoji: "🩹", re: /injur|doubt|fitness|knock|hamstring|ruled out|out for|scan/i },
  { tag: "lineup", emoji: "📋", re: /line-?up|team news|starting xi|starts|benched|recalled/i },
  { tag: "discipline", emoji: "🟥", re: /\bban\b|suspend|red card|\bvar\b|dismiss/i },
  { tag: "transfer", emoji: "🔁", re: /transfer|\bdeal\b|\bsigns?\b|\bfee\b|move to|joins/i },
  { tag: "match", emoji: "📊", re: /report|reaction|analysis|player ratings|follow live|live:/i },
];
function categorize(it) {
  const txt = it.title + " " + (it.desc || "");
  for (const t of NEWS_TAGS) if (t.re.test(txt)) return { tag: t.tag, emoji: t.emoji };
  return { tag: "news", emoji: "📰" };
}
function titleTokens(s) {
  return new Set(String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 3));
}
function dedupe(items) {
  const kept = [];
  for (const it of items) {
    const tk = titleTokens(it.title);
    const dup = kept.some(k => {
      const kt = k._tk; let inter = 0;
      for (const w of tk) if (kt.has(w)) inter++;
      const denom = Math.min(tk.size, kt.size) || 1;
      return inter / denom > 0.6;                       // same story, different outlet
    });
    if (!dup) { it._tk = tk; kept.push(it); }
  }
  kept.forEach(k => delete k._tk);
  return kept;
}

async function newsLane(env, url, acao) {
  const teams = (url.searchParams.get("teams") || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const results = await Promise.all(RSS_FEEDS.map(async (feed) => {
    try {
      const res = await fetch(feed, { headers: { "User-Agent": "foresight-relay/1.0" }, cf: { cacheTtl: 120 } });
      if (!res.ok) return [];
      const src = feed.includes("bbc") ? "BBC Sport" : feed.includes("espn") ? "ESPN" : feed.includes("guardian") ? "The Guardian" : "RSS";
      return parseRss(await res.text(), src);
    } catch (e) { return []; }
  }));
  let items = results.flat();
  if (teams.length) {
    const hits = items.filter(it => teams.some(t => (it.title + " " + it.desc).toLowerCase().includes(t)));
    if (hits.length) items = hits; // fall back to all football news if no team match yet
  }
  items.sort((a, b) => b.ts - a.ts);
  items = dedupe(items);
  items.forEach(it => { const c = categorize(it); it.tag = c.tag; it.emoji = c.emoji; });
  return json(
    { ok: true, count: items.length, items: items.slice(0, 30), fetchedAt: new Date().toISOString() },
    200, acao,
    { "Cache-Control": "public, max-age=" + NEWS_CACHE_SECONDS }
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const acao = corsOrigin(request, env); // "*", allowed origin, or null (denied)
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(null, acao) });

    try {
      if (url.pathname === "/health") {
        return json({
          ok: true, host: host(env), hasCreds: !!(env && env.TXLINE_API_TOKEN),
          service: "foresight-relay", version: VERSION, activeStreams: ACTIVE_SSE,
        }, 200, acao);
      }
      if (url.pathname === "/api/scores/stream") return await proxySSE("scores", env, request, url, acao, ctx);
      if (url.pathname === "/api/odds/stream") return await proxySSE("odds", env, request, url, acao, ctx);
      if (url.pathname === "/api/news") {
        const ip = request.headers.get("CF-Connecting-IP");
        if (!allowRate("news", ip, NEWS_REQ_PER_MIN)) {
          return json({ error: "rate limited: retry later" }, 429, acao, { "Retry-After": "60" });
        }
        return await newsLane(env, url, acao);
      }
      return json({ error: "not found", paths: ["/health", "/api/scores/stream", "/api/odds/stream", "/api/news"] }, 404, acao);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500, acao);
    }
  },
};
