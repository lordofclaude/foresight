# FORESIGHT — Full Project Scope + ChatGPT Design-Exploration Prompt

*2026-07-18. Purpose: (1) the complete scope of the Foresight app in one place, (2) a copy-paste prompt for ChatGPT to generate 15 UI/UX concept images so we can think outside the box before the final design pass. Live build: https://foresight-txline.vercel.app*

---

## 1. What Foresight is (full scope)

**One line:** the sports-prediction league where reputations are provable — commit a call before the market moves, get graded trustlessly by anchored World Cup data, build a bettor track record that cannot be forged or backdated.

**The problem:** every tipster's history is editable, every "I called it" screenshot croppable. Sports prediction has a reputation problem — and the reputation is that none of it can be trusted.

**The loop (three fused surfaces):**
1. **Upset Radar** — a grid of every live match, each tile scored 0–100 for "upset brewing" (favorite's consensus decay × trailing state × underdog pressure). The radar creates the *moment* to make a contrarian call.
2. **Why-It-Moved tape** — the match's consensus win-probability curve with every significant move detected and *joined to its cause* (goal, red card, VAR…); moves with no event behind them are flagged. Measures **market lag** — our calibration on real World Cup data found the odds move before the goal even reaches the data feed (median 23s) and reprice ~34 percentage points on majors.
3. **Prophet League** — commit→reveal→grade reputation. Your pick is hashed (SHA-256) with the market price embedded, anchored with a timestamp you don't control (Solana devnet memo, ~$0.001). After full time it's graded against the on-chain match stats. Reveal-or-burn: hiding a loser costs a full loss. Leaderboard scored in $-vs-the-market with shrinkage so hot streaks can't beat sustained records.

**The five trust guarantees (each kills one cheat):**
- L1 can't backdate (hash + blockchain timestamp)
- L2 can't cherry-pick the price you "beat" (market snapshot inside the hash, provable via the data provider's Merkle proofs)
- L3 can't hide losers (reveal-or-burn)
- L4 nobody can favor anyone (grading reads cryptographically anchored match stats — same keys an on-chain validator checks)
- L5 score rewards skill not luck ($100-flat at de-vigged prices = zero EV vs the market by construction; positive record = real edge). Earliness receipts ("you beat the market by 13 minutes") only print beyond the measured ±105s feed-noise band.

**Data honesty:** the feed (TxLINE — Merkle-anchored sports data on Solana) has consensus odds + typed match events. NO betting volume/liquidity data. All "spikes" are implied-probability moves. No player-level props guaranteed.

## 2. What the UI has TODAY (v1, dark terminal aesthetic)

- Header stats row (match clock, your score, picks, commits, matches settled)
- **Radar grid**: 3 real WC fixtures as clickable tiles (score, clock, risk number 0–100, gradient risk bar, FT/SETTLED badge)
- Selected-match panel: risk gauge with reason string ("favorite 56%→31% · TRAILING · pressure 4/10min")
- **Commit card**: three price buttons (HOME/DRAW/AWAY with live implied %), COMMIT button, list of your commits with status chips (COMMITTED/REVEALED/GRADED/BURNED) and truncated hashes
- Replay controls (speed selector, RUN, INSTANT)
- **Canvas tape**: win-probability line, event glyphs (goals/reds/VAR), detected-move dots, ◆ commit markers, green "market lag" brackets, playhead
- **Receipts feed**: settlement cards ("SETTLED — 90' result 1–1 → draw"), market-lag receipts, win/loss receipts, burn notices
- **Prophet leaderboard**: rank, wallet, shrunk score, W/N record, 🔥 burns, ⚡ upset calls (sims labeled)
- Verify/forge panels (recompute hash → MATCH; forgery → NO COMMITMENT FOUND)
- Long honest footer (endpoints, layers, disclaimers)

## 3. What it does NOT have yet but WILL (design for these too)

- **Wallet connect + real on-chain commits** (Phantom; each commit = a real memo tx; slot/blockTime shown)
- **Prophet profile pages**: calibration curve, pick history timeline, per-tournament records, earliness distribution, verified badge
- **Copy-trading**: "mirror @ana's next calls" (devnet), copy-fee model, following feed
- **Shareable receipt cards**: image cards for social ("Called the draw at 26% — proof on-chain", QR to verification)
- **Live mode**: SSE-driven, matches populate the radar as they kick off; push alerts ("⚠ upset brewing in ESP–JPN, risk 62")
- **Multi-tournament history**: reputation compounds across competitions; seasonal leagues, badges/streaks
- **Mobile-first layout** (current is desktop terminal); one-thumb commit flow
- **Pre-match lobby**: all upcoming fixtures with prices, commit deadlines counting down to kickoff
- **Groups/private leagues**: compete with friends, group leaderboards
- **Onboarding**: explain commit-reveal in 3 taps without saying "SHA-256"

