# Foresight — full project state

**As of:** 2026-07-19, ~02:30 UTC (submissions close 23:59 UTC same day; World Cup FINAL kicks off 19:00 UTC)
**Track:** TxODDS × Solana World Cup Hackathon, Track 1 — Prediction Markets & Settlement ($18,000 pool)

This is a working snapshot, not a claim of finality — a few items below are mid-flight in a parallel work session and marked as such.

---

## 1. What we built

**The problem:** sports prediction runs entirely on reputation, and every reputation is fakeable — tipster histories are editable, screenshots are croppable, losers quietly delete posts. Nobody's product proves the three things that make a call actually worth something: **when** it was made, **at what price**, and **how it graded**.

**The idea:** the prediction and its proof are the same event. You commit inside Foresight — pick a side, the pick is hashed with the market price sealed inside, and the hash is anchored with a timestamp nobody controls. There is no separate "record" to fabricate later, because the commit *is* the record. No gambling, no custody of money by default — Foresight settles **reputation**, not funds. Closer to Strava for predictions than a sportsbook.

**Five layers make it unfakeable:**

| Layer | What it stops | Mechanism |
|---|---|---|
| Timestamp | Backdating | Commit hash anchored with a timestamp outside user control (Solana validator blockTime, or wallet-signed devnet memo) |
| Anchored price | Cherry-picking the odds you "beat" | The market price triple is sealed inside the hash at commit time |
| Reveal-or-burn | Hiding losers | An unrevealed pick grades as a full loss automatically |
| Trustless grading | Rigged results | Grading reads the same statKeys an on-chain `validateStatV2` predicate checks |
| Market-relative scoring | Luck | Scored against the market's own de-vigged odds — sustained positive return is provably skill |

---

## 2. The product (what's actually in the app)

Single self-contained HTML/JS file (`index.html`), no build step, no framework, no backend by default — runs from `file://` or any static host.

- **Landing gate** — particle-field hero (canvas physics, reduced-motion aware), real Clerk sign-in (Google OAuth *and* Sign-in-with-Solana), guest entry always available so a judge is never blocked.
- **Upset Radar** — every live match scored 0–100 for "upset brewing" (consensus decay × trailing favorite × underdog pressure), plus a live **σ volatility chip** per market (rolling stddev of implied-probability moves).
- **Ticker tape** — a scrolling TradingView-style strip across the top: every market's home/draw/away implied %, colored 10-minute deltas, σ, live markers.
- **Markets terminal view** — an OpenBB-style dense table (toggle: tiles ⇄ terminal) with the same data as sortable rows plus a per-market sparkline; deep-linkable via `?view=table`.
- **Probability tape** — the consensus curve with a crosshair + hover tooltip (H/D/A % and nearest event), touch/drag support, area gradient under the home line, floating dual price labels (home + away), commit/move/settlement markers.
- **Why-it-moved / news-driver matching** — when a market move has no match event behind it, the app searches a live football-news lane (BBC/ESPN/Guardian, deduped and categorized) for the nearest team-relevant headline and attaches it as a labeled "possible driver" (keyword+recency ranked, never claimed as certainty, live-fixture-only).
- **Prophet League** — commit → reveal → grade, de-vigged flat-stake scoring, shrinkage leaderboard, 🎯 win-streak badges, prophet profiles with a cumulative $-vs-market sparkline and calibration bars (implied price taken vs. actual win rate per bucket).
- **Agent Builder** — deploy a strategy three ways (no-code rule, natural-language prompt compiled to rules, or an external API agent that POSTs signed picks) and get an instant backtest across every real fixture that also populates the leaderboard.
- **Live feed** — one unified ticker: goals, cards, VAR, market moves, commits, settlements, a deterministic 🎙 pundit lane, and desktop notifications on goals/reds/VAR while GO LIVE is active.
- **Portfolio** — every open pick marked to market every tick against the live consensus, exchange-style.
- **Real on-chain anchor card** — see §4.
- **Truth-labeled data-flow strip + PRACTICE/VERIFIED banners** — the app states plainly, per session, whether the active fixture's calls are local practice or genuinely wallet-anchorable, and walks the five-stage pipeline (TxLINE quotes → commit+hash → Solana timestamp → TxLINE final statKeys → deterministic grade) with a `[REAL]` / `[PRACTICE·LOCAL]` tag on each stage.
- **Guided demo rail** — a `?demo=1` mode that adds a 4-step focus rail (commit → run/instant → verify/forge → real anchor) for a clean, judge-legible walkthrough without needing sign-in, a wallet, or a live match.

