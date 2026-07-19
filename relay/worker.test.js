import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";

const env = { TXLINE_JWT: "test-jwt", TXLINE_API_TOKEN: "test-token" };
const req = (path, init = {}) => new Request("https://relay.test" + path, init);

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
