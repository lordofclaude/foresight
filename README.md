# ⚡ FORESIGHT — verified prediction reputation on TxLINE (Track 1)

**The prediction league where reputations are provable.** The upset radar surfaces the moment → you commit a call whose hash is timestamp-anchored before the market moves → the move-detector proves *when* the consensus caught up ("market lag receipts") → your score compounds into a bettor reputation that cannot be forged or backdated. **No money ever moves** — the settlement engine settles *reputation* instead of funds, which makes it the cleanest possible Track 1 product legally while still exercising the track's stated tiebreaker (custom validation logic over TxLINE's primitives).

Open `index.html` (double-click, `file://`, zero installs) — it ships **four real World Cup fixtures**: three complete replay tapes (Argentina–Switzerland 18222446, France–Spain 18237038, England–Argentina 18241006 — real score events + real StablePrice full-match 1X2 consensus) plus **France–England 18257865**, whose tape was built from the real live feed on match night (2026-07-18) and streams in-app over true push SSE via the deployed relay (below).

## Architecture — browser ⇄ relay ⇄ TxLINE + devnet

```
browser (static index.html — no build, no framework)
  ├─ EventSource /api/scores/stream ┐
  ├─ EventSource /api/odds/stream   ├─► foresight-relay (Cloudflare Worker)  ─► TxLINE SSE
  ├─ fetch      /api/news ──────────┘    creds (JWT + X-Api-Token) server-side;   (txline-dev.txodds.com)
  │                                      └─ BBC/ESPN/Guardian RSS → dedup + tags
  └─ Phantom wallet ─────────────────► Solana devnet (memo tx per commit; blockTime = unforgeable timestamp)
```

**Relay:** https://foresight-relay.lordofclaude.workers.dev (`relay/worker.js`, deployed via wrangler). TxLINE's live streams need an Authorization JWT + `X-Api-Token` that must never ship to a public page — the relay holds them server-side and pipes the *same real SSE body* straight through, mirroring TxLINE's own paths so the app's already-tested `TxReal.streamLive()` client works with only a host swap (zero new browser stream code). Plus `/api/news`: BBC Sport + ESPN + Guardian RSS, cross-outlet deduped (token-overlap on titles), deterministically tagged (injury/lineup/discipline/transfer/match — keywords, no claimed AI). Honest limits: read-only, CORS-open, no user data; the 401 JWT-refresh cache is per-isolate (best-effort — a cold start just re-mints); per-IP token-bucket rate limits (SSE 10/min, news 30/min), fixtureId validation, and a concurrent-stream cap shipped in v1.1.0-hardened — per-isolate best-effort, honestly documented in the worker header.

## The five verification layers (what "verified" means)

| Layer | Cheat it kills | Mechanism |
|---|---|---|
| **L1 commit** | backdating ("I called it!") | pick → `sha256(canonical_pick \| salt)`; the hash is anchored with a timestamp outside user control. Prod: ~5000-lamport **devnet memo tx** (validator `blockTime`); replay demo: sim-slot, labeled. Pre-match picks require blockTime < `StartTime` (provable via `GET /api/fixtures/validation`). |
| **L2 anchored price** | cherry-picking the odds you "beat" + latency sniping | the canonical pick **embeds the StablePrice implied triple + odds `Ts`** at commit; `GET /api/odds/validation?messageId&ts` proves what the market said at that instant. Commit after the move → you're scored against the post-move price → zero credit. |
| **L3 reveal-or-burn** | hiding losers | unrevealed commits grade as a full loss. Committing both sides nets ≈ 0 by arithmetic (one win minus one full loss < one honest win — asserted in tests). |
| **L4 trustless grading** | operator favoritism | outcome = TxLINE's on-chain statKey map. The replay grader reads `game_finalised.Stats[1001]+[3001]` vs `[1002]+[3002]` (H1+H2 goals = the 90' 1X2 result) — **byte-identical keys to the prod `validateStatV2` predicate**. Prod = the SettleKit binding pattern (the SettleKit Anchor program (see the companion hackathon repo), compiles): `require!(hash == commit)` then CPI `validate_stat_v2`, writing W/L to a reputation PDA instead of routing USDC. |
| **L5 skill scoring** | luck-farming | $100 flat staked at the **de-vigged anchored price**: EV vs the market's own probabilities is 0 by construction, so sustained positive return IS beating the market. Leaderboard uses shrinkage `avgReturn·n/(n+6)` — a 1-pick streak cannot outrank a sustained record (asserted). |

