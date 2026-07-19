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
node test.js
node test-ui-logic.js
node test-inline.js
Start-Process .\index.html
```

The three suites last passed in this working tree on 2026-07-18:

| Suite | Result | Scope |
|---|---:|---|
| `node test.js` | 138 passed | commitment core, scoring, league state, agent rules, and committed-tape integration |
| `node test-ui-logic.js` | 50 passed | selected pure UI functions and source invariants |
| `node test-inline.js` | 109 passed | extracted inline UI logic and relay news helpers |

These are useful regression suites, not an end-to-end certification. They do not automate a real Clerk session, Phantom popup, active TxLINE stream, browser persistence, or the external agent contract.

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

ANCHOR (optional)
eligible browser call -> connected Solana wallet -> devnet Memo transaction
committed proof artifacts -> browser verification/explorer links

AUTH / IDENTITY
browser -> Clerk sign-in UI
        -> authenticated user maps to a sanitized in-memory handle
        -> new commits in that session include the handle in canonicalPick
        -> no durable account, wallet binding, or persisted record follows
```

There is no application database in this repository. League state, follow state, built agents, and profiles are browser-memory demo state; reloading resets them. `localStorage` is used for entry/relay preferences, not as a verified record store.

## Claim ledger: REAL vs PRACTICE/SIM vs PLANNED

| Status | Surface | What the repository supports | Boundary |
|---|---|---|---|
| **REAL / SHIPPED** | TxLINE inputs | Four checked-in fixture tapes contain match events and StablePrice 1X2 observations captured from TxLINE. | They are pipeline fixtures, not a statistical sample proving edge. The France–England tape has no `game_finalised` event. |
| **REAL / SHIPPED** | Live relay | The Worker implements `/health`, `/api/scores/stream`, `/api/odds/stream`, and `/api/news`. | Live usefulness depends on upstream availability and fixture activity. Limits and JWT cache are per Worker isolate. |
| **REAL / SHIPPED** | Pre-kickoff timestamp | `anchored-proof-final.json` records an Argentina pick for Spain–Argentina, anchored on devnet at `2026-07-18T23:50:18Z`, before the `2026-07-19T19:00:00Z` kickoff. | This proves that committed payload existed by that Solana block time. It does not yet show the final grade or a long track record. |
| **REAL / SHIPPED** | Post-match mechanism anchor | `anchored-proof.json` contains a real devnet memo for Argentina–Switzerland. | Its block time is `2026-07-18T17:42:55Z`, while kickoff was `2026-07-12T01:00:00Z`; it is post-match and proves only memo/hash plumbing. |
| **REAL / SHIPPED** | Atomic settlement receipt | `settlement-proof.json` records a successful devnet transaction that composed TxLINE `validateStatV2` for England–Argentina and a `FSGHT1-SETTLE` grade memo in the same transaction. | This is client-side instruction composition, not a custom Foresight-program CPI. The referenced commit was made after the match, so this is a settlement mechanism proof, not evidence of foresight. The grade is not written to a persisted Foresight profile. |
| **REAL / OPTIONAL** | Browser wallet commit | For an eligible future or verified-live fixture, the browser can ask a connected Solana wallet to sign and send the memo transaction. | Completed/captured fixtures remain practice-only. Wallet UI was not covered by the automated suites above. |
| **REAL / PARTIAL** | Clerk | The landing gate loads Clerk; an authenticated user maps to a sanitized in-memory handle, and new commits in that session hash the handle into `canonicalPick`. | The handle is not a durable identity record: there is no database, stable Clerk-ID profile, account-wallet binding, or history that survives a rebuild/reload. |
| **REAL / OUTBOUND LINK** | Polymarket | The UI opens a Polymarket search in a new tab. | Foresight does not query positions, place orders, verify execution, or touch funds. |
| **PRACTICE / LOCAL** | Human replay calls | Hash, reveal, burn, grade, verify, forge demo, and notional P&L run locally against real captured inputs. | No external timestamp unless an eligible wallet flow is used; no persistence after reload. |
| **PRACTICE / SIM** | League field and agents | Rule, prompt, API-labeled, and manual identities traverse the same local league functions and populate the UI. | These are deterministic demo identities. They are not users or imported performance records. |
| **PRACTICE / SIM** | Prompt agent | Natural-language-like input is compiled by deterministic keyword rules. | No LLM is called. Unsupported lineup/player triggers are not real data integrations. |
| **PRACTICE / SIM** | Follow and premium | Follow/auto-allocation UI and a two-step premium unlock are demoable. | No payment processor, subscription, custody, or real allocation is wired. Dollar values are notional. |
| **PLANNED** | External agent ingestion | The UI documents `POST /api/agents/{id}/commit`. | No such server route exists in the Worker or static app. The API agent shown is a local stand-in. |
| **PLANNED / UNWIRED** | TxLINE proof lookups | `shared/txline-real.js` has helpers for fixture, odds, and stat validation. | The relay does not expose them and the commit/grade UI does not invoke them. Copy that calls the price “provable” describes the intended seam, not the current runtime path. |
| **PLANNED** | Durable reputation | Bind Clerk/wallet identities to immutable commits, reveals, grades, and public profiles. | There is no application database or durable record service today. |
| **PLANNED** | On-chain profile state | A program-owned reputation account and contract-enforced reveal/grade state machine. | This deploy repository includes proof artifacts and client composition, not a deployed Foresight reputation program. |

## The four checked-in fixtures