---

## 4. THE CHATGPT PROMPT (copy everything below the line into ChatGPT)

---

I'm designing **Foresight** — a web/mobile app best described as *"Strava for sports predictions"*: a prediction league where every call is cryptographically timestamped BEFORE the match moves, graded automatically from official data, and builds an unfakeable reputation. Users never risk money — the product is **provable bragging rights**.

Core objects the UI must express:
1. **The Radar** — a live grid of every World Cup match, each scored 0–100 for "upset brewing" (color-coded). It's the pulse of the whole sport at a glance and the prompt to act.
2. **The Commit** — the sacred moment: pick a side at the current market %, hit COMMIT, and your call is locked with a timestamp forever. (Think: pulling the trigger on a conviction.)
3. **The Tape** — a match's win-probability curve over time, with markers where the market jumped, what caused each jump (goal/red card/VAR), your ◆ commit position on the curve, and a bracket showing "you were 13 minutes ahead of the market".
4. **Receipts** — settlement moments: "90' result 1–1 → DRAW. Your call at 26% paid 3.8×. ⚡ upset call landed." Losses print too — "recorded forever, that's the point." Unrevealed picks BURN 🔥.
5. **The Prophet League** — leaderboard + profile pages: win record, $-vs-market score, calibration curve, earliness stats, verified badge, copy-this-prophet button, private leagues with friends.
6. **Trust theater** — verify-my-commit (hash matches ✓) and try-to-forge (REJECTED ✗) interactions that make the cryptography *feel* real without jargon.

Current v1 is a dark quant-terminal aesthetic (monospace, cyan/violet on near-black). I want to explore far beyond that.

**Generate 15 distinct UI concept images** — each a different design direction for this app. For each: one polished, realistic app screen (not a wireframe), with a 1-line caption naming the direction. Mix desktop and mobile. Cover at least these 15 directions:

1. **Broadcast graphics** — the app as a TV sports overlay package (Sky Sports/ESPN energy)
2. **Betting-slip skeuomorphism** — commits as physical paper slips that get stamped/torn/burned
3. **Trading terminal maximalism** — Bloomberg-for-football, dense multi-panel
4. **Brutalist sports poster** — huge type, raw grids, matchday-poster energy
5. **iOS-native minimal** — one-thumb mobile commit flow, SF-style, live-activity widgets
6. **Social-first (BeReal/Strava)** — feed of friends' calls, receipt cards, streaks, kudos
7. **Prophecy/mystic theme** — tarot-card receipts, oracle iconography, constellation leaderboards (playful, not cringe)
8. **Glassmorphism stadium** — translucent layers over blurred live-match footage
9. **Retro teletext/Ceefax** — nostalgic football-scores aesthetic, modernized
10. **E-ink/paper ledger** — the reputation as a permanent typewritten record book
11. **Gaming/esports HUD** — XP bars, ranked tiers (Bronze Prophet → Grandmaster Oracle), kill-feed of settlements
12. **Data-viz editorial** — The Pudding/NYT-graphics style, the tape as hero storytelling
13. **Radar-first command center** — the upset radar as a literal radar sweep, mission-control vibes
14. **Receipt-printer physical** — settlements print from a thermal printer, torn edges, monospace, shareable
15. **Luxury watch/private-bank** — reputation as wealth; engraved metal, serif type, "your record, certified"

Constraints to respect in every concept: probabilities shown as % (no decimal odds confusion), a visible timestamp on every committed call (it's the soul of the product), losses displayed with the same dignity as wins (honesty is the brand), one primary CTA per screen ("COMMIT"), and a clear SIMULATED label pattern for demo/practice content. No real-money language anywhere — this is reputation, not gambling.

Make each image feel like a screenshot from a real, shipped product. After the 15 images, tell me which 3 directions you'd bet on for a product whose brand promise is "provable foresight" and why.

---

*End of prompt. Saved 2026-07-18; owner: Tiago; app: 06-builds/t1-foresight/ in the SolanaTxODDsHackathon repo.*
