import test from "node:test";
import assert from "node:assert/strict";
import worker, { RelaySharedState } from "./worker.js";
import { DurableRelayStateClient, LocalRelayStateClient, RelayStateCore, STREAM_STALE_AFTER_MS } from "./state.js";

const env = { TXLINE_JWT: "test-jwt", TXLINE_API_TOKEN: "test-token" };
const req = (path, init = {}) => new Request("https://relay.test" + path, init);

function durableHarness() {
  const data = new Map();
  const state = {
    storage: {
      get: async key => data.get(key),
      put: async (key, value) => { data.set(key, structuredClone(value)); },
    },
    blockConcurrencyWhile: action => action(),
  };
  let durable = new RelaySharedState(state);
  const namespace = {
    idFromName: name => name,
    get: () => ({ fetch: (url, init) => durable.fetch(new Request(url, init)) }),
    restart: () => { durable = new RelaySharedState(state); },
  };
  return { namespace, data };
}

test("streams require a valid fixtureId", async () => {
  let res = await worker.fetch(req("/api/scores/stream"), env, {});
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_fixture_id");

  res = await worker.fetch(req("/api/odds/stream?fixtureId=0"), env, {});
  assert.equal(res.status, 400);
});

test("allowlisted CORS reflects allowed origins and rejects other browser origins", async () => {
  const corsEnv = { ...env, ALLOWED_ORIGINS: "https://app.example" };
  let res = await worker.fetch(req("/health", { headers: { Origin: "https://app.example" } }), corsEnv, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://app.example");

  res = await worker.fetch(req("/health", { headers: { Origin: "https://evil.example" } }), corsEnv, {});
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

test("news route parses and decodes RSS items", async () => {
  const xml = "<rss><channel><item><title><![CDATA[England &amp; France team news]]></title>" +
    "<link>https://news.example/match</link><description>Starting XI</description>" +
    "<pubDate>Sat, 18 Jul 2026 12:00:00 GMT</pubDate></item></channel></rss>";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(xml, { status: 200 });
  try {
    const res = await worker.fetch(req("/api/news", { headers: { "CF-Connecting-IP": "rss-test" } }), env, {});
    const body = await res.json();
    assert.equal(body.count, 1);
    assert.equal(body.items[0].title, "England & France team news");
    assert.ok(body.items[0].ts > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("news route rate limit rejects the 31st immediate request", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<rss><channel></channel></rss>", { status: 200 });
  try {
    const ip = "rate-test-" + Math.random();
    for (let i = 0; i < 30; i++) {
      const res = await worker.fetch(req("/api/news", { headers: { "CF-Connecting-IP": ip } }), env, {});
      assert.equal(res.status, 200);
    }
    const limited = await worker.fetch(req("/api/news", { headers: { "CF-Connecting-IP": ip } }), env, {});
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("Retry-After"), "60");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Polymarket route returns exact-match historical moneyline comparison", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const priceByToken = { "home-token": 0.41, "draw-token": 0.32, "away-token": 0.27 };
  globalThis.fetch = async url => {
    calls.push(String(url));
    const parsed = new URL(String(url));
    if (parsed.hostname === "gamma-api.polymarket.com") {
      return new Response(JSON.stringify({ events: [{
        title: "Spain vs. Argentina", slug: "fifwc-esp-arg", active: true, closed: false,
        liquidity: 1200000, volume: 3400000,
        markets: [
          { question: "Will Spain win?", sportsMarketType: "moneyline", outcomes: '["Yes","No"]', outcomePrices: '["0.42","0.58"]', clobTokenIds: '["home-token","home-no"]', slug: "spain" },
          { question: "Will Spain vs. Argentina end in a draw?", sportsMarketType: "moneyline", outcomes: '["Yes","No"]', outcomePrices: '["0.31","0.69"]', clobTokenIds: '["draw-token","draw-no"]', slug: "draw" },
          { question: "Will Argentina win?", sportsMarketType: "moneyline", outcomes: '["Yes","No"]', outcomePrices: '["0.27","0.73"]', clobTokenIds: '["away-token","away-no"]', slug: "argentina" },
        ],
      }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const token = parsed.searchParams.get("market");
    return new Response(JSON.stringify({ history: [{ t: 1784141960, p: priceByToken[token] }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const res = await worker.fetch(req("/api/polymarket?home=Spain&away=Argentina&atMs=1784142020504", { headers: { "CF-Connecting-IP": `poly-${Math.random()}` } }), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.matched, true);
    assert.equal(body.mode, "HISTORICAL_ASOF");
    assert.deepEqual(body.prices, { home: 0.41, draw: 0.32, away: 0.27 });
    assert.deepEqual(body.priceModes, { home: "HISTORICAL_ASOF", draw: "HISTORICAL_ASOF", away: "HISTORICAL_ASOF" });
    assert.equal(body.event.url, "https://polymarket.com/event/fifwc-esp-arg");
    assert.equal(calls.filter(url => url.includes("prices-history")).length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Polymarket route never substitutes current prices for missing historical quotes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const parsed = new URL(String(url));
    if (parsed.hostname === "gamma-api.polymarket.com") {
      return new Response(JSON.stringify({ events: [{
        title: "Spain vs. Argentina", slug: "fifwc-esp-arg", active: false, closed: true,
        markets: [
          { question: "Will Spain win?", sportsMarketType: "moneyline", outcomes: '["Yes","No"]', outcomePrices: '["0.99","0.01"]', clobTokenIds: '["home-token","home-no"]', slug: "spain" },
          { question: "Will Spain vs. Argentina end in a draw?", sportsMarketType: "moneyline", outcomes: '["Yes","No"]', outcomePrices: '["0.005","0.995"]', clobTokenIds: '["draw-token","draw-no"]', slug: "draw" },
          { question: "Will Argentina win?", sportsMarketType: "moneyline", outcomes: '["Yes","No"]', outcomePrices: '["0.005","0.995"]', clobTokenIds: '["away-token","away-no"]', slug: "argentina" },
        ],
      }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const token = parsed.searchParams.get("market");
    if (token === "draw-token") throw new Error("CLOB timeout");
    if (token === "away-token") return new Response(JSON.stringify({ history: [{ t: 1784142100, p: 0.27 }] }), { status: 200 });
    return new Response(JSON.stringify({ history: [{ t: 1784141960, p: 0.41 }] }), { status: 200 });
  };
  try {
    const res = await worker.fetch(req("/api/polymarket?home=Spain&away=Argentina&atMs=1784142020504", { headers: { "CF-Connecting-IP": `poly-partial-${Math.random()}` } }), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, "PARTIAL_HISTORICAL_ASOF");
    assert.deepEqual(body.prices, { home: 0.41, draw: null, away: null });
    assert.deepEqual(body.priceModes, { home: "HISTORICAL_ASOF", draw: "UNAVAILABLE", away: "UNAVAILABLE" });
    assert.deepEqual(body.quoteTimes, { home: 1784141960000, draw: null, away: null });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Polymarket route uses current prices only when no as-of timestamp is requested", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const parsed = new URL(String(url));
    assert.equal(parsed.hostname, "gamma-api.polymarket.com");
    return new Response(JSON.stringify({ events: [{
      title: "Spain vs. Argentina", slug: "fifwc-esp-arg", active: true, closed: false,
      markets: [
        { question: "Will Spain win?", sportsMarketType: "moneyline", outcomes: '["Yes","No"]', outcomePrices: '["0.42","0.58"]', clobTokenIds: '["home-token","home-no"]' },
        { question: "Will Spain vs. Argentina end in a draw?", sportsMarketType: "moneyline", outcomes: '["Yes","No"]', outcomePrices: '["0.31","0.69"]', clobTokenIds: '["draw-token","draw-no"]' },
        { question: "Will Argentina win?", sportsMarketType: "moneyline", outcomes: '["Yes","No"]', outcomePrices: '["0.27","0.73"]', clobTokenIds: '["away-token","away-no"]' },
      ],
    }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const res = await worker.fetch(req("/api/polymarket?home=Spain&away=Argentina", { headers: { "CF-Connecting-IP": `poly-latest-${Math.random()}` } }), env, {});
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.mode, "LATEST_AVAILABLE");
    assert.deepEqual(body.prices, { home: 0.42, draw: 0.31, away: 0.27 });
    assert.deepEqual(body.priceModes, { home: "LATEST_AVAILABLE", draw: "LATEST_AVAILABLE", away: "LATEST_AVAILABLE" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Polymarket route rejects invalid team and timestamp inputs", async () => {
  let res = await worker.fetch(req("/api/polymarket?home=Spain&away=Spain", { headers: { "CF-Connecting-IP": `poly-invalid-${Math.random()}` } }), env, {});
  assert.equal(res.status, 400);
  res = await worker.fetch(req("/api/polymarket?home=Spain&away=Argentina&atMs=yesterday", { headers: { "CF-Connecting-IP": `poly-invalid-${Math.random()}` } }), env, {});
  assert.equal(res.status, 400);
});

test("proof routes validate parameters and construct only documented upstream paths", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ upstreamReceipt: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    let res = await worker.fetch(req("/api/fixtures/validation?fixtureId=7&timestamp=1784418232498"), env, {});
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.proofStatus, "api_received_not_cryptographically_verified");
    assert.equal(body.cryptographicallyVerified, false);

    res = await worker.fetch(req("/api/odds/validation?messageId=1838400688%3A00003%3A000002-10021-stab&ts=1784418232498"), env, {});
    assert.equal(res.status, 200);

    res = await worker.fetch(req("/api/scores/stat-validation?fixtureId=7&statKey=1001&value=0&seq=9"), env, {});
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.relayReceipt.requested.expectedValue, "0");

    assert.equal(new URL(calls[0].url).pathname, "/api/fixtures/validation");
    assert.deepEqual(Object.fromEntries(new URL(calls[0].url).searchParams), { fixtureId: "7", timestamp: "1784418232498" });
    assert.equal(new URL(calls[1].url).pathname, "/api/odds/validation");
    assert.deepEqual(Object.fromEntries(new URL(calls[1].url).searchParams), {
      messageId: "1838400688:00003:000002-10021-stab", ts: "1784418232498",
    });
    assert.equal(new URL(calls[2].url).pathname, "/api/scores/stat-validation");
    assert.deepEqual(Object.fromEntries(new URL(calls[2].url).searchParams), { fixtureId: "7", seq: "9", statKeys: "1001" });
    assert.equal(calls.every(call => call.init.headers.Authorization === "Bearer test-jwt"), true);

    res = await worker.fetch(req("/api/odds/validation?messageId=bad%2Fpath&ts=1"), env, {});
    assert.equal(res.status, 400);
    res = await worker.fetch(req("/api/scores/stat-validation?fixtureId=7&statKey=1001&seq=9"), env, {});
    assert.equal(res.status, 400);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("existing statKeys client shape remains compatible", async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl;
  globalThis.fetch = async url => {
    calledUrl = String(url);
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const res = await worker.fetch(req("/api/scores/stat-validation?fixtureId=7&seq=9&statKeys=1001%2C3001"), env, {});
    assert.equal(res.status, 200);
    assert.equal(new URL(calledUrl).searchParams.get("statKeys"), "1001,3001");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("two Durable Object clients share durable rate and concurrent-stream limits", async () => {
  const { namespace } = durableHarness();
  const instanceA = new DurableRelayStateClient(namespace);
  const instanceB = new DurableRelayStateClient(namespace);
  const nowMs = 2_000_000_000_000;
  assert.equal((await instanceA.takeRate({ kind: "proof", subject: "same-ip", perMinute: 2, nowMs })).allowed, true);
  assert.equal((await instanceB.takeRate({ kind: "proof", subject: "same-ip", perMinute: 2, nowMs })).allowed, true);
  namespace.restart();
  assert.equal((await instanceA.takeRate({ kind: "proof", subject: "same-ip", perMinute: 2, nowMs })).allowed, false);

  const base = { kind: "scores", fixtureId: "7", subject: "stream-ip", perMinute: 10, maxConcurrent: 1, nowMs };
  assert.equal((await instanceA.admitSse({ ...base, connectionId: "conn-a", requestId: "request-a" })).allowed, true);
  const blocked = await instanceB.admitSse({ ...base, connectionId: "conn-b", requestId: "request-b" });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "concurrency_limited");
  await instanceA.close({ connectionId: "conn-a", nowMs: nowMs + 1, reason: "ended" });
  assert.equal((await instanceB.admitSse({ ...base, connectionId: "conn-b", requestId: "request-b", nowMs: nowMs + 2 })).allowed, true);
});

test("stream telemetry distinguishes connecting, first frame, stale, and ended", async () => {
  const core = new RelayStateCore();
  const state = new LocalRelayStateClient(core);
  const nowMs = 2_000_000_000_000;
  await state.admitSse({
    connectionId: "telemetry-1", kind: "odds", fixtureId: "8", requestId: "telemetry-request",
    subject: "ip", perMinute: 10, maxConcurrent: 20, nowMs,
  });
  let stream = (await state.snapshot(nowMs)).streams[0];
  assert.equal(stream.status, "connecting_upstream");
  assert.equal(stream.connected, false);
  assert.equal(stream.hasFirstFrame, false);

  await state.connected({ connectionId: "telemetry-1", nowMs: nowMs + 1 });
  stream = (await state.snapshot(nowMs + 1)).streams[0];
  assert.equal(stream.status, "connected_waiting_first_frame");
  assert.equal(stream.connected, true);
  assert.equal(stream.hasFirstFrame, false);

  await state.frame({ connectionId: "telemetry-1", nowMs: nowMs + 2, frameCount: 2, byteCount: 42 });
  stream = (await state.snapshot(nowMs + 2)).streams[0];
  assert.equal(stream.status, "fresh");
  assert.equal(stream.framesObserved, 2);
  assert.equal(stream.bytesObserved, 42);

  stream = (await state.snapshot(nowMs + 2 + STREAM_STALE_AFTER_MS + 1)).streams[0];
  assert.equal(stream.status, "stale");
  assert.equal(stream.stale, true);
  assert.equal(stream.lastFrameAgeMs, STREAM_STALE_AFTER_MS + 1);

  await state.close({ connectionId: "telemetry-1", nowMs: nowMs + STREAM_STALE_AFTER_MS + 4, reason: "upstream_ended" });
  const snapshot = await state.snapshot(nowMs + STREAM_STALE_AFTER_MS + 4);
  assert.equal(snapshot.activeStreams, 0);
  assert.equal(snapshot.streams[0].status, "ended");
  assert.equal(snapshot.streams[0].endReason, "upstream_ended");
});

test("client disconnect cleans up shared concurrent-SSE accounting", async () => {
  const { namespace } = durableHarness();
  const streamEnv = { ...env, RELAY_SHARED_STATE: namespace };
  const waits = [];
  let upstreamCancelled = false;
  const encoder = new TextEncoder();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode("data: {\"ok\":true}\n\n")); },
    cancel() { upstreamCancelled = true; },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  try {
    const response = await worker.fetch(req("/api/scores/stream?fixtureId=7", {
      headers: { "CF-Connecting-IP": "disconnect-ip", "X-Request-ID": "disconnect-request-1" },
    }), streamEnv, { waitUntil: promise => waits.push(promise) });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    await reader.cancel();
    await Promise.allSettled(waits);
    assert.equal(upstreamCancelled, true);

    const health = await worker.fetch(req("/health"), streamEnv, {});
    const body = await health.json();
    const telemetry = body.streamTelemetry.streams.find(item => item.requestId === "disconnect-request-1");
    assert.equal(body.activeStreams, 0);
    assert.equal(telemetry.hasFirstFrame, true);
    assert.equal(telemetry.status, "ended");
    assert.equal(telemetry.endReason, "client_disconnect_or_pipe_error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("health remains backward compatible without Durable Object binding", async () => {
  const response = await worker.fetch(req("/health", { headers: { "X-Request-ID": "health-request-123" } }), env, {});
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Request-ID"), "health-request-123");
  assert.equal(body.ok, true);
  assert.equal(typeof body.activeStreams, "number");
  assert.equal(body.capabilities.includes("scores_stream"), true);
  assert.equal(body.capabilityStatus.stateScope, "per_isolate_fallback");
  assert.equal(body.warnings.some(message => message.includes("per-isolate")), true);
});

test("SSE remains usable through the per-isolate compatibility path", async () => {
  const originalFetch = globalThis.fetch;
  const waits = [];
  globalThis.fetch = async () => new Response("data: {\"fixtureId\":7}\n\n", {
    status: 200, headers: { "Content-Type": "text/event-stream" },
  });
  try {
    const response = await worker.fetch(req("/api/scores/stream?fixtureId=7", {
      headers: { "CF-Connecting-IP": "fallback-stream-ip", "X-Request-ID": "fallback-stream-request" },
    }), env, { waitUntil: promise => waits.push(promise) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Relay-State-Scope"), "per_isolate_fallback");
    assert.equal(await response.text(), "data: {\"fixtureId\":7}\n\n");
    await Promise.allSettled(waits);
    const health = await worker.fetch(req("/health"), env, {});
    const body = await health.json();
    const telemetry = body.streamTelemetry.streams.find(item => item.requestId === "fallback-stream-request");
    assert.equal(telemetry.hasFirstFrame, true);
    assert.equal(telemetry.status, "ended");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("health reports stale shared upstream telemetry", async () => {
  const { namespace } = durableHarness();
  const client = new DurableRelayStateClient(namespace);
  const old = Date.now() - STREAM_STALE_AFTER_MS - 1000;
  await client.admitSse({
    connectionId: "stale-connection", kind: "scores", fixtureId: "9", requestId: "stale-request",
    subject: "stale-ip", perMinute: 10, maxConcurrent: 20, nowMs: old - 2,
  });
  await client.connected({ connectionId: "stale-connection", nowMs: old - 1 });
  await client.frame({ connectionId: "stale-connection", nowMs: old, frameCount: 1, byteCount: 10 });
  const response = await worker.fetch(req("/health"), { ...env, RELAY_SHARED_STATE: namespace }, {});
  const body = await response.json();
  const telemetry = body.streamTelemetry.streams.find(item => item.requestId === "stale-request");
  assert.equal(body.capabilityStatus.stateScope, "durable_object_shared");
  assert.equal(telemetry.status, "stale");
  assert.equal(telemetry.connected, true);
  assert.equal(telemetry.hasFirstFrame, true);
});

test("upstream failures carry request IDs and sanitized structured details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("secret upstream host detail must not escape"); };
  try {
    const response = await worker.fetch(req("/api/scores/stream?fixtureId=77", {
      headers: { "CF-Connecting-IP": "failure-ip", "X-Request-ID": "failure-request-1" },
    }), env, {});
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("X-Request-ID"), "failure-request-1");
    assert.equal(body.requestId, "failure-request-1");
    assert.deepEqual(body.failure, { category: "upstream_transport", retryable: true });
    assert.equal(text.includes("secret upstream host detail"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