**Honest residual:** sybil resistance is economic (commit fees + shrinkage + min-n + profile depth), not absolute — same as every reputation system. What is cryptographic: *no individual record can be forged or backdated.*

## The three fused surfaces

- **Upset radar** — `risk(t) = 100·(0.35·declineNorm + 0.40·trailing + 0.25·pressureNorm)` from consensus decay, score state, and underdog pressure. Deterministic, documented in `foresight.js`.
- **Consensus tape + market-lag receipts** — move detection is the **SurpriseIndex detector** (`shared/agent.js`) over the same real tape; `earliness()` joins your commit timestamp to the market's subsequent repricing: *"your hash landed at 61'; the consensus repriced at 74' — you beat the market by 13 minutes, both timestamps independently provable."*
- **Prophet league** — commit → reveal → grade pipeline; simulated prophets (clearly labeled `SIM`) populate the single-fixture demo through the *identical* pipeline as your real picks; one sim deliberately never reveals → the BURNED path is shown, not hidden.

## A real-data war story (why L4 reads statKeys)

Argentina–Switzerland *looked* like an Argentina win (3–1 final)… **in extra time**. The 90-minute 1X2 — what the consensus market actually prices — settled **1–1 draw** (H1 `1001=1,1002=0`; H2 `3001=0,3002=1`). An interim `fulltime` stats map in the feed said 1–0 — grading from it would have settled the market wrong. The fix: read the period-prefixed statKeys of the `game_finalised` update, exactly what the on-chain predicate checks. Deterministic settlement means *the settlement source must be the anchored keys, not derived running state* — this is the whole Track 1 thesis, discovered the honest way. (Also a nice API-feedback item for TxODDS.)

## TxLINE endpoints used

- `GET /api/scores/historical/{fixtureId}` — real event tape (SSE)
- `GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}` — StablePrice 1X2 consensus timeline (Bookmaker 10021, full-match `MarketPeriod=null`)
- `GET /api/scores/stream` + `GET /api/odds/stream` — real live SSE, proxied by the relay (creds server-side) into the in-app GO LIVE mode
- `GET /api/scores/updates/{fixtureId}` + `GET /api/odds/updates/{fixtureId}` — 5-min live windows, used by `shared/live-poll.js` to accumulate the France–England tape
- `GET /api/fixtures/snapshot` — fixture meta
- Proof path (prod wiring, documented seams): `GET /api/odds/validation` (L2), `GET /api/fixtures/validation` (L1 deadline), `GET /api/scores/stat-validation` + `validateStatV2` (L4)

## ⟨REAL⟩ swap list (replay → production)

| Demo (this repo) | Production |
|---|---|
| sim-slot anchor `{sim:true,t}` | devnet **memo tx** per commit (~5000 lamports); `blockTime` = L1 timestamp. Wallet + web3 plumbing exists in `anchor-commit.js` / `verify-wallet-flow.js` |
| replay grading via `outcomeFromTape` statKeys | `grade_pick` instruction: SettleKit's `settle()` (lib.rs:100–110) minus the vault — CPI `validateStatV2`, write reputation PDA |
| ~~replay tape~~ | **✅ shipped** — GO LIVE consumes the real `GET /api/odds/stream` + `GET /api/scores/stream` SSE through the deployed relay |
| simulated prophets | real wallets; copy-mirroring of a top prophet (devnet) |

## Agents — strategies that trade themselves (rule / prompt / API)

