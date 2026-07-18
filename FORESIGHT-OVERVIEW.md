# ⚡ Foresight — Provable Bragging Rights

**Live app:** https://foresight-txline.vercel.app
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

**Backend:** none, by design. Everything runs client-side. The "backend" for the on-chain parts is the user's own Solana wallet (Phantom) — Foresight never holds a private key or custodies funds.

## Key functionality

### 1. Upset Radar
A live grid of every match, each scored 0–100 for "how likely is an upset brewing" — computed from how much the market's confidence in the favorite has decayed, whether the favorite is trailing, and how much pressure the underdog is generating (shots, corners, danger events). It's the "what should I be watching right now" layer.

### 2. Why-It-Moved (the probability tape)
A live chart of each team's win probability over the match, with every significant jump automatically joined to the event that caused it ("Argentina's odds jumped +47pts — goal, 12th minute"). When the market moves with **no event behind it**, that's flagged too — a "the market knows something" signal. Calibrated on real match data: consensus repricing on a major event averages ~34 points; the market front-runs the official data feed by a median of 23 seconds.

### 3. Prophet League (the reputation layer)
Commit → reveal → grade. You pick a side, your call is hashed and timestamped, and after full time it's graded against the real match result — read from the exact same on-chain-verifiable stat keys a smart contract would check. Reveal-or-burn: hide a losing call and it grades as a full loss automatically (you can't cherry-pick which calls you show). Scoring is dollars-vs-the-market at the de-vigged price, so a positive long-run record is *provably* skill, not luck.

The leaderboard is **live from kickoff**, not just after full time — it mark-to-markets every open position every second, the same way a real exchange computes "value if you cashed out right now."

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
Connect a Phantom wallet (devnet) and every commit from then on signs a **genuine on-chain transaction** — confirmed for real, verified end-to-end (a test transaction confirmed on live Solana devnet in 392ms). No private key ever touches the page; the wallet signs, Foresight never sees it.

### 8. Trade the idea on Polymarket
Every pick has a "Trade this on Polymarket ↗" button that opens Polymarket's real market search for that exact matchup and side — you execute on your own account. Foresight never places a trade for you or touches your funds; it's a pointer to real liquidity, not a broker.

### 9. Unified live feed
One scrolling ticker across every match — goals, red cards, VAR reviews, big odds swings, commits, and settlements, all in real time.

### 10. Real on-chain proof, not a mockup
One genuine commit is anchored on Solana devnet right now — the app has a "recompute the hash → prove it matches on-chain" button that lets anyone verify the mechanism is real by checking the actual blockchain, live, in the browser.

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

## Live tonight (as of writing)

France vs England is being tracked live — a background poller pulls real match events and odds every 15 seconds and feeds them into the exact same rendering pipeline as every other match, so once the game kicks off, all of the above (radar, probability tape, live feed, portfolio) works on it automatically.

## What's next

- **Wire every commit to real on-chain by default** (currently opt-in via wallet-connect; sim-mode remains for frictionless demos)
- **Prophet profile pages** — calibration curves, historical accuracy over time, shareable public profiles
- **Real payment processing** for the premium follow tier
- **Live SSE mode** — true push-based live data instead of the current poll-and-refresh approach, once there's a secure backend to hold API credentials
- **Multi-tournament history** — reputations that compound across seasons, not just one World Cup
- **Mobile app** — the web app is fully responsive today; a native app is the natural next step given how much of this is "check your leaderboard rank on your phone"

## Try it yourself

**https://foresight-txline.vercel.app** — open it, it boots straight into a live match (no setup needed). Click any radar tile to pick a match, hit "Commit a call" to make a prediction, click "🤖 Build an agent" to test an automated strategy, or click any name on the leaderboard to see their full verified track record.

---

*Built solo (with Claude Code) for the TxODDS/Solana World Cup Hackathon, July 2026.*
