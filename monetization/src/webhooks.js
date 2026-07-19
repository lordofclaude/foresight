"use strict";

const { STATES } = require("./entitlements");

function header(request, name) {
  const headers = request && request.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] || headers[name.toLowerCase()] || null;
}

function actorFromPayer(payer) {
  if (!payer || typeof payer !== "object") return null;
  const ids = [payer.organization_id, payer.user_id].filter(Boolean);
  return ids.length === 1 ? ids[0] : null;
}

function stateFromStatus(value) {
  if (value === "active") return STATES.ACTIVE;
  if (value === "past_due") return STATES.PAST_DUE;
  if (value === "canceled" || value === "ended" || value === "expired" || value === "abandoned") return STATES.CANCELED;
  return STATES.PENDING;
}

function lifecycleTransition(event) {
  if (!event || !event.data) return null;
  const type = event.type, data = event.data;
  if (type.startsWith("paymentAttempt.")) return null;
  const subscriptionEvent = ["subscription.created", "subscription.updated", "subscription.active", "subscription.pastDue"].includes(type);
  const itemEvent = type.startsWith("subscriptionItem.");
  if (!subscriptionEvent && !itemEvent) return null;
  const actorId = actorFromPayer(data.payer);
  if (!actorId || !data.id) throw new Error("billing_actor_or_subject_missing");
  let status = stateFromStatus(data.status);
  if (type === "subscription.active" || type === "subscriptionItem.active") status = STATES.ACTIVE;
  if (type === "subscription.pastDue" || type === "subscriptionItem.pastDue") status = STATES.PAST_DUE;
  if (["subscriptionItem.canceled", "subscriptionItem.ended", "subscriptionItem.expired", "subscriptionItem.abandoned"].includes(type)) status = STATES.CANCELED;
  return { subjectId: `${subscriptionEvent ? "subscription" : "item"}:${data.id}`, actorId, status, sourceType: type };
}

class InMemoryIdempotencyStore {
  constructor() { this.claimed = new Set(); this.completed = new Set(); }
  claim(id) { if (this.claimed.has(id) || this.completed.has(id)) return false; this.claimed.add(id); return true; }
  complete(id) { this.claimed.delete(id); this.completed.add(id); }
  release(id) { this.claimed.delete(id); }
}

class InMemoryLifecycleStore {
  constructor() { this.bySubject = new Map(); this.byActor = new Map(); this.effects = 0; }
  apply(transition, eventId) {
    const existing = this.bySubject.get(transition.subjectId);
    if (existing && existing.actorId !== transition.actorId) throw new Error("billing_actor_mismatch");
    const record = { ...transition, eventId };
    this.bySubject.set(transition.subjectId, record);
    this.byActor.set(transition.actorId, record);
    this.effects++;
    return record;
  }
  getActorStatus(actorId) { return this.byActor.get(actorId) || { actorId, status: STATES.FREE }; }
}

function createWebhookProcessor({ config, verifyWebhook, idempotencyStore, lifecycleStore }) {
  const ids = idempotencyStore || new InMemoryIdempotencyStore();
  const lifecycle = lifecycleStore || new InMemoryLifecycleStore();
  return {
    async process(request) {
      if (!config || !config.ready || config.webhookVerificationConfigured !== true) return { status: 503, ok: false, reason: "billing_not_configured" };
      if (typeof verifyWebhook !== "function") return { status: 503, ok: false, reason: "webhook_verifier_unavailable" };
      let event;
      try { event = await verifyWebhook(request); }
      catch (_) { return { status: 400, ok: false, reason: "signature_verification_failed" }; }
      const eventId = header(request, "svix-id");
      if (!eventId) return { status: 400, ok: false, reason: "verified_event_id_missing" };
      if (!ids.claim(eventId)) return { status: 200, ok: true, duplicate: true };
      try {
        const transition = lifecycleTransition(event);
        if (transition) lifecycle.apply(transition, eventId);
        ids.complete(eventId);
        return { status: 200, ok: true, duplicate: false, applied: Boolean(transition) };
      } catch (error) {
        ids.release(eventId);
        return { status: error.message === "billing_actor_mismatch" ? 409 : 422, ok: false, reason: error.message };
      }
    },
    idempotencyStore: ids,
    lifecycleStore: lifecycle,
  };
}

module.exports = { actorFromPayer, lifecycleTransition, InMemoryIdempotencyStore, InMemoryLifecycleStore, createWebhookProcessor };