---

## 3. Integrations — what's connected to what, and how

### TxLINE (TxODDS's real-time sports data layer)
- **Historical replay data:** `GET /api/scores/historical/{fixtureId}` + `GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}` — pulled and compacted into four real World Cup fixtures (Argentina–Switzerland, France–Spain, England–Argentina, France–England).
- **Live push:** `GET /api/scores/stream` + `GET /api/odds/stream` — genuine Server-Sent Events, proxied through our relay (see below) so the app can go **GO LIVE** on a match in progress with true push updates, no polling, no reload.
- **Proof/validation seams (documented, exercised):** `/api/odds/validation`, `/api/fixtures/validation`, `/api/scores/stat-validation` — the latter is the exact Merkle-proof endpoint our on-chain settlement call consumes (see §4).
- **Auth:** guest JWT (`POST /auth/guest/start`) + `X-Api-Token`, held server-side only (see relay).

### Foresight relay (Cloudflare Worker, deployed)
`https://foresight-relay.lordofclaude.workers.dev` — the one server-side piece, by design. TxLINE's live streams require credentials that must never reach a public browser page, so this Worker holds them and re-emits the *same real SSE body*, mirroring TxLINE's own paths so the existing tested client (`TxReal.streamLive()`) needs only a host swap. It also serves a merged, deduplicated, keyword-categorized football-news lane (`/api/news`).
- **Hardened (v1.1.0):** per-IP token-bucket rate limits (10 SSE conns/min, 30 news req/min, documented as best-effort/per-isolate), fixtureId input validation, a concurrent-stream cap, `Cache-Control` on news, optional origin allowlist.
- **Verified live:** `/health` returns `{ok:true, hasCreds:true, version:"1.1.0-hardened-2026-07-18"}`; SSE streams confirmed delivering real frames end-to-end through the deployed Worker (not just locally).

### Solana (devnet)
Three genuine, independently-verified transactions — not diagrams, not mocks:

1. **Mechanism-demo anchor** — `5LGBfVQ9…CYdrM` — the first proof-of-concept commit, anchored *after* its match ended. Now honestly re-captioned in the app as exactly that (it originally, incorrectly, claimed "before kickoff" — fixed).
2. **Wallet-flow proof** — `bpxbfCjp…dUAsL` — confirms the exact transaction shape a connected Phantom wallet signs, built → signed → confirmed on live devnet in 555ms.
3. **World Cup FINAL pre-kickoff anchor** — `Lo1VDBry…R94L` — a real pick (Argentina, the de-vigged underdog @ 26.3%, fixture 18257739 Spain v Argentina) sealed on-chain **~19 hours before kickoff** (blockTime 2026-07-18 23:50:18 UTC vs. kickoff 2026-07-19 19:00:00 UTC). This is the app's hero anchor card. Its hash is recomputable and verifiable client-side in the browser against the on-chain memo.
4. **Atomic on-chain settlement** — `3ukg95uA…Wybt` — one devnet transaction containing **both** TxLINE's own `validateStatV2` instruction (proving England–Argentina's final score 1–2 against the on-chain Merkle root) **and** the Foresight grade memo for the anchored commit, landed in the same transaction. The grade record can only exist because the chain verified the outcome first. This is instruction composition from the client — not a custom-program CPI — and both the app and docs say so explicitly; deploying a dedicated settlement program (SettleKit, already compiles) remains the upgrade path for full CPI-based settlement.

Every wallet interaction uses the Solana Memo program directly; Foresight never holds a private key or custodies funds.

### Clerk (identity)
Google OAuth and Sign-in-with-Solana (`web3_solana_signature`) both enabled on the live Clerk instance. Signing in rebinds the local `ME` identity variable to a Clerk-derived handle, which is then hashed into every subsequent commit's canonical payload — the provable statement names its author. Sessions restore silently on return visits. Guest commits made before sign-in keep their original label permanently (immutable history, by design).

### Everything else is client-side
No database, no persisted backend state. The "backend" for on-chain parts is the user's own wallet.

---

## 4. Verification status (all independently re-checked, not just claimed)