The leaderboard field isn't opaque bots — it's **real agents** trading the same real tapes through the same commit→reveal→grade pipeline as a human. Three provenance kinds, tagged on the board (👤 human · 🤖 rule/prompt · 🛰️ API) and public 🔓 / private 🔒:

- **Rule agents** — no-code `WHEN <condition> [AND minute≥X] → BET <side>` over fields TxLINE actually provides (score, goal margin, minute, red cards, favourite/underdog, live consensus). E.g. `@two-nil-shield`: lead ≥2 after 75′ → back the leader.
- **Prompt agents** — natural language compiled to rules (`compilePrompt`), prompt public or private. A deterministic keyword compiler stands in for an LLM in this static build. **Player/lineup prompts ("when Messi comes on") are flagged unsupported** — TxLINE has no lineup data; we never fake a trigger we can't grade.
- **API agents** — an external algo/ML (its own model, its own data feeds) POSTs a signed pick: `POST /api/agents/{id}/commit {fixtureId, pick, ts, sig}` → hashed, timestamped, graded like any commit. **The black box stays private; the track record becomes provable.** The static demo ships `@polyquant-ml` as a labeled example; the endpoint is a documented contract (no server in a static page).

**Deploying an agent = an instant backtest** across every real World Cup fixture — the same run that lands it on the leaderboard IS "how would this have done." **Follow** any leader (human or agent) to mirror its calls into your portfolio: you copy a *verified* record even when the strategy is hidden. No external "best trader" data is imported — every record is earned inside Foresight. Engine + 40 agent assertions in `foresight.js` / `test.js`.

## Data analysis behind the thresholds

Cross-fixture calibration on **4 real World Cup tapes** pulled from the live API — findings + reproduction in the companion hackathon workspace (`11-projects/quant-analysis/final-four/FORESIGHT-CALIBRATION.md`, `node foresight-analysis.js`):
- **Move census:** explained repricings p50 **33.7pts** vs unexplained drift p50 **2.9pts** → `minMag=0.02` keeps every real repricing.
- **Market lag:** p50 **−16s** — the consensus front-ran the scores feed on **14/25 major events** (median 23s). Feed-noise band ±105s → earliness receipts gated at **minLeadSec=120** (no fake alpha).
- **Upset radar:** max-risk **73/91/100** in the three favorite-failed matches vs **1** in the favorite-held control — perfect separation on this corpus (n=4: calibration evidence, not significance).
- **Payouts:** every contrarian call in the replayable knockouts paid **+$217..+$251**; every favorite pick lost.
- **No liquidity data exists in TxLINE** — all "spikes" are consensus implied-probability moves; the product's copy says so.

## UX pass — live from kickoff, not a static wall

