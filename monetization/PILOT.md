# Concierge pilot: verified receipt operations

## Hypothesis

Independent forecasting agents and small prediction teams making at least 50 public calls per month will pay to remove the manual work of proving when a call was made, monitoring its lifecycle, and distributing a verifiable record. The narrow wedge is operational trust infrastructure—not picks, betting execution, custody, or financial advice.

## Ideal first customers

- Independent sports or event-forecasting agents with a public audience.
- Small quant communities, contests, or newsletters publishing 50+ calls per month.
- Teams that already copy links, screenshots, hashes, or timestamps into a manual audit trail.

Casual bettors and teams seeking automated wagering are out of scope for this pilot.

## Offers

| Pilot | Price hypothesis | Delivered outcome |
| --- | ---: | --- |
| Verified Alerts | $19/month | Instant receipt confirmation, stale/final status alerts, and a weekly verified-record digest. Includes a 20-minute concierge setup. |
| Builder API | $49/month | Everything in Alerts plus read-only receipt lookup and signed lifecycle webhooks, one developer credential, and a 10,000-call monthly fair-use limit. |

Both offers map to feature slugs (`verified_receipt_alerts`, `verified_receipt_api`). Names and prices are experiments; they never become authorization logic.

## Fourteen-day pilot motion

1. Recruit 20 qualified prospects from active forecaster communities and conduct ten 20-minute workflow interviews.
2. Ask each prospect to show the last time provenance or lifecycle tracking cost them credibility or time; record the current workaround and weekly minutes spent.
3. Show one live receipt moving from captured to finalized, then present one randomized offer from `EXPERIMENT.md`.
4. Before billing is enabled, collect only explicit purchase intent and scheduling consent. Do not show checkout, claim payment, or label anyone premium.
5. After the enablement checklist is complete, onboard paying design partners manually, confirm their first verified record within 24 hours, and review usage weekly.

## Concierge delivery promise

For each active pilot customer, Foresight will configure one alert destination, validate the first five receipts, investigate missed lifecycle transitions, and deliver a weekly proof-of-record digest. All paid API and alert actions still pass the server entitlement gate. Manual support cannot override `PAST_DUE`, `CANCELED`, or `REFUNDED`.

## Evidence to capture

- Current manual minutes per week and the artifact used as proof.
- Purchase intent at the shown price, checkout completion, activation time, and paid retention.
- Number of verified records opened, alerts acted on, and API calls made.
- Refund/churn reason selected from a short non-PII taxonomy.

The pilot wins only if customers repeatedly use the proof workflow and pay; compliments and waitlist signups are supporting evidence, not success.
