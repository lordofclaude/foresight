# FORESIGHT — Technical Documentation

**Verified prediction reputations, powered by TxLINE and settled on Solana.**
TxODDS × Solana World Cup Hackathon — Track 1: Prediction Markets & Settlement

**Live product:** https://foresight-txline.vercel.app
**Repository:** https://github.com/lordofclaude/foresight

---

## 1. Executive summary

Sports prediction has always run on unverifiable claims. A tipster says they called the draw at 26% — there's no way to check when they said it, what price they were actually looking at, or whether the "winning call" is one of twenty screenshots that quietly never got posted.

**Foresight closes that gap.** Every call is cryptographically hashed with the live market price sealed inside, timestamped on Solana before the outcome is knowable, and graded automatically against TxLINE's own verified match data. The commitment and the record are the same object — there is nothing left to fake, edit, or cherry-pick after the fact.

This isn't a mockup of that idea. It's a working product with real transactions on Solana devnet, a real credentialed relay streaming TxLINE's live SSE feeds into a broadcast-grade trading terminal, real Clerk-authenticated identity bound into every commitment, and a settlement path that calls TxLINE's own on-chain validation instruction directly.

---

## 2. System architecture

```
                         ┌─────────────────────────────┐
                         │        TxLINE (TxODDS)       │
                         │  live scores · odds · Merkle  │
                         │      validation primitives     │
                         └───────────────┬───────────────┘
                                         │ authenticated REST + SSE
                         ┌───────────────▼───────────────┐
                         │      Foresight Relay Worker     │
                         │  (Cloudflare, deployed, hardened)│
                         │  holds TxLINE credentials server-│
                         │  side · rate-limited · validated │
                         └───────────────┬───────────────┘
                                         │ SSE passthrough + REST
        ┌────────────────────────────────▼────────────────────────────────┐
        │                    FORESIGHT — browser client                    │
        │  live terminal · commit engine · settlement engine · Clerk auth  │
        └───────┬───────────────────────────────────────────────┬────────┘
                │ Sign-in-with-Google / Sign-in-with-Solana      │ Phantom
        ┌───────▼───────┐                              ┌────────▼────────┐
        │     Clerk      │                              │  Solana (devnet) │
        │   identity     │                              │  commit anchors  │
        │    layer       │                              │  atomic settle   │
        └────────────────┘                              └──────────────────┘
```

No database. No custodied funds. No middleman between a user's identity, their prediction, and the chain that proves it existed.

---

## 3. TxLINE integration — the data backbone

Foresight is built directly on TxLINE's live match and market data, not a static export. The client integrates **fifteen distinct TxLINE endpoints** across authentication, fixtures, odds, and scores, spanning point-in-time snapshots, bucketed historical intervals, live in-play windows, live push streams, and cryptographic Merkle-proof validation:

| Category | Endpoint | Purpose |
|---|---|---|
| Auth | `POST /auth/guest/start` | Guest JWT issuance, 30-day session |
| Fixtures | `GET /api/fixtures/snapshot` | Fixture discovery and metadata across the World Cup schedule |
| Fixtures | `GET /api/fixtures/updates/{epochDay}/{hourOfDay}` | Fixture state changes over time |
| Fixtures | `GET /api/fixtures/validation` | Pre-match deadline proof — gates commit eligibility cryptographically |
| Odds | `GET /api/odds/snapshot/{fixtureId}` | Point-in-time StablePrice consensus, used to seal the price inside every commit |
| Odds | `GET /api/odds/updates/{fixtureId}` | Live in-play odds window (current 5-minute cache) |
| Odds | `GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}` | Bucketed historical odds intervals for full-match consensus timelines |
| Odds | `GET /api/odds/validation` | Merkle-proof validation of a specific odds message — the anchored-price receipt |
| Odds | `GET /api/odds/stream` | **Live SSE push** — real-time consensus updates, proxied through the Foresight relay |
| Scores | `GET /api/scores/snapshot/{fixtureId}` | Point-in-time match state |
| Scores | `GET /api/scores/historical/{fixtureId}` | Full event tape for completed fixtures — goals, cards, VAR, substitutions |
| Scores | `GET /api/scores/updates/{fixtureId}` | Live in-play score window for matches still being played |
| Scores | `GET /api/scores/updates/{epochDay}/{hourOfDay}/{interval}` | Bucketed historical score intervals |
| Scores | `GET /api/scores/stat-validation` | **The settlement primitive** — Merkle proof of a specific statKey, consumed directly by our on-chain settlement transaction |
| Scores | `GET /api/scores/stream` | **Live SSE push** — real-time match events, proxied through the Foresight relay |

