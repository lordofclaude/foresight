"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { STAGES, pseudonymizeActor, validateExperimentEvent } = require("../src/events");
const { billingConfigFromEnv } = require("../src/config");

test("event schema covers view through active, refund and churn", () => {
  assert.deepEqual(STAGES, ["offer_viewed", "purchase_intent", "checkout_started", "subscription_active", "refund_recorded", "churn_recorded"]);
});

test("valid analytics event uses a non-reversible keyed pseudonym", () => {
  const actorHash = pseudonymizeActor("user_123", "analytics-key");
  const event = { schemaVersion: 1, eventId: "event_123", stage: "purchase_intent", occurredAt: "2026-07-19T00:00:00.000Z", actorHash, experimentId: "pricing-v1", variant: "alerts-19", offerId: "alerts", source: "demo" };
  assert.equal(validateExperimentEvent(event).valid, true);
  assert.equal(actorHash.includes("user_123"), false);
});

test("PII and unknown fields are rejected", () => {
  const base = { schemaVersion: 1, eventId: "event_123", stage: "offer_viewed", occurredAt: "2026-07-19T00:00:00.000Z", actorHash: "a".repeat(64), experimentId: "x", variant: "a", offerId: "alerts", source: "landing" };
  assert.equal(validateExperimentEvent({ ...base, email: "person@example.com" }).reason, "pii_field_forbidden");
  assert.equal(validateExperimentEvent({ ...base, arbitrary: true }).reason, "unknown_field:arbitrary");
  assert.equal(validateExperimentEvent({ ...base, variant: "person@example.com" }).reason, "unsafe_experiment_dimension");
  assert.equal(validateExperimentEvent({ ...base, anonymousSessionHash: "b".repeat(64) }).reason, "pseudonymous_actor");
  assert.equal(validateExperimentEvent({ ...base, reasonCode: "customer said their full name" }).reason, "reason_code");
});

test("Clerk config requires explicit enablement, test keys and webhook verification", () => {
  assert.equal(billingConfigFromEnv({}).ready, false);
  const prod = billingConfigFromEnv({ FORESIGHT_CLERK_BILLING_ENABLED: "true", CLERK_PUBLISHABLE_KEY: "pk_live_x", CLERK_SECRET_KEY: "sk_live_x", CLERK_WEBHOOK_SIGNING_SECRET: "whsec_x" });
  assert.equal(prod.ready, false);
  assert.equal(prod.canRenderCheckout, false);
  const dev = billingConfigFromEnv({ FORESIGHT_CLERK_BILLING_ENABLED: "true", CLERK_PUBLISHABLE_KEY: "pk_test_x", CLERK_SECRET_KEY: "sk_test_x", CLERK_WEBHOOK_SIGNING_SECRET: "whsec_x" });
  assert.equal(dev.ready, true);
  assert.equal(dev.canRenderCheckout, false);
});
