# ⚡ Foresight — Provable Bragging Rights

**Live app:** https://foresight-txline.vercel.app
**Live relay:** https://foresight-relay.lordofclaude.workers.dev (credential relay for live SSE + news)
**Built for:** TxODDS World Cup Hackathon, Track 1 — Prediction Markets & Settlement ($18,000 pool)
**Status:** built, deployed, tested (102/102 automated tests passing)

---

## The problem

Every match, a million people say "I called it." None of them can prove it.

Sports prediction runs entirely on reputation, and every reputation in it is fakeable. Tipster histories are editable. Screenshots are croppable. Winners advertise, losers quietly delete the post. The whole tipster industry monetizes this fog — paid picks, "verified" cappers, cherry-picked odds — with no way for anyone to actually audit anything.

The frustrating part: genuinely skilled predictors exist. They just can't be told apart from the noise, because a prediction is only worth something if you can prove **when** you made it, **at what price**, and **how it graded**. Nobody's product proves all three.

## What Foresight is

A prediction league where every call is cryptographically timestamped *before* the outcome is knowable, graded automatically against real World Cup data, and builds a reputation that literally cannot be faked.

**The core idea in one sentence:** the prediction and its proof are the same event — there's nothing to fake because there's no separate "record" to fabricate. You commit inside Foresight; the commit *is* the record.

No gambling, no custody of real money by default. It's closer to Strava for predictions than a sportsbook — the product is the provable skill record itself, not a bet.

## How it's built

