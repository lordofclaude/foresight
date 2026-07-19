# Foresight

Foresight is a verified track record for sports predictions.

It combines captured or live TxLINE match data, hash commitments, optional Solana devnet timestamps, deterministic grading, and a reputation UI. The current build is a hackathon prototype: it demonstrates the proof pipeline, but most replay identities and records are local simulations rather than persisted user history.

- **App:** [foresight-txline.vercel.app](https://foresight-txline.vercel.app)
- **Relay health:** [foresight-relay.lordofclaude.workers.dev/health](https://foresight-relay.lordofclaude.workers.dev/health)
- **Stack:** static HTML/JavaScript, a Cloudflare Worker relay, TxLINE, optional Clerk entry, and Solana devnet

## Judge quickstart

### 30-second path — no account, wallet, or live match required

1. Open [the deployed app with the entry gate skipped](https://foresight-txline.vercel.app/?nogate=1).
2. In **Commit a call**, select a side and commit. The banner correctly labels this a local **PRACTICE** call.
3. Click **⚡ INSTANT**, then **✓ verify my last commit** and **✗ try to forge a backdated call**. The first recomputes the local hash; the second explains why an externally timestamped record cannot be inserted into an earlier slot.
4. In **Real on-chain anchor**, inspect the Spain–Argentina World Cup Final artifact. Its Solana block time is about 19 hours before kickoff. The older Argentina–Switzerland artifact is explicitly labeled post-match.
5. Optional: inspect the atomic settlement receipt. It composes TxLINE `validateStatV2` and a grade memo in one devnet transaction; it is a mechanism proof, not a persisted profile update.

Do not make the demo depend on **GO LIVE**. The relay is shipped, but a successful SSE connection does not guarantee frames when the selected fixture is inactive or the upstream feed is quiet.

### Reproduce locally

Requirements: Node.js 18 or newer. The app has no build step.

```powershell
git clone <repository-url> Foresight
cd Foresight
npm ci
npm test
npm ci --prefix e2e
npx --prefix e2e playwright install chromium
npm run test:browser
python -m http.server 4173
```

The consolidated suites last passed in this working tree on 2026-07-18:

| Suite | Result | Scope |
|---|---:|---|
| `node test.js` | 155 passed | commitment core, scoring, league state, agent rules, and committed-tape integration |
| `node test-ui-logic.js` | 58 passed | selected pure UI functions and source invariants |
| `node test-inline.js` | 109 passed | extracted inline UI logic and relay news helpers |
| `npm run test:domains` | 111 passed | identity binding, proof receipts, live state, capture, follow, and accessibility/performance |
| `npm run test:services` | 100 passed | ledger, relay, evaluation, agent ingestion, proof pages, and monetization validation |
| `npm run test:browser` | 9 passed | deterministic guest, live-state, wallet-mock, reload, mobile, and keyboard flows |

These suites avoid chain mutation. Clerk has a separate three-case Playwright project that skips unless test-instance secrets are supplied; Phantom confirmation is explicitly mocked in CI rather than broadcasting. Active upstream availability and production service bindings still require deployment checks.

If the browser restricts `file://` behavior, serve the directory with any static server; for example, if Python is available:

```powershell
python -m http.server 4173
```

Then open `http://localhost:4173/?nogate=1`.

## The product in one loop

1. **Observe:** show match events and full-match 1X2 StablePrice consensus.
2. **Commit:** hash a canonical prediction payload containing fixture, side, price triple, price timestamp, identity label, and salt.
3. **Timestamp:** for an eligible future or verified-live fixture, a connected wallet can publish the hash as a Solana devnet memo. Historical replay calls stay local practice.
4. **Reveal or burn:** a matching reveal can be graded; an unrevealed local demo commit is treated as a loss.
5. **Grade:** derive the 90-minute result from TxLINE final stats and calculate notional return relative to the committed price.
6. **Explain:** display the probability tape, market moves, upset-risk heuristic, portfolio mark-to-market, and leaderboard/profile views.

This design can make an individual timestamped record auditable. It does not, by itself, prove that a predictor has durable edge, eliminate multi-account behavior, or establish a legal classification.

## Current architecture and data flow

```text
REPLAY (default)
four committed real-data/*.tape.js artifacts
        -> shared/txline-real.js normalizes fixture/events/odds
        -> shared/agent.js builds a wall-clock tape and detects moves
        -> foresight.js commits/reveals/grades and computes scores
        -> index.html renders practice calls, simulated agents, and profiles in memory

LIVE (optional)
browser EventSource-compatible fetch client
        -> deployed relay: /api/scores/stream + /api/odds/stream
        -> TxLINE SSE, with credentials held by the Worker
        -> same normalize/detect/render pipeline as replay
browser -> relay /api/news -> public football RSS -> deterministic tags/dedup
browser -> relay /api/polymarket -> public Gamma discovery + CLOB price history
browser -> lazy official X timeline widget (no X credentials or ingestion)

ANCHOR (optional)
eligible browser call -> connected Solana wallet -> devnet Memo transaction
committed proof artifacts -> browser verification/explorer links

AUTH / IDENTITY
browser -> Clerk sign-in UI
        -> authenticated user maps to a sanitized in-memory handle
        -> new commits in that session include the handle in canonicalPick
        -> no durable account, wallet binding, or persisted record follows
```

The deployed static app still has no application database, so its replay league remains browser-memory demo state. This repository now also contains an append-only D1 ledger implementation, public proof/profile pages, identity binding, and authenticated agent-ingestion services. Those production seams are tested but are **not deployed or configured**, and the main replay UI does not pretend otherwise. `localStorage` is used for entry/relay preferences, never as a verified record store.

## Claim ledger: REAL vs PRACTICE/SIM vs PLANNED

| Status | Surface | What the repository supports | Boundary |
|---|---|---|---|
| **REAL / SHIPPED** | TxLINE inputs | Four checked-in fixture tapes contain match events, StablePrice 1X2 observations, and final markers captured from TxLINE. | They are pipeline fixtures, not a statistical sample proving edge. |
| **REAL / SHIPPED** | Live relay | Worker `1.2.1-shared-state-2026-07-18` implements `/health`, score/odds SSE, news, and the three fixed proof routes. Shared rate/concurrency accounting and freshness telemetry use a Durable Object. | Live usefulness still depends on upstream availability and fixture activity; `/health` is readiness, not proof of a fresh frame. |
| **REAL / SHIPPED** | Pre-kickoff timestamp | `anchored-proof-final.json` records an Argentina pick for Spain–Argentina, anchored on devnet at `2026-07-18T23:50:18Z`, before the `2026-07-19T19:00:00Z` kickoff. | This proves that committed payload existed by that Solana block time. It does not yet show the final grade or a long track record. |
| **REAL / SHIPPED** | Post-match mechanism anchor | `anchored-proof.json` contains a real devnet memo for Argentina–Switzerland. | Its block time is `2026-07-18T17:42:55Z`, while kickoff was `2026-07-12T01:00:00Z`; it is post-match and proves only memo/hash plumbing. |
| **REAL / SHIPPED** | Atomic settlement receipt | `settlement-proof.json` records a successful devnet transaction that composed TxLINE `validateStatV2` for England–Argentina and a `FSGHT1-SETTLE` grade memo in the same transaction. | This is client-side instruction composition, not a custom Foresight-program CPI. The referenced commit was made after the match, so this is a settlement mechanism proof, not evidence of foresight. The grade is not written to a persisted Foresight profile. |
| **REAL / OPTIONAL** | Browser wallet commit | For an eligible future or verified-live fixture, the browser can ask a connected Solana wallet to sign and send the memo transaction. | Completed/captured fixtures remain practice-only. Wallet UI was not covered by the automated suites above. |
| **REAL / PARTIAL** | Clerk | The landing gate loads Clerk; an authenticated user maps to a sanitized in-memory handle. `shared/identity-binding.js` additionally implements stable Clerk subject IDs and signed, expiring wallet-link challenges. | The deployed UI still uses the session label only. The binding service is fail-closed until a real backend is configured and has not been deployed. |
| **IMPLEMENTED / RELAY DEPLOYMENT PENDING** | Polymarket comparison | The redesigned UI compares TxLINE StablePrice with like-for-like public Polymarket moneylines at the selected replay timestamp. `relay/worker.js` discovers the exact event through Gamma and reads CLOB history without credentials. Missing or post-target history remains unavailable and is labeled as partial coverage; current prices are never substituted into an as-of comparison. | The currently deployed `1.2.1` relay predates `/api/polymarket`; deploy the updated Worker before relying on this panel publicly. Foresight still does not query positions, place orders, verify execution, or touch funds. |
| **REAL / OPTIONAL EMBED** | X context | The context card lazy-loads X's official `platform.x.com/widgets.js` timeline only when the X tab is opened, with a matchup search link as fallback. | No X API credentials, firehose, sentiment score, or archived tweet dataset exists. Browser/privacy blockers may suppress the embed. |
| **PRACTICE / LOCAL** | Human replay calls | Hash, reveal, burn, grade, verify, forge demo, and notional P&L run locally against real captured inputs. | No external timestamp unless an eligible wallet flow is used; no persistence after reload. |
| **PRACTICE / SIM** | League field and agents | Rule, prompt, API-labeled, and manual identities traverse the same local league functions and populate the UI. | These are deterministic demo identities. They are not users or imported performance records. |
| **PRACTICE / SIM** | Prompt agent | Natural-language-like input is compiled by deterministic keyword rules. | No LLM is called. Unsupported lineup/player triggers are not real data integrations. |
| **PRACTICE / TESTED SEAM** | Follow and premium | Follow is now explicitly a receipt-alert watchlist, labeled local/not persisted. A separate Clerk Billing entitlement/webhook validation module is tested. | No payment processor is enabled, no subscription is sold, and follow never implies copy execution, custody, or portfolio mutation. |
| **IMPLEMENTED / NOT DEPLOYED** | External agent ingestion | `agent-ingest/` accepts signed commit-only requests with Ed25519 verification, ownership binding, replay protection, rate limits, idempotency, and proof/fixture validation. | Production bindings and an agent registry are not configured; the API-labeled demo agent remains local. |
| **REAL RELAY / UI UNWIRED** | TxLINE proof lookups | The deployed relay exposes fixture, odds, and stat validation routes; `shared/proof-receipts.js` binds and validates their response contracts. | The main commit/grade UI does not yet persist those receipts into the ledger, and an API response is not mislabeled cryptographically verified. |
| **IMPLEMENTED / NOT DEPLOYED** | Durable reputation | `ledger/` implements append-only receipts, server-enforced transitions, immutable evidence, authoritative grading, public reads, and profile aggregates. | D1, auth, and proof-verifier bindings are deliberately fail-closed and not provisioned for the public app. |
| **PLANNED** | On-chain profile state | A program-owned reputation account and contract-enforced reveal/grade state machine. | This deploy repository includes proof artifacts and client composition, not a deployed Foresight reputation program. |

## The four checked-in fixtures

| Fixture | Captured events | Odds observations | Final marker |
|---|---:|---:|---|
| Argentina–Switzerland (`18222446`) | 239 | 1,726 | yes |
| France–Spain (`18237038`) | 172 | 2,540 | yes |
| England–Argentina (`18241006`) | 167 | 2,637 | yes |
| France–England (`18257865`) | 142 | 2,519 | yes |

The tapes are valuable demonstrations of ingestion, normalization, replay, move detection, and settlement guards. Four finalized fixtures are still not enough to estimate predictive performance, calibration stability, or commercial advantage. The leakage-safe report currently has only two holdout fixtures versus its minimum of twenty, so it explicitly refuses a performance claim.

### The Argentina–Switzerland settlement lesson

This fixture is useful for mechanism correctness, not for the timestamp claim. Argentina won 3–1 after extra time, but the full-time 1X2 market settles on the 90-minute result: 1–1. The replay grader therefore reads the final event’s regulation-period keys (`1001 + 3001` and `1002 + 3002`) rather than deriving a result from the eventual extra-time score or an interim stats map.

Separately, the committed `anchored-proof.json` transaction was posted days after this match. The UI and these docs label it as a post-match mechanism anchor. The real pre-kickoff timestamp example is the Spain–Argentina World Cup Final artifact in `anchored-proof-final.json`.

## API and integration inventory

### Runtime routes that are actually shipped

| Route/dependency | Called by | Behavior |
|---|---|---|
| Relay `GET /health` | browser live control | Reports relay readiness/config presence; it does not prove upstream frames are flowing. |
| Relay `GET /api/scores/stream?fixtureId=...` | browser live mode | Proxies TxLINE score SSE with server-held credentials. |
| Relay `GET /api/odds/stream?fixtureId=...` | browser live mode | Proxies TxLINE odds SSE with server-held credentials. |
| Relay `GET /api/news?teams=...` | selected-match context and browser live mode | Fetches public RSS, deduplicates titles, and applies deterministic keyword tags. |
| Relay `GET /api/polymarket?home=...&away=...&atMs=...` | market-intelligence comparison | Discovers the exact public Polymarket event, resolves its three moneylines, and returns public CLOB prices at or before the TxLINE quote timestamp. Per-outcome timestamps and modes expose partial coverage without substituting current or future prices. Implemented and tested locally; updated Worker deployment pending. |
| Clerk hosted JavaScript | landing gate | Authenticates entry and labels subsequent in-memory commits with a sanitized session handle; it does not create a durable profile or account-wallet binding. |
| Solana devnet RPC | wallet/CLI proof flows | Sends memo transactions and queries confirmations. |
| Official X website widget | context tab | Lazy-loads the public `FIFAWorldCup` timeline from X; direct matchup search remains available when embeds are blocked. |

The Worker is read-only with respect to Foresight users. Rate/concurrency accounting and upstream freshness telemetry are coordinated through a Durable Object; a compatibility fallback remains for environments without that binding. The public deployment still warns that `ALLOWED_ORIGINS` is unset.

### Capture helpers and TxLINE seams

`shared/txline-real.js` contains direct TxLINE clients for fixture snapshots, historical score SSE, odds snapshots/updates, live streams, and validation endpoints. At normal app boot, however, replay data comes from checked-in tape files; the browser does not refetch the historical endpoints.

`shared/live-poll.js` is a credentialed local capture helper for score/odds update windows. It is not part of the judge path. It is dry-run by default, requires explicit `--write` confirmation, restricts output to the root `real-data/` directory, supports atomic resume/backups and final/incomplete markers, and refuses unsafe credential/config paths. See `shared/LIVE-CAPTURE.md` and the ignored config template.

The following proof seams are deployed on the relay and have strict client contracts, but are not yet persisted by the main prediction UI:

- `GET /api/fixtures/validation` — intended deadline/start-time proof.
- `GET /api/odds/validation` — intended anchored-price proof.
- `GET /api/scores/stat-validation` — intended result/stat proof.

The committed settlement artifact is evidence that `validateStatV2` can be composed successfully on devnet. The static replay still grades locally, and profiles remain local.

## Wallet and chain verifier: read before running

The normal app does not need a raw key file: a browser wallet signs directly. The CLI proof scripts are different. They require `npm install`, a user-provided **throwaway funded devnet keypair** at `_keys/wallet.json`, network access, and devnet SOL.

```powershell
npm install
npm run verify-wallet-flow
```

That command is **not a read-only test**. It broadcasts a transaction, pays a devnet fee, changes chain state, and changes the supplied wallet balance. Never use a valuable or mainnet-funded key. `npm run anchor` also broadcasts and rewrites `anchored-proof.json`; it should not be part of routine judging. `anchor-final.js` is a one-off artifact generator with an out-of-repository key path and an existing-output guard, not a reproducible setup step.

## Scoring and product signals

- The $100 stake is notional. A win is scored at the de-vigged committed price; a loss is `-$100`.
- Leaderboard score applies `average return × n/(n+6)` shrinkage to reduce the visual impact of very small samples.
- Upset risk is a deterministic heuristic using favorite-price decline, score state, and underdog pressure events.
- Market-move detection operates on the captured/live consensus tape. TxLINE inputs used here do not provide traded volume, so “move” means implied-probability change, not liquidity flow.
- News-driver matching is a keyword/recency suggestion. It is labeled as a possible driver, not a causal conclusion.

These are prototype analytics. They need more fixtures, holdout evaluation, sensitivity analysis, and monitoring before being used as performance claims.

## Top 15 production improvements: implementation status

1. **Durable ledger — implemented, deployment pending:** D1 schema, append-only receipts/events, idempotency, public reads, and fail-closed auth/proof adapters.
2. **Identity binding — implemented, integration pending:** stable Clerk subjects plus signed, expiring, domain-bound wallet challenges, replay protection, unlink, and account-switch handling.
3. **Proof receipts — implemented, UI persistence pending:** deadline, quote, and final-stat contracts preserve provenance/root/slot and reject mismatches, staleness, or unsupported verification labels.
4. **Server state machine — implemented, deployment pending:** only legal COMMITTED → REVEALED → GRADED or terminal BURNED/INVALID transitions are accepted.
5. **Verified grades/evidence — implemented, deployment pending:** immutable evidence taxonomy prevents memo/mechanism artifacts from becoming authoritative grades.
6. **Authenticated agent ingestion — implemented, deployment pending:** commit-only Ed25519 API with ownership, nonce/timestamp replay defense, allowlists, proof binding, and idempotency.
7. **Leakage-safe evaluation — implemented, sample expansion pending:** whole-fixture chronological splits, 90-minute outcomes, baseline metrics, calibration, uncertainty, and explicit low-N refusal.
8. **Browser E2E — implemented:** deterministic guest, live-state, wallet-mock, reload, mobile, keyboard, and optional Clerk-token projects; Clerk cases skip unless test secrets exist.
9. **Durable relay state — deployed:** Durable Object coordination, shared rate/concurrency controls, persistent telemetry, freshness states, request IDs, and sanitized errors.
10. **Evidence-based live state — implemented:** CONNECTING/LIVE/STALE/ERROR/ENDED plus exact fixture/quote freshness guards for wallet eligibility.
11. **Safe capture workflow — implemented:** dry-run default, explicit write confirmation, safe paths, resume/backups, redaction, and final/incomplete manifests.
12. **Shareable proof pages — implemented, ledger deployment pending:** receipt/profile entry points, strict origin/ID handling, CSP, accessible sample mode, evidence labels, and print/mobile layouts.
13. **Follow semantics — implemented as alerts only:** creator+strategy watchlists never imply copying, execution, allocation, persistence, or custody.
14. **Monetization validation — implemented, disabled:** fail-closed Clerk feature checks, signed/idempotent webhooks, PII-free funnel, concierge pilot, and pricing experiment; no fake checkout.
15. **Accessibility/performance — implemented:** keyboard-native controls, focus-managed dialogs, chart alternatives, deduplicated announcements, reduced-motion/render budgets, and 390px/200% reflow hardening.

The ranked top-20 judge-facing improvements and pitch rationale are tracked in `HACKATHON-REVIEW.md`. “Implemented” above means source and tests exist; only the relay item is currently deployed as a service.

## Repository map

- [`index.html`](index.html) — static UI, replay/live rendering, Clerk gate, browser wallet flow, and demo interactions.
- [`foresight.js`](foresight.js) — commitment, reveal/burn, scoring, profiles, agent rules, and outcome logic.
- [`shared/txline-real.js`](shared/txline-real.js) — TxLINE client, SSE parser, tape normalization, and proof helper seams.
- [`shared/agent.js`](shared/agent.js) — market-move detector and real-tape adapter.
- [`relay/worker.js`](relay/worker.js) — deployed SSE/news relay and its route-level controls.
- [`ledger/`](ledger/) — append-only receipt/evidence service and public profile aggregation.
- [`agent-ingest/`](agent-ingest/) — signed external-agent commit API.
- [`proof-pages/`](proof-pages/) — safe public receipt/profile pages with deterministic sample mode.
- [`evaluation/`](evaluation/) — leakage-safe baseline evaluation and low-sample claim gate.
- [`e2e/`](e2e/) — Playwright guest, live, wallet-mock, responsive, and optional Clerk tests.
- [`monetization/`](monetization/) — disabled-by-default entitlement/webhook and demand-validation seam.
- [`assets/world-cup/`](assets/world-cup/) — ten original, optimized international-football images plus prompt/placement manifest.
- [`real-data/`](real-data/) — four checked-in fixture tapes.
- [`anchored-proof-final.json`](anchored-proof-final.json) — real pre-kickoff World Cup Final devnet anchor.
- [`anchored-proof.json`](anchored-proof.json) — real but post-match Argentina–Switzerland mechanism anchor.
- [`settlement-proof.json`](settlement-proof.json) — real atomic devnet validation-plus-grade-memo receipt.
- [`test.js`](test.js), [`test-ui-logic.js`](test-ui-logic.js), [`test-inline.js`](test-inline.js) — current local regression suites.
- [`verify-wallet-flow.js`](verify-wallet-flow.js) — chain-mutating devnet verifier; not a normal test.

## Business framing

The product hypothesis is that some fans, analysts, model builders, and publishers will value an audit trail that makes prediction history harder to edit after the fact. Possible revenue paths include paid analytics, private leagues, verified-profile tooling, and platform integrations. Those are hypotheses: this repository contains no revenue, paid subscribers, customer validation, or legal opinion.

Foresight does not currently custody funds or execute wagers. Any future execution, payments, copy allocation, or commercial deployment would require separate product, security, compliance, and jurisdiction-specific review.
