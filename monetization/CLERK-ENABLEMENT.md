# Clerk Billing development enablement checklist

Current posture: **not enabled or verified**. The repository contains no Clerk Billing credentials or webhook signing secret, so paid capabilities must remain unavailable and checkout must not be rendered.

No Clerk Dashboard, Stripe, production, or secret-management changes were made by this package.

## Development instance

- [ ] Create or select a separate non-production Clerk instance.
- [ ] Enable Clerk Billing explicitly in that development instance.
- [ ] Use only `pk_test_…`, `sk_test_…`, and the development webhook's `whsec_…` secret.
- [ ] Set `FORESIGHT_CLERK_BILLING_ENABLED=true` only after Billing is visibly enabled.
- [ ] Keep all secret keys server-side and out of source control and browser bundles.
- [ ] Confirm the chosen B2C user or B2B organization billing model before creating plans.

## Products and feature entitlements

- [ ] Define feature `verified_receipt_alerts` for the alert capability.
- [ ] Define feature `verified_receipt_api` for read-only receipt/API access.
- [ ] Attach features to the development pilot plans; plan names may describe offers but never authorize them.
- [ ] At every server operation, call Clerk `has({ feature: "…" })` and combine it with the local verified `ACTIVE` lifecycle.
- [ ] Deny on missing auth, missing configuration, unknown feature, stale evidence, actor mismatch, or any state other than `ACTIVE`.
- [ ] Reload the authenticated session after a real checkout so fresh Clerk feature evidence is available; still treat webhooks as asynchronous.

## Verified webhook seam

- [ ] Expose a public server route that passes the untouched request to Clerk's framework-specific `verifyWebhook(req)` helper.
- [ ] Subscribe only to the required Clerk Billing lifecycle events, including `subscription.created`, `subscription.updated`, `subscription.active`, `subscription.pastDue`, and relevant `subscriptionItem.*` lifecycle events.
- [ ] Persist `svix-id` in a durable store with a unique constraint before applying side effects.
- [ ] Bind each subscription/item subject to exactly one Clerk user or organization actor and reject reassignment.
- [ ] Store the verified lifecycle and timestamps durably; the in-memory classes in this package are only reference/test adapters.
- [ ] Return success for duplicate verified deliveries without replaying side effects.
- [ ] Do not grant access from payment-attempt events, client callbacks, plan text, query parameters, or unverified webhook JSON.

Clerk's payment-attempt events do not provide a complete refund lifecycle. Set `REFUNDED` only from a separately verified, authoritative reconciliation/admin process; never infer it from a browser event. `REFUNDED`, `PAST_DUE`, and `CANCELED` must revoke the feature gate immediately in the local contract.

## Validation before any checkout UI

- [ ] Run `npm test` and retain coverage for forged/stale evidence, actor mismatch, negative lifecycle states, duplicate webhooks, and missing configuration.
- [ ] Use Clerk development test payment methods to exercise activation, failed payment, cancellation, and session refresh.
- [ ] Replay a signed duplicate and confirm one lifecycle side effect.
- [ ] Send a forged signature and confirm no state change.
- [ ] Attempt cross-actor reuse and confirm denial.
- [ ] Reconcile a refund and confirm both alert and API capabilities deny.
- [ ] Confirm funnel events contain no direct identifiers or free text.
- [ ] Only after all checks pass, implement real checkout in the server-backed product. `billingConfigFromEnv()` intentionally reports `canRenderCheckout: false`; this validation package alone never authorizes checkout.

Production enablement is a separate security and operations decision and may require an attached payment provider. It is explicitly outside this implementation.
