import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify, createPublicKey } from "node:crypto";
import test from "node:test";

import {
  canonicalize,
  createCommitService,
  encodeUtf8,
  IngestError,
  MemoryCommitStore,
  signingMessage
} from "./domain.mjs";
import worker from "./worker.mjs";

const NOW = 2_000_000_000_000;

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function setup() {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = b64url(keys.publicKey.export({ type: "spki", format: "der" }));
  const policies = new Map([
    ["fixture-a", { markets: ["1X2_FT"], selections: ["part1", "draw", "part2"], closesAtMs: NOW + 60_000 }],
    ["fixture-b", { markets: ["1X2_FT"], selections: ["part1", "draw", "part2"], closesAtMs: NOW + 60_000 }]
  ]);
  const receipts = new Map();
  const state = { rateAllowed: true };
  const dependencies = {
    registry: { get: async id => id === "agent-one" ? { ownerId: "owner-one", publicKey } : null },
    ownerAuth: { verify: async ({ ownerId, authorization }) => ownerId === "owner-one" && authorization === "Bearer owner-token-strong" },
    signatureVerifier: {
      verify: async ({ publicKey: encoded, message, signature }) => {
        const key = createPublicKey({ key: Buffer.from(encoded, "base64url"), type: "spki", format: "der" });
        return verify(null, Buffer.from(message), key, Buffer.from(signature));
      }
    },
    hasher: { sha256Hex: async bytes => sha256Hex(Buffer.from(bytes)) },
    fixturePolicy: { get: async id => policies.get(id) || null },
    quoteProofVerifier: {
      verify: async ({ fixtureId, market, proof }) => {
        const expected = receipts.get(proof.reference);
        return { valid: Boolean(expected && expected.fixtureId === fixtureId && expected.market === market && expected.quoteDigest === proof.quoteDigest) };
      }
    },
    rateLimiter: { take: async () => ({ allowed: state.rateAllowed }) },
    store: new MemoryCommitStore()
  };
  const service = createCommitService(dependencies);

  function envelope(overrides = {}, options = {}) {
    const base = {
      version: 1,
      agentId: "agent-one",
      ownerId: "owner-one",
      fixtureId: "fixture-a",
      market: "1X2_FT",
      selection: "part1",
      nonce: "nonce_000000000001",
      issuedAtMs: NOW,
      quote: {
        quoteId: "txline:fixture-a:closing",
        source: "txline",
        observedAtMs: NOW - 1000,
        pricesPpm: { part1: 500_000, draw: 300_000, part2: 200_000 }
      }
    };
    const payload = {
      ...base,
      ...overrides,
      quote: { ...base.quote, ...(overrides.quote || {}), pricesPpm: { ...base.quote.pricesPpm, ...(overrides.quote?.pricesPpm || {}) } }
    };
    const reference = options.reference || `receipt:${payload.fixtureId}:${payload.nonce}`;
    const quoteDigest = `sha256:${sha256Hex(encodeUtf8(canonicalize({
      fixtureId: payload.fixtureId,
      market: payload.market,
      quote: payload.quote
    })))}`;
    payload.proof = overrides.proof || { kind: "txline_quote_v1", reference, quoteDigest };
    if (options.registerProof !== false) receipts.set(reference, { fixtureId: payload.fixtureId, market: payload.market, quoteDigest });
    const signature = b64url(sign(null, Buffer.from(signingMessage(payload)), keys.privateKey));
    return { payload, signature };
  }

  const submit = body => service.submit({ body, authorization: "Bearer owner-token-strong", nowMs: NOW });
  return { keys, dependencies, policies, receipts, service, state, envelope, submit };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error instanceof IngestError && error.code === code);
}

test("accepts a valid signed immutable commit and makes exact retry idempotent", async () => {
  const context = setup();
  const body = context.envelope();
  const first = await context.submit(body);
  const retry = await context.submit(body);
  assert.equal(first.status, "accepted");
  assert.equal(retry.status, "idempotent");
  assert.equal(first.receipt.submissionDigest, retry.receipt.submissionDigest);
});

test("invalid Ed25519 signature is rejected", async () => {
  const context = setup();
  const body = context.envelope();
  const corrupted = Buffer.from(body.signature, "base64url");
  corrupted[0] ^= 1;
  body.signature = b64url(corrupted);
  await rejectsCode(context.submit(body), "invalid_signature");
});

test("signature from a different domain is rejected", async () => {
  const context = setup();
  const body = context.envelope();
  body.signature = b64url(sign(null, Buffer.from(`OTHER_PROTOCOL_V1\n${canonicalize(body.payload)}`), context.keys.privateKey));
  await rejectsCode(context.submit(body), "invalid_signature");
});

test("same agent nonce on a different fixture is rejected as replay", async () => {
  const context = setup();
  await context.submit(context.envelope());
  const replay = context.envelope({ fixtureId: "fixture-b", quote: { quoteId: "txline:fixture-b:closing" } }, { reference: "receipt:b" });
  await rejectsCode(context.submit(replay), "nonce_replay");
});

