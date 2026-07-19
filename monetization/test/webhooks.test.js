"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { STATES } = require("../src/entitlements");
const { createWebhookProcessor, InMemoryLifecycleStore } = require("../src/webhooks");

const READY = { ready: true, webhookVerificationConfigured: true };
function request(id = "msg_1") { return { headers: new Map([["svix-id", id]]) }; }
function subscription(type, actorId = "user_1", status = "active", id = "sub_1") {
  return { type, data: { id, status, payer: { user_id: actorId }, items: [{ plan: { slug: "pilot" } }] } };
}

test("forged webhook never reaches lifecycle effects", async () => {
  const store = new InMemoryLifecycleStore();
  const processor = createWebhookProcessor({ config: READY, verifyWebhook: async () => { throw new Error("bad signature"); }, lifecycleStore: store });
  const result = await processor.process(request());
  assert.equal(result.status, 400);
  assert.equal(result.reason, "signature_verification_failed");
  assert.equal(store.effects, 0);
});

test("no billing/webhook configuration fails closed before verification", async () => {
  let called = false;
  const processor = createWebhookProcessor({ config: { ready: false }, verifyWebhook: async () => { called = true; } });
  const result = await processor.process(request());
  assert.equal(result.status, 503);
  assert.equal(called, false);
});

test("duplicate verified svix-id applies exactly one lifecycle effect", async () => {
  const store = new InMemoryLifecycleStore();
  const processor = createWebhookProcessor({ config: READY, verifyWebhook: async () => subscription("subscription.active"), lifecycleStore: store });
  const first = await processor.process(request("msg_same"));
  const duplicate = await processor.process(request("msg_same"));
  assert.equal(first.applied, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.effects, 1);
  assert.equal(store.getActorStatus("user_1").status, STATES.ACTIVE);
});

test("verified actor mismatch cannot reassign an existing subscription", async () => {
  const store = new InMemoryLifecycleStore();
  let event = subscription("subscription.active", "user_1");
  const processor = createWebhookProcessor({ config: READY, verifyWebhook: async () => event, lifecycleStore: store });
  assert.equal((await processor.process(request("msg_1"))).status, 200);
  event = subscription("subscription.updated", "user_2");
  const mismatch = await processor.process(request("msg_2"));
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.reason, "billing_actor_mismatch");
  assert.equal(store.getActorStatus("user_1").status, STATES.ACTIVE);
  assert.equal(store.getActorStatus("user_2").status, STATES.FREE);
});

test("past-due and cancellation events deny lifecycle without plan gating", async () => {
  const store = new InMemoryLifecycleStore();
  let event = subscription("subscription.pastDue", "user_1", "past_due");
  const processor = createWebhookProcessor({ config: READY, verifyWebhook: async () => event, lifecycleStore: store });
  await processor.process(request("msg_due"));
  assert.equal(store.getActorStatus("user_1").status, STATES.PAST_DUE);
  event = { type: "subscriptionItem.canceled", data: { id: "item_1", status: "canceled", payer: { user_id: "user_1" }, plan: { slug: "pilot" } } };
  await processor.process(request("msg_cancel"));
  assert.equal(store.getActorStatus("user_1").status, STATES.CANCELED);
});

test("payment events are acknowledged but cannot grant a feature lifecycle", async () => {
  const store = new InMemoryLifecycleStore();
  const event = { type: "paymentAttempt.updated", data: { id: "pay_1", status: "paid", payer: { user_id: "user_1" } } };
  const processor = createWebhookProcessor({ config: READY, verifyWebhook: async () => event, lifecycleStore: store });
  const result = await processor.process(request("msg_pay"));
  assert.equal(result.status, 200);
  assert.equal(result.applied, false);
  assert.equal(store.getActorStatus("user_1").status, STATES.FREE);
});
