"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { STATES, FEATURES, ClerkFeatureAdapter, authorizeFeature } = require("../src/entitlements");
const { InMemoryLifecycleStore } = require("../src/webhooks");

const READY = { ready: true };
const NOW = 1_800_000_000_000;
function activeStore(actorId = "user_1", status = STATES.ACTIVE) {
  const store = new InMemoryLifecycleStore();
  store.apply({ subjectId: "subscription:sub_1", actorId, status, sourceType: "test" }, "evt_1");
  return store;
}
function evidence(overrides = {}) {
  return { verified: true, actorId: "user_1", requestedActorId: "user_1", feature: FEATURES.RECEIPT_ALERTS, entitled: true, issuedAt: NOW - 1000, expiresAt: NOW + 60000, ...overrides };
}

test("no config fails closed", async () => {
  const result = await authorizeFeature({ config: { ready: false }, lifecycleStore: activeStore(), adapter: { check: async () => evidence() }, actorId: "user_1", feature: FEATURES.RECEIPT_ALERTS, now: NOW });
  assert.deepEqual(result, { allowed: false, status: STATES.FREE, reason: "billing_not_configured" });
});

test("forged or unverified feature evidence is denied", async () => {
  const result = await authorizeFeature({ config: READY, lifecycleStore: activeStore(), adapter: { check: async () => evidence({ verified: false }) }, actorId: "user_1", feature: FEATURES.RECEIPT_ALERTS, now: NOW });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "unverified_entitlement");
});

test("stale or expired feature evidence is denied", async () => {
  const stale = await authorizeFeature({ config: READY, lifecycleStore: activeStore(), adapter: { check: async () => evidence({ issuedAt: NOW - 301000 }) }, actorId: "user_1", feature: FEATURES.RECEIPT_ALERTS, now: NOW });
  const expired = await authorizeFeature({ config: READY, lifecycleStore: activeStore(), adapter: { check: async () => evidence({ expiresAt: NOW }) }, actorId: "user_1", feature: FEATURES.RECEIPT_ALERTS, now: NOW });
  assert.equal(stale.reason, "stale_entitlement");
  assert.equal(expired.reason, "stale_entitlement");
});

test("actor and feature mismatches are denied", async () => {
  const actor = await authorizeFeature({ config: READY, lifecycleStore: activeStore(), adapter: { check: async () => evidence({ actorId: "user_2" }) }, actorId: "user_1", feature: FEATURES.RECEIPT_ALERTS, now: NOW });
  const feature = await authorizeFeature({ config: READY, lifecycleStore: activeStore(), adapter: { check: async () => evidence({ feature: FEATURES.AGENT_API }) }, actorId: "user_1", feature: FEATURES.RECEIPT_ALERTS, now: NOW });
  assert.equal(actor.reason, "actor_mismatch");
  assert.equal(feature.reason, "feature_mismatch");
});

for (const status of [STATES.FREE, STATES.PENDING, STATES.PAST_DUE, STATES.CANCELED, STATES.REFUNDED]) {
  test(`${status} lifecycle denies paid features`, async () => {
    const result = await authorizeFeature({ config: READY, lifecycleStore: activeStore("user_1", status), adapter: { check: async () => evidence() }, actorId: "user_1", feature: FEATURES.RECEIPT_ALERTS, now: NOW });
    assert.equal(result.allowed, false);
    assert.equal(result.status, status);
  });
}

test("ACTIVE plus fresh verified feature entitlement allows the exact feature", async () => {
  const result = await authorizeFeature({ config: READY, lifecycleStore: activeStore(), adapter: { check: async () => evidence() }, actorId: "user_1", feature: FEATURES.RECEIPT_ALERTS, now: NOW });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "verified_feature_entitlement");
});

test("Clerk adapter calls has({ feature }) and never a plan-name gate", async () => {
  const calls = [];
  const adapter = new ClerkFeatureAdapter(async () => ({ userId: "user_1", sessionIssuedAt: NOW - 1000, sessionExpiresAt: NOW + 60000, has: query => { calls.push(query); return query.feature === FEATURES.AGENT_API; } }));
  const result = await adapter.check({ actorId: "user_1", feature: FEATURES.AGENT_API });
  assert.equal(result.entitled, true);
  assert.deepEqual(calls, [{ feature: FEATURES.AGENT_API }]);
  assert.equal("plan" in calls[0], false);
});