- **Boots straight into a live match** (England–Argentina, ~28% in) and auto-starts the replay — no empty 0-0 screen waiting for a click.
- **Live leaderboard from kickoff**: `liveLeaderboard()` mark-to-markets every open commit every tick (reusing `FO.markToMarket`), so standings populate and update continuously, converging to the exact official grade at full time. Tagged "● LIVE STANDINGS" → "FINAL".
- **Unified live feed**: one reverse-chronological ticker across all matches — goals, red cards, VAR, big consensus moves, commits, settlements — replacing the old settlement-only receipts list.
- **Premium follow tiers**: any prophet (including @you) sets auto-follow to 🆓 free or 💎 paid. Free = full auto-copy. Paid = tracking is always free (see every call), auto-allocation needs an honest two-step "unlock" (no payment processor exists — never a silent charge).
- **Polymarket deep-link**: "Trade this on Polymarket ↗" opens Polymarket's real search for the matchup/side in a new tab — you execute on your own account; Foresight never touches funds or claims to place trades for you.
- **Landing gate**: particle-canvas hero (AetherFlow-style, vanilla port, fully stops when the gate closes) in front of the app. **Clerk sign-in is real** — Google OAuth *and* Sign-in-with-Solana (`web3_solana_signature`, enabled on the Foresight Clerk instance); the publishable key (`pk_test_Y2VydGFpbi1lbXUtNjMuY2xlcmsuYWNjb3VudHMuZGV2JA`) is public by design and overridable via `?clerk_pk=`. Guest entry always works — a judge is never blocked by auth — and `?nogate=1` skips the gate entirely.
- **Trading-terminal tape**: crosshair + hover tooltip (H/D/A implied % at the hovered minute + the nearest goal/card/VAR event), area gradient under the home line, floating last-price label on the right edge — the lightweight-charts affordances, borrowed pattern not the library (our overlays are too custom to swap).
- **OpenBB-style monitor row** above the tape: one cell per outcome (H/D/A) with de-vigged implied %, colored ▲/▼ delta vs 10 minutes ago, and an inline sparkline.
- Text density trimmed behind `ⓘ` progressive-disclosure toggles (league mechanics, commit mechanics, full trust-layer footer) so the page reads clean at a glance.
- Toast stack capped at 4 + commit-burst batching, so a fast replay speed can't paper the screen in notifications.
- Verified via **real DOM `.click()` dispatch** (not direct function calls) on every interactive control — agent builder (all 3 tabs), deploy, leaderboard row → profile, follow/track/unlock, verify, forge, commit flow, Google button. 18/18 pass, 0 JS errors.

## Insight layer — reading the room, honestly labeled

