# Foresight monetization validation

This package is a deliberately isolated validation seam for a paid Foresight pilot. It does **not** turn on billing, render checkout, grant a premium badge, or modify the product. Until Clerk Billing is explicitly enabled with development credentials and a verified webhook is configured, every paid capability fails closed.

## What it validates

- Whether serious forecasters will pay for verified receipt alerts and read-only API access.
- Whether a request has a fresh, actor-bound Clerk feature entitlement.
- Whether subscription lifecycle updates came through a signed, idempotent webhook.
- Whether funnel measurement can answer the commercial question without collecting PII.

## Package boundaries

`src/config.js` reports readiness from explicit test-only configuration. `src/entitlements.js` authorizes feature slugs only when the local lifecycle is `ACTIVE` and the Clerk evidence is fresh and actor-bound. `src/webhooks.js` accepts an injected official Clerk `verifyWebhook(req)` adapter, applies lifecycle transitions once per `svix-id`, and refuses actor reassignment. `src/events.js` validates an allowlisted, pseudonymous funnel schema.

The lifecycle model is `FREE`, `PENDING`, `ACTIVE`, `PAST_DUE`, `CANCELED`, and `REFUNDED`. Only `ACTIVE` can pass a paid feature gate. Plan names never authorize a capability.

## Run the focused tests

```powershell
cd C:\Users\lordo\Desktop\Foresight\monetization
npm test
```

The tests cover no configuration, forged and stale entitlements, actor mismatch, past-due/canceled/refunded denial, forged webhooks, duplicate delivery, and PII rejection.

## Integration contract

1. Complete `CLERK-ENABLEMENT.md` in a separate Clerk development instance.
2. On the server, construct configuration from secrets and inject Clerk's framework-specific `verifyWebhook(req)` helper into `createWebhookProcessor`.
3. Feed verified subscription events into a durable implementation of the lifecycle and idempotency stores. The in-memory stores are test/reference implementations only.
4. At every paid server action, resolve Clerk auth and call `authorizeFeature` using `verified_receipt_alerts` or `verified_receipt_api`.
5. Return a neutral upgrade/renewal response on denial; never trust UI state, plan labels, or client-supplied claims.
6. Emit only validated events from `events.js` and aggregate by experiment arm.

Official implementation references: [Clerk Billing](https://clerk.com/docs/guides/billing/overview), [feature-based access checks](https://clerk.com/docs/guides/billing/for-b2c-saas/access-control), and [webhook verification](https://clerk.com/docs/guides/development/webhooks/overview).
