/* =====================================================================
   FORESIGHT — verified prediction reputation core (pure, browser + node)

   The commit→reveal→grade league. Every function is deterministic and
   side-effect free; the UI is only a renderer, tests drive the same code.

   The five verification layers (see README):
     L1 can't backdate      — commitHash(canonical||salt) anchored with a
                              timestamp OUTSIDE user control (devnet memo
                              blockTime in prod; tape-time in replay sim)
     L2 can't cherry-pick   — the canonical pick EMBEDS the StablePrice
        the price beaten      triple + oddsTs at commit (provable via
                              GET /api/odds/validation)
     L3 can't hide losers   — reveal-or-burn: unrevealed commits grade
                              as a full loss
     L4 nobody can favor    — outcome = TxLINE stats; prod grades via
                              validateStatV2 CPI/.view() (statKeys
                              1001+3001 / 1002+3002 = H1+H2 goals for the
                              90-minute 1X2 result)
     L5 score rewards skill — $100 flat staked at the DE-VIGGED anchored
                              price: EV vs the market's own probabilities
                              is 0 by construction, so sustained positive
                              return IS beating the market. Leaderboard
                              uses shrinkage so short hot streaks lose to
                              sustained records.
   ===================================================================== */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.Foresight = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ---------------- sha256 (compact, synchronous, dependency-free) ----------------
     Standard FIPS 180-4. Synchronous so node tests and the file:// page share
     byte-identical hashing (crypto.subtle is async and context-dependent). */
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function utf8Bytes(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.codePointAt(i);
      if (c > 0xffff) i++;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  function sha256(str) {
    const m = utf8Bytes(str), l = m.length * 8;
    m.push(0x80);
    while (m.length % 64 !== 56) m.push(0);
    for (let i = 7; i >= 0; i--) m.push((i >= 4 ? 0 : (l / Math.pow(2, i * 8))) & 0xff | 0);
    // (message length < 2^32 bits here; high dword written as 0 above)
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
        h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Array(64);
    const rr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let i = 0; i < m.length; i += 64) {
      for (let t = 0; t < 16; t++) w[t] = (m[i + t * 4] << 24) | (m[i + t * 4 + 1] << 16) | (m[i + t * 4 + 2] << 8) | m[i + t * 4 + 3];
      for (let t = 16; t < 64; t++) {
        const s0 = rr(w[t - 15], 7) ^ rr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        const s1 = rr(w[t - 2], 17) ^ rr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let t = 0; t < 64; t++) {
        const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[t] + w[t]) | 0;
        const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
        const mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7].map(x => (x >>> 0).toString(16).padStart(8, "0")).join("");
  }

  /* ---------------- canonical pick + commit hash ---------------- */
  function stableStringify(o) {
    if (o === null || typeof o !== "object") return JSON.stringify(o);
    if (Array.isArray(o)) return "[" + o.map(stableStringify).join(",") + "]";
    return "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
  }
  /** The signed statement. mkt = StablePrice implied triple AT COMMIT (L2);
      oddsTs = the anchored odds message timestamp (provable third-party). */
  function canonicalPick(p) {
    return stableStringify({
      v: 1, wallet: p.wallet, fixtureId: p.fixtureId, market: "1X2_FT",
      pick: p.pick, mkt: { home: round5(p.mkt.home), draw: round5(p.mkt.draw), away: round5(p.mkt.away) },
      oddsTs: p.oddsTs,
    });
  }
  const round5 = x => Math.round(x * 1e5) / 1e5;
  const commitHash = (canonical, salt) => sha256(canonical + "|" + salt);
  /** The exact on-chain memo text for a pick — single source of truth shared
      by the CLI anchor script (anchor-commit.js) and any browser wallet flow,
      so a hash anchored from either path is verifiable the same way. Kept
      under 566 bytes (Solana memo/tx practical limit) by design: fixed
      "FSGHT1|<64-hex-hash>|fx<id>" shape, ~80-90 bytes always. */
  function memoFor(p) {
    const canonical = canonicalPick(p);
    const hash = commitHash(canonical, p.salt);
    return { canonical, hash, memo: "FSGHT1|" + hash + "|fx" + p.fixtureId };
  }

  /* ---------------- de-vig + flat-stake scoring (L5) ----------------
     Multiplicative de-vig: q_i = p_i / Σp. The anchored triple is already
     demargined (TXLineStablePriceDemargined) so Σp ≈ 1; normalizing keeps
     the math exact anyway. fairOdds = 1/q_pick.
     $100 flat: win → +100·(fairOdds−1), lose → −100. EV under the market's
     own q is exactly 0 → avg return over many picks estimates pure edge. */
  function devig(mkt) {
    const s = mkt.home + mkt.draw + mkt.away;
    return { home: mkt.home / s, draw: mkt.draw / s, away: mkt.away / s };
  }
  const PICK_SIDE = { part1: "home", draw: "draw", part2: "away" };
  function gradePick(pick, mktAtCommit, winner, stake = 100) {
    const q = devig(mktAtCommit);
    const qPick = q[PICK_SIDE[pick]];
    const fairOdds = 1 / qPick;
    const won = pick === winner;
    const favProb = Math.max(q.home, q.draw, q.away);
    return {
      won, qPick, fairOdds,
      pnl: won ? stake * (fairOdds - 1) : -stake,
      upsetCall: qPick < favProb - 1e-12,   // picked something other than the favorite
    };
  }

  /* ---------------- mark-to-market (live portfolio value) ----------------
     A pick committed at de-vigged price q_entry is, mechanically, a prediction-
     market SHARE: it cost q_entry per $1 of payout, so a $stake wager buys
     stake/q_entry shares. At any later moment the same outcome trades at
     q_now (still de-vigged) — the position's fair cash-out value is
     shares · q_now = stake · (q_now / q_entry). This is exactly what a "cash
     out now" button computes on a real exchange: no oracle, no settlement,
     no waiting for full time — just the current consensus.
     Before grading: unrealizedPnl = value − stake (can swing either way as
     the market moves against/for you). After grading: value freezes at the
     realized payout. Sealed (unrevealed, pick unknown to us) can't be marked. */
  function markToMarket(commit, mktNow, stake = 100) {
    if (commit.status === "GRADED" || commit.status === "BURNED") {
      const won = commit.grade && commit.grade.won;
      return { value: won ? commit.grade.pnl + stake : 0, unrealizedPnl: null, qNow: null, live: false };
    }
    const pick = commit.pick;
    if (!pick) return { value: stake, unrealizedPnl: 0, qNow: null, live: false };   // sealed: can't mark what we can't see
    const qEntry = devig(commit.mktAtCommit)[PICK_SIDE[pick]];
    const qNow = devig(mktNow)[PICK_SIDE[pick]];
    const value = stake * (qNow / qEntry);
    return { value, unrealizedPnl: value - stake, qNow, live: true };
  }

  /* ---------------- the league (L1/L3/L4 state machine) ---------------- */
  function createLeague() {
    const commits = [];
    let nextId = 1;
    /** L1: record hash + public meta. `anchor` = {slot, blockTime} in prod
        (devnet memo); in replay-sim it is {t} on the tape axis, labeled SIM. */
    function commit(p) {
      const canonical = canonicalPick(p);
      const c = {
        id: nextId++, wallet: p.wallet, fixtureId: p.fixtureId,
        hash: commitHash(canonical, p.salt),
        tCommit: p.tCommit, mktAtCommit: { ...p.mkt }, oddsTs: p.oddsTs,
        anchor: p.anchor || { sim: true, t: p.tCommit },
        status: "COMMITTED", pick: null, grade: null,
        // provenance: how did this call originate? (leaderboard tags it)
        by: p.by || "human",            // "human" | "rule" | "prompt" | "api"
        visibility: p.visibility || "public",  // "public" | "private" (strategy hidden)
        copiedFrom: p.copiedFrom || null,      // wallet this pick mirrors, if any
      };
      commits.push(c);
      return c;
    }
    /** L3: reveal = re-derive the hash from the claimed pick + salt. */
    function reveal(id, claim) {
      const c = commits.find(x => x.id === id);
      if (!c) return null;
      const canonical = canonicalPick({
        wallet: c.wallet, fixtureId: c.fixtureId, pick: claim.pick,
        mkt: c.mktAtCommit, oddsTs: c.oddsTs,
      });
      if (commitHash(canonical, claim.salt) !== c.hash) { c.status = "INVALID"; return c; }
      c.status = "REVEALED"; c.pick = claim.pick;
      return c;
    }
    /** L4: grade everything against the TxLINE outcome. Unrevealed → BURNED
        (full stake loss): hiding a loser costs exactly what losing costs.
        Pass fixtureId to settle one fixture of a multi-match league. */
    function gradeAll(winner, stake = 100, fixtureId) {
      for (const c of commits) {
        if (fixtureId != null && c.fixtureId !== fixtureId) continue;
        if (c.status === "REVEALED") {
          c.grade = gradePick(c.pick, c.mktAtCommit, winner, stake);
          c.status = "GRADED";
        } else if (c.status === "COMMITTED") {
          c.grade = { won: false, pnl: -stake, burned: true, upsetCall: false };
          c.status = "BURNED";
        }
      }
      return commits;
    }
    /** Reputation profile per wallet. Shrinkage (L5): score = avgReturn ·
        n/(n+SHRINK_K) — a 2-pick hot streak cannot outrank a 20-pick record. */
    const SHRINK_K = 6;
    /** Is this wallet a human, or an agent? Derived from its commits. */
    function walletKind(wallet) {
      const any = commits.find(c => c.wallet === wallet);
      return { by: any ? any.by : "human", visibility: any ? any.visibility : "public" };
    }
    function profile(wallet) {
      const mine = commits.filter(c => c.wallet === wallet && (c.status === "GRADED" || c.status === "BURNED"));
      const n = mine.length;
      const pnl = mine.reduce((s, c) => s + c.grade.pnl, 0);
      const wins = mine.filter(c => c.grade.won).length;
      const upsetsLanded = mine.filter(c => c.grade.won && c.grade.upsetCall).length;
      const avgReturnPct = n ? pnl / n : 0;                    // per-$100-stake
      const k = walletKind(wallet);
      return {
        wallet, n, wins, pnl, upsetsLanded, avgReturnPct,
        shrunk: avgReturnPct * (n / (n + SHRINK_K)),
        burned: mine.filter(c => c.status === "BURNED").length,
        by: k.by, visibility: k.visibility,
      };
    }
    function leaderboard(minN = 1) {
      const wallets = [...new Set(commits.map(c => c.wallet))];
      return wallets.map(profile).filter(p => p.n >= minN).sort((a, b) => b.shrunk - a.shrunk);
    }
    return { commit, reveal, gradeAll, profile, leaderboard, walletKind, commits };
  }

  /* ---------------- earliness (the Why-It-Moved receipt) ----------------
     Given a commit and the detected consensus moves (SurpriseAgent.detectMoves
     over the real tape), find the first subsequent move ≥ minMag in the
     direction that VINDICATES the pick (home-prob up vindicates part1, down
     vindicates part2; draw picks get no earliness receipt in v1).
     lead = seconds between the committed timestamp and the market's move.
     minLeadSec=120: cross-fixture calibration (quant-analysis/final-four/
     foresight-analysis.js, 3 real WC tapes) measured event↔move lag noise of
     ±110s (p10 −55s / p90 +110s — the consensus often moves BEFORE the scores
     feed logs the event). A lead inside that band is indistinguishable from
     feed-timing noise, so it earns NO receipt. */
  function earliness(commitT, pick, moves, minMag = 0.02, minLeadSec = 120) {
    const wantDir = pick === "part1" ? 1 : pick === "part2" ? -1 : 0;
    if (!wantDir) return null;
    for (const mv of moves) {
      const tm = mv.emittedT != null ? mv.emittedT : mv.t;
      if (tm > commitT && mv.dir === wantDir && mv.magnitude >= minMag) {
        const leadSec = Math.round(tm - commitT);
        return leadSec >= minLeadSec ? { leadSec, move: mv } : null;
      }
    }
    return null;
  }

  /* ---------------- upset risk (the radar tile) ----------------
     risk(t) ∈ [0,100] = 100·(0.35·declineNorm + 0.40·trailing + 0.25·pressureNorm)
       declineNorm  = min(1, (q_fav(kickoff) − q_fav(t)) / 0.25)   consensus decay
       trailing     = 1 if the kickoff favorite is behind on goals at t,
                      0.4 if level after minute 60, else 0
       pressureNorm = min(1, underdog corners+shots in last 600s / 6)
     Deterministic; every term computable from the tape alone. */
  function upsetRisk(ticks, events, t) {
    if (!ticks.length) return { risk: 0, favSide: "home" };
    const q0 = devig({ home: ticks[0].home, draw: 1 - ticks[0].home - ticks[0].away, away: ticks[0].away });
    const favSide = q0.home >= q0.away ? "home" : "away";
    const favTeam = favSide === "home" ? 1 : 2;
    let cur = ticks[0];
    for (const k of ticks) { if (k.t <= t) cur = k; else break; }
    const qt = devig({ home: cur.home, draw: 1 - cur.home - cur.away, away: cur.away });
    const decline = Math.max(0, q0[favSide] - qt[favSide]);
    let g1 = 0, g2 = 0, pressure = 0;
    for (const e of events) {
      if (e.t > t) break;
      if (e.stats) { g1 = e.stats.g1; g2 = e.stats.g2; }
      if ((e.type === "corner" || e.type === "shot") && e.team && e.team !== favTeam && t - e.t <= 600) pressure++;
    }
    const favGoals = favTeam === 1 ? g1 : g2, dogGoals = favTeam === 1 ? g2 : g1;
    const trailing = favGoals < dogGoals ? 1 : (favGoals === dogGoals && t > 3600 ? 0.4 : 0);
    const risk = Math.round(100 * (0.35 * Math.min(1, decline / 0.25) + 0.40 * trailing + 0.25 * Math.min(1, pressure / 6)));
    return { risk: Math.max(0, Math.min(100, risk)), favSide, decline, trailing, pressure, qFav0: q0[favSide], qFavT: qt[favSide] };
  }

  /* =====================================================================
     AGENTS — strategies that trade automatically, into the SAME
     commit→reveal→grade pipeline as a human. Three provenance kinds:
       "rule"   — no-code condition→bet, built on-platform, strategy public
       "prompt" — natural language compiled to rules, prompt public OR private
       "api"    — an external algo/ML (its own model, its own data) POSTs a
                  signed pick; the black box stays hidden, the RECORD is
                  provable. In prod: POST /api/agents/{id}/commit {pick,
                  fixtureId, sig}; the demo injects labeled example API picks.
     Deploying an agent = an instant BACKTEST over the real World Cup tapes:
     the same run that populates the leaderboard IS "how would this have done".

     Triggers evaluate ONLY fields TxLINE actually provides — score, goal
     margin, minute, red cards, opening favourite, live consensus. Player /
     lineup triggers ("when Messi comes on") are UNSUPPORTED and flagged,
     never faked (no lineup data in the feed). ===================================================================== */

  // opening favourite (participant 1 or 2) from the first consensus tick
  function openingFavourite(tape) {
    const t = tape.ticks[0];
    const q = devig({ home: t.home, draw: Math.max(0.02, 1 - t.home - t.away), away: t.away });
    return q.home >= q.away ? 1 : 2;
  }
  // live match state at event i, from real cumulative stats
  function matchStateAt(events, i) {
    const e = events[i], s = e.stats || { g1: 0, g2: 0, r1: 0, r2: 0, s1: 0, s2: 0, c1: 0, c2: 0 };
    const redTeam = s.r1 > 0 && s.r2 === 0 ? 1 : s.r2 > 0 && s.r1 === 0 ? 2 : null;
    return { minute: e.minute, t: e.t != null ? e.t : e.minute * 60, g1: s.g1, g2: s.g2,
      diff: s.g1 - s.g2, level: s.g1 === s.g2, redTeam, redAny: s.r1 > 0 || s.r2 > 0,
      odds: e.odds, type: e.type };
  }
  // resolve a bet spec to a concrete side given state + favourite
  function resolveSide(spec, st, favP) {
    switch (spec) {
      case "part1": case "draw": case "part2": return spec;
      case "fav": return favP === 1 ? "part1" : "part2";
      case "dog": return favP === 1 ? "part2" : "part1";
      case "leader": return st.diff > 0 ? "part1" : st.diff < 0 ? "part2" : null;
      case "trailer": return st.diff < 0 ? "part1" : st.diff > 0 ? "part2" : null;
      case "nonRed": return st.redTeam === 1 ? "part2" : st.redTeam === 2 ? "part1" : null;
      default: return null;
    }
  }
  // one trigger condition against state
  function condTrue(c, st, favP) {
    switch (c.k) {
      case "kickoff": return st.minute <= 1;
      case "minGte": return st.minute >= c.v;
      case "leadAny": return Math.abs(st.diff) >= c.v;
      case "favLeadBy": return (favP === 1 ? st.diff : -st.diff) >= c.v;
      case "favTrail": return (favP === 1 ? st.diff : -st.diff) <= -(c.v || 1);
      case "level": return st.level;
      case "red": return st.redAny;
      case "favImpliedLte": { const q = devig(st.odds); return q[favP === 1 ? "home" : "away"] <= c.v; }
      default: return false;
    }
  }
  /** Run an agent over one fixture's tape. At the FIRST event where every
      trigger condition holds AND the bet resolves to a side, it commits (and
      auto-reveals — an agent is deterministic, it has nothing to hide). One
      commit per fixture. Returns the commit, or null if never triggered. */
  function runAgentOnTape(agent, tape, fixtureId, league) {
    const favP = openingFavourite(tape);
    const events = tape.events;
    for (let i = 0; i < events.length; i++) {
      const st = matchStateAt(events, i);
      if (!st.odds || st.odds.synthetic) continue;
      if (!agent.rules.when.every(c => condTrue(c, st, favP))) continue;
      const side = resolveSide(agent.rules.bet, st, favP);
      if (!side) continue;                       // e.g. "leader" while level → keep waiting
      const salt = "agent:" + agent.name + ":" + fixtureId;
      const c = league.commit({ wallet: agent.name, fixtureId, pick: side, salt,
        tCommit: st.t, mkt: st.odds, oddsTs: Math.round(st.t * 1000),
        anchor: { sim: true, t: st.t }, by: agent.kind, visibility: agent.visibility });
      league.reveal(c.id, { pick: side, salt });
      return c;
    }
    return null;
  }

  // NL prompt → rules. A deterministic keyword compiler standing in for an LLM
  // (a static page has no model; prod translates with one). Honest by design:
  // player/lineup references return {unsupported} rather than a faked rule.
  const PLAYER_SIGNALS = /\b(messi|ronaldo|mbapp|haaland|neymar|enters the pitch|comes on|substitut|in the lineup|starts|is playing)\b/i;
  function compilePrompt(text) {
    const t = " " + text.toLowerCase() + " ";
    const when = []; let bet = null;
    const num = (re) => { const m = t.match(re); return m ? parseInt(m[1], 10) : null; };
    // minute
    const min = num(/(?:past|after|beyond|>|over)\s*(\d{1,3})\s*(?:'|min|minute)/) || num(/(\d{1,3})\s*(?:'|min|minute)/);
    if (min != null) when.push({ k: "minGte", v: min });
    // score margin ("2:0", "2-0", "winning by 2", "2 goals up", "2 nil")
    const margin = num(/(\d)\s*[:\-]\s*0/) || num(/by\s*(\d)/) || num(/(\d)\s*(?:goal|nil)/);
    if (margin != null) { when.push({ k: "leadAny", v: margin }); bet = bet || "leader"; }
    if (/\bred card|sent off|red\b/.test(t)) { when.push({ k: "red" }); bet = bet || "nonRed"; }
    if (/\bkickoff|from the start|always|pre-?match\b/.test(t)) when.push({ k: "kickoff" });
    if (/\blevel|tied|deadlock|still 0-?0\b/.test(t)) when.push({ k: "level" });
    if (/\btrail|behind|losing|down a goal|comeback\b/.test(t)) when.push({ k: "favTrail", v: 1 });
    // bet side keywords (explicit override)
    if (/\bdraw|tie\b/.test(t)) bet = "draw";
    else if (/\bunderdog|upset|outsider\b/.test(t)) bet = "dog";
    else if (/\bfavou?rite|favou?red\b/.test(t)) bet = "fav";
    else if (/\b(back|bet)\s+(them|they|the winning|the leader|leading team)\b/.test(t)) bet = "leader";
    else if (/\bhome\b/.test(t)) bet = "part1";
    else if (/\baway\b/.test(t)) bet = "part2";
    const playerRef = PLAYER_SIGNALS.test(text);
    if (playerRef && !when.length) return { unsupported: true, reason: "Player/lineup triggers need lineup data, which TxLINE doesn't provide. Supported: score, goal margin, minute, red cards, favourite/underdog, odds." };
    if (!when.length || !bet) return { unsupported: true, reason: "Couldn't extract a supported rule. Try e.g. \"when a team is 2 goals up after 80 min, back them\" or \"when a red card is shown, back the other team\"." };
    const warn = playerRef ? "Note: player references were ignored (no lineup data); using the score/time/card parts only." : null;
    return { when, bet, warn };
  }

  /** The default field: real rule-agents (public strategies) + a private
      prompt-agent + an external API-algo example + a couple of manual humans.
      Deterministic. Replaces the old opaque seeded bots with inspectable
      strategies, so "human vs agent, public vs private" is real on the board. */
  const AGENT_ROSTER = [
    { name: "@two-nil-shield", kind: "rule", visibility: "public", strategy: "Back the leader once they lead by 2+ after 75'", rules: { when: [{ k: "leadAny", v: 2 }, { k: "minGte", v: 75 }], bet: "leader" } },
    { name: "@late-lock", kind: "rule", visibility: "public", strategy: "Back any team leading after 80'", rules: { when: [{ k: "leadAny", v: 1 }, { k: "minGte", v: 80 }], bet: "leader" } },
    { name: "@red-fade", kind: "rule", visibility: "public", strategy: "When a red card is shown, back the team still at 11", rules: { when: [{ k: "red" }], bet: "nonRed" } },
    { name: "@chalk", kind: "rule", visibility: "public", strategy: "Back the pre-match favourite at kickoff", rules: { when: [{ k: "kickoff" }], bet: "fav" } },
    { name: "@draw-camper", kind: "prompt", visibility: "public", strategy: "\"back the draw when it's still level after 70 minutes\"", prompt: "back the draw when it's still level after 70 minutes", rules: { when: [{ k: "level" }, { k: "minGte", v: 70 }], bet: "draw" } },
    { name: "@blackbox-7", kind: "prompt", visibility: "private", strategy: null, prompt: "(private)", rules: { when: [{ k: "favTrail", v: 1 }, { k: "minGte", v: 25 }], bet: "fav" } },
    { name: "@polyquant-ml", kind: "api", visibility: "private", strategy: null, prompt: null, rules: { when: [{ k: "favImpliedLte", v: 0.42 }, { k: "minGte", v: 20 }], bet: "fav" } },
  ];
  function agentField(league, tapesByFixture, seed = 4242) {
    const deployed = [];
    for (const agent of AGENT_ROSTER) {
      let n = 0;
      for (const { fixtureId, tape } of tapesByFixture) if (runAgentOnTape(agent, tape, fixtureId, league)) n++;
      deployed.push({ agent, picks: n });
    }
    // a couple of MANUAL humans for contrast (👤). One forgets to reveal → burn.
    const rnd = mulberry32(seed);
    ["@ana", "@miguel"].forEach((wallet, hi) => {
      tapesByFixture.forEach(({ fixtureId, tape }, fi) => {
        if (rnd() < 0.5) return;                              // humans don't bet every match
        const ticks = tape.ticks;
        const tCommit = rnd() * ticks[ticks.length - 1].t * 0.7;
        let c0 = ticks[0]; for (const k of ticks) { if (k.t <= tCommit) c0 = k; else break; }
        const mkt = { home: c0.home, draw: Math.max(0.02, 1 - c0.home - c0.away), away: c0.away };
        const pick = ["part1", "draw", "part2"][Math.floor(rnd() * 3)];
        const salt = "human:" + wallet + ":" + fixtureId;
        const c = league.commit({ wallet, fixtureId, pick, salt, tCommit, mkt, oddsTs: Math.round(tCommit * 1000), anchor: { sim: true, t: tCommit }, by: "human", visibility: "public" });
        if (!(wallet === "@miguel" && fi === 0)) league.reveal(c.id, { pick, salt });   // @miguel burns one
      });
    });
    return deployed;
  }

  /* ---------------- simulated prophets (legacy seeded field; kept for tests) ----------------
     CLEARLY LABELED SIMULATED in the UI. They exist so a single-fixture demo
     has a populated league; every mechanic (hash, reveal, burn, grading) is
     identical to the real user's picks. "Skill" is simulated by letting a
     prophet peek `skill` fraction of the time and commit just before a big
     move in its direction; the grader never knows. Deterministic (seeded). */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const SIM_NAMES = ["@cassandra", "@miguel", "@ana", "@turbo", "@owl", "@ferns", "@salt", "@vjeko"];
  function simulatedProphets(league, tape, moves, fixtureId, seed = 777) {
    const rnd = mulberry32(seed);
    const ticks = tape.ticks;
    const oddsAt = t => { let c = ticks[0]; for (const k of ticks) { if (k.t <= t) c = k; else break; } return { home: c.home, draw: Math.max(0.02, 1 - c.home - c.away), away: c.away }; };
    const bigMoves = moves.filter(m => m.magnitude >= 0.03);
    const out = [];
    SIM_NAMES.forEach((wallet, i) => {
      const skill = i / (SIM_NAMES.length - 1);            // 0..1 spread
      const nPicks = 1 + Math.floor(rnd() * 3);
      for (let p = 0; p < nPicks; p++) {
        let tCommit, pick;
        if (bigMoves.length && rnd() < skill * 0.85) {      // "sees it coming"
          const mv = bigMoves[Math.floor(rnd() * bigMoves.length)];
          const tm = mv.emittedT != null ? mv.emittedT : mv.t;
          tCommit = Math.max(0, tm - (120 + rnd() * 600));  // 2–12 min early
          pick = mv.dir === 1 ? "part1" : "part2";
        } else {                                            // noise pick
          tCommit = rnd() * ticks[ticks.length - 1].t * 0.8;
          pick = ["part1", "draw", "part2"][Math.floor(rnd() * 3)];
        }
        const mkt = oddsAt(tCommit);
        const salt = "sim-" + wallet + "-" + p;
        const c = league.commit({ wallet, fixtureId, pick, salt, tCommit, mkt, oddsTs: Math.round(tCommit * 1000), anchor: { sim: true, t: tCommit } });
        // one low-skill prophet "forgets" a reveal → demonstrates BURNED honestly
        if (!(i === 1 && p === 0)) league.reveal(c.id, { pick, salt });
        out.push(c);
      }
    });
    return out;
  }

  /* ---------------- outcome from the tape (L4, replay mode) ----------------
     90-minute 1X2 = H1 + H2 goals, read from the REAL on-chain statKey map of
     the game_finalised update (period_prefix + base_key: 1001/3001 = p1 H1/H2
     goals, 1002/3002 = p2). This is byte-for-byte the same data the prod
     validateStatV2 predicate checks — the replay grader and the on-chain
     grader read identical keys. (Never use interim `fulltime` stats maps:
     they can be partial — Argentina–Switzerland's regulation actually ended
     1–1 while an interim map said 1–0.) Fallback: cumulative final stats. */
  function outcomeFromTape(events) {
    const fin = [...events].reverse().find(e => e.type === "game_finalised" && e.raw && e.raw.Stats && e.raw.Stats["1001"] != null);
    let g1, g2, at, source;
    if (fin) {
      const S = fin.raw.Stats;
      g1 = (S["1001"] || 0) + (S["3001"] || 0);
      g2 = (S["1002"] || 0) + (S["3002"] || 0);
      at = fin.minute; source = "statKeys";
    } else {
      const src = events[events.length - 1];
      g1 = src.stats.g1; g2 = src.stats.g2; at = src.minute; source = "fallback-final";
    }
    return { winner: g1 > g2 ? "part1" : g2 > g1 ? "part2" : "draw", g1, g2, at, source, statKeys: [1001, 3001, 1002, 3002] };
  }

  return {
    sha256, utf8Bytes, stableStringify, canonicalPick, commitHash, memoFor,
    devig, gradePick, markToMarket, createLeague, earliness, upsetRisk,
    simulatedProphets, outcomeFromTape, mulberry32, SIM_NAMES, PICK_SIDE,
    compilePrompt, runAgentOnTape, agentField, AGENT_ROSTER,
    openingFavourite, matchStateAt, resolveSide, condTrue,
  };
});