- **🎯 Win-streaks** — consecutive *graded* wins, on the leaderboard and in profiles (current + best); a BURNED commit breaks the streak, because reveal-or-burn counts as a loss everywhere.
- **Per-prophet calibration bars** — the implied price you took (▫) vs how often you actually won (▪), bucketed; above the market = edge, not luck. Plus a **cumulative $-vs-market sparkline** across resolved picks (inline SVG) in every profile.
- **σ volatility chip** — each radar tile shows the rolling stddev of tick-to-tick implied-prob moves over the last ~10 minutes ("which market is hot right now"), flaring when it runs hot.
- **News-driver matching** — when the market moves with *no event on the tape*, the live feed offers the nearest team-relevant headline published up to 45 min before the move, ranked by team keywords + football-risk terms + recency. Live fixture only (replay matches have no archival news and we won't fake it), and printed as *"possible driver … (keyword+recency match, not certainty)"* — a hint, never a claim.
- **🎙 Pundit lane** — deterministic template commentary on goals/reds/moves/settlements. No LLM, so it never claims intelligence it doesn't have.
- **Desktop notifications** — live goals, red cards and VAR reviews ping the first screen (permission asked on GO LIVE, never before).

## Real wallet-connect (every commit can be genuinely on-chain, not just the one demo)

Click **🔗 Connect Wallet** (Phantom, devnet) — from then on, every commit signs a real Solana memo transaction via your own wallet (we never see the key), confirmed in ~1-2s. Verified for real: `verify-wallet-flow.js` builds the identical transaction shape `commitRealOnChain()` uses in the browser and confirms it on live devnet — latest run: **555ms** (tx `bpxbfCjp…dUAsL`, see below). Headless-Chrome (genuinely no wallet extension) proves the honest fallback: "no wallet detected" with a Phantom link, never a fake success. Simulated agents/humans on the leaderboard stay sim-slots either way — there's no honest way to hand 8 fake identities their own real wallets. `memoFor()` in `foresight.js` is the single shared implementation both the CLI anchor script and the browser wallet flow use, so a hash from either path verifies identically (proven: the refactored CLI reproduces the exact already-anchored hash byte-for-byte).

## GO LIVE — France v England (fixture 18257865), true push SSE

Click **🔴 GO LIVE** (or open with `?live=1`): the app opens `EventSource` connections to the relay's `/api/scores/stream` + `/api/odds/stream` — **genuine push frames from TxLINE's real SSE, no polling, no reload** — and merges every new score/odds message into the France–England bundle, rebuilding that one fixture's tape through the *identical* `TxReal.buildTape()` + `buildRealTape` pipeline every replay tape already goes through. Zero new rendering code: radar, tape, monitor, feed, portfolio and agents all just work on the live match, pinned to the live edge. The relay's `/api/news` lane merges into the feed every 60s. This ran for real on match night, 2026-07-18. `?relay=` / the in-app field points it at a local `wrangler dev` instead.

The older path — `shared/live-poll.js` polling `scores/updates`/`odds/updates` every 15s into a local `tape.js` (because `historical` endpoints stay locked until 6h after kickoff) — is how the France–England tape file itself was accumulated, and remains the CLI tape-builder. As an in-app live mode it's **superseded by the relay**. Building it also fixed a real correctness gap: `tickSettlements()` now requires an actual `game_finalised` event before ever grading a fixture — a live tape's `endT` is just "latest data so far," not the true final whistle, and settling on that would have graded an unfinished match on incomplete stats.

## Real on-chain anchor (L1 proven, not mocked)

`node anchor-commit.js` posts a genuine Foresight commit hash to **Solana devnet** as an SPL-Memo transaction — the validator's `blockTime` is the unforgeable timestamp. It's been run once; the proof is committed in `anchored-proof.json` / `.js` and shown live in the app's ⛓ card (recompute-the-hash button proves it matches the on-chain memo):
- pick: Argentina–Switzerland **DRAW @ 26%**, anchored before kickoff
- hash: `506b1b08262e3a01a9f91dc92356b8da35960fffa28181aa847a161a3358eb54`
- tx: [`5LGBfVQ9…CYdrM`](https://explorer.solana.com/tx/5LGBfVQ9deCMyU7Po5A5soo81S69BGvKBf9tBwmkNRTPjJeQ5DjSSXbdTo6xR94948SDYfv5RWEUVb3g6WVCYdrM?cluster=devnet) · blockTime 2026-07-18 17:42:55 UTC

A **second, independent proof** exercises the browser wallet path: `node verify-wallet-flow.js` builds the exact transaction shape `commitRealOnChain()` uses (same shared `FO.memoFor()`, England–Argentina fixture 18241006) and confirmed it on live devnet in **555ms** — tx [`bpxbfCjp…dUAsL`](https://explorer.solana.com/tx/bpxbfCjpcJfuG3Sy5ShrYYFZPXSieE6jMccjG2Ua4xkjJuNhXtW26bJFFEYgc7LjWvuqX5CnvwC4dDQQnvdUAsL?cluster=devnet).

The in-app replay uses labeled sim-slots for speed; these prove the mechanism is real. (Run needs devnet SOL in `_keys/wallet.json (your own devnet keypair)`)

**Deployed:** https://foresight-txline.vercel.app · **Live relay:** https://foresight-relay.lordofclaude.workers.dev/health · **Demo script:** `10-submissions/demo-video-script-foresight.md` (hackathon workspace)

## Files

- `foresight.js` — pure core: sha256 (FIPS vectors tested), canonical pick + commit hash, league state machine, de-vig + flat-stake scoring + shrinkage, earliness, upset risk, simulated prophets, agents, statKey outcome. Browser + node.
- `index.html` — renderer: landing gate, radar (σ chips), commit flow, tape canvas with crosshair/tooltip/monitor row + commit markers + market-lag brackets, league board with streaks/calibration, verify/forge panels, live feed, GO LIVE module.
- `relay/worker.js` — the deployed Cloudflare Worker: SSE pass-through (`/api/scores/stream`, `/api/odds/stream`) with creds server-side + `/api/news` RSS lane.
- `shared/live-poll.js` — CLI live-tape accumulator (built the France–England tape file).
- `test.js` — **102 assertions, 102/102 passing**. Includes real-tape integration (outcome=draw from statKeys, deterministic league, hedge-is-pointless, burn path) + the agent engine suite. Note: the real-tape block resolves fixtures via `../shared/real-data`, so run it inside the full hackathon workspace layout.
