"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Follow = require("../shared/follow.js");

let passed = 0;
const ok = (value, message) => { assert.ok(value, message); passed++; };
const rejects = async (action, code, message) => {
  await assert.rejects(action, error => error && error.code === code, message); passed++;
};
const identity = (extra = {}) => ({ actorId: "@viewer", creatorId: "@creator", strategyId: "foresight:rule:@creator", ...extra });
const preferences = extra => ({ ...Follow.DEFAULT_PREFERENCES, ...(extra || {}) });
let clock = 2_000_000_000_000;

(async () => {
  const local = Follow.createController({ mode: Follow.MODES.LOCAL_DEMO, now: () => ++clock });
  let state = local.snapshot(identity());
  ok(state.state === "UNFOLLOWED" && state.version === 0, "unknown follow starts explicitly UNFOLLOWED");
  ok(state.persistence === "local_demo" && !state.persisted && !state.entitlementVerified, "initial browser state is local, unpersisted, and not entitled");
  ok(/alerts\/watchlist only/.test(state.scope) && /no execution/.test(state.scope), "scope explicitly excludes execution semantics");

  const requested = await local.request({ ...identity(), preferences: preferences() });
  ok(requested.record.state === "REQUESTED" && requested.record.version === 1, "follow request enters REQUESTED");
  ok(requested.record.creatorId === "@creator" && requested.record.strategyId === "foresight:rule:@creator", "request binds creator and strategy identities");
  const duplicateRequest = await local.request({ ...identity(), preferences: preferences() });
  ok(duplicateRequest.idempotent && duplicateRequest.record.version === 1, "duplicate identical request is idempotent");
  await rejects(() => local.request({ ...identity(), preferences: preferences({ burned: false }) }), "PREFERENCE_CONFLICT", "duplicate request cannot silently mutate preferences");

  const active = await local.activate(identity());
  ok(active.record.state === "ACTIVE" && !active.record.persisted, "local activation remains explicitly unpersisted");
  ok((await local.activate(identity())).idempotent, "duplicate activation is idempotent");
  const paused = await local.pause(identity());
  ok(paused.record.state === "PAUSED", "active alerts can pause");
  ok((await local.pause(identity())).idempotent, "duplicate pause is idempotent");
  ok((await local.activate(identity())).record.state === "ACTIVE", "paused alerts can resume");
  const unfollowed = await local.unfollow(identity());
  ok(unfollowed.record.state === "UNFOLLOWED", "active alerts can unfollow");
  ok((await local.unfollow(identity())).idempotent, "duplicate unfollow is idempotent");
  await rejects(() => local.pause(identity()), "INVALID_TRANSITION", "UNFOLLOWED cannot pause");

  const prefsController = Follow.createController({ now: () => ++clock });
  await prefsController.request({ ...identity(), preferences: preferences() });
  const changed = await prefsController.updatePreferences({ ...identity(), preferences: preferences({ burned: false }) });
  ok(changed.record.preferences.burned === false && changed.record.version === 2, "preference changes are explicit versioned transitions");
  ok((await prefsController.updatePreferences({ ...identity(), preferences: preferences({ burned: false }) })).idempotent, "identical preference update is idempotent");
  await rejects(() => prefsController.updatePreferences({ ...identity(), preferences: preferences({ delivery: "email" }) }), "INVALID_PREFERENCES", "unsupported delivery fails validation");
  await rejects(() => prefsController.updatePreferences({ ...identity(), preferences: preferences({ committed: false, graded: false, burned: false }) }), "INVALID_PREFERENCES", "at least one receipt alert is required");
  await rejects(() => prefsController.updatePreferences({ ...identity(), preferences: { ...preferences(), secret: true } }), "INVALID_PREFERENCES", "unknown preference keys are rejected");
  await rejects(() => prefsController.updatePreferences({ ...identity(), preferences: preferences({ committed: "yes" }) }), "INVALID_PREFERENCES", "preference flags must be boolean");
  await rejects(() => prefsController.request({ ...identity({ actorId: "@creator" }), preferences: preferences() }), "SELF_FOLLOW", "self-follow is rejected");

  const missingBackend = Follow.createController({ mode: Follow.MODES.PERSISTED_SERVICE, now: () => ++clock });
  await rejects(() => missingBackend.request({ ...identity(), preferences: preferences(), authContext: { actorId: "@viewer" } }), "BACKEND_REQUIRED", "service mode fails closed without backend");

  let calls = 0;
  const backend = async request => {
    calls++;
    return {
      authorized: true, persisted: true, operationId: request.operationId,
      actorId: request.actorId, creatorId: request.creatorId, strategyId: request.strategyId,
      state: request.targetState, version: request.expectedVersion + 1, receiptId: `receipt-${calls}`,
      entitlementVerified: true, entitlementReceiptId: "entitlement-verified-1"
    };
  };
  const service = Follow.createController({ mode: Follow.MODES.PERSISTED_SERVICE, now: () => ++clock, authorizeAndPersist: backend });
  await rejects(() => service.request({ ...identity(), preferences: preferences() }), "AUTH_REQUIRED", "service transition requires authenticated backend context");
  const persisted = await service.request({ ...identity(), preferences: preferences(), authContext: { actorId: "@viewer", session: "opaque" } });
  ok(persisted.record.persisted && persisted.record.authorizationVerified && persisted.record.backendReceiptId === "receipt-1", "exact authorized backend receipt finalizes persistence");
  ok(persisted.record.entitlementVerified && persisted.record.entitlementReceiptId === "entitlement-verified-1", "premium may be shown only from explicit verified entitlement receipt");
  await service.request({ ...identity(), preferences: preferences(), authContext: { actorId: "@viewer" } });
  ok(calls === 1, "idempotent service request does not call persistence twice");

  const mismatch = Follow.createController({
    mode: Follow.MODES.PERSISTED_SERVICE, now: () => ++clock,
    authorizeAndPersist: async request => ({
      authorized: true, persisted: true, operationId: request.operationId,
      actorId: request.actorId, creatorId: "@someone-else", strategyId: request.strategyId,
      state: request.targetState, version: 1, receiptId: "bad"
    })
  });
  await rejects(() => mismatch.request({ ...identity(), preferences: preferences(), authContext: { actorId: "@viewer" } }), "BACKEND_REJECTED", "mismatched creator receipt fails closed");
  ok(mismatch.snapshot(identity()).state === "UNFOLLOWED", "rejected backend transition does not mutate local state");

  const unreceiptedEntitlement = Follow.createController({
    mode: Follow.MODES.PERSISTED_SERVICE, now: () => ++clock,
    authorizeAndPersist: async request => ({
      authorized: true, persisted: true, operationId: request.operationId,
      actorId: request.actorId, creatorId: request.creatorId, strategyId: request.strategyId,
      state: request.targetState, version: 1, receiptId: "follow-receipt", entitlementVerified: true
    })
  });
  await rejects(() => unreceiptedEntitlement.request({ ...identity(), preferences: preferences(), authContext: { actorId: "@viewer" } }), "BACKEND_REJECTED", "premium entitlement cannot verify without its own receipt ID");

  const unavailable = Follow.createController({
    mode: Follow.MODES.PERSISTED_SERVICE, now: () => ++clock,
    authorizeAndPersist: async () => { throw new Error("backend detail"); }
  });
  await rejects(() => unavailable.request({ ...identity(), preferences: preferences(), authContext: { actorId: "@viewer" } }), "BACKEND_UNAVAILABLE", "backend errors fail closed with sanitized code");

  ok(Follow.followKey(identity()) !== Follow.followKey(identity({ strategyId: "foresight:rule:other" })), "strategy identity is part of the subscription key");
  const source = fs.readFileSync(path.join(__dirname, "..", "shared", "follow.js"), "utf8");
  ok(!source.includes("localStorage"), "follow domain never presents local browser state as durable storage");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  ok(html.includes('src="shared/follow.js"') && html.includes("LOCAL DEMO · NOT PERSISTED"), "browser loads shared semantics and discloses local unpersisted state");
  ok(!/premium auto-follow|unlock auto-follow|auto-allocate|copiedFrom|mirrored picks/i.test(html), "browser contains no legacy premium or mirrored-execution follow copy/code");
  const uiFollowBlock = html.slice(html.indexOf("/* Follow only changes receipt-alert"), html.indexOf("/* ---------------- Clerk account"));
  ok(!/league\.commit|myCommits|portfolioHistory|mySecrets/.test(uiFollowBlock), "follow UI cannot create or mutate a prediction position");

  console.log(`follow: ${passed}/${passed} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
