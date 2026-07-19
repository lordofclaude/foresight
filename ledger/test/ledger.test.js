import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sha256, stableStringify } from "../src/domain.js";
import { MemoryLedgerRepository } from "../src/memory-repository.js";
import { handleRequest, verifyValidationReceipt } from "../worker.js";

const owner = "clerk:user_test_123";
const clock = () => "2026-07-19T01:02:03.000Z";
const afterReveal = () => "2026-07-19T01:06:00.000Z";
const afterSettlement = () => "2026-07-19T01:11:00.000Z";
const canonicalValue = {
  v: 1, wallet: owner, fixtureId: 18257739, market: "1X2_FT",
  pick: "away", mkt: { home: 0.4207, draw: 0.31649, away: 0.26281 },
  oddsTs: 1784418232498,
};
const canonical = stableStringify(canonicalValue);
const salt = "deterministic-test-salt";
const commitHash = await sha256(canonical + "|" + salt);
const receiptId = "r_" + commitHash;
const env = { AUTH_VERIFY_URL: "https://identity.example.test/verify" };

function authFetch(url, init) {
  assert.equal(url, "https://identity.example.test/verify");
  assert.match(init.headers.Authorization, /^Bearer /);
  return Promise.resolve(new Response(JSON.stringify({ active: true, subject: owner }), { status: 200 }));
}
function request(path, method = "GET", body, key = "idem-key-0001", token = "test-token") {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (key) headers["Idempotency-Key"] = key;
  if (token) headers.Authorization = "Bearer " + token;
  return new Request("https://ledger.example.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const createBody = {
  commitHash, fixtureId: 18257739, canonicalVersion: 1, market: "1X2_FT",
  oddsTs: 1784418232498, committedAt: "2026-07-18T23:50:18.000Z",
  revealDeadline: "2026-07-19T01:05:00.000Z", settleAfter: "2026-07-19T01:10:00.000Z",
  anchor: { kind: "solana_memo", network: "devnet", signature: "Lo1V-test" },
};
function verifier(overrides = {}) {
  return async expected => ({
    status: "VERIFIED", validationReceiptId: expected.validationReceiptId, action: expected.action,
    receiptId: expected.receiptId, ownerId: expected.ownerId, commitHash: expected.commitHash,
    fixtureId: expected.fixtureId, market: expected.market, final: true,
    verifiedAt: expected.action === "INVALID" ? "2026-07-19T01:01:30.000Z" : "2026-07-19T01:10:30.000Z", verifier: "txline:validation-service",
    ...(expected.action === "GRADE" ? { winner: "part2" } : {}),
    ...(expected.action === "INVALID" ? { reason: "fixture data invalidated" } : {}),
    ...overrides,
  });
}
function options(repository, extra = {}) { return { repository, fetchImpl: authFetch, clock, proofVerifier: verifier(), logger: { warn() {} }, ...extra }; }
async function json(response) { return { status: response.status, body: await response.json() }; }
const transition = (type, expectedSequence, validationReceiptId = "validation-receipt-0001") => type === "REVEALED"
  ? { type, expectedSequence, payload: { canonical, salt } }
  : { type, expectedSequence, payload: { validationReceiptId } };
async function create(repository, body = createBody, extra = {}) {
  return json(await handleRequest(request("/v1/receipts", "POST", body), env, options(repository, extra)));
}
async function apply(repository, body, key, extra = {}) {
  return json(await handleRequest(request("/v1/receipts/" + receiptId + "/transitions", "POST", body, key), env, options(repository, extra)));
}

test("writes fail closed when identity or proof verification is not configured", async () => {
  const repository = new MemoryLedgerRepository();
  let result = await json(await handleRequest(request("/v1/receipts", "POST", createBody), { DB: {} }, options(repository)));
  assert.equal(result.status, 503); assert.equal(result.body.code, "auth_not_configured");
  await create(repository);
  await apply(repository, transition("REVEALED", 0), "reveal-config-01");
  result = await apply(repository, transition("GRADED", 1), "grade-config-001", { clock: afterSettlement, proofVerifier: null });
  assert.equal(result.status, 503); assert.equal(result.body.code, "proof_verifier_not_configured");
  assert.equal(result.body.rejection.accepted, false);
});

test("health truthfully reports database, auth, and proof-verifier configuration", async () => {
  const result = await json(await handleRequest(request("/health", "GET", undefined, null, null), {}));
  assert.equal(result.status, 200); assert.equal(result.body.databaseConfigured, false);
  assert.equal(result.body.writesConfigured, false); assert.equal(result.body.proofVerifierConfigured, false);
});

test("D1 schema enforces deadlines, verifier authority, monotonic transitions, and immutability", async () => {
  const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
  for (const pattern of [/reveal_deadline TEXT NOT NULL/, /settle_after TEXT NOT NULL/, /receipt_events_validate_insert/, /reveal deadline passed/, /matching verified validation receipt/, /receipts_no_update/, /receipt_events_no_delete/]) assert.match(schema, pattern);
});

test("creates a stable deadline-bound receipt and replays an exact idempotent retry", async () => {
  const repository = new MemoryLedgerRepository();
  const created = await create(repository);
  assert.equal(created.status, 201); assert.equal(created.body.receiptId, receiptId);
  assert.equal(created.body.ownerId, owner); assert.equal(created.body.state, "COMMITTED");
  assert.equal(created.body.revealDeadline, createBody.revealDeadline);
  const replayed = await create(repository);
  assert.equal(replayed.body.idempotentReplay, true); assert.equal((await repository.getEvents(receiptId)).length, 1);
});

test("commit idempotency key and commitment hash cannot be repurposed", async () => {
  const repository = new MemoryLedgerRepository(); await create(repository);
  let result = await create(repository, { ...createBody, fixtureId: 7 });
  assert.equal(result.status, 409); assert.equal(result.body.code, "idempotency_conflict");
  result = await json(await handleRequest(request("/v1/receipts", "POST", createBody, "different-create-key"), env, options(repository)));
  assert.equal(result.status, 409); assert.equal(result.body.code, "receipt_exists");
});

test("rejects malformed, future, closed, and incorrectly ordered commit deadlines", async () => {
  for (const [body, code, extra] of [
    [{ ...createBody, revealDeadline: "2026-07-18T23:00:00.000Z" }, "invalid_deadlines", {}],
    [{ ...createBody, committedAt: "2026-07-19T02:00:00.000Z", revealDeadline: "2026-07-19T03:00:00.000Z", settleAfter: "2026-07-19T04:00:00.000Z" }, "commitment_from_future", {}],
    [createBody, "commit_window_closed", { clock: afterReveal }],
  ]) {
    const result = await create(new MemoryLedgerRepository(), body, extra);
    assert.equal(result.status, 409 - (code === "invalid_deadlines" ? 9 : 0)); assert.equal(result.body.code, code);
  }
});

test("binds authenticated owner, fixture metadata, canonical bytes, and commitment hash", async () => {
  const repository = new MemoryLedgerRepository(); await create(repository);
  let result = await apply(repository, { type: "REVEALED", expectedSequence: 0, payload: { canonical, salt: "wrong" } }, "reveal-wrong-01");
  assert.equal(result.body.code, "commitment_mismatch");
  const wrongOwnerCanonical = stableStringify({ ...canonicalValue, wallet: "clerk:other_user" });
  const wrongOwnerHash = await sha256(wrongOwnerCanonical + "|" + salt);
  const otherRepo = new MemoryLedgerRepository();
  await create(otherRepo, { ...createBody, commitHash: wrongOwnerHash });
  result = await json(await handleRequest(request("/v1/receipts/r_" + wrongOwnerHash + "/transitions", "POST", { type: "REVEALED", expectedSequence: 0, payload: { canonical: wrongOwnerCanonical, salt } }, "wrong-owner-key"), env, options(otherRepo)));
  assert.equal(result.status, 409); assert.equal(result.body.code, "owner_binding_mismatch");
  const wrongFixture = stableStringify({ ...canonicalValue, fixtureId: 7 });
  const wrongFixtureHash = await sha256(wrongFixture + "|" + salt);
  const fixtureRepo = new MemoryLedgerRepository(); await create(fixtureRepo, { ...createBody, commitHash: wrongFixtureHash });
  result = await json(await handleRequest(request("/v1/receipts/r_" + wrongFixtureHash + "/transitions", "POST", { type: "REVEALED", expectedSequence: 0, payload: { canonical: wrongFixture, salt } }, "wrong-fixture-key"), env, options(fixtureRepo)));
  assert.equal(result.body.code, "commitment_mismatch");
});

test("enforces reveal deadline and exact client sequence", async () => {
  const repository = new MemoryLedgerRepository(); await create(repository);
  let result = await apply(repository, transition("REVEALED", 1), "stale-seq-key-01");
  assert.equal(result.status, 409); assert.equal(result.body.code, "stale_sequence");
  assert.equal(result.body.rejection.actualSequence, 0); assert.equal(result.body.rejection.currentState, "COMMITTED");
  result = await apply(repository, transition("REVEALED", 0), "late-reveal-key", { clock: afterReveal });
  assert.equal(result.status, 409); assert.equal(result.body.code, "reveal_deadline_passed");
  assert.equal((await repository.getEvents(receiptId)).length, 1);
});

test("permits COMMITTED→REVEALED→GRADED and derives grade only from verified outcome", async () => {
  const repository = new MemoryLedgerRepository(); await create(repository);
  let result = await apply(repository, transition("REVEALED", 0), "reveal-grade-001");
  assert.equal(result.status, 201); assert.equal(result.body.events.at(-1).payload.pick, "part2");
  result = await apply(repository, transition("GRADED", 1), "grade-too-early", { clock });
  assert.equal(result.body.code, "settlement_not_open");
  result = await apply(repository, transition("GRADED", 1), "grade-valid-001", { clock: afterSettlement });
  assert.equal(result.status, 201); assert.equal(result.body.state, "GRADED");
  const grade = result.body.events.at(-1).payload;
  assert.equal(grade.result, "WIN"); assert.equal(grade.winner, "part2"); assert.equal(grade.pnl, 280.5);
  assert.equal(grade.validation.status, "VERIFIED");
  const replay = await apply(repository, transition("GRADED", 1), "grade-valid-001", { clock: afterSettlement });
  assert.equal(replay.body.idempotentReplay, true); assert.equal((await repository.getEvents(receiptId)).length, 3);
  result = await apply(repository, transition("INVALID", 2), "grade-terminal-1", { clock: afterSettlement });
  assert.equal(result.body.code, "illegal_transition"); assert.equal((await repository.getEvents(receiptId)).length, 3);
});

test("never accepts browser-supplied grade authority or a mismatched verifier receipt", async () => {
  const repository = new MemoryLedgerRepository(); await create(repository); await apply(repository, transition("REVEALED", 0), "reveal-proof-001");
  let result = await apply(repository, { type: "GRADED", expectedSequence: 1, payload: { result: "WIN", winner: "part2", pnl: 999999, proof: { verified: true } } }, "browser-grade-01", { clock: afterSettlement });
  assert.equal(result.status, 400); assert.equal(result.body.code, "invalid_request");
  result = await apply(repository, transition("GRADED", 1), "bad-status-key-1", { clock: afterSettlement, proofVerifier: verifier({ status: "api_received_not_verified" }) });
  assert.equal(result.body.code, "validation_receipt_mismatch");
  result = await apply(repository, transition("GRADED", 1), "bad-fixture-key", { clock: afterSettlement, proofVerifier: verifier({ fixtureId: 7 }) });
  assert.equal(result.body.code, "validation_receipt_mismatch");
  result = await apply(repository, transition("GRADED", 1), "bad-commit-hash", { clock: afterSettlement, proofVerifier: verifier({ commitHash: "0".repeat(64) }) });
  assert.equal(result.body.code, "validation_receipt_mismatch");
  result = await apply(repository, transition("GRADED", 1), "future-proof-key", { clock: afterSettlement, proofVerifier: verifier({ verifiedAt: "2026-07-19T02:00:00.000Z" }) });
  assert.equal(result.body.code, "validation_receipt_time_mismatch");
  assert.equal((await repository.getEvents(receiptId)).length, 2);
});

test("enforces legal BURNED and INVALID branches and terminal immutability", async () => {
  const burnRepo = new MemoryLedgerRepository(); await create(burnRepo);
  let result = await apply(burnRepo, transition("BURNED", 0), "burn-too-early", { clock });
  assert.equal(result.body.code, "settlement_not_open");
  result = await apply(burnRepo, transition("BURNED", 0), "burn-valid-key", { clock: afterSettlement });
  assert.equal(result.body.state, "BURNED"); assert.equal(result.body.events.at(-1).payload.pnl, -100);
  result = await apply(burnRepo, transition("INVALID", 1), "burn-rewrite-01", { clock: afterSettlement });
  assert.equal(result.body.code, "illegal_transition");

  const invalidRepo = new MemoryLedgerRepository(); await create(invalidRepo);
  result = await apply(invalidRepo, transition("INVALID", 0), "invalid-key-001");
  assert.equal(result.body.state, "INVALID"); assert.equal(result.body.events.at(-1).payload.reason, "fixture data invalidated");
  result = await apply(invalidRepo, transition("REVEALED", 1), "invalid-rewrite1");
  assert.equal(result.body.code, "illegal_transition");

  const revealedInvalidRepo = new MemoryLedgerRepository(); await create(revealedInvalidRepo);
  await apply(revealedInvalidRepo, transition("REVEALED", 0), "invalid-reveal01");
  result = await apply(revealedInvalidRepo, transition("INVALID", 1), "invalid-after-r1");
  assert.equal(result.body.state, "INVALID");
});

test("rejects illegal COMMITTED→GRADED and REVEALED→BURNED transitions before verifier use", async () => {
  let calls = 0;
  const countVerifier = async expected => { calls++; return verifier()(expected); };
  const committed = new MemoryLedgerRepository(); await create(committed);
  let result = await apply(committed, transition("GRADED", 0), "direct-grade-01", { clock: afterSettlement, proofVerifier: countVerifier });
  assert.equal(result.body.code, "illegal_transition");
  const revealed = new MemoryLedgerRepository(); await create(revealed); await apply(revealed, transition("REVEALED", 0), "legal-reveal-01");
  result = await apply(revealed, transition("BURNED", 1), "revealed-burn-1", { clock: afterSettlement, proofVerifier: countVerifier });
  assert.equal(result.body.code, "illegal_transition"); assert.equal(calls, 0);
});

test("cross-owner writes and idempotency-key mutation are rejected with auditable envelopes", async () => {
  const repository = new MemoryLedgerRepository(); await create(repository);
  const otherAuth = () => Promise.resolve(new Response(JSON.stringify({ active: true, subject: "clerk:other_user" })));
  let result = await json(await handleRequest(request("/v1/receipts/" + receiptId + "/transitions", "POST", transition("INVALID", 0), "other-owner-key"), env, { repository, fetchImpl: otherAuth, clock, proofVerifier: verifier(), logger: { warn() {} } }));
  assert.equal(result.body.code, "owner_mismatch"); assert.match(result.body.rejection.rejectionId, /^rej_[0-9a-f]{64}$/);
  await apply(repository, transition("REVEALED", 0), "same-idem-key01");
  result = await apply(repository, transition("GRADED", 1), "same-idem-key01", { clock: afterSettlement });
  assert.equal(result.body.code, "idempotency_conflict"); assert.equal(result.body.rejection.accepted, false);
});

class RacingRepository extends MemoryLedgerRepository {
  constructor() { super(); this.waiting = []; }
  async appendEvent(event) {
    await new Promise(resolve => { this.waiting.push(resolve); if (this.waiting.length === 2) this.waiting.splice(0).forEach(done => done()); });
    return super.appendEvent(event);
  }
}

test("different-key races append once and reject the loser without breaking sequence", async () => {
  const repository = new RacingRepository(); await create(repository);
  const [a, b] = await Promise.all([
    apply(repository, transition("REVEALED", 0), "race-key-alpha"),
    apply(repository, transition("REVEALED", 0), "race-key-bravo"),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.ok([a, b].some(value => value.body.code === "concurrent_transition"));
  const events = await repository.getEvents(receiptId);
  assert.deepEqual(events.map(event => event.sequence), [0, 1]);
});

test("same-key concurrent retry resolves to one event plus an idempotent replay", async () => {
  const repository = new RacingRepository(); await create(repository);
  const [a, b] = await Promise.all([
    apply(repository, transition("REVEALED", 0), "race-same-key01"),
    apply(repository, transition("REVEALED", 0), "race-same-key01"),
  ]);
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  assert.ok(a.body.idempotentReplay || b.body.idempotentReplay);
  assert.equal((await repository.getEvents(receiptId)).length, 2);
});

test("stored chain corruption is detected instead of silently reordering history", async () => {
  const repository = new MemoryLedgerRepository(); await create(repository);
  repository.events.get(receiptId)[0].sequence = 2;
  const result = await json(await handleRequest(request("/v1/receipts/" + receiptId, "GET", undefined, null, null), {}, options(repository)));
  assert.equal(result.status, 500); assert.equal(result.body.code, "ledger_integrity_error");
});

test("profile aggregates only immutable authoritative terminal outcomes", async () => {
  const repository = new MemoryLedgerRepository(); await create(repository);
  await apply(repository, transition("BURNED", 0), "profile-burn-key", { clock: afterSettlement });
  const profile = await json(await handleRequest(request("/v1/profiles/" + encodeURIComponent(owner), "GET", undefined, null, null), {}, options(repository)));
  assert.equal(profile.body.settledCount, 1); assert.equal(profile.body.pnl, -100); assert.equal(profile.body.stateCounts.BURNED, 1);
});

test("server proof-verifier seam uses only the server credential and rejects transport failure", async () => {
  const input = { action: "GRADE", validationReceiptId: "validation-1", receiptId, ownerId: owner, commitHash, fixtureId: 18257739, market: "1X2_FT" };
  const result = await verifyValidationReceipt(input, { PROOF_VERIFY_URL: "https://proof.example.test/verify", PROOF_VERIFY_TOKEN: "server-secret" }, async (url, init) => {
    assert.equal(url, "https://proof.example.test/verify");
    assert.equal(init.headers.Authorization, "Bearer server-secret");
    assert.deepEqual(JSON.parse(init.body), input);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  assert.deepEqual(result, { ok: true });
  await assert.rejects(() => verifyValidationReceipt(input, { PROOF_VERIFY_URL: "https://proof.example.test/verify", PROOF_VERIFY_TOKEN: "server-secret" }, async () => { throw new Error("offline"); }), error => error.code === "proof_verifier_unavailable");
});
