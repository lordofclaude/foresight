"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ProofReceipts = require("../shared/proof-receipts.js");

const NOW = Date.parse("2026-07-18T12:00:00.000Z");
const binding = Object.freeze({
  fixtureId: 18241006,
  market: "1X2_FT",
  side: "part2",
  price: 0.381,
  quoteTimestampMs: 1784375700000,
  predictionTimestampMs: 1784376000000,
  fixtureDeadlineMs: 1784444400000,
});

function relayResponse(capability, requested, extra) {
  return Object.assign({
    proofStatus: ProofReceipts.API_RECEIVED,
    verificationStatus: "not_verified",
    verified: false,
    cryptographicallyVerified: false,
    apiReceived: true,
    relayReceipt: {
      capability,
      requested,
      receivedAt: new Date(NOW - 1000).toISOString(),
    },
  }, extra || {});
}

const cases = [
  {
    name: "fixture deadline",
    kind: "fixture_deadline_validation",
    request: { fixtureId: binding.fixtureId, timestamp: binding.predictionTimestampMs },
    requested: { fixtureId: String(binding.fixtureId), timestamp: String(binding.predictionTimestampMs) },
  },
  {
    name: "odds",
    kind: "odds_validation",
    request: { messageId: "1838400688:00003:000002-10021-stab", ts: binding.quoteTimestampMs },
    requested: { messageId: "1838400688:00003:000002-10021-stab", ts: String(binding.quoteTimestampMs) },
  },
  {
    name: "score/stat",
    kind: "score_stat_validation",
    request: { fixtureId: binding.fixtureId, seq: 91, statKey: 1002, value: 2 },
    requested: { fixtureId: String(binding.fixtureId), seq: "91", statKeys: "1002", expectedValue: "2" },
  },
];

for (const example of cases) {
  test("normalizes the " + example.name + " seam as explicitly unverified API evidence", () => {
    const raw = relayResponse(example.kind, example.requested, {
      provenance: { provider: "TxLINE", endpoint: ProofReceipts.SEAMS[example.kind].route },
      root: "0xnot-yet-verified",
      slot: 477262320,
    });
    const receipt = ProofReceipts.normalizeProofReceipt(example.kind, example.request, binding, raw, {
      nowMs: NOW,
      maxAgeMs: 5000,
    });

    assert.equal(receipt.version, 1);
    assert.deepEqual(receipt.binding, binding);
    assert.equal(receipt.verification.status, ProofReceipts.API_RECEIVED);
    assert.equal(receipt.verification.verified, false);
    assert.equal(receipt.evidence.root, "0xnot-yet-verified");
    assert.equal(receipt.evidence.slot, 477262320);
    assert.deepEqual(receipt.evidence.provenance, raw.provenance);
    assert.deepEqual(receipt.evidence.raw, raw);
  });
}

test("preserves, but does not infer, cryptographic verification metadata", () => {
  const request = cases[1].request;
  const response = relayResponse(cases[1].kind, cases[1].requested, {
    proofStatus: "verified",
    verificationStatus: "verified",
    verified: true,
    cryptographicallyVerified: true,
    proof: { root: "root-abc", slot: 77, provenance: { program: "TxLINE" } },
  });
  const receipt = ProofReceipts.normalizeProofReceipt(cases[1].kind, request, binding, response, { nowMs: NOW });
  assert.deepEqual(receipt.verification, {
    apiReceived: true,
    cryptographicallyVerified: true,
    status: ProofReceipts.CRYPTOGRAPHICALLY_VERIFIED,
    verified: true,
  });
  assert.equal(receipt.evidence.root, "root-abc");
  assert.equal(receipt.evidence.slot, 77);
  assert.deepEqual(receipt.evidence.provenance, { program: "TxLINE" });
});

test("rejects a verified label without both explicit flags and auditable metadata", () => {
  const request = cases[0].request;
  const response = relayResponse(cases[0].kind, cases[0].requested, {
    proofStatus: "verified",
    verified: true,
    cryptographicallyVerified: true,
  });
  assert.throws(
    () => ProofReceipts.normalizeProofReceipt(cases[0].kind, request, binding, response, { nowMs: NOW }),
    error => error.code === "incomplete_verified_proof"
  );
});