| Check | Result |
|---|---|
| Core test suite | 155 passed, 0 failed |
| Inline-logic suite (streaks/calibration/marketVol/newsDriver/pundit/relay helpers) | 109 passed, 0 failed |
| UI-logic suite (chart y-range, live-fixture routing, etc.) | 53 passed, 0 failed |
| Smoke suite | 15 passed, 0 failed |
| Sibling SurpriseIndex agent suite (shared dependency) | 70 passed, 0 failed |
| Production site | HTTP 200, serving the latest commit |
| Relay `/health` | `ok:true, hasCreds:true`, v1.1.0-hardened |
| All 3 devnet transactions | `finalized`, `err:null`, independently confirmed via RPC |
| GitHub repo | public (was private — fixed; a private repo is an automatic disqualifier per the rules) |
| Vercel bot-challenge | disabled (was returning 403 to automated screeners) |

---

## 5. What's still left before final submission

### Must happen (blocking)
1. **Record the demo video (≤5 min)** — explicitly "an absolute requirement to pass initial screening" per the official rules, and "submissions will be evaluated heavily based on the demo video" since live matches end before judging. A timed teleprompter script is ready at `10-submissions/DEMO-RECORDING-KIT.html` (paced to a 2:58 golden path against `?demo=1`), plus the full shot-by-shot script in `demo-video-script-foresight.md` (war-room `10-submissions/`).
2. **Submit the Superteam Earn form** — the draft submission slot currently holds a different project (VAR Court); Foresight's submission text is ready in `SUBMISSION-FORESIGHT.md`.

### Should happen (judge-facing, not launch-blocking)
3. **One live wallet click-through** — connect Phantom on the deployed site and make one real commit, so the demo video can show a genuine live-signed transaction rather than only the pre-existing anchors. (Blocked on you having the Phantom extension installed — instructions given separately.)
4. **France–England historical settlement** — the live-polled tape for fixture 18257865 has no `game_finalised` event yet because TxLINE's historical endpoint only unlocks ~6h post-kickoff. A background job is currently waiting until 03:02 UTC to pull it automatically and will retry every 10 minutes if still locked; once it lands, the fixture needs a resync + redeploy so the leaderboard reads 4/4 settled instead of 3/4.
5. **GO LIVE on the FINAL** — the app already auto-targets fixture 18257739 (Spain v Argentina) for live streaming once it's within 2 hours of its 19:00 UTC kickoff; no action needed, but worth confirming on the day.

### In progress elsewhere (do not assume done — a parallel work session has uncommitted work in this exact area right now)
6. There are currently **uncommitted** files (`shared/identity-binding.js`, `shared/proof-receipts.js`, an `evaluation/` directory, a `ledger/` directory, plus edits to `index.html` and `HACKATHON-REVIEW.md`) that look like a deeper identity/proof/ledger pass mid-flight in another session. These have **not** been reviewed, tested, committed, or deployed as part of this document — treat them as work-in-progress, not shipped state, until confirmed otherwise.

### Nice-to-have (explicitly out of scope for tonight, documented honestly in-app)
- A deployed custom settlement **program** doing the CPI into `validate_stat` itself (currently: client-composed atomic transaction, which is honestly labeled as such).
- Persisted on-chain reputation (currently: local/deterministic profile state).
- Real payment processing for the premium follow tier (currently: simulated, never a silent charge).
- The "PROPHET" naming — a funded product with the same name exists elsewhere in the space; a rename is a pre-launch decision, not made yet.

---

## 6. Where everything lives

- **Live site:** https://foresight-txline.vercel.app (`?demo=1` for the guided judge path, `?view=table` for the terminal markets view)
- **Relay:** https://foresight-relay.lordofclaude.workers.dev
- **Public repo (submit this one):** https://github.com/lordofclaude/foresight
- **War-room / hackathon workspace:** https://github.com/lordofclaude/solana-txodds-hackathon (`06-builds/t1-foresight`)
- **Submission materials:** `SUBMISSION-FORESIGHT.md` (war-room: `10-submissions/SUBMISSION-FORESIGHT.md`), `JUDGE-VERIFY-ONEPAGER.md` (war-room `10-submissions/`), `demo-video-script-foresight.md` (war-room `10-submissions/`), `DEMO-RECORDING-KIT.html` (war-room `10-submissions/`)
- **Pitch deck:** `04-pitch-decks/track1/Good/t1-25-foresight.html`
