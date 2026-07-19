# Foresight — pitch and product overview

Foresight is a verified track record for sports predictions.

The product turns “I called it” into an inspectable sequence: a prediction payload is hashed, optionally timestamped outside the app, revealed, graded against TxLINE match data, and shown as a record. The hackathon build demonstrates that sequence while clearly separating real integrations and proof artifacts from local practice and simulated league activity.

- **Try it:** [foresight-txline.vercel.app/?nogate=1](https://foresight-txline.vercel.app/?nogate=1)
- **Technical audit and setup:** [README.md](README.md)
- **Relay status:** [foresight-relay.lordofclaude.workers.dev/health](https://foresight-relay.lordofclaude.workers.dev/health)

## The 20-second pitch

Prediction reputations are easy to edit after the result: winners stay visible, losers disappear, and the claimed timing or price is difficult to audit. Foresight is a prediction league built around receipts. It commits a call before grading, can anchor eligible calls to Solana, and resolves them from TxLINE data. The result is a product prototype for building a track record whose individual verified entries are harder to backdate or rewrite.

The current build proves important pieces of that mechanism. It does not yet provide durable accounts, a production prediction ledger, a large performance sample, or evidence that its demo agents have repeatable edge.

## 30-second judge path

1. Open [the app with the gate skipped](https://foresight-txline.vercel.app/?nogate=1).
2. Pick a side under **Commit a call**. Notice the **PRACTICE** label: captured-match calls are local, not silently presented as on-chain history.
3. Click **⚡ INSTANT**, then verify the hash and try the forge action.
4. Inspect **Real on-chain anchor**. Lead with the Spain–Argentina World Cup Final artifact, anchored around 19 hours before kickoff.
5. Show the atomic settlement receipt: one real devnet transaction composed TxLINE `validateStatV2` and a grade memo. Explain that it proves the validation/receipt mechanism, while the static profile is still local.

Avoid relying on GO LIVE during a timed pitch. The relay routes are real, but an inactive fixture may produce no new frames.

## The pitch story

### 1. Start with the human problem

“Every match, people say ‘I called it.’ The hard part is not publishing a prediction; it is proving when it was made, what market price it faced, and whether the full history includes the losses.”

This is narrower and more defensible than claiming the product proves who is skilled or eliminates fraud altogether.

### 2. Show the product loop

“Foresight locks a canonical call as a hash, optionally gives it an external Solana timestamp, and grades it from TxLINE match data. Reveal-or-burn is designed to make hiding a losing committed call costly inside the record.”

Then make a practice call, run the replay, and verify the hash. The practice label increases trust because the demo does not confuse a local replay interaction with an externally timestamped prediction.

### 3. Show the strongest evidence

The hero timestamp artifact is the Spain–Argentina World Cup Final pick:

- Fixture `18257739`, Argentina/away.
- Solana devnet block time `2026-07-18T23:50:18Z`.
- Scheduled kickoff `2026-07-19T19:00:00Z`.
- The block time is roughly 19 hours before kickoff.

The older Argentina–Switzerland transaction is not the foresight proof. Its kickoff was `2026-07-12T01:00:00Z`, and its memo was anchored at `2026-07-18T17:42:55Z`, after the match. It is useful only as a real memo/hash mechanism demonstration.

The settlement receipt adds a second kind of evidence: transaction `3ukg95uA…JRT1Wybt` successfully composed TxLINE’s devnet `validateStatV2` instruction and a `FSGHT1-SETTLE` memo for England–Argentina in the same transaction. This is client-side instruction composition, not a custom-program CPI. The referenced commit was also posted after that match, so the receipt demonstrates settlement plumbing rather than predictive performance.

### 4. Show why the interface matters

The probability tape, move annotations, upset radar, notional mark-to-market, and profiles make the receipt understandable. They are not independent proof of edge; they are the product surfaces that could make an audited record useful to fans, analysts, and strategy builders.

### 5. End with the product to build

“The hackathon build proves the loop. The next milestone is to persist it: bind Clerk and wallets to an append-only record, wire TxLINE’s price/deadline/stat proof routes into every entry, and expose a shareable profile whose complete history survives reloads.”

That ending creates a credible bridge from prototype to product without implying that persistence, payments, execution, or market adoption already exist.

## What the judge is seeing

| Surface | User value | Current reality |
|---|---|---|
| Probability tape | See how full-match consensus changed around match events. | Runs on four captured TxLINE fixture tapes; optional live mode uses the shipped relay. |
| Upset radar | Prioritize matches whose favorite confidence, score state, and pressure signals look unusual. | Deterministic heuristic, not a probability forecast validated on a large sample. |
| Commit / reveal / burn | Lock a call, reveal it, and penalize an unrevealed local commit. | Fully functional in local demo state; external timestamp only for eligible wallet-signed calls. |
| Verify / forge | Recompute the commitment and explain why a prior external timestamp matters. | Local hash verification is real computation; the practice call has no external time proof. |
| League and profiles | Compare notional, market-relative records and inspect history. | Populated by deterministic simulated identities and browser-local state. |
| Agent builder | Express rule/prompt/API-shaped strategies and run them through the same replay functions. | Rule/prompt logic is local; API mode is a stand-in because no ingestion route exists. |
| Follow / premium | Demonstrate a possible discovery and monetization loop. | Local UI simulation; no payment or real allocation. |
| Clerk gate | Offer Google/Solana account entry. | A real Clerk session maps to a sanitized in-memory handle used by new commits; there is no durable profile, stable Clerk-ID record, account-wallet binding, or persisted history. |
| Wallet anchor | Give an eligible call a Solana devnet timestamp. | Browser wallet path exists; captured historical calls are deliberately practice-only. |
| Settlement receipt | Show that TxLINE stat validation and a grade receipt can be atomic. | One real devnet composition artifact exists; profiles and normal replay grades remain local. |

## Architecture and data flow

```text
CAPTURED REPLAY
real-data/*.tape.js
  -> TxReal normalization
  -> SurpriseAgent wall-clock tape + move detection
  -> Foresight commit/reveal/burn/grade functions
  -> browser UI and in-memory profiles

OPTIONAL LIVE
browser
  -> Cloudflare Worker relay
     -> TxLINE /api/scores/stream
     -> TxLINE /api/odds/stream
     -> public football RSS for /api/news
  -> the same normalization and rendering pipeline

OPTIONAL TIMESTAMP / RECEIPT
browser wallet or proof script
  -> Solana devnet memo transaction
settlement composition
  -> TxLINE validateStatV2 instruction + grade memo in one devnet transaction

ENTRY
browser -> Clerk hosted sign-in
        -> sanitized session handle labels new in-memory commits
        -> no Foresight database or account-wallet binding yet
```

The deploy repository is intentionally small: a static page, shared JavaScript, committed tapes, and a Worker relay. That makes the demo inspectable, but it also means durable reputation is not shipped yet.

## Exact claim ledger

| Label | Shipped evidence | Do not imply |
|---|---|---|
| **REAL** | Four checked-in TxLINE-derived fixture tapes and a shared normalization pipeline. | Four fixtures prove predictive edge, significance, or generalization. |
| **REAL** | Worker routes: `/health`, `/api/scores/stream`, `/api/odds/stream`, `/api/news`. | The Worker exposes every TxLINE or proof endpoint, or that an open stream always has fresh data. |
| **REAL** | World Cup Final devnet memo anchored before kickoff. | One timestamp is a completed track record or a winning prediction. |
| **REAL, POST-MATCH** | Argentina–Switzerland devnet memo/hash artifact. | That artifact predates kickoff or proves foresight. |
| **REAL MECHANISM RECEIPT** | England–Argentina `validateStatV2` plus grade memo composed atomically on devnet. | It is a custom Foresight-program CPI, a pre-match prediction, or a persisted profile grade. |
| **REAL, OPTIONAL** | Connected-wallet memo path for eligible future/verified-live calls. | Every click in the replay is broadcast or automated wallet E2E has passed. |
| **REAL, PARTIAL** | Clerk authenticates entry, maps the user to a sanitized session handle, and includes that handle in new in-memory commit payloads. | The handle is a durable Clerk-ID profile, is linked to a wallet, or owns history that survives reload/rebuild. |
| **PRACTICE** | Human replay calls, local hash verification, reveal/burn, grade, notional portfolio. | A local practice call has an external timestamp or immutable storage. |
| **SIM** | League identities, prompt/rule/API-labeled agents, follow, premium unlock. | These are real users, paid accounts, deployed strategies, or executed trades. |
| **PLANNED** | `POST /api/agents/{id}/commit`, durable profiles, payments, public record URLs, program-owned reputation. | Those systems are present in the static app or Worker. |
| **PLANNED / UNWIRED** | Runtime use of `/api/fixtures/validation`, `/api/odds/validation`, and `/api/scores/stat-validation`. | The current commit screen already returns these proofs. Client helper functions exist, but the UI and relay do not wire them. |

## Why the four tapes matter—and what they do not prove

The repository contains:

- Argentina–Switzerland (`18222446`): final marker present.
- France–Spain (`18237038`): final marker present.
- England–Argentina (`18241006`): final marker present.
- France–England (`18257865`): captured tape without a `game_finalised` marker.

Together they exercise replay ingestion, odds/event alignment, market-move detection, incomplete-match guards, regulation-time grading, and multi-fixture UI behavior. They are pipeline demos. They are not a sufficient sample for claims about hit rate, calibration, profitability, statistical significance, or competitive advantage.

Argentina–Switzerland is particularly useful for settlement correctness. Argentina won after extra time, but the 90-minute full-time 1X2 result was a 1–1 draw. Foresight reads regulation-period keys from the final update rather than using the eventual extra-time score or an interim total. That is an implementation lesson, not a claim that Foresight predicted the result before kickoff.

## API integration: honest inventory

### Shipped runtime integrations

- `GET /health` on the deployed relay.
- `GET /api/scores/stream?fixtureId=...` proxied to TxLINE SSE.
- `GET /api/odds/stream?fixtureId=...` proxied to TxLINE SSE.
- `GET /api/news?teams=...` backed by public RSS with deterministic dedup/tagging.
- Clerk-hosted sign-in UI.
- Solana devnet RPC for optional memo commits and proof receipts.
- Polymarket search deep links only—no API execution or account access.

### Capture-time helpers

`shared/txline-real.js` includes clients for fixture snapshots, score history, odds snapshots/intervals, update windows, and validation calls. The deployed replay loads checked-in files rather than requesting historical data on boot.

`shared/live-poll.js` can accumulate update windows with local credentials. It writes files and currently needs an explicit `--out ../real-data` to target this flattened repository’s checked-in tape directory; it is not part of the judge setup.

### Present as seams, not shipped flows

- Fixture validation for a commit deadline.
- Odds validation for the committed price/message.
- Stat validation for the final result.
- Authenticated external agent commits.
- Persisted identity, reveal scheduling, record publication, and payment entitlements.

The one atomic settlement artifact shows that on-chain stat validation can participate in the mechanism. The normal app does not yet request and store those proofs per replay call.

## Current evidence

The evidence available today is engineering evidence:

- Four captured fixture tapes, three with final markers.
- A real World Cup Final memo timestamped before kickoff.
- A real but post-match memo mechanism artifact.
- A real devnet atomic validation-plus-grade-memo settlement artifact.
- Regression suites last run at 138/138 core, 50/50 UI logic, and 109/109 inline/relay logic.
- A deployed static app and a deployed relay.

There are no claims here of active customers, revenue, paid conversion, long-run model performance, or completed legal review.

## Business hypotheses

The wedge is an audit trail for prediction history. Potential users include fans who want credible bragging rights, analysts who want a public record, model builders who want third-party-verifiable timestamps, and publishers/platforms that want a consistent record format.

Possible models to test:

1. Paid analytics and private leagues.
2. Subscription tools for following verified profiles.
3. B2B verification/profile infrastructure.
4. Qualified referral traffic to execution venues, without implying Foresight executes or custodies funds.

These are hypotheses, not present traction or a legal conclusion. Payments, execution, copying, and jurisdiction-specific operation would need separate product, security, and compliance work.

## The next product milestone

The highest-value next step is not another visualization. It is a durable verified record:

1. Bind Clerk users and wallets to one explicit identity.
2. Persist every commit before accepting a reveal.
3. Wire TxLINE deadline, price, and final-stat validation into the record.
4. Store anchor and validation receipts with each call.
5. Enforce reveal-or-burn outside the browser.
6. Publish stable, shareable profiles with complete histories.
7. Implement signed external-agent ingestion with replay protection.
8. Evaluate strategies on a larger, held-out corpus with uncertainty reported.
9. Add real browser E2E for auth, wallet, relay freshness, and reload behavior.
10. Only then test payment and follow/notification demand.

That milestone converts the strongest hackathon mechanism into the product promised by the first sentence: a verified track record for sports predictions.

## Local verification

Node.js 18 or newer is sufficient for the read-only suites:

```powershell
node test.js
node test-ui-logic.js
node test-inline.js
```

The app itself has no build step; open `index.html` or serve the directory statically.

`npm run verify-wallet-flow` is not part of routine verification. It requires a user-provided funded devnet key at `_keys/wallet.json` and **broadcasts a transaction**, paying a devnet fee and mutating chain state. Use only a throwaway devnet key. See [README.md](README.md) for the complete setup, integration table, and limitations.
