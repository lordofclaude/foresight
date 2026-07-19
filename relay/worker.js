import { DurableRelayStateClient, LocalRelayStateClient, RelayStateCore, STREAM_STALE_AFTER_MS } from "./state.js";

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
     /api/polymarket?home=Spain&away=Argentina&atMs=<unix-ms>
                                           -> public moneyline comparison (no key)

   Secrets (wrangler secret put … ; local: relay/.dev.vars):
     TXLINE_JWT, TXLINE_API_TOKEN, TXLINE_HOST (optional, defaults devnet)
   Optional env:
     ALLOWED_ORIGINS — comma-separated origin allowlist. When set, only listed
       origins are reflected in CORS (others get no ACAO header). When unset,
       CORS stays "*" (needed for file:// local demos + the Vercel site today).

   Hardening (2026-07-18): required fixtureId validation, fixed proof routes,
   upstream timeouts/error shaping, request IDs, per-IP rate limits, shared SSE
   admission, and server-observed freshness telemetry. RELAY_SHARED_STATE uses
   one Durable Object across isolates; older deployments without the binding
   retain a health-labeled per-isolate compatibility limiter.
*/

const VERSION = "1.3.0-market-intelligence-2026-07-18";
const DEFAULT_HOST = "https://txline-dev.txodds.com";

// ---- hardening knobs ------------------------------------------------------
const SSE_CONN_PER_MIN = 10;      // new SSE connections per IP per minute
const PROOF_REQ_PER_MIN = 30;     // validation receipt lookups per IP per minute
const NEWS_REQ_PER_MIN = 30;      // /api/news requests per IP per minute
const MARKET_REQ_PER_MIN = 30;    // /api/polymarket requests per IP per minute
const MAX_CONCURRENT_SSE = 20;    // simultaneous pass-throughs in the active state scope
const NEWS_CACHE_SECONDS = 60;    // Cache-Control max-age for /api/news
const MARKET_CACHE_SECONDS = 60;  // public Polymarket discovery/history cache
const UPSTREAM_TIMEOUT_MS = 8000; // connect/JSON/RSS deadline; SSE body is not timed

// Module-scoped JWT cache: lets a 401 refresh survive within a warm isolate.
let JWT_CACHE = null;

// Missing RELAY_SHARED_STATE preserves the existing deployed SSE behavior with
// an explicitly reported per-isolate compatibility limiter.
const LOCAL_RELAY_STATE = new LocalRelayStateClient();

function relayState(env) {
  return env && env.RELAY_SHARED_STATE
    ? new DurableRelayStateClient(env.RELAY_SHARED_STATE)
    : LOCAL_RELAY_STATE;
}

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
    "Access-Control-Allow-Headers": "Last-Event-ID, Cache-Control, Content-Type, X-Request-ID",
    "Access-Control-Expose-Headers": "Last-Event-ID, X-Request-ID, X-Relay-State-Scope",
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

function requestIdFor(request) {
  const supplied = request.headers.get("X-Request-ID");
  if (supplied && /^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/.test(supplied)) return supplied;
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `relay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function connectionIdFor() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function withRequestId(response, requestId, scope) {
  const headers = new Headers(response.headers);
  headers.set("X-Request-ID", requestId);
  if (scope) headers.set("X-Relay-State-Scope", scope);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function stateFailure(acao, requestId, capability) {
  return json({
    error: "relay shared state unavailable",
    code: "state_unavailable",
    capability,
    requestId,
    failure: { category: "shared_state", retryable: true },
  }, 503, acao, { "Retry-After": "15" });
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

function upstreamFailure(e, acao, capability, requestId) {
  if (e && e.code === "MISSING_CREDENTIALS") {
    return json({ error: "relay credentials unavailable", code: "relay_not_configured", capability, requestId,
      failure: { category: "configuration", retryable: false } }, 503, acao);
  }
  if (e && e.code === "UPSTREAM_TIMEOUT") {
    return json({ error: "upstream request timed out", code: "upstream_timeout", capability, requestId,
      failure: { category: "upstream_timeout", retryable: true } }, 504, acao);
  }
  return json({ error: "upstream request failed", code: "upstream_unavailable", capability, requestId,
    failure: { category: "upstream_transport", retryable: true } }, 502, acao);
}

/** Proxy a TxLINE SSE stream (scores|odds), refreshing the JWT once on 401. */
async function proxySSE(kind, env, req, url, acao, ctx, state, requestId) {
  const fixtureId = url.searchParams.get("fixtureId");
  if (!fixtureId || !/^[1-9]\d{0,9}$/.test(fixtureId)) {
    return json({ error: "fixtureId is required and must be a positive integer (max 10 digits)", code: "invalid_fixture_id" }, 400, acao);
  }

  const ip = req.headers.get("CF-Connecting-IP");
  const connectionId = connectionIdFor();
  let admission;
  try {
    admission = await state.admitSse({
      connectionId, kind, fixtureId, requestId, subject: ip || "unknown",
      perMinute: SSE_CONN_PER_MIN, maxConcurrent: MAX_CONCURRENT_SSE, nowMs: Date.now(),
    });
  } catch {
    return stateFailure(acao, requestId, kind + "_stream");
  }
  if (!admission.allowed && admission.reason === "rate_limited") {
    return json({ error: "rate limited: too many stream connections, retry later" }, 429, acao, { "Retry-After": "60" });
  }
  if (!admission.allowed) {
    return json({ error: "busy: too many concurrent streams, retry later" }, 503, acao, { "Retry-After": "15" });
  }

  const target = host(env) + "/api/" + kind + "/stream?fixtureId=" + encodeURIComponent(fixtureId);

  let up;
  try {
    up = await credentialedFetch(target, env, req, "text/event-stream");
  } catch (e) {
    await state.close({ connectionId, nowMs: Date.now(), reason: "upstream_error" }).catch(() => {});
    return upstreamFailure(e, acao, kind + "_stream", requestId);
  }
  if (!up.ok || !up.body) {
    await state.close({ connectionId, nowMs: Date.now(), reason: "upstream_rejected" }).catch(() => {});
    return json({
      error: "upstream stream rejected the request",
      code: "upstream_rejected",
      capability: kind + "_stream",
      upstreamStatus: up.status,
      requestId,
      failure: { category: "upstream_status", retryable: up.status >= 500 },
    }, 502, acao);
  }

  try {
    const connected = await state.connected({ connectionId, nowMs: Date.now() });
    if (!connected || connected.found !== true) throw new Error("state reservation missing");
  } catch {
    await up.body.cancel().catch(() => {});
    return stateFailure(acao, requestId, kind + "_stream");
  }

  // Pass bytes through unchanged while observing complete SSE frame boundaries.
  // Telemetry is asynchronous and never delays or mutates the upstream payload.
  const decoder = new TextDecoder();
  let carry = "";
  let pendingFrames = 0;
  let pendingBytes = 0;
  let telemetryQueue = Promise.resolve();
  const reportFrames = () => {
    if (!pendingFrames) return;
    const nowMs = Date.now();
    const frameCount = pendingFrames;
    const byteCount = pendingBytes;
    pendingFrames = 0;
    pendingBytes = 0;
    telemetryQueue = telemetryQueue.then(() => state.frame({ connectionId, nowMs, frameCount, byteCount })).catch(() => {});
  };
  const observe = (chunk, final) => {
    const decoded = decoder.decode(chunk || new Uint8Array(), { stream: !final });
    const pieces = (carry + decoded).replace(/\r\n/g, "\n").split("\n\n");
    carry = pieces.pop().slice(-8192);
    pendingFrames += pieces.length;
    pendingBytes += chunk && chunk.byteLength || 0;
    reportFrames();
  };
  const { readable, writable } = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      observe(chunk, false);
    },
    flush() { observe(new Uint8Array(), true); },
  });
  const lifecycle = up.body.pipeTo(writable)
    .then(() => "upstream_ended", () => "client_disconnect_or_pipe_error")
    .then(async reason => {
      reportFrames();
      await telemetryQueue;
      await state.close({ connectionId, nowMs: Date.now(), reason }).catch(() => {});
    });
  if (ctx && ctx.waitUntil) ctx.waitUntil(lifecycle);

  return new Response(readable, {
    status: 200,
    headers: cors({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Relay-State-Scope": state.scope,
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

async function proxyProof(capability, upstreamPath, upstreamParams, requested, env, req, acao, state, requestId) {
  const ip = req.headers.get("CF-Connecting-IP");
  let rate;
  try {
    rate = await state.takeRate({ kind: "proof", subject: ip || "unknown", perMinute: PROOF_REQ_PER_MIN, nowMs: Date.now() });
  } catch {
    return stateFailure(acao, requestId, capability);
  }
  if (!rate.allowed) {
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
        requestId,
        failure: { category: "upstream_status", retryable: up.status >= 500 },
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
      relayReceipt: { capability, requested, receivedAt: new Date().toISOString(), requestId },
    }), 200, acao);
  } catch (e) {
    return upstreamFailure(e, acao, capability, requestId);
  }
}

function fixtureValidation(env, req, url, acao, state, requestId) {
  if (!hasOnlyParams(url, ["fixtureId", "timestamp"])) {
    return invalidParam(acao, "only fixtureId and timestamp are accepted");
  }
  const fixtureId = unsignedInteger(singleParam(url, "fixtureId"), true, 9999999999);
  const timestamp = unsignedInteger(singleParam(url, "timestamp"), true, Number.MAX_SAFE_INTEGER);
  if (!fixtureId) return invalidParam(acao, "fixtureId is required and must be a positive integer (max 10 digits)", "invalid_fixture_id");
  if (!timestamp) return invalidParam(acao, "timestamp is required and must be a positive safe integer", "invalid_timestamp");
  const params = new URLSearchParams({ fixtureId, timestamp });
  return proxyProof("fixture_deadline_validation", "/api/fixtures/validation", params, { fixtureId, timestamp }, env, req, acao, state, requestId);
}

function oddsValidation(env, req, url, acao, state, requestId) {
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
  return proxyProof("odds_validation", "/api/odds/validation", params, { messageId, ts }, env, req, acao, state, requestId);
}

function statValidation(env, req, url, acao, state, requestId) {
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
  return proxyProof("score_stat_validation", "/api/scores/stat-validation", params, requested, env, req, acao, state, requestId);
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

// ---- Polymarket comparison: public Gamma discovery + public CLOB history --
// This route is deliberately read-only. It never accepts credentials, wallet
// addresses, orders, or trade parameters; it only normalizes public prices so
// the browser can compare them with TxLINE's 1X2 consensus at the same moment.
function parseArrayField(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

function cleanTeam(value) {
  const team = String(value || "").trim();
  return /^[A-Za-z][A-Za-z .'-]{1,39}$/.test(team) ? team : null;
}

function normWords(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function pickMatchEvent(events, home, away) {
  const h = normWords(home), a = normWords(away);
  const candidates = (Array.isArray(events) ? events : []).filter(event => {
    const title = normWords(event && event.title);
    return title.includes(h) && title.includes(a) && Array.isArray(event.markets);
  });
  return candidates.sort((x, y) => {
    const xt = normWords(x.title), yt = normWords(y.title);
    const exactX = xt === `${h} vs ${a}` || xt === `${a} vs ${h}` ? 1 : 0;
    const exactY = yt === `${h} vs ${a}` || yt === `${a} vs ${h}` ? 1 : 0;
    const moneyX = x.markets.filter(m => m && m.sportsMarketType === "moneyline").length;
    const moneyY = y.markets.filter(m => m && m.sportsMarketType === "moneyline").length;
    return (exactY - exactX) || (moneyY - moneyX);
  })[0] || null;
}

function moneylineSide(market, home, away) {
  if (!market) return null;
  const question = normWords(market.question || market.marketTitle);
  if (!/\bwin\b|\bdraw\b/.test(question)) return null;
  if (/\bdraw\b/.test(question)) return "draw";
  if (question.includes(normWords(home))) return "home";
  if (question.includes(normWords(away))) return "away";
  return null;
}

function yesQuote(market) {
  const outcomes = parseArrayField(market && market.outcomes);
  const prices = parseArrayField(market && market.outcomePrices);
  const tokens = parseArrayField(market && market.clobTokenIds);
  const yes = outcomes.findIndex(value => String(value).toLowerCase() === "yes");
  const index = yes >= 0 ? yes : 0;
  const price = Number(prices[index]);
  return {
    price: Number.isFinite(price) && price >= 0 && price <= 1 ? price : null,
    tokenId: tokens[index] ? String(tokens[index]) : null,
  };
}

async function historicalQuote(tokenId, atMs) {
  if (!tokenId || !atMs) return null;
  const target = Math.floor(atMs / 1000);
  const endpoint = new URL("https://clob.polymarket.com/prices-history");
  endpoint.searchParams.set("market", tokenId);
  endpoint.searchParams.set("startTs", String(target - 15 * 60));
  endpoint.searchParams.set("endTs", String(target + 15 * 60));
  endpoint.searchParams.set("fidelity", "1");
  const response = await fetchWithTimeout(endpoint.toString(), { headers: { Accept: "application/json" }, cf: { cacheTtl: MARKET_CACHE_SECONDS } });
  if (!response.ok) return null;
  const body = await response.json();
  const points = (Array.isArray(body && body.history) ? body.history : [])
    .map(point => ({ t: Number(point && point.t), p: Number(point && point.p) }))
    .filter(point => Number.isFinite(point.t) && Number.isFinite(point.p) && point.p >= 0 && point.p <= 1)
    .sort((x, y) => x.t - y.t);
  if (!points.length) return null;
  const past = points.filter(point => point.t <= target);
  if (!past.length) return null;
  const point = past[past.length - 1];
  return { price: point.p, atMs: point.t * 1000 };
}

async function polymarketLane(url, acao) {
  const home = cleanTeam(url.searchParams.get("home"));
  const away = cleanTeam(url.searchParams.get("away"));
  const atRaw = url.searchParams.get("atMs");
  const atMs = atRaw && /^\d{13}$/.test(atRaw) ? Number(atRaw) : null;
  if (!home || !away || normWords(home) === normWords(away)) {
    return json({ error: "valid distinct home and away teams are required", code: "invalid_teams" }, 400, acao);
  }
  if (atRaw && !atMs) return json({ error: "atMs must be a 13-digit unix timestamp", code: "invalid_timestamp" }, 400, acao);

  const search = new URL("https://gamma-api.polymarket.com/public-search");
  search.searchParams.set("q", `${home} vs. ${away}`);
  search.searchParams.set("limit_per_type", "20");
  search.searchParams.set("keep_closed_markets", "1");
  search.searchParams.set("search_profiles", "false");
  const response = await fetchWithTimeout(search.toString(), { headers: { Accept: "application/json", "User-Agent": "foresight-relay/1.3" }, cf: { cacheTtl: MARKET_CACHE_SECONDS } });
  if (!response.ok) return json({ error: "Polymarket discovery unavailable", code: "polymarket_upstream" }, 502, acao);
  const body = await response.json();
  const event = pickMatchEvent(body && body.events, home, away);
  if (!event) return json({ ok: true, matched: false, home, away, prices: { home: null, draw: null, away: null }, fetchedAt: new Date().toISOString() }, 200, acao, { "Cache-Control": "public, max-age=" + MARKET_CACHE_SECONDS });

  const markets = {};
  for (const market of event.markets || []) {
    const side = moneylineSide(market, home, away);
    if (side && !markets[side]) markets[side] = market;
  }
  const entries = await Promise.all(["home", "draw", "away"].map(async side => {
    const market = markets[side];
    if (!market) return [side, { price: null, atMs: null, slug: null, priceMode: "UNAVAILABLE" }];
    const current = yesQuote(market);
    if (!atMs) {
      return [side, {
        price: current.price,
        atMs: null,
        slug: market.slug || null,
        priceMode: current.price == null ? "UNAVAILABLE" : "LATEST_AVAILABLE",
      }];
    }
    let quote = null;
    try { quote = await historicalQuote(current.tokenId, atMs); } catch {}
    return [side, {
      price: quote ? quote.price : null,
      atMs: quote ? quote.atMs : null,
      slug: market.slug || null,
      priceMode: quote ? "HISTORICAL_ASOF" : "UNAVAILABLE",
    }];
  }));
  const quotes = Object.fromEntries(entries);
  const historicalCount = entries.filter(([, quote]) => quote.priceMode === "HISTORICAL_ASOF").length;
  const mode = !atMs ? "LATEST_AVAILABLE"
    : historicalCount === entries.length ? "HISTORICAL_ASOF"
      : historicalCount > 0 ? "PARTIAL_HISTORICAL_ASOF" : "HISTORICAL_UNAVAILABLE";
  return json({
    ok: true,
    matched: true,
    home,
    away,
    event: {
      title: event.title || `${home} vs. ${away}`,
      slug: event.slug || null,
      url: event.slug ? `https://polymarket.com/event/${encodeURIComponent(event.slug)}` : null,
      status: event.closed ? "RESOLVED" : event.active ? "LIVE" : "INACTIVE",
      liquidity: Number(event.liquidity) || null,
      volume: Number(event.volume) || null,
    },
    prices: {
      home: quotes.home.price,
      draw: quotes.draw.price,
      away: quotes.away.price,
    },
    quoteTimes: {
      home: quotes.home.atMs,
      draw: quotes.draw.atMs,
      away: quotes.away.atMs,
    },
    priceModes: {
      home: quotes.home.priceMode,
      draw: quotes.draw.priceMode,
      away: quotes.away.priceMode,
    },
    mode,
    requestedAtMs: atMs,
    fetchedAt: new Date().toISOString(),
  }, 200, acao, { "Cache-Control": "public, max-age=" + MARKET_CACHE_SECONDS });
}