Four real World Cup fixtures are fully integrated end-to-end (Argentina–Switzerland, France–Spain, England–Argentina, France–England), and the product streamed a live match — France v England — through the full pipeline in real time on match night, with genuine push updates arriving through the deployed relay.

**Grading is deterministic and trustless by construction.** Foresight reads the exact period-prefixed statKeys (`1001`/`1002` first-half goals, `3001`/`3002` second-half goals) that TxLINE's own on-chain `validateStatV2` predicate checks — not a derived running score, not an interim stats map. This surfaced a genuinely subtle correctness case during development: a fixture that finished 3–1 after extra time actually settles its full-time 1X2 market as a 1–1 draw, because the market prices the 90-minute result. Grading from the anchored statKeys handles this automatically and correctly, every time — exactly the deterministic settlement logic the track calls out as its tiebreaker criterion.

---

## 4. Solana integration — real transactions, not diagrams

Every on-chain claim in Foresight is backed by a signature you can look up on Solana's public explorer right now.

### 4.1 Pre-kickoff commitment on the World Cup Final

Foresight sealed a real prediction on the World Cup Final — Spain v Argentina — **roughly 19 hours before kickoff**:

- **Pick:** Argentina, the de-vigged underdog at 26.281% consensus (fair odds ≈3.8)
- **Commit hash:** `5fc918c973c777b590218ec781a3eacf69394742bf761a50bdfba14a15bf23c9`
- **Transaction:** [`Lo1VDBrynPiqkuD6HFaQWH5Pim4Pu9qEG3NZJcvKv6hqMmWci8EUontzzybKkrwLJHyeTvxXBQuzw1EQriqR94L`](https://explorer.solana.com/tx/Lo1VDBrynPiqkuD6HFaQWH5Pim4Pu9qEG3NZJcvKv6hqMmWci8EUontzzybKkrwLJHyeTvxXBQuzw1EQriqR94L?cluster=devnet)
- **Validator blockTime:** 2026-07-18 23:50:18 UTC — kickoff is 2026-07-19 19:00:00 UTC

The app recomputes `sha256(canonical_pick | salt)` directly in the browser and shows it matching the hash embedded in the on-chain memo — anyone can verify the mechanism themselves in one click, no trust required.

### 4.2 Atomic on-chain settlement

Foresight goes further than anchoring — it settles a real prediction on-chain using TxLINE's own validation program directly. One Solana transaction contains **both**:

1. TxLINE's `validateStatV2` instruction, proving England–Argentina's final score (1–2) against TxLINE's on-chain Merkle root, and
2. The Foresight settlement memo, grading the anchored commitment as a win

Both instructions land in the same transaction — the settlement record exists **only because the chain verified the outcome first**, in the same atomic operation.

- **Settlement transaction:** [`3ukg95uA2cipKZA5yhuU3ZfYT4G8FYMTjxggM1JLXFsfjxKvhMMFkXpzCAF84QzYHGDaSv3LED4bpz2jJRT1Wybt`](https://explorer.solana.com/tx/3ukg95uA2cipKZA5yhuU3ZfYT4G8FYMTjxggM1JLXFsfjxKvhMMFkXpzCAF84QzYHGDaSv3LED4bpz2jJRT1Wybt?cluster=devnet)
- **Oracle program:** `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` (TxLINE devnet)
- **Result:** Argentina call graded WIN, on-chain, verifiably

### 4.3 Wallet-signed commits

Any user can connect Phantom and sign a genuine Solana memo transaction for their own commit — the exact transaction shape is proven end-to-end, confirmed on live devnet. Foresight never touches a private key; the wallet signs, Foresight only reads the public result.

---

## 5. Identity — Clerk authentication bound to every commitment

Foresight uses Clerk for identity, with both **Google OAuth** and **Sign-in-with-Solana** (`web3_solana_signature`) enabled on the live instance. Signing in binds a stable Clerk account ID into `ME` — every subsequent commitment hashes that identity into its canonical payload, so the provable statement carries a verified author, not an anonymous session token. Identity state restores silently across sessions; dashboard entry is explicitly gated behind authentication.

---

## 6. The product

- **Live trading terminal** — a scrolling market ticker (every fixture's home/draw/away implied probability, live deltas, volatility), a dense terminal table view, and a probability tape with crosshair inspection, dual price labels, and event markers — built in the visual language of professional trading terminals.
- **Upset Radar** — every match scored 0–100 for how much an upset is brewing, from consensus decay, scoreline state, and underdog pressure, with a live volatility indicator per market.
- **Commit engine** — pick a side at the live price, get a SHA-256 commitment with the market triple sealed inside, anchored with a timestamp outside anyone's control.
- **Why-it-moved / news-driver matching** — market moves with no attached match event are cross-referenced against a live, deduplicated football news feed to surface the likely driver.
- **Prophet League** — reveal-or-burn grading, de-vigged scoring, a shrinkage-adjusted leaderboard, win-streak badges, and per-prophet calibration curves showing the price taken versus the actual win rate.
- **Agent Builder** — deploy a rule-based, prompt-based, or externally-hosted API strategy and get an instant backtest across every real fixture, populating the same leaderboard as human players.
- **Unified live feed** — goals, cards, VAR, market moves, commitments, and settlements in one real-time stream, plus a deterministic commentary lane and desktop notifications.
- **Cross-market comparison** — TxLINE consensus is compared directly against Polymarket's public price feed for the same fixture at matching timestamps, surfacing genuine cross-venue divergence.

---

## 7. Live infrastructure — the credential relay

TxLINE's live SSE streams require an authenticated JWT and API token that must never reach a public browser. Foresight runs a dedicated Cloudflare Worker relay that holds those credentials server-side and re-emits TxLINE's live SSE bodies verbatim, mirroring TxLINE's own endpoint paths so the browser client needs only a host swap to go from replay to genuinely live. The relay additionally serves a merged, deduplicated, categorized football news feed and a Polymarket comparison lane, and ships hardened with per-IP rate limiting, input validation, and connection caps.

- **Deployed:** `https://foresight-relay.lordofclaude.workers.dev`
- **Live health check:** returns confirmed credentials and streaming status in real time

---

## 8. Engineering quality

Foresight ships with a comprehensive automated test suite covering commitment hashing, canonicalization, de-vig math, mark-to-market pricing, settlement grading, leaderboard shrinkage, calibration statistics, live-data merging, identity binding, and the relay's own request handling — **400 automated assertions, passing end to end**, including dedicated suites for the identity layer and the on-chain proof-receipt pipeline.

---

## 9. TxLINE API feedback

As requested: TxLINE's real-time feed and Merkle-proof primitives are genuinely excellent to build against — the same normalized schema covering fixtures, odds, and scores across every competition made it possible to go from a single hardcoded fixture to a fully general four-fixture, live-streaming product without touching the core data model. The statKey design in particular — period-prefixed, byte-identical between the REST validation payloads and the values an on-chain instruction checks — is exactly the right primitive for building deterministic settlement logic on top of, and is the reason Foresight's grading logic can be a handful of pure functions instead of a fragile state machine.

One friction point worth flagging: `scores/historical` responds as `text/event-stream` framing rather than plain JSON, including for fully finished fixtures — worth documenting explicitly, since it's an easy trap for a first integration. We built a small SSE-frame parser once and reused it everywhere, so it cost us minutes, not hours.

---

## 10. Links

- **Live app:** https://foresight-txline.vercel.app
- **Relay:** https://foresight-relay.lordofclaude.workers.dev
- **Repository:** https://github.com/lordofclaude/foresight
- **Pre-kickoff Final anchor:** https://explorer.solana.com/tx/Lo1VDBrynPiqkuD6HFaQWH5Pim4Pu9qEG3NZJcvKv6hqMmWci8EUontzzybKkrwLJHyeTvxXBQuzw1EQriqR94L?cluster=devnet
- **Atomic on-chain settlement:** https://explorer.solana.com/tx/3ukg95uA2cipKZA5yhuU3ZfYT4G8FYMTjxggM1JLXFsfjxKvhMMFkXpzCAF84QzYHGDaSv3LED4bpz2jJRT1Wybt?cluster=devnet
