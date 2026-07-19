/* Foresight follow semantics.
   Follow is a watchlist subscription for verified prediction-receipt alerts.
   It is never execution, custody, automatic betting, portfolio copying, or a
   paid entitlement. Browser demo state is deliberately local and ephemeral. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FollowSemantics = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = 1;
  const STATES = Object.freeze({ REQUESTED: "REQUESTED", ACTIVE: "ACTIVE", PAUSED: "PAUSED", UNFOLLOWED: "UNFOLLOWED" });
  const MODES = Object.freeze({ LOCAL_DEMO: "local_demo", PERSISTED_SERVICE: "persisted_service" });
  const FOLLOW_SCOPE = "Verified prediction-receipt alerts/watchlist only; no execution, custody, automatic bets, portfolio copying, or paid access.";
  const DEFAULT_PREFERENCES = Object.freeze({ committed: true, graded: true, burned: true, delivery: "in_app" });
  const ID_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@._:-]{1,159}$/;

  class FollowError extends Error {
    constructor(code, message) { super(message); this.name = "FollowError"; this.code = code; }
  }
  function fail(code, message) { throw new FollowError(code, message); }
  function identityPart(value, label) {
    if (typeof value !== "string" || !ID_PATTERN.test(value)) fail("INVALID_IDENTITY", `${label} is invalid`);
    return value;
  }
  function normalizeIdentity(input) {
    if (!input || typeof input !== "object") fail("INVALID_IDENTITY", "follow identity is required");
    const identity = {
      actorId: identityPart(input.actorId, "actorId"),
      creatorId: identityPart(input.creatorId, "creatorId"),
      strategyId: identityPart(input.strategyId, "strategyId")
    };
    if (identity.actorId === identity.creatorId) fail("SELF_FOLLOW", "an identity cannot follow itself");
    return Object.freeze(identity);
  }
  function followKey(identity) {
    const value = normalizeIdentity(identity);
    return `${value.actorId}|${value.creatorId}|${value.strategyId}`;
  }
  function normalizePreferences(input) {
    const value = input == null ? DEFAULT_PREFERENCES : input;
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_PREFERENCES", "notification preferences are required");
    const allowed = ["committed", "graded", "burned", "delivery"];
    const extra = Object.keys(value).filter(key => !allowed.includes(key));
    const missing = allowed.filter(key => !(key in value));
    if (extra.length || missing.length) fail("INVALID_PREFERENCES", "notification preference keys are invalid");
    if (![value.committed, value.graded, value.burned].every(item => typeof item === "boolean")) {
      fail("INVALID_PREFERENCES", "receipt notification preferences must be boolean");
    }
    if (!value.committed && !value.graded && !value.burned) fail("INVALID_PREFERENCES", "at least one receipt alert must be enabled");
    if (value.delivery !== "in_app") fail("INVALID_PREFERENCES", "this MVP supports in_app receipt alerts only");
    return Object.freeze({ committed: value.committed, graded: value.graded, burned: value.burned, delivery: value.delivery });
  }
  function samePreferences(a, b) {
    return a.committed === b.committed && a.graded === b.graded && a.burned === b.burned && a.delivery === b.delivery;
  }
  function initialRecord(identity, mode) {
    return Object.freeze({
      ...identity,
      key: followKey(identity),
      state: STATES.UNFOLLOWED,
      version: 0,
      preferences: DEFAULT_PREFERENCES,
      persistence: mode,
      persisted: false,
      authorizationVerified: false,
      entitlementVerified: false,
      entitlementReceiptId: null,
      backendReceiptId: null,
      updatedAt: null,
      scope: FOLLOW_SCOPE
    });
  }

  function createController(options = {}) {
    const mode = options.mode || MODES.LOCAL_DEMO;
    if (!Object.values(MODES).includes(mode)) fail("INVALID_MODE", "unknown follow persistence mode");
    const now = options.now || Date.now;
    const authorizeAndPersist = options.authorizeAndPersist || null;
    const records = new Map();

    function snapshot(input) {
      const identity = normalizeIdentity(input);
      return records.get(followKey(identity)) || initialRecord(identity, mode);
    }

    async function persist(previous, candidate, action, authContext) {
      if (mode === MODES.LOCAL_DEMO) {
        return Object.freeze({
          ...candidate,
          persistence: MODES.LOCAL_DEMO,
          persisted: false,
          authorizationVerified: false,
          entitlementVerified: false,
          entitlementReceiptId: null,
          backendReceiptId: null
        });
      }
      if (typeof authorizeAndPersist !== "function") fail("BACKEND_REQUIRED", "persisted follow mode requires an authorization and persistence backend");
      if (!authContext || typeof authContext !== "object") fail("AUTH_REQUIRED", "authenticated backend context is required");
      if (authContext.actorId && authContext.actorId !== candidate.actorId) fail("AUTH_MISMATCH", "authenticated actor does not match follow actor");
      const operationId = `${candidate.key}|v${previous.version + 1}|${action}|${candidate.state}`;
      let receipt;
      try {
        receipt = await authorizeAndPersist(Object.freeze({
          operationId, action, previousState: previous.state, targetState: candidate.state,
          actorId: candidate.actorId, creatorId: candidate.creatorId, strategyId: candidate.strategyId,
          preferences: candidate.preferences, expectedVersion: previous.version, authContext
        }));
      } catch {
        fail("BACKEND_UNAVAILABLE", "follow authorization or persistence backend is unavailable");
      }
      if (!receipt || receipt.authorized !== true) fail("AUTHORIZATION_FAILED", "backend did not authorize this follow transition");
      const exact = receipt.persisted === true && receipt.operationId === operationId &&
        receipt.actorId === candidate.actorId && receipt.creatorId === candidate.creatorId &&
        receipt.strategyId === candidate.strategyId && receipt.state === candidate.state &&
        receipt.version === previous.version + 1 && typeof receipt.receiptId === "string" && receipt.receiptId.length > 0;
      if (!exact) fail("BACKEND_REJECTED", "backend did not persist this exact creator, strategy, state, and version");
      if (receipt.entitlementVerified === true &&
          (typeof receipt.entitlementReceiptId !== "string" || receipt.entitlementReceiptId.length === 0)) {
        fail("BACKEND_REJECTED", "verified entitlement requires an exact backend receipt ID");
      }
      return Object.freeze({
        ...candidate,
        persistence: MODES.PERSISTED_SERVICE,
        persisted: true,
        authorizationVerified: true,
        entitlementVerified: receipt.entitlementVerified === true,
        entitlementReceiptId: receipt.entitlementVerified === true && typeof receipt.entitlementReceiptId === "string" ? receipt.entitlementReceiptId : null,
        backendReceiptId: receipt.receiptId
      });
    }

    async function commit(action, input, target, allowedFrom, preferences) {
      const identity = normalizeIdentity(input);
      const key = followKey(identity);
      const previous = records.get(key) || initialRecord(identity, mode);
      if (previous.state === target) return Object.freeze({ record: previous, idempotent: true });
      if (!allowedFrom.includes(previous.state)) fail("INVALID_TRANSITION", `${previous.state} cannot transition to ${target}`);
      const candidate = Object.freeze({
        ...previous,
        state: target,
        version: previous.version + 1,
        preferences: preferences || previous.preferences,
        updatedAt: Number(now())
      });
      if (!Number.isSafeInteger(candidate.updatedAt)) fail("INVALID_CLOCK", "follow clock must return integer milliseconds");
      const stored = await persist(previous, candidate, action, input.authContext);
      records.set(key, stored);
      return Object.freeze({ record: stored, idempotent: false });
    }

    async function request(input) {
      const preferences = normalizePreferences(input && input.preferences);
      const current = snapshot(input);
      if (current.state === STATES.REQUESTED) {
        if (!samePreferences(current.preferences, preferences)) fail("PREFERENCE_CONFLICT", "use updatePreferences to change an existing request");
        return Object.freeze({ record: current, idempotent: true });
      }
      return commit("request", input, STATES.REQUESTED, [STATES.UNFOLLOWED], preferences);
    }
    const activate = input => commit("activate", input, STATES.ACTIVE, [STATES.REQUESTED, STATES.PAUSED]);
    const pause = input => commit("pause", input, STATES.PAUSED, [STATES.ACTIVE]);
    const unfollow = input => commit("unfollow", input, STATES.UNFOLLOWED, [STATES.REQUESTED, STATES.ACTIVE, STATES.PAUSED]);
    async function updatePreferences(input) {
      const preferences = normalizePreferences(input && input.preferences);
      const identity = normalizeIdentity(input);
      const key = followKey(identity);
      const previous = records.get(key) || initialRecord(identity, mode);
      if (previous.state === STATES.UNFOLLOWED) fail("INVALID_TRANSITION", "notification preferences require an existing follow request");
      if (samePreferences(previous.preferences, preferences)) return Object.freeze({ record: previous, idempotent: true });
      const candidate = Object.freeze({ ...previous, version: previous.version + 1, preferences, updatedAt: Number(now()) });
      if (!Number.isSafeInteger(candidate.updatedAt)) fail("INVALID_CLOCK", "follow clock must return integer milliseconds");
      const stored = await persist(previous, candidate, "update_preferences", input.authContext);
      records.set(key, stored);
      return Object.freeze({ record: stored, idempotent: false });
    }
    function clearLocalDemo() {
      if (mode !== MODES.LOCAL_DEMO) fail("BACKEND_REQUIRED", "persisted service state cannot be cleared by the browser");
      records.clear();
    }
    return Object.freeze({ snapshot, request, activate, pause, unfollow, updatePreferences, clearLocalDemo });
  }

  return Object.freeze({
    VERSION, STATES, MODES, FOLLOW_SCOPE, DEFAULT_PREFERENCES, FollowError,
    normalizeIdentity, normalizePreferences, followKey, createController,
    BACKEND_CONTRACT: Object.freeze({
      request: "{operationId, action, previousState, targetState, actorId, creatorId, strategyId, preferences, expectedVersion, authContext}",
      response: "{authorized:true, persisted:true, operationId, actorId, creatorId, strategyId, state, version, receiptId, entitlementVerified?, entitlementReceiptId?}",
      rule: "Authenticate actor, authorize exact creator+strategy, compare expectedVersion, persist idempotently by operationId, and return the exact stored identity/state/version."
    })
  });
});
