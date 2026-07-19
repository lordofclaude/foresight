"use strict";

const crypto = require("node:crypto");

const STAGES = Object.freeze(["offer_viewed", "purchase_intent", "checkout_started", "subscription_active", "refund_recorded", "churn_recorded"]);
const ALLOWED_KEYS = new Set(["schemaVersion", "eventId", "stage", "occurredAt", "actorHash", "anonymousSessionHash", "experimentId", "variant", "offerId", "feature", "source", "amountCents", "currency", "reasonCode"]);
const PII_KEYS = /email|name|wallet|address|phone|ip|useragent|user_agent|clerkid|clerk_id/i;
const SOURCES = new Set(["landing", "demo", "concierge", "billing", "support"]);
const FEATURES = new Set(["verified_receipt_alerts", "verified_receipt_api"]);
const REASON_CODES = new Set(["price", "missing_feature", "no_longer_needed", "unreliable", "support_burden", "other"]);
const SAFE_TOKEN = /^[-_a-zA-Z0-9]{1,64}$/;

function pseudonymizeActor(actorId, analyticsKey) {
  if (!actorId || !analyticsKey) throw new Error("actor and analytics key are required");
  return crypto.createHmac("sha256", analyticsKey).update(String(actorId)).digest("hex");
}

function validateExperimentEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return { valid: false, reason: "event_object_required" };
  for (const key of Object.keys(event)) {
    if (PII_KEYS.test(key)) return { valid: false, reason: "pii_field_forbidden" };
    if (!ALLOWED_KEYS.has(key)) return { valid: false, reason: `unknown_field:${key}` };
  }
  if (event.schemaVersion !== 1) return { valid: false, reason: "schema_version" };
  if (!STAGES.includes(event.stage)) return { valid: false, reason: "funnel_stage" };
  if (!/^[-_a-zA-Z0-9]{8,128}$/.test(event.eventId || "")) return { valid: false, reason: "event_id" };
  if (!/^\d{4}-\d{2}-\d{2}T/.test(event.occurredAt || "") || !Number.isFinite(Date.parse(event.occurredAt))) return { valid: false, reason: "occurred_at" };
  const actors = [event.actorHash, event.anonymousSessionHash].filter(Boolean);
  if (actors.length !== 1 || !/^[a-f0-9]{64}$/.test(actors[0])) return { valid: false, reason: "pseudonymous_actor" };
  if (![event.experimentId, event.variant, event.offerId].every((value) => SAFE_TOKEN.test(value || ""))) return { valid: false, reason: "unsafe_experiment_dimension" };
  if (!SOURCES.has(event.source)) return { valid: false, reason: "source" };
  if (event.feature != null && !FEATURES.has(event.feature)) return { valid: false, reason: "feature" };
  if (event.reasonCode != null && !REASON_CODES.has(event.reasonCode)) return { valid: false, reason: "reason_code" };
  if (event.amountCents != null && (!Number.isSafeInteger(event.amountCents) || event.amountCents < 0)) return { valid: false, reason: "amount_cents" };
  if ((event.amountCents != null) !== (event.currency != null) || event.currency != null && !/^[A-Z]{3}$/.test(event.currency)) return { valid: false, reason: "money_pair" };
  return { valid: true };
}

module.exports = { STAGES, pseudonymizeActor, validateExperimentEvent };