| Fixture | Captured events | Odds observations | Final marker |
|---|---:|---:|---|
| Argentina–Switzerland (`18222446`) | 239 | 1,726 | yes |
| France–Spain (`18237038`) | 172 | 2,540 | yes |
| England–Argentina (`18241006`) | 167 | 2,637 | yes |
| France–England (`18257865`) | 142 | 2,519 | no |

The tapes are valuable demonstrations of ingestion, normalization, replay, move detection, and settlement guards. Four fixtures—three final and one incomplete—are not enough to estimate predictive performance, calibration stability, or commercial advantage. Any thresholds derived from them should be presented as prototype settings pending out-of-sample evaluation.

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
| Relay `GET /api/news?teams=...` | browser live mode | Fetches public RSS, deduplicates titles, and applies deterministic keyword tags. |
| Clerk hosted JavaScript | landing gate | Authenticates entry and labels subsequent in-memory commits with a sanitized session handle; it does not create a durable profile or account-wallet binding. |
| Solana devnet RPC | wallet/CLI proof flows | Sends memo transactions and queries confirmations. |
| Polymarket web search | outbound link | Opens a search page only. |

The Worker is read-only with respect to Foresight users. Its token buckets, concurrent-stream counter, and JWT cache are per-isolate best efforts rather than globally durable controls.

### Capture helpers and TxLINE seams

`shared/txline-real.js` contains direct TxLINE clients for fixture snapshots, historical score SSE, odds snapshots/updates, live streams, and validation endpoints. At normal app boot, however, replay data comes from checked-in tape files; the browser does not refetch the historical endpoints.

`shared/live-poll.js` is a credentialed local capture helper for score/odds update windows. It is not part of the judge path. Its current default output is relative to `shared/`, while the checked-in tapes live in root `real-data/`; a developer must explicitly pass `--out ../real-data` and provide `shared/.txline.json`. It writes accumulator/tape files.

The following proof seams exist as client helpers but are not wired into the deployed relay or prediction UI:

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

## Top limitations and next steps

1. **Persist the ledger:** store commits, reveals, burns, validation receipts, and grades in a durable append-only service.
2. **Bind identity:** map Clerk user IDs and connected wallets to the same Foresight profile, with explicit account-linking and recovery.
3. **Wire all three TxLINE proof calls:** verify fixture deadline, price/message, and final stats in the production commit/grade path.
4. **Enforce the state machine:** move hash/reveal/grade rules from browser-only logic into a service or program that cannot silently omit records.
5. **Persist verified grades:** connect the real atomic settlement receipt to a durable public profile; distinguish program state from a memo receipt.
6. **Ship authenticated agent ingestion:** implement the documented agent endpoint with signatures, replay protection, rate limits, and fixture/price validation.
7. **Expand evaluation:** capture a materially larger multi-competition dataset and publish pre-registered, out-of-sample metrics with uncertainty.
8. **Add browser E2E coverage:** automate guest path, Clerk callback, live relay states, wallet rejection/pending/confirmation, reload behavior, and mobile layouts.
9. **Harden relay state:** move global rate/concurrency accounting and JWT coordination to durable infrastructure; add observable upstream freshness.
10. **Make live status evidence-based:** distinguish connected, first frame received, fresh frames, stale, ended, and replay/captured states.
11. **Fix the capture workflow:** align `shared/live-poll.js` output/config paths with this flattened deploy repository and document safe secret setup.
12. **Create shareable proof pages:** expose a stable record URL containing commitment, anchor, validation inputs, reveal, and grade.
13. **Implement follow semantics:** define whether follow means alerts, mirrored practice calls, or real execution; do not imply execution before it exists.
14. **Validate monetization:** treat premium analytics/follow as hypotheses until payment, entitlement, refunds, and customer demand are tested.
15. **Complete accessibility/performance QA:** keyboard flow, reduced motion, chart alternatives, contrast, screen-reader labels, low-end devices, and slow networks.

## Repository map

- [`index.html`](index.html) — static UI, replay/live rendering, Clerk gate, browser wallet flow, and demo interactions.
- [`foresight.js`](foresight.js) — commitment, reveal/burn, scoring, profiles, agent rules, and outcome logic.
- [`shared/txline-real.js`](shared/txline-real.js) — TxLINE client, SSE parser, tape normalization, and proof helper seams.
- [`shared/agent.js`](shared/agent.js) — market-move detector and real-tape adapter.
- [`relay/worker.js`](relay/worker.js) — deployed SSE/news relay and its route-level controls.
- [`real-data/`](real-data/) — four checked-in fixture tapes.
- [`anchored-proof-final.json`](anchored-proof-final.json) — real pre-kickoff World Cup Final devnet anchor.
- [`anchored-proof.json`](anchored-proof.json) — real but post-match Argentina–Switzerland mechanism anchor.
- [`settlement-proof.json`](settlement-proof.json) — real atomic devnet validation-plus-grade-memo receipt.
- [`test.js`](test.js), [`test-ui-logic.js`](test-ui-logic.js), [`test-inline.js`](test-inline.js) — current local regression suites.
- [`verify-wallet-flow.js`](verify-wallet-flow.js) — chain-mutating devnet verifier; not a normal test.

## Business framing

The product hypothesis is that some fans, analysts, model builders, and publishers will value an audit trail that makes prediction history harder to edit after the fact. Possible revenue paths include paid analytics, private leagues, verified-profile tooling, and platform integrations. Those are hypotheses: this repository contains no revenue, paid subscribers, customer validation, or legal opinion.

Foresight does not currently custody funds or execute wagers. Any future execution, payments, copy allocation, or commercial deployment would require separate product, security, compliance, and jurisdiction-specific review.
