# Paid offer experiment

## Question

Can Foresight convert a qualified forecaster's provenance pain into a paid, repeatedly used workflow—and which initial price supports that outcome?

## Design

Randomize qualified prospects within each offer after a consistent live demonstration:

| Arm | Offer shown |
| --- | --- |
| A1 | Verified Alerts at $19/month |
| A2 | Verified Alerts at $29/month |
| B1 | Builder API at $49/month |
| B2 | Builder API at $79/month |

Target at least 20 qualified offer views per product (ten per price) before drawing a directional conclusion. Keep copy, demo, onboarding, and refund terms identical. Do not combine casual traffic with qualified design partners.

Before Clerk enablement, the CTA records `purchase_intent` only. `checkout_started` and `subscription_active` may be emitted only by a real configured flow and verified lifecycle processing.

## PII-free funnel

Measure the ordered stages defined in `event-schema.json`:

`offer_viewed → purchase_intent → checkout_started → subscription_active → refund_recorded / churn_recorded`

Use an HMAC-pseudonymized actor or anonymous session, experiment arm, feature slug, timestamp, and allowlisted context. Never record email, name, wallet/address, phone, IP, raw Clerk ID, or free text.

## Advance thresholds

Advance from validation to a production implementation when all of these are true:

- At least 40 qualified offer views and at least 12 purchase intents (30%).
- At least half of purchase intents start checkout once billing is enabled.
- At least five customers become active paid pilots, with first value inside 24 hours.
- At least 60% of the first cohort remains active at day 30.
- At least three API customers make ten verified calls per week, or at least five alert customers act on two alerts per week.
- Refund rate is at most 10%, verified-event accuracy is 100%, and 95% of alerts arrive within two minutes of the stored transition.
- Ongoing concierge work is at most 30 minutes per customer per week.

Use the higher-price arm when its active conversion is no more than five percentage points below the lower-price arm and retention/usage are not worse. With this sample, treat the result as directional, not statistically definitive.

## Stop or redesign thresholds

Stop the current offer and interview the non-converters if any condition occurs:

- Fewer than 10% express purchase intent after 40 qualified views.
- Fewer than three active customers after 60 qualified views with billing available.
- Refunds exceed 20%, or two customers report a provenance/security error.
- Alert latency misses the two-minute target in more than 5% of verified transitions.
- Concierge work exceeds 60 minutes per customer per week for two consecutive weeks.
- No three active customers use the paid capability weekly by day 30.

Security, actor isolation, and truthful lifecycle state are hard guardrails: one confirmed cross-actor exposure pauses the pilot immediately.
