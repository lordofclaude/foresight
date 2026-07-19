/* Foresight Relay — Cloudflare Worker (runs locally via `wrangler dev`, deploys via `wrangler deploy`).

   Why this exists: TxLINE's live endpoints require an Authorization JWT + X-Api-Token.
   Those must NEVER ship to a public browser page. This relay holds them server-side
   and re-emits the SAME real SSE stream to the browser, plus a football news lane.

   It mirrors TxLINE's own paths (/api/scores/stream, /api/odds/stream) so the app's
   already-tested TxReal.streamLive() client works against it with only a host swap —
   zero new browser stream code.

   Endpoints (all GET, read-only):
     /health                              -> service status + capabilities
     /api/scores/stream?fixtureId=<id>    -> proxied real SSE (scores)
     /api/odds/stream?fixtureId=<id>      -> proxied real SSE (odds)
     /api/fixtures/validation?fixtureId=<id>&timestamp=<unix-ms>
     /api/odds/validation?messageId=<id>&ts=<unix-ms>
     /api/scores/stat-validation?fixtureId=<id>&statKey=<key>&value=<n>&seq=<n>
     /api/news?teams=England,France       -> merged football news JSON (RSS, no key)

   Secrets (wrangler secret put … ; local: relay/.dev.vars):
     TXLINE_JWT, TXLINE_API_TOKEN, TXLINE_HOST (optional, defaults devnet)
   Optional env:
     ALLOWED_ORIGINS — comma-separated origin allowlist. When set, only listed
       origins are reflected in CORS (others get no ACAO header). When unset,
       CORS stays "*" (needed for file:// local demos + the Vercel site today).

   Hardening (2026-07-18): required fixtureId validation, fixed proof routes,
   upstream timeouts/error shaping, per-IP token-bucket rate limits (SSE 10/min,
   proof/news 30/min), concurrent-SSE cap (20), and explicit cache policy.
   NOTE: rate/concurrency state is per-isolate in-memory — best-effort only.
   Cloudflare may run many isolates across PoPs, each with its own counters.
   Good enough to stop casual abuse for a hackathon; use Durable Objects or
   Cloudflare Rate Limiting rules for real global enforcement.
*/

const VERSION = "1.2.0-proof-relay-2026-07-18";
const DEFAULT_HOST = "https://txline-dev.txodds.com";

// ---- hardening knobs ------------------------------------------------------
const SSE_CONN_PER_MIN = 10;      // new SSE connections per IP per minute
const PROOF_REQ_PER_MIN = 30;     // validation receipt lookups per IP per minute
const NEWS_REQ_PER_MIN = 30;      // /api/news requests per IP per minute
const MAX_CONCURRENT_SSE = 20;    // simultaneous SSE pass-throughs per isolate
const MAX_BUCKETS = 2000;         // bound rate-limit memory per isolate
const NEWS_CACHE_SECONDS = 60;    // Cache-Control max-age for /api/news
const UPSTREAM_TIMEOUT_MS = 8000; // connect/JSON/RSS deadline; SSE body is not timed

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
    "Access-Control-Allow-Headers": "Last-Event-ID, Cache-Control, Content-Type",
    "Access-Control-Expose-Headers": "Last-Event-ID",
    "X-Content-Type-Options": "nosniff",
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
    headers: cors(Object.assign({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    }, extraHeaders || {}), acao),
  });
}

function host(env) { return (env && env.TXLINE_HOST) || DEFAULT_HOST; }
function jwt(env) { return JWT_CACHE || (env && env.TXLINE_JWT) || null; }