**Data:** [TxLINE](https://txline.txodds.com) — TxODDS's real-time sports data feed (the same company that powers FanDuel and Betfair's odds), with every update cryptographically Merkle-anchored on Solana. Foresight uses **real World Cup fixtures** — actual match events (goals, cards, VAR reviews) and actual consensus betting odds (StablePrice), not synthetic data.

**Chain:** Solana devnet. Every prediction commit can be signed as a real on-chain transaction (a "memo" transaction — cheap, ~$0.001, and permanently verifiable on Solana's public explorer). The validator's timestamp becomes the unforgeable proof that a call predates its outcome.

**Frontend:** a single self-contained HTML/JS app (no build step, no framework) — runs from a file or a static host. Broadcast-TV visual style (think Sky Sports graphics): condensed italic type, lime/navy/electric-blue palette, big scorelines, flag chips.

**Backend:** almost none, by design. The app runs entirely client-side; the "backend" for the on-chain parts is the user's own Solana wallet (Phantom) — Foresight never holds a private key or custodies funds. The one server-side piece is a thin **credential relay** (a deployed Cloudflare Worker): TxLINE's live streams require secret API credentials that must never ship to a public page, so the relay holds them server-side and pipes the same real SSE straight through, plus a football-news lane (BBC/ESPN/Guardian RSS — cross-outlet dedup, deterministic keyword categorization, no claimed AI). It's read-only, stores no user data, and is honestly thin: its JWT-refresh cache is per-isolate (best-effort), and v1.1.0 added per-IP rate limits, input validation and a concurrent-stream cap (per-isolate best-effort, documented as such).

```
browser (static page) ── SSE + JSON ──► foresight-relay (CF Worker, creds server-side) ──► TxLINE
        └── Phantom wallet ───────────► Solana devnet (memo tx per commit; blockTime = unforgeable timestamp)
```

## Key functionality

### 1. Upset Radar
A live grid of every match, each scored 0–100 for "how likely is an upset brewing" — computed from how much the market's confidence in the favorite has decayed, whether the favorite is trailing, and how much pressure the underdog is generating (shots, corners, danger events). It's the "what should I be watching right now" layer.

### 2. Why-It-Moved (the probability tape)
A live chart of each team's win probability over the match, with every significant jump automatically joined to the event that caused it ("Argentina's odds jumped +47pts — goal, 12th minute"). When the market moves with **no event behind it**, that's flagged too — a "the market knows something" signal; in live mode it's additionally matched against recent team-relevant headlines and printed as *"possible driver … (keyword+recency match, not certainty)"* — a hint, never a claim. Calibrated on real match data: consensus repricing on a major event averages ~34 points; the market front-runs the official data feed by a median of 23 seconds.

The tape reads like a trading terminal: crosshair + hover tooltip (all three implied prices plus the nearest goal/card/VAR event), an area gradient under the price line, a floating last-price label, and an OpenBB-style monitor row above it — one cell per outcome with de-vigged implied %, a colored 10-minute delta, and a sparkline. Each radar tile also carries a **σ volatility chip** (rolling stddev of implied-probability moves over the last ~10 minutes) — "which market is hot right now" at a glance.

### 3. Prophet League (the reputation layer)
Commit → reveal → grade. You pick a side, your call is hashed and timestamped, and after full time it's graded against the real match result — read from the exact same on-chain-verifiable stat keys a smart contract would check. Reveal-or-burn: hide a losing call and it grades as a full loss automatically (you can't cherry-pick which calls you show). Scoring is dollars-vs-the-market at the de-vigged price, so a positive long-run record is *provably* skill, not luck.

The leaderboard is **live from kickoff**, not just after full time — it mark-to-markets every open position every second, the same way a real exchange computes "value if you cashed out right now."

Profiles carry the receipts: **🎯 win-streaks** (current + best; a hidden/burned pick breaks the streak, because reveal-or-burn counts as a loss everywhere), **calibration bars** (the implied price you took vs how often you actually won, per bucket — above the market is edge, not luck), and a **cumulative dollars-vs-market sparkline** across resolved picks.

### 4. Agent Builder — test a strategy on real data
Anyone can deploy an automated prediction strategy three ways:
- **No-code rules** — "when a team leads by 2 goals after 75 minutes, back them"
- **Natural-language prompts** — compiled to the same rules, public or kept private
- **External API** — plug in your own ML model; it POSTs signed picks and gets the same provable track record without revealing what's inside the model

Deploying an agent is an instant backtest across every real match — the same run that populates the leaderboard *is* "how would this idea have performed." Every leader on the board is tagged 👤 human, 🤖 rule/prompt agent, or 🛰️ external API, and 🔓 public or 🔒 private, so you always know who or what you're looking at.

### 5. Follow / copy — with a real monetization mechanic
Follow anyone (human or agent) to mirror their calls into your own portfolio. Every prophet chooses: 🆓 free auto-follow (most start here, to build a track record), or 💎 premium — where tracking (seeing every call) stays free, but auto-allocation requires unlocking. No fake payment processing exists yet (that's explicitly labeled), but the mechanic — the actual product decision of "free to watch, pay to auto-copy" — is fully built and demoable.

### 6. Live mark-to-market portfolio
Every open pick re-prices every second against the current market, exactly like a real trading position monitor — a Bloomberg-terminal-style ticker showing unrealized P&L, not just a final win/loss.

### 7. Real Solana wallet integration
Connect a Phantom wallet (devnet) and every commit from then on signs a **genuine on-chain transaction** — confirmed for real, verified end-to-end (the latest end-to-end test transaction confirmed on live Solana devnet in 555ms). No private key ever touches the page; the wallet signs, Foresight never sees it.

### 8. Trade the idea on Polymarket
Every pick has a "Trade this on Polymarket ↗" button that opens Polymarket's real market search for that exact matchup and side — you execute on your own account. Foresight never places a trade for you or touches your funds; it's a pointer to real liquidity, not a broker.

### 9. Unified live feed
One scrolling ticker across every match — goals, red cards, VAR reviews, big odds swings, commits, and settlements, all in real time.

### 10. Real on-chain proof, not a mockup
Two genuine transactions are confirmed on Solana devnet right now: the original pre-kickoff commit (Argentina–Switzerland draw, anchored hours before the result), and a second proof exercising the exact transaction shape the browser wallet flow signs (confirmed in 555ms). The app has a "recompute the hash → prove it matches on-chain" button that lets anyone verify the mechanism is real by checking the actual blockchain, live, in the browser.

### 11. GO LIVE — true push SSE
One button switches the app from replay to **live**: it opens EventSource connections to the relay's proxied TxLINE streams (real push frames — no polling, no page reload) and merges every new score and odds message into the live fixture's tape through the exact same tested pipeline every replay uses. France vs England (fixture 18257865) ran through it for real on match night, 2026-07-18. Live goals, red cards, and VAR reviews can fire **desktop notifications**, and a deterministic 🎙 pundit lane adds commentary (templates, no LLM — it never claims intelligence it doesn't have).

### 12. Landing gate — real sign-in, never a wall
A particle-canvas hero fronts the app with **Clerk sign-in: Google OAuth and Sign-in-with-Solana** (wallet-signature auth, enabled on the instance — the publishable key in the page is public by design). Guest entry always works, so nobody is ever blocked by auth, and `?nogate=1` skips the gate entirely.

## The five things that make it unfakeable

| Layer | What it stops |
|---|---|
| **Timestamp** | Backdating — a commit's hash is anchored with a timestamp nobody controls |
| **Anchored price** | Cherry-picking — the market price you "beat" is sealed inside the hash at commit time |
| **Reveal-or-burn** | Hiding losers — an unrevealed pick grades as a full loss |
| **Trustless grading** | Rigged results — grading reads the same verifiable data a smart contract would check |
| **Market-relative scoring** | Luck — you're scored against the market's own odds, so sustained positive results are provably skill |

## Business model

Foresight monetizes trust, not wagers:
1. **Free forever** core league; a paid "Pro" tier for deeper analytics and private leagues
2. **Copy-follow fees** — a cut of premium auto-follow subscriptions once a prophet builds a real following
3. **B2B / partnerships** — sportsbooks pay for verified-sharp discovery and high-intent traffic; tipster platforms license "Foresight-verified" as an anti-fraud layer
4. Deliberately **never** custody wagers or take a cut of bets — that would make Foresight a gambling operator requiring licensing in every market. Staying out of that business is the moat, not a limitation.

## Live on match night (2026-07-18)

France vs England streamed **live in-app**: the deployed relay proxied TxLINE's real SSE streams into the page — true push, no polling or reload — and the live tape merged through the same tested pipeline as every replay, so everything above (radar, probability tape, live feed, portfolio, agents) worked on the real match as it happened. The background poller that originally built the France–England tape file remains as the CLI tape-builder; for in-app live use it's superseded by the relay.

## What's next

- **Wire every commit to real on-chain by default** (currently opt-in via wallet-connect; sim-mode remains for frictionless demos)
- **Shareable public profile pages** — streaks, calibration bars, and the edge sparkline are in-app today; permalinks and sharing are next
- **Real payment processing** for the premium follow tier
- **Relay hardening** — rate limiting and a durable JWT cache (today's refresh cache is per-isolate, best-effort)
- **Multi-tournament history** — reputations that compound across seasons, not just one World Cup
- **Mobile app** — the web app is fully responsive today; a native app is the natural next step given how much of this is "check your leaderboard rank on your phone"

## Try it yourself

**https://foresight-txline.vercel.app** — open it, sign in with Google or a Solana wallet, or just enter as a guest (`?nogate=1` skips the gate); it boots straight into a live match, no setup needed. Click any radar tile to pick a match, hit "Commit a call" to make a prediction, click "🤖 Build an agent" to test an automated strategy, click any name on the leaderboard for their full verified record (streaks, calibration, edge), or hit "🔴 GO LIVE" (`?live=1`) to stream real TxLINE data through the relay.

---

*Built solo (with Claude Code) for the TxODDS/Solana World Cup Hackathon, July 2026.*
