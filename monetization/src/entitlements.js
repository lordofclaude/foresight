"use strict";

const STATES = Object.freeze({
  FREE: "FREE",
  PENDING: "PENDING",
  ACTIVE: "ACTIVE",
  PAST_DUE: "PAST_DUE",
  CANCELED: "CANCELED",
  REFUNDED: "REFUNDED",
});
const FEATURES = Object.freeze({
  RECEIPT_ALERTS: "verified_receipt_alerts",
  AGENT_API: "verified_receipt_api",
});
const KNOWN_FEATURES = new Set(Object.values(FEATURES));

function deny(status, reason) { return { allowed: false, status, reason }; }

class ClerkFeatureAdapter {
  constructor(resolveAuth) {
    if (typeof resolveAuth !== "function") throw new TypeError("resolveAuth must be a function");
    this.resolveAuth = resolveAuth;
  }

  async check({ actorId, feature }) {
    const auth = await this.resolveAuth();
    if (!auth || typeof auth.has !== "function") return { verified: false, reason: "auth_unavailable" };
    const resolvedActor = auth.orgId || auth.userId || null;
    return {
      verified: true,
      actorId: resolvedActor,
      feature,
      // Specific capability check. A plan-name toggle is intentionally absent.
      entitled: Boolean(auth.has({ feature })),
      issuedAt: Number(auth.sessionIssuedAt),
      expiresAt: Number(auth.sessionExpiresAt),
      requestedActorId: actorId,
    };
  }
}

async function authorizeFeature({ config, lifecycleStore, adapter, actorId, feature, now = Date.now(), maxEvidenceAgeMs = 5 * 60000 }) {
  if (!config || !config.ready) return deny(STATES.FREE, "billing_not_configured");
  if (!actorId) return deny(STATES.FREE, "actor_required");
  if (!KNOWN_FEATURES.has(feature)) return deny(STATES.FREE, "unknown_feature");
  if (!lifecycleStore || typeof lifecycleStore.getActorStatus !== "function") return deny(STATES.FREE, "lifecycle_store_unavailable");
  const lifecycle = lifecycleStore.getActorStatus(actorId) || { status: STATES.FREE };
  if (lifecycle.status !== STATES.ACTIVE) return deny(lifecycle.status || STATES.FREE, `lifecycle_${String(lifecycle.status || STATES.FREE).toLowerCase()}`);
  if (!adapter || typeof adapter.check !== "function") return deny(STATES.ACTIVE, "feature_adapter_unavailable");

  let evidence;
  try { evidence = await adapter.check({ actorId, feature }); }
  catch (_) { return deny(STATES.ACTIVE, "feature_check_failed"); }
  if (!evidence || evidence.verified !== true) return deny(STATES.ACTIVE, "unverified_entitlement");
  if (evidence.actorId !== actorId || evidence.requestedActorId && evidence.requestedActorId !== actorId) return deny(STATES.ACTIVE, "actor_mismatch");
  if (evidence.feature !== feature) return deny(STATES.ACTIVE, "feature_mismatch");
  if (!Number.isFinite(evidence.issuedAt) || !Number.isFinite(evidence.expiresAt)) return deny(STATES.ACTIVE, "missing_evidence_time");
  if (evidence.issuedAt > now + 30000 || now - evidence.issuedAt > maxEvidenceAgeMs || evidence.expiresAt <= now) return deny(STATES.ACTIVE, "stale_entitlement");
  if (evidence.entitled !== true) return deny(STATES.ACTIVE, "feature_not_entitled");
  return { allowed: true, status: STATES.ACTIVE, reason: "verified_feature_entitlement", feature, actorId };
}

module.exports = { STATES, FEATURES, ClerkFeatureAdapter, authorizeFeature };