async function fetchWithTimeout(target, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(target, Object.assign({}, init || {}, { signal: controller.signal }));
  } catch (e) {
    if (controller.signal.aborted) {
      const timeout = new Error("upstream timeout");
      timeout.code = "UPSTREAM_TIMEOUT";
      throw timeout;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Mint a fresh 30-day guest JWT (same call txline-real.js uses). */
async function refreshJwt(env) {
  const res = await fetchWithTimeout(host(env) + "/auth/guest/start", { method: "POST" });
  if (!res.ok) throw new Error("guest authentication failed with status " + res.status);
  const body = await res.json().catch(() => null);
  JWT_CACHE = (body && (body.token || body.jwt)) || (typeof body === "string" ? body : null);
  if (!JWT_CACHE) throw new Error("guest authentication returned no token");
  return JWT_CACHE;
}

function upstreamHeaders(env, req, accept) {
  const h = {
    Authorization: "Bearer " + jwt(env),
    "X-Api-Token": env.TXLINE_API_TOKEN || "",
    Accept: accept || "application/json",
    "Cache-Control": "no-cache",
  };
  const lei = req.headers.get("Last-Event-ID");
  if (lei && lei.length <= 256 && !/[\r\n]/.test(lei)) h["Last-Event-ID"] = lei;
  return h;
}

async function credentialedFetch(target, env, req, accept) {
  if (!(env && env.TXLINE_API_TOKEN)) {
    const e = new Error("relay credentials unavailable");
    e.code = "MISSING_CREDENTIALS";
    throw e;
  }
  if (!jwt(env)) await refreshJwt(env);
  let up = await fetchWithTimeout(target, { headers: upstreamHeaders(env, req, accept) });
  if (up.status === 401) {
    JWT_CACHE = null;
    await refreshJwt(env);
    up = await fetchWithTimeout(target, { headers: upstreamHeaders(env, req, accept) });
  }
  return up;
}

function upstreamFailure(e, acao, capability) {
  if (e && e.code === "MISSING_CREDENTIALS") {
    return json({ error: "relay credentials unavailable", code: "relay_not_configured", capability }, 503, acao);
  }
  if (e && e.code === "UPSTREAM_TIMEOUT") {
    return json({ error: "upstream request timed out", code: "upstream_timeout", capability }, 504, acao);
  }
  return json({ error: "upstream request failed", code: "upstream_unavailable", capability }, 502, acao);
}

/** Proxy a TxLINE SSE stream (scores|odds), refreshing the JWT once on 401. */
async function proxySSE(kind, env, req, url, acao, ctx) {
  const fixtureId = url.searchParams.get("fixtureId");
  if (!fixtureId || !/^[1-9]\d{0,9}$/.test(fixtureId)) {
    return json({ error: "fixtureId is required and must be a positive integer (max 10 digits)", code: "invalid_fixture_id" }, 400, acao);
  }

  const ip = req.headers.get("CF-Connecting-IP");
  if (!allowRate("sse", ip, SSE_CONN_PER_MIN)) {
    return json({ error: "rate limited: too many stream connections, retry later" }, 429, acao, { "Retry-After": "60" });
  }
  if (ACTIVE_SSE >= MAX_CONCURRENT_SSE) {
    return json({ error: "busy: too many concurrent streams, retry later" }, 503, acao, { "Retry-After": "15" });
  }

  const target = host(env) + "/api/" + kind + "/stream?fixtureId=" + encodeURIComponent(fixtureId);

  let up;
  try {
    up = await credentialedFetch(target, env, req, "text/event-stream");
  } catch (e) {
    return upstreamFailure(e, acao, kind + "_stream");
  }
  if (!up.ok || !up.body) {
    return json({
      error: "upstream stream rejected the request",
      code: "upstream_rejected",
      capability: kind + "_stream",
      upstreamStatus: up.status,
    }, 502, acao);
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

// ---- fixed TxLINE proof seams (read-only; never an arbitrary path proxy) --
function invalidParam(acao, message, code) {
  return json({ error: message, code: code || "invalid_parameters" }, 400, acao);
}

function hasOnlyParams(url, allowed) {
  const keys = new Set(allowed);
  for (const key of url.searchParams.keys()) if (!keys.has(key)) return false;
  return true;
}

function singleParam(url, name) {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function unsignedInteger(raw, positive, max) {
  const re = positive ? /^[1-9]\d{0,15}$/ : /^(?:0|[1-9]\d{0,15})$/;
  if (!re.test(String(raw == null ? "" : raw))) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < (positive ? 1 : 0) || n > max) return null;
  return String(n);
}

async function readJsonWithTimeout(res) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error("upstream response timeout");
      e.code = "UPSTREAM_TIMEOUT";
      reject(e);
    }, UPSTREAM_TIMEOUT_MS);
  });
  try {
    return await Promise.race([res.json(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function proxyProof(capability, upstreamPath, upstreamParams, requested, env, req, acao) {
  const ip = req.headers.get("CF-Connecting-IP");
  if (!allowRate("proof", ip, PROOF_REQ_PER_MIN)) {
    return json({ error: "rate limited: retry later", code: "rate_limited" }, 429, acao, { "Retry-After": "60" });
  }

  let up;
  try {
    const target = host(env) + upstreamPath + "?" + upstreamParams.toString();
    up = await credentialedFetch(target, env, req, "application/json");
    if (!up.ok) {
      return json({
        error: "upstream validation rejected the request",
        code: "upstream_rejected",
        capability,
        upstreamStatus: up.status,
      }, 502, acao);
    }
    const body = await readJsonWithTimeout(up);
    const base = body && typeof body === "object" && !Array.isArray(body) ? body : { data: body };
    return json(Object.assign({}, base, {
      proofStatus: "api_received_not_cryptographically_verified",
      verificationStatus: "not_verified",
      verified: false,
      cryptographicallyVerified: false,
      apiReceived: true,
      relayReceipt: { capability, requested, receivedAt: new Date().toISOString() },
    }), 200, acao);
  } catch (e) {
    return upstreamFailure(e, acao, capability);
  }
}

function fixtureValidation(env, req, url, acao) {
  if (!hasOnlyParams(url, ["fixtureId", "timestamp"])) {
    return invalidParam(acao, "only fixtureId and timestamp are accepted");
  }
  const fixtureId = unsignedInteger(singleParam(url, "fixtureId"), true, 9999999999);
  const timestamp = unsignedInteger(singleParam(url, "timestamp"), true, Number.MAX_SAFE_INTEGER);
  if (!fixtureId) return invalidParam(acao, "fixtureId is required and must be a positive integer (max 10 digits)", "invalid_fixture_id");
  if (!timestamp) return invalidParam(acao, "timestamp is required and must be a positive safe integer", "invalid_timestamp");
  const params = new URLSearchParams({ fixtureId, timestamp });
  return proxyProof("fixture_deadline_validation", "/api/fixtures/validation", params, { fixtureId, timestamp }, env, req, acao);
}

function oddsValidation(env, req, url, acao) {
  if (!hasOnlyParams(url, ["messageId", "ts"])) {
    return invalidParam(acao, "only messageId and ts are accepted");
  }
  const messageId = singleParam(url, "messageId");
  const ts = unsignedInteger(singleParam(url, "ts"), true, Number.MAX_SAFE_INTEGER);
  if (!messageId || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(messageId)) {
    return invalidParam(acao, "messageId is required and contains unsupported characters", "invalid_message_id");
  }
  if (!ts) return invalidParam(acao, "ts is required and must be a positive safe integer", "invalid_timestamp");
  const params = new URLSearchParams({ messageId, ts });
  return proxyProof("odds_validation", "/api/odds/validation", params, { messageId, ts }, env, req, acao);
}

function statValidation(env, req, url, acao) {
  if (!hasOnlyParams(url, ["fixtureId", "seq", "statKey", "value", "statKeys"])) {
    return invalidParam(acao, "only fixtureId, seq, statKey, value, and statKeys are accepted");
  }
  const fixtureId = unsignedInteger(singleParam(url, "fixtureId"), true, 9999999999);
  const seq = unsignedInteger(singleParam(url, "seq"), false, Number.MAX_SAFE_INTEGER);
  if (!fixtureId) return invalidParam(acao, "fixtureId is required and must be a positive integer (max 10 digits)", "invalid_fixture_id");
  if (seq === null) return invalidParam(acao, "seq is required and must be a non-negative safe integer", "invalid_seq");

  const statKeyRaw = singleParam(url, "statKey");
  const statKeysRaw = singleParam(url, "statKeys");
  if (!!statKeyRaw === !!statKeysRaw) {
    return invalidParam(acao, "provide exactly one of statKey or statKeys", "invalid_stat_key");
  }

  let statKeys;
  let value = null;
  if (statKeyRaw) {
    const statKey = unsignedInteger(statKeyRaw, true, 999999);
    value = unsignedInteger(singleParam(url, "value"), false, 999999);
    if (!statKey) return invalidParam(acao, "statKey must be a positive integer no greater than 999999", "invalid_stat_key");
    if (value === null) return invalidParam(acao, "value is required with statKey and must be a non-negative integer", "invalid_stat_value");
    statKeys = statKey;
  } else {
    if (url.searchParams.has("value")) return invalidParam(acao, "value is only accepted with statKey", "invalid_stat_value");
    const parts = statKeysRaw.split(",");
    if (!parts.length || parts.length > 8) return invalidParam(acao, "statKeys must contain 1 to 8 comma-separated keys", "invalid_stat_key");
    const parsed = parts.map(k => unsignedInteger(k, true, 999999));
    if (parsed.some(k => !k)) return invalidParam(acao, "statKeys contains an invalid key", "invalid_stat_key");
    statKeys = parsed.join(",");
  }

  const params = new URLSearchParams({ fixtureId, seq, statKeys });
  const requested = { fixtureId, seq, statKeys };
  if (value !== null) requested.expectedValue = value;
  return proxyProof("score_stat_validation", "/api/scores/stat-validation", params, requested, env, req, acao);
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
      const res = await fetchWithTimeout(feed, { headers: { "User-Agent": "foresight-relay/1.0" }, cf: { cacheTtl: 120 } });
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
    const suppliedOrigin = request.headers.get("Origin");
    if (suppliedOrigin && acao === null) {
      return json({ error: "origin not allowed", code: "origin_not_allowed" }, 403, null);
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors({ "Cache-Control": "no-store" }, acao) });
    if (request.method !== "GET") {
      return json({ error: "method not allowed", code: "method_not_allowed" }, 405, acao, { Allow: "GET, OPTIONS" });
    }

    try {
      if (url.pathname === "/health") {
        const openCors = !(env && env.ALLOWED_ORIGINS && env.ALLOWED_ORIGINS.trim());
        return json({
          ok: true, host: host(env), hasCreds: !!(env && env.TXLINE_API_TOKEN),
          service: "foresight-relay", version: VERSION, activeStreams: ACTIVE_SSE,
          corsMode: openCors ? "open" : "allowlist",
          warnings: openCors ? ["ALLOWED_ORIGINS is unset; browser access is allowed from any origin"] : [],
          capabilities: [
            "scores_stream", "odds_stream", "football_news",
            "fixture_deadline_validation", "odds_validation", "score_stat_validation",
          ],
        }, 200, acao);
      }
      if (url.pathname === "/api/scores/stream") return await proxySSE("scores", env, request, url, acao, ctx);
      if (url.pathname === "/api/odds/stream") return await proxySSE("odds", env, request, url, acao, ctx);
      if (url.pathname === "/api/fixtures/validation") return await fixtureValidation(env, request, url, acao);
      if (url.pathname === "/api/odds/validation") return await oddsValidation(env, request, url, acao);
      if (url.pathname === "/api/scores/stat-validation") return await statValidation(env, request, url, acao);
      if (url.pathname === "/api/news") {
        const ip = request.headers.get("CF-Connecting-IP");
        if (!allowRate("news", ip, NEWS_REQ_PER_MIN)) {
          return json({ error: "rate limited: retry later" }, 429, acao, { "Retry-After": "60" });
        }
        return await newsLane(env, url, acao);
      }
      return json({
        error: "not found",
        paths: [
          "/health", "/api/scores/stream", "/api/odds/stream", "/api/news",
          "/api/fixtures/validation", "/api/odds/validation", "/api/scores/stat-validation",
        ],
      }, 404, acao);
    } catch (e) {
      return json({ error: "internal relay error", code: "internal_error" }, 500, acao);
    }
  },
};