export class RelaySharedState {
  constructor(state) {
    this.state = state;
    this.core = new RelayStateCore();
    this.queue = Promise.resolve();
    this.ready = state.blockConcurrencyWhile(async () => {
      this.core = new RelayStateCore(await state.storage.get("relay-state-v1"));
    });
  }

  fetch(request) {
    const run = () => this.handle(request);
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  async handle(request) {
    await this.ready;
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    let input;
    try { input = await request.json(); } catch { return new Response("invalid json", { status: 400 }); }
    if (!Number.isSafeInteger(input && input.nowMs)) return new Response("invalid timestamp", { status: 400 });
    const pathname = new URL(request.url).pathname;
    let result;
    if (pathname === "/rate") result = this.core.takeRate(input);
    else if (pathname === "/sse/admit") result = this.core.admitSse(input);
    else if (pathname === "/sse/connected") result = this.core.connected(input);
    else if (pathname === "/sse/frame") result = this.core.frame(input);
    else if (pathname === "/sse/close") result = this.core.close(input);
    else if (pathname === "/snapshot") result = this.core.snapshot(input.nowMs);
    else return new Response("not found", { status: 404 });
    await this.state.storage.put("relay-state-v1", this.core.export());
    return new Response(JSON.stringify(result), {
      status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}

async function dispatch(request, env, ctx, requestId, state) {
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
      const warnings = openCors ? ["ALLOWED_ORIGINS is unset; browser access is allowed from any origin"] : [];
      if (state.scope === "per_isolate_fallback") warnings.push("RELAY_SHARED_STATE is absent; rate and concurrency limits are per-isolate compatibility enforcement");
      let telemetry;
      let stateStatus = "ready";
      try {
        telemetry = await state.snapshot(Date.now());
      } catch {
        telemetry = { activeStreams: 0, staleAfterMs: STREAM_STALE_AFTER_MS, streams: [] };
        stateStatus = "unavailable";
        warnings.push("relay shared state is unavailable; state-dependent routes fail closed");
      }
      return json({
        ok: true, host: host(env), hasCreds: !!(env && env.TXLINE_API_TOKEN),
        service: "foresight-relay", version: VERSION, activeStreams: telemetry.activeStreams,
        corsMode: openCors ? "open" : "allowlist", warnings,
        capabilities: [
          "scores_stream", "odds_stream", "football_news", "polymarket_public_prices",
          "fixture_deadline_validation", "odds_validation", "score_stat_validation",
        ],
        capabilityStatus: {
          stateScope: state.scope,
          stateStatus,
          streamTelemetry: "server_observed_sse_frames",
          streamStates: ["connecting_upstream", "connected_waiting_first_frame", "fresh", "stale", "ended", "error"],
        },
        streamTelemetry: telemetry,
      }, 200, acao);
    }
    if (url.pathname === "/api/scores/stream") return await proxySSE("scores", env, request, url, acao, ctx, state, requestId);
    if (url.pathname === "/api/odds/stream") return await proxySSE("odds", env, request, url, acao, ctx, state, requestId);
    if (url.pathname === "/api/fixtures/validation") return await fixtureValidation(env, request, url, acao, state, requestId);
    if (url.pathname === "/api/odds/validation") return await oddsValidation(env, request, url, acao, state, requestId);
    if (url.pathname === "/api/scores/stat-validation") return await statValidation(env, request, url, acao, state, requestId);
    if (url.pathname === "/api/news") {
      const ip = request.headers.get("CF-Connecting-IP");
      let rate;
      try {
        rate = await state.takeRate({ kind: "news", subject: ip || "unknown", perMinute: NEWS_REQ_PER_MIN, nowMs: Date.now() });
      } catch {
        return stateFailure(acao, requestId, "football_news");
      }
      if (!rate.allowed) return json({ error: "rate limited: retry later" }, 429, acao, { "Retry-After": "60" });
      return await newsLane(env, url, acao);
    }
    if (url.pathname === "/api/polymarket") {
      const ip = request.headers.get("CF-Connecting-IP");
      let rate;
      try {
        rate = await state.takeRate({ kind: "polymarket", subject: ip || "unknown", perMinute: MARKET_REQ_PER_MIN, nowMs: Date.now() });
      } catch {
        return stateFailure(acao, requestId, "polymarket_public_prices");
      }
      if (!rate.allowed) return json({ error: "rate limited: retry later" }, 429, acao, { "Retry-After": "60" });
      return await polymarketLane(url, acao);
    }
    return json({
      error: "not found",
      paths: [
        "/health", "/api/scores/stream", "/api/odds/stream", "/api/news", "/api/polymarket",
        "/api/fixtures/validation", "/api/odds/validation", "/api/scores/stat-validation",
      ],
    }, 404, acao);
  } catch {
    return json({ error: "internal relay error", code: "internal_error", requestId,
      failure: { category: "internal", retryable: false } }, 500, acao);
  }
}

export default {
  async fetch(request, env, ctx) {
    const requestId = requestIdFor(request);
    let state;
    try { state = relayState(env); } catch { state = null; }
    const scope = state ? state.scope : "unavailable";
    const response = state
      ? await dispatch(request, env, ctx, requestId, state)
      : stateFailure(corsOrigin(request, env), requestId, "relay_state");
    return withRequestId(response, requestId, scope);
  },
};