test("binds deadline and odds queries to the canonical prediction timestamps", () => {
  assert.throws(
    () => ProofReceipts.normalizeProofReceipt(cases[0].kind,
      { ...cases[0].request, fixtureId: 999 }, binding,
      relayResponse(cases[0].kind, cases[0].requested), { nowMs: NOW }),
    error => error.code === "fixture_mismatch"
  );
  assert.throws(
    () => ProofReceipts.normalizeProofReceipt(cases[1].kind,
      { ...cases[1].request, ts: binding.quoteTimestampMs + 1 }, binding,
      relayResponse(cases[1].kind, cases[1].requested), { nowMs: NOW }),
    error => error.code === "timestamp_mismatch"
  );
});

test("rejects relay request, capability, fixture, market, side, price, and timestamp mismatches", () => {
  const base = cases[2];
  const attempts = [
    [relayResponse("odds_validation", base.requested), "capability_mismatch"],
    [relayResponse(base.kind, { ...base.requested, seq: "92" }), "request_mismatch"],
    [relayResponse(base.kind, base.requested, { fixtureId: 999 }), "fixture_mismatch"],
    [relayResponse(base.kind, base.requested, { market: "TOTALS" }), "market_mismatch"],
    [relayResponse(base.kind, base.requested, { side: "part1" }), "side_mismatch"],
    [relayResponse(base.kind, base.requested, { stablePrice: 0.5 }), "price_mismatch"],
    [relayResponse(base.kind, base.requested, { oddsTs: binding.quoteTimestampMs + 1 }), "timestamp_mismatch"],
  ];
  for (const [response, code] of attempts) {
    assert.throws(
      () => ProofReceipts.normalizeProofReceipt(base.kind, base.request, binding, response, { nowMs: NOW }),
      error => error.code === code,
      code
    );
  }
});

test("rejects stale, future, failed, contradictory, and incomplete relay responses", () => {
  const base = cases[0];
  const stale = relayResponse(base.kind, base.requested);
  stale.relayReceipt.receivedAt = new Date(NOW - 6001).toISOString();
  const future = relayResponse(base.kind, base.requested);
  future.relayReceipt.receivedAt = new Date(NOW + 5001).toISOString();
  const failed = relayResponse(base.kind, base.requested, { error: "upstream failed" });
  const contradictory = relayResponse(base.kind, base.requested, { cryptographicallyVerified: true });
  const missing = relayResponse(base.kind, base.requested);
  delete missing.relayReceipt.requested;

  const checks = [
    [stale, "stale_response"],
    [future, "future_response"],
    [failed, "invalid_response"],
    [contradictory, "incomplete_response"],
    [missing, "incomplete_response"],
  ];
  for (const [response, code] of checks) {
    assert.throws(
      () => ProofReceipts.normalizeProofReceipt(base.kind, base.request, binding, response, { nowMs: NOW, maxAgeMs: 5000 }),
      error => error.code === code,
      code
    );
  }
});

test("rejects invalid canonical bindings before packaging evidence", () => {
  const base = cases[0];
  const response = relayResponse(base.kind, base.requested);
  const invalid = [
    [{ ...binding, price: Infinity }, "invalid_price"],
    [{ ...binding, quoteTimestampMs: binding.predictionTimestampMs + 1 }, "invalid_timestamp_order"],
    [{ ...binding, predictionTimestampMs: binding.fixtureDeadlineMs }, "post_deadline_prediction"],
    [{ ...binding, market: "1X2 FT?evil" }, "invalid_market"],
  ];
  for (const [candidate, code] of invalid) {
    assert.throws(
      () => ProofReceipts.normalizeProofReceipt(base.kind, base.request, candidate, response, { nowMs: NOW }),
      error => error.code === code,
      code
    );
  }
});