test("stale and future submission timestamps are rejected", async () => {
  const stale = setup();
  await rejectsCode(stale.submit(stale.envelope({ issuedAtMs: NOW - 300_001, quote: { observedAtMs: NOW - 301_000 } })), "stale_timestamp");
  const future = setup();
  await rejectsCode(future.submit(future.envelope({ issuedAtMs: NOW + 15_001, quote: { observedAtMs: NOW } })), "future_timestamp");
});

test("a changed second commit for the same agent/fixture/market is rejected", async () => {
  const context = setup();
  await context.submit(context.envelope());
  const mutation = context.envelope({ selection: "part2", nonce: "nonce_000000000002" }, { reference: "receipt:mutation" });
  await rejectsCode(context.submit(mutation), "duplicate_mutation");
});

test("fixture mismatch against proof receipt is rejected", async () => {
  const context = setup();
  const body = context.envelope({ fixtureId: "fixture-b", quote: { quoteId: "txline:fixture-b:closing" } }, {
    reference: "receipt:wrong-fixture",
    registerProof: false
  });
  context.receipts.set("receipt:wrong-fixture", {
    fixtureId: "fixture-a",
    market: body.payload.market,
    quoteDigest: body.payload.proof.quoteDigest
  });
  await rejectsCode(context.submit(body), "quote_proof_rejected");
});

test("price mismatch against an otherwise real proof receipt is rejected", async () => {
  const context = setup();
  const original = context.envelope({}, { reference: "receipt:fixed-prices" });
  const changed = context.envelope({ quote: { pricesPpm: { part1: 400_000, draw: 300_000, part2: 300_000 } } }, {
    reference: "receipt:fixed-prices",
    registerProof: false
  });
  assert.notEqual(original.payload.proof.quoteDigest, changed.payload.proof.quoteDigest);
  await rejectsCode(context.submit(changed), "quote_proof_rejected");
});

test("a quote changed without updating the proof digest is rejected", async () => {
  const context = setup();
  const original = context.envelope();
  const changed = context.envelope({ quote: { pricesPpm: { part1: 400_000, draw: 300_000, part2: 300_000 } } }, {
    reference: "receipt:changed"
  });
  changed.payload.proof.quoteDigest = original.payload.proof.quoteDigest;
  changed.signature = b64url(sign(null, Buffer.from(signingMessage(changed.payload)), context.keys.privateKey));
  await rejectsCode(context.submit(changed), "quote_digest_mismatch");
});

test("rate limiter rejection fails closed", async () => {
  const context = setup();
  context.state.rateAllowed = false;
  await rejectsCode(context.submit(context.envelope()), "rate_limited");
});

test("owner authentication and ownership binding fail closed", async () => {
  const context = setup();
  const body = context.envelope();
  await rejectsCode(context.service.submit({ body, authorization: null, nowMs: NOW }), "owner_auth_failed");
  const wrongOwner = context.envelope({ ownerId: "owner-two" });
  await rejectsCode(context.submit(wrongOwner), "owner_mismatch");
});

test("owner-auth dependency failure returns dependency_unavailable", async () => {
  const context = setup();
  context.dependencies.ownerAuth.verify = async () => { throw new Error("auth backend down"); };
  await rejectsCode(context.submit(context.envelope()), "dependency_unavailable");
});

test("unknown prompt or secret fields are never accepted", async () => {
  const context = setup();
  const prompt = context.envelope();
  prompt.payload.prompt = "private strategy";
  await rejectsCode(context.submit(prompt), "invalid_schema");
  const secret = context.envelope();
  secret.payload.secret = "do-not-store";
  await rejectsCode(context.submit(secret), "invalid_schema");
});

test("allowlist rejects unknown fixture and market", async () => {
  const fixture = setup();
  await rejectsCode(fixture.submit(fixture.envelope({ fixtureId: "fixture-x", quote: { quoteId: "txline:fixture-x:closing" } })), "fixture_not_allowed");
  const market = setup();
  await rejectsCode(market.submit(market.envelope({ market: "TOTALS_FT" })), "market_not_allowed");
});

test("missing dependency is rejected at construction", () => {
  assert.throws(() => createCommitService({}), /missing required dependency/);
});

test("Worker health is trade-free and missing production bindings fail closed", async () => {
  const health = await worker.fetch(new Request("https://ingest.test/health"), {});
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "foresight-agent-ingest", executesTrades: false });

  const context = setup();
  const response = await worker.fetch(new Request("https://ingest.test/v1/agent-commits", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer owner-token-strong" },
    body: JSON.stringify(context.envelope())
  }), {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "service_unavailable");
});

test("Worker reports malformed JSON as a client error before dependency setup", async () => {
  const response = await worker.fetch(new Request("https://ingest.test/v1/agent-commits", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{" 
  }), {});
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_json" });
});