test("deterministic serialization sorts nested object keys and rejects non-JSON evidence", () => {
  const a = { z: 1, nested: { b: 2, a: 1 }, rows: [{ y: true, x: false }] };
  const b = { rows: [{ x: false, y: true }], nested: { a: 1, b: 2 }, z: 1 };
  assert.equal(ProofReceipts.deterministicSerialize(a), ProofReceipts.deterministicSerialize(b));
  assert.equal(ProofReceipts.deterministicSerialize(a), '{"nested":{"a":1,"b":2},"rows":[{"x":false,"y":true}],"z":1}');
  assert.throws(() => ProofReceipts.deterministicSerialize({ bad: undefined }), error => error.code === "non_json_evidence");
});

test("client calls only the three fixed routes with canonical query shapes", async () => {
  const calls = [];
  const responses = new Map(cases.map(example => [ProofReceipts.SEAMS[example.kind].route, relayResponse(example.kind, example.requested)]));
  const client = ProofReceipts.createProofReceiptClient({
    relayOrigin: "https://relay.example",
    allowedOrigins: ["https://relay.example", "https://backup.example"],
    now: () => NOW,
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return new Response(JSON.stringify(responses.get(new URL(url).pathname)), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    },
  });

  await client.fixtureDeadline(cases[0].request, binding);
  await client.odds(cases[1].request, binding);
  await client.scoreStat(cases[2].request, binding);

  assert.deepEqual(calls.map(call => call.url.pathname), [
    "/api/fixtures/validation",
    "/api/odds/validation",
    "/api/scores/stat-validation",
  ]);
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), {
    fixtureId: String(binding.fixtureId), timestamp: String(binding.predictionTimestampMs),
  });
  assert.deepEqual(Object.fromEntries(calls[1].url.searchParams), {
    messageId: cases[1].request.messageId, ts: String(binding.quoteTimestampMs),
  });
  assert.deepEqual(Object.fromEntries(calls[2].url.searchParams), {
    fixtureId: String(binding.fixtureId), seq: "91", statKey: "1002", value: "2",
  });
  assert.ok(calls.every(call => call.init.method === "GET" && call.init.redirect === "error" && call.init.signal));
});

test("client rejects unallowlisted, credentialed, path-bearing, and insecure remote origins", () => {
  const create = relayOrigin => ProofReceipts.createProofReceiptClient({
    relayOrigin,
    allowedOrigins: ["https://relay.example"],
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  assert.throws(() => create("https://evil.example"), error => error.code === "relay_origin_not_allowed");
  assert.throws(() => create("https://user:pass@relay.example"), error => error.code === "invalid_relay_origin");
  assert.throws(() => create("https://relay.example/arbitrary"), error => error.code === "invalid_relay_origin");
  assert.throws(() => create("http://relay.example"), error => error.code === "invalid_relay_origin");
  assert.doesNotThrow(() => ProofReceipts.createProofReceiptClient({
    relayOrigin: "http://127.0.0.1:8787",
    allowedOrigins: ["http://127.0.0.1:8787"],
    fetchImpl: async () => new Response("{}"),
  }));
});

test("client propagates caller aborts without waiting for the relay", async () => {
  const client = ProofReceipts.createProofReceiptClient({
    relayOrigin: "https://relay.example",
    allowedOrigins: ["https://relay.example"],
    timeoutMs: 1000,
    fetchImpl: (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  });
  const controller = new AbortController();
  const pending = client.fixtureDeadline(cases[0].request, binding, { signal: controller.signal });
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(pending, /caller cancelled/);
});

test("client fails closed on non-JSON and unsuccessful relay responses", async () => {
  const makeClient = fetchImpl => ProofReceipts.createProofReceiptClient({
    relayOrigin: "https://relay.example",
    allowedOrigins: ["https://relay.example"],
    fetchImpl,
  });
  await assert.rejects(
    makeClient(async () => new Response("no", { status: 502 })).odds(cases[1].request, binding),
    error => error.code === "relay_http_error"
  );
  await assert.rejects(
    makeClient(async () => new Response("plain", { status: 200, headers: { "Content-Type": "text/plain" } })).odds(cases[1].request, binding),
    error => error.code === "invalid_content_type"
  );
});
