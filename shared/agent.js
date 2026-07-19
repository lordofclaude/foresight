/* ============================================================
   SurpriseIndex — deterministic surprise-move classification agent.

   PURE LOGIC ONLY: no DOM, no timers, no randomness at decision
   time. Every function operates on plain arrays of ticks/events,
   so the whole agent runs headless in Node (see test.js) exactly
   as it runs in the browser (index.html is just a renderer).

   Pipeline
     1. ticks            → volatility-adjusted move detection
                           (displacement z-scores vs robust MAD
                           baselines over three rolling windows)
     2. move + events    → explanation join (deterministic rule
                           taxonomy R1..R4)
     3. label            → EXPLAINED / PARTIAL / UNEXPLAINED
     4. UNEXPLAINED + thresholds → open a monitored THESIS
     5. thesis lifecycle → close with verdict:
                           MARKET_KNEW_FIRST / PRICE_CONFIRMED /
                           REVERTED / CONTRADICTED / EXPIRED
     6. scorecard        → precision, FP rate, simulated P&L,
                           shadow P&L per label class

   ⟨REAL⟩ swap points:
     - ticks come from buildDemoTape() here; in production they are
       the SSE frames of GET /api/odds/stream?fixtureId (StablePrice
       implied Pct per outcome, one detector instance per outcome).
     - events come from shared/txline-mock.js; in production they
       are GET /api/scores/stream?fixtureId SSE messages.
     - calibration/backtests: GET /api/scores/historical/{fixtureId}
       + GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}.
   ============================================================ */
const SurpriseAgent = (() => {
  "use strict";

  /* ---------------- configuration: every threshold in one place ----------------
     These are the exact deterministic rules the agent trades on.   */
  const CFG = {
    // --- tape geometry ---
    tickSec: 12,              // one consensus tick every 12 sim-seconds
    // --- move detection ---
    spanTicks: 4,             // displacement lookback: 4 ticks = 48s
    windows: [8, 20, 40],     // rolling baselines (ticks): ~96s / 4min / 8min
    zThreshold: 3.0,          // |z| needed per window
    minWindowsAgree: 2,       // move must clear z in >= 2 of 3 windows
    sigmaFloor: 0.004,        // robust-sigma floor (implied-prob units)
    minAbsMove: 0.020,        // magnitude floor: 2.0 implied points
    coalesceGapTicks: 2,      // flagged ticks <=2 apart merge into one move
    warmupSpans: 8,           // no detection until 8 spans of history exist
    // --- explanation join (R1..R4) ---
    explain: {
      majorSec: 90,           // R1: direction-matched major event <=90s before move
      staleSec: 240,          // R2: same but 90..240s  -> PARTIAL (stale repricing)
      densitySec: 360,        // R3 window for pressure events
      densityCount: 3,        // R3: >=3 same-direction pressure events -> PARTIAL
      phaseSec: 60            // R4: phase transition <=60s -> PARTIAL
    },
    // --- thesis lifecycle ---
    freshnessSec: 120,        // move must be emitted <=120s after its peak
    thesis: {
      minAbsMove: 0.025,      // only surprise moves >=2.5pts open a thesis
      maxOpen: 3,             // risk cap: concurrent open theses
      horizonSec: 600,        // monitor window: 10 sim-minutes
      confirmFrac: 0.5,       // price continues 50% of move size  -> confirmed
      stopFrac: 0.6,          // price retraces 60% of move size   -> reverted
      notionalPerProb: 1000   // sim stake: P&L = dProb * $1000 ($10 per point)
    },
    shadowHoldSec: 300,       // shadow position hold per label class
    demoSeed: 20260714        // deterministic tape noise
  };

  /* ---------------- math ---------------- */
  function median(a) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function mad(a) {              // median absolute deviation (robust to jump outliers)
    if (!a.length) return 0;
    const m = median(a);
    return median(a.map(v => Math.abs(v - m)));
  }
  function mulberry32(seed) {    // deterministic PRNG for the demo tape only
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmtMin = t => Math.floor(t / 60) + "'";
  const fmtUsd = v => (v >= 0 ? "+$" : "-$") + Math.abs(v).toFixed(0);

  /* ---------------- event semantics (soccer feed v1.1 taxonomy) ---------------- */
  // expectedDir: which way the HOME implied probability should move on this event.
  // +1 = home strengthens, -1 = home weakens, 0 = not a direction-bearing major.
  function expectedDir(e) {
    if (e.type === "goal") return e.team === 1 ? 1 : -1;
    if (e.type === "penalty" && e.detail === "Scored") return e.team === 1 ? 1 : -1;
    if (e.type === "penalty" && e.detail === "Missed") return e.team === 1 ? -1 : 1;
    if (e.type === "card" && e.detail === "Red") return e.team === 1 ? -1 : 1;
    if (e.type === "var" || e.type === "var_verdict") return e.team === 1 ? 1 : -1;
    return 0;
  }
  const isMajor = e => expectedDir(e) !== 0;
  function isPressure(e) {       // minor events that legitimately drift a price
    if (e.type === "corner") return true;
    if (e.type === "shot" && (e.detail === "OnTarget" || e.detail === "Woodwork" || e.detail === "Blocked")) return true;
    if (e.type === "freekick" && (e.detail === "Danger" || e.detail === "HighDanger")) return true;
    return false;
  }
  const pressureDir = e => (e.team === 1 ? 1 : -1);
  const isPhase = e => e.type === "kickoff" || e.type === "halftime" || e.type === "fulltime" || e.type === "game_finalised";
  function evName(e) {
    const team = e.teamName && e.teamName !== "—" ? " " + e.teamName : "";
    const det = e.detail ? " " + e.detail : "";
    return `${e.minute}' ${e.type}${det}${team}`;
  }

  /* ---------------- 1. move detection ----------------
     span_i  = home_i - home_{i-L}         (48s displacement)
     sigma_W = max(floor, 1.4826 * MAD(spans in last W ticks))
     z_i,W   = span_i / sigma_W
     MAD (not stddev) so one goal jump does not blind the detector
     for the next window — robust volatility adjustment.           */
  function spanAt(ticks, i, cfg = CFG) {
    return i < cfg.spanTicks ? null : ticks[i].home - ticks[i - cfg.spanTicks].home;
  }
  function zStats(ticks, i, cfg = CFG) {
    const L = cfg.spanTicks, span = spanAt(ticks, i, cfg);
    if (span === null || i < L + cfg.warmupSpans) {
      return { span: span || 0, zs: cfg.windows.map(() => 0), sigmas: cfg.windows.map(() => null), agree: 0, flagged: false };
    }
    const sigmas = [], zs = [];
    for (const W of cfg.windows) {
      const from = Math.max(L, i - W), spans = [];
      for (let j = from; j < i; j++) spans.push(spanAt(ticks, j, cfg));
      const sigma = Math.max(cfg.sigmaFloor, 1.4826 * mad(spans));
      sigmas.push(sigma); zs.push(span / sigma);
    }
    const agree = zs.filter(z => Math.abs(z) >= cfg.zThreshold).length;
    const flagged = Math.abs(span) >= cfg.minAbsMove && agree >= cfg.minWindowsAgree;
    return { span, zs, sigmas, agree, flagged };
  }

  // Incremental detector: coalesces consecutive flagged ticks (same direction,
  // gap <= coalesceGapTicks) into ONE move, emitted when the segment closes.
  function createDetector(cfg = CFG) {
    return {
      seg: null,
      push(ticks, i) {
        const st = zStats(ticks, i, cfg);
        let emitted = null;
        if (st.flagged) {
          const dir = st.span > 0 ? 1 : -1;
          if (this.seg && this.seg.dir === dir && i - this.seg.lastIdx <= cfg.coalesceGapTicks + 1) {
            this.seg.lastIdx = i;
            if (Math.abs(st.span) > this.seg.peakAbs) {
              this.seg.peakAbs = Math.abs(st.span); this.seg.peakIdx = i; this.seg.peakStats = st;
            }
          } else {
            if (this.seg) emitted = this.finish(ticks);
            this.seg = { dir, startIdx: i, lastIdx: i, peakIdx: i, peakAbs: Math.abs(st.span), peakStats: st };
          }
        } else if (this.seg && i - this.seg.lastIdx > cfg.coalesceGapTicks) {
          emitted = this.finish(ticks);
        }
        if (emitted) { emitted.emittedT = ticks[i].t; emitted.emittedIdx = i; }
        return emitted;
      },
      finish(ticks) {
        const s = this.seg; this.seg = null;
        return {
          t: ticks[s.peakIdx].t, idx: s.peakIdx, dir: s.dir, magnitude: s.peakAbs,
          price: ticks[s.peakIdx].home, zs: s.peakStats.zs, agree: s.peakStats.agree
        };
      }
    };
  }
  function detectMoves(ticks, cfg = CFG) {   // batch wrapper (tests / backtests)
    const det = createDetector(cfg), out = [];
    for (let i = 0; i < ticks.length; i++) { const m = det.push(ticks, i); if (m) out.push(m); }
    if (det.seg) { const m = det.finish(ticks); m.emittedT = ticks[ticks.length - 1].t; m.emittedIdx = ticks.length - 1; out.push(m); }
    return out;
  }

  /* ---------------- 2+3. explanation join — deterministic rule taxonomy ----------------
     R1  direction-matched MAJOR event <=90s before the move  -> EXPLAINED
     R2  direction-matched MAJOR event 90..240s before        -> PARTIAL (stale repricing)
     R3  >=3 same-direction PRESSURE events <=360s before     -> PARTIAL (buildup)
     R4  phase transition <=60s before                        -> PARTIAL (structural)
     else                                                     -> UNEXPLAINED             */
  function classifyMove(move, events, cfg = CFG) {
    const E = cfg.explain, t = move.t, trace = [];
    const win = (e, lo, hi) => t - e.t >= lo && t - e.t <= hi;

    const r1 = events.filter(e => isMajor(e) && win(e, 0, E.majorSec) && expectedDir(e) === move.dir);
    trace.push({ rule: "R1", desc: `major event, direction match, <=${E.majorSec}s`, pass: r1.length > 0, detail: r1.length ? evName(r1[r1.length - 1]) : "none" });
    if (r1.length) return { label: "EXPLAINED", rule: "R1", evidence: r1[r1.length - 1], trace };

    const r2 = events.filter(e => isMajor(e) && t - e.t > E.majorSec && t - e.t <= E.staleSec && expectedDir(e) === move.dir);
    trace.push({ rule: "R2", desc: `major event, direction match, ${E.majorSec}-${E.staleSec}s (stale repricing)`, pass: r2.length > 0, detail: r2.length ? evName(r2[r2.length - 1]) : "none" });
    if (r2.length) return { label: "PARTIAL", rule: "R2", evidence: r2[r2.length - 1], trace };

    const r3 = events.filter(e => isPressure(e) && win(e, 0, E.densitySec) && pressureDir(e) === move.dir);
    trace.push({ rule: "R3", desc: `>=${E.densityCount} same-direction pressure events <=${E.densitySec}s`, pass: r3.length >= E.densityCount, detail: `${r3.length} found` });
    if (r3.length >= E.densityCount) return { label: "PARTIAL", rule: "R3", evidence: r3[r3.length - 1], evidenceAll: r3, trace };

    const r4 = events.filter(e => isPhase(e) && win(e, 0, E.phaseSec));
    trace.push({ rule: "R4", desc: `phase transition <=${E.phaseSec}s`, pass: r4.length > 0, detail: r4.length ? evName(r4[r4.length - 1]) : "none" });
    if (r4.length) return { label: "PARTIAL", rule: "R4", evidence: r4[r4.length - 1], trace };

    trace.push({ rule: "R0", desc: "no explanation rule fired", pass: true, detail: "information-rich by elimination" });
    return { label: "UNEXPLAINED", rule: "R0", evidence: null, trace };
  }

  /* ---------------- 4. thesis gate — auditable threshold checks ---------------- */
  function tryOpenThesis(state, mv, tick, cfg = CFG) {
    const T = cfg.thesis;
    const open = state.theses.filter(x => x.status === "OPEN").length;
    const lag = tick.t - mv.t;
    const checks = [
      { rule: "label", desc: "label == UNEXPLAINED", pass: mv.label === "UNEXPLAINED", detail: mv.label },
      { rule: "magnitude", desc: `|move| >= ${T.minAbsMove}`, pass: mv.magnitude >= T.minAbsMove, detail: (mv.magnitude * 100).toFixed(1) + "pts" },
      { rule: "z-agree", desc: `windows agreeing >= ${state.cfg.minWindowsAgree}/${state.cfg.windows.length}`, pass: mv.agree >= state.cfg.minWindowsAgree, detail: `${mv.agree}/${state.cfg.windows.length}` },
      { rule: "freshness", desc: `emit lag <= ${cfg.freshnessSec}s`, pass: lag <= cfg.freshnessSec, detail: lag + "s" },
      { rule: "risk", desc: `open theses < ${T.maxOpen}`, pass: open < T.maxOpen, detail: String(open) }
    ];
    if (!checks.every(c => c.pass)) return { thesis: null, checks };
    const th = {
      id: state.nextId++, moveT: mv.t, entryT: tick.t, entry: tick.home, dir: mv.dir,
      mag: mv.magnitude, status: "OPEN", verdict: null, exit: null, pnl: null,
      closedT: null, leadSec: null, evidence: null, path: [{ t: tick.t, home: tick.home }]
    };
    state.theses.push(th);
    return { thesis: th, checks };
  }

  /* ---------------- 5. agent (streaming) ---------------- */
  function createAgent(cfg = CFG) {
    const state = { cfg, ticks: [], events: [], moves: [], theses: [], journal: [], nextId: 1 };
    const det = createDetector(cfg);
    const lastPrice = () => state.ticks.length ? state.ticks[state.ticks.length - 1].home : null;
    const log = (t, kind, text, trace) => state.journal.push({ t, kind, text, trace: trace || null });

    function verdictText(th) {
      const side = th.dir === 1 ? "LONG" : "SHORT";
      switch (th.verdict) {
        case "MARKET_KNEW_FIRST":
          return `THESIS #${th.id} CLOSED — UNEXPLAINED move at ${fmtMin(th.moveT)} preceded ${evName(th.evidence)} by ${th.leadSec}s — THE MARKET KNEW FIRST · ${side} ${fmtUsd(th.pnl)}`;
        case "PRICE_CONFIRMED":
          return `THESIS #${th.id} CLOSED — informed flow confirmed by continued price path (+${(cfg.thesis.confirmFrac * 100).toFixed(0)}% of move) · ${side} ${fmtUsd(th.pnl)}`;
        case "REVERTED":
          return `THESIS #${th.id} CLOSED — noise: price retraced through ${(cfg.thesis.stopFrac * 100).toFixed(0)}% stop · ${side} ${fmtUsd(th.pnl)}`;
        case "CONTRADICTED":
          return `THESIS #${th.id} CLOSED — wrong way: opposing major event ${evName(th.evidence)} · ${side} ${fmtUsd(th.pnl)}`;
        default:
          return `THESIS #${th.id} CLOSED — horizon elapsed, no confirming information · ${side} ${fmtUsd(th.pnl)}`;
      }
    }
    function closeThesis(th, verdict, exit, evidence, t) {
      th.status = "CLOSED"; th.verdict = verdict; th.exit = exit; th.closedT = t;
      th.pnl = (exit - th.entry) * th.dir * cfg.thesis.notionalPerProb;
      if (evidence) { th.evidence = evidence; th.leadSec = evidence.t - th.moveT; }
      log(t, "close", verdictText(th), null);
    }

    function onEvent(e) {                      // ⟨REAL⟩ SSE frame of /api/scores/stream
      state.events.push(e);
      for (const th of state.theses) {
        if (th.status !== "OPEN") continue;
        const d = expectedDir(e);
        if (d === 0) continue;
        const exit = (e.odds && typeof e.odds.home === "number") ? e.odds.home : (lastPrice() ?? th.entry);
        if (d === th.dir && e.t - th.entryT <= cfg.thesis.horizonSec) {
          closeThesis(th, "MARKET_KNEW_FIRST", exit, e, e.t);
        } else if (d === -th.dir) {
          closeThesis(th, "CONTRADICTED", exit, e, e.t);
        }
      }
      if (e.type === "game_finalised") {
        for (const th of state.theses) if (th.status === "OPEN") closeThesis(th, "EXPIRED", lastPrice() ?? th.entry, null, e.t);
        log(e.t, "info", `match finalised (${e.detail}) — session closed`);
      }
    }

    function onTick(tick) {                    // ⟨REAL⟩ SSE frame of /api/odds/stream
      state.ticks.push(tick);
      const T = cfg.thesis;
      for (const th of state.theses) {
        if (th.status !== "OPEN") continue;
        th.path.push({ t: tick.t, home: tick.home });
        const exc = (tick.home - th.entry) * th.dir;
        if (exc >= T.confirmFrac * th.mag) closeThesis(th, "PRICE_CONFIRMED", tick.home, null, tick.t);
        else if (exc <= -T.stopFrac * th.mag) closeThesis(th, "REVERTED", tick.home, null, tick.t);
        else if (tick.t - th.entryT >= T.horizonSec) closeThesis(th, "EXPIRED", tick.home, null, tick.t);
      }
      const mv = det.push(state.ticks, state.ticks.length - 1);
      if (mv) {
        const cls = classifyMove(mv, state.events, cfg);
        mv.cls = cls; mv.label = cls.label; mv.rule = cls.rule;
        state.moves.push(mv);
        const zTxt = mv.zs.map(z => z.toFixed(1)).join("/");
        log(tick.t, "move",
          `MOVE ${mv.dir > 0 ? "+" : "-"}${(mv.magnitude * 100).toFixed(1)}pts @ ${fmtMin(mv.t)} z[${zTxt}] agree ${mv.agree}/3 -> ${cls.label}${cls.rule !== "R0" ? " (" + cls.rule + ")" : ""}`,
          cls.trace);
        if (cls.label === "UNEXPLAINED") {
          const { thesis, checks } = tryOpenThesis(state, mv, tick, cfg);
          if (thesis) {
            log(tick.t, "open",
              `THESIS #${thesis.id} OPEN — ${thesis.dir === 1 ? "LONG" : "SHORT"} home @ ${(thesis.entry * 100).toFixed(1)}% · move ${(mv.magnitude * 100).toFixed(1)}pts unexplained · monitoring ${T.horizonSec}s`,
              checks);
          } else {
            log(tick.t, "veto", `thesis vetoed for UNEXPLAINED move @ ${fmtMin(mv.t)}`, checks);
          }
        }
      }
      return mv;
    }

    return { state, cfg, onEvent, onTick };
  }

  /* ---------------- 6. scorecard ---------------- */
  function shadowPnl(mv, ticks, cfg = CFG) {   // hold-for-300s shadow position per move
    let entryIdx = -1;
    for (let i = 0; i < ticks.length; i++) if (ticks[i].t >= mv.emittedT) { entryIdx = i; break; }
    if (entryIdx < 0) return null;
    const exitT = ticks[entryIdx].t + cfg.shadowHoldSec;
    let exitIdx = -1;
    for (let i = entryIdx; i < ticks.length; i++) if (ticks[i].t >= exitT) { exitIdx = i; break; }
    if (exitIdx < 0) return null;
    return (ticks[exitIdx].home - ticks[entryIdx].home) * mv.dir * cfg.thesis.notionalPerProb;
  }
  function computeScorecard(state, cfg) {
    cfg = cfg || state.cfg || CFG;
    const labels = {};
    for (const L of ["EXPLAINED", "PARTIAL", "UNEXPLAINED"]) {
      const ms = state.moves.filter(m => m.label === L);
      let pnl = 0, resolved = 0;
      for (const m of ms) { const p = shadowPnl(m, state.ticks, cfg); if (p !== null) { pnl += p; resolved++; } }
      labels[L] = { count: ms.length, resolved, shadowPnl: pnl };
    }
    const closed = state.theses.filter(t => t.status === "CLOSED");
    const tp = closed.filter(t => t.verdict === "MARKET_KNEW_FIRST" || t.verdict === "PRICE_CONFIRMED");
    const fp = closed.filter(t => t.verdict === "REVERTED" || t.verdict === "CONTRADICTED");
    const expired = closed.filter(t => t.verdict === "EXPIRED");
    const knew = closed.filter(t => t.verdict === "MARKET_KNEW_FIRST");
    const graded = tp.length + fp.length;
    return {
      labels,
      theses: {
        total: state.theses.length,
        open: state.theses.filter(t => t.status === "OPEN").length,
        closed: closed.length, tp: tp.length, fp: fp.length, expired: expired.length,
        precision: graded ? tp.length / graded : null,
        fpRate: closed.length ? fp.length / closed.length : null,
        pnl: closed.reduce((s, t) => s + t.pnl, 0),
        avgLeadSec: knew.length ? knew.reduce((s, t) => s + t.leadSec, 0) / knew.length : null
      }
    };
  }

  /* ---------------- headless backtest driver ---------------- */
  function runBacktest(tape, cfg = CFG) {
    const ag = createAgent(cfg);
    let ei = 0;
    for (const tick of tape.ticks) {
      while (ei < tape.events.length && tape.events[ei].t <= tick.t) ag.onEvent(tape.events[ei++]);
      ag.onTick(tick);
    }
    while (ei < tape.events.length) ag.onEvent(tape.events[ei++]);
    return { state: ag.state, scorecard: computeScorecard(ag.state, cfg) };
  }

  /* ---------------- demo tape synthesis ----------------
     ⟨REAL⟩ In production this whole block is DELETED: tick density
     comes from the real /api/odds/stream SSE (many bookmaker/
     StablePrice updates per minute). The shared mock only reprices
     at scripted events, so we deterministically reconstruct a
     realistic tick tape around it: interpolated consensus + seeded
     micro-noise + three "informed flow" leaks that front-run real
     scripted events, one pure-noise spike, and two drift episodes.
     The AGENT does not know any of this — it sees only ticks.      */
  const DEMO_INJECTIONS = [
    { kind: "spike", t0: 1704, dir: -1, mag: 0.030, holdSec: 24, revertSec: 240, note: "pure noise spike ~28' (no information) — agent should stop out" },
    { kind: "drift", t0: 1512, dir: 1, mag: 0.026, holdSec: 600, revertSec: 120, note: "late repricing ~25' after the 23' goal (R2 partial)" },
    { kind: "drift", t0: 3756, dir: -1, mag: 0.026, holdSec: 600, revertSec: 120, note: "pressure drift ~63' after Morocco surge 58'-63' (R3 partial)" },
    { kind: "leak", t0: 3984, dir: -1, mag: 0.035, until: 4140, note: "informed flow ~66.5' before the 69' Morocco goal" },
    { kind: "leak", t0: 4704, dir: -1, mag: 0.040, until: 4860, note: "informed flow ~78.5' before the 81' France red card" },
    { kind: "leak", t0: 5052, dir: 1, mag: 0.032, until: 5220, note: "informed flow ~84' before the 87' France goal" }
  ];
  function injOffset(inj, t, cfg = CFG) {
    if (t < inj.t0) return 0;
    const rampSec = cfg.spanTicks * cfg.tickSec;           // 48s ramp
    const full = inj.mag * inj.dir, rampEnd = inj.t0 + rampSec;
    if (t < rampEnd) return full * (t - inj.t0) / rampSec;
    if (inj.kind === "leak") return t < inj.until ? full : 0;   // event arrives -> consensus absorbs it
    const holdEnd = rampEnd + inj.holdSec;
    if (t < holdEnd) return full;
    const revEnd = holdEnd + inj.revertSec;
    if (t < revEnd) return full * (1 - (t - holdEnd) / inj.revertSec);  // slow revert (below detection)
    return 0;
  }
  function buildDemoTape(rawEvents, cfg = CFG) {
    const events = rawEvents.map(e => ({ ...e, t: e.minute * 60 }));
    const endT = events[events.length - 1].t;
    const rnd = mulberry32(cfg.demoSeed);
    const ticks = [];
    let ev = 0, baseHome = rawEvents[0].odds.home, baseAway = rawEvents[0].odds.away;
    for (let t = 0; t <= endT; t += cfg.tickSec) {
      while (ev < events.length && events[ev].t <= t) { baseHome = events[ev].odds.home; baseAway = events[ev].odds.away; ev++; }
      let off = 0;
      for (const inj of DEMO_INJECTIONS) off += injOffset(inj, t, cfg);
      const noise = (rnd() * 2 - 1) * 0.002;
      ticks.push({
        t, minute: t / 60,
        home: clamp(baseHome + off + noise, 0.03, 0.95),
        away: clamp(baseAway - off * 0.7 - noise * 0.5, 0.02, 0.95)
      });
    }
    return { ticks, events, injections: DEMO_INJECTIONS };
  }

  /* REAL tape (no synthesis, no injections): ticks = the StablePrice consensus
     timeline from a pulled TxLINE fixture (txline-real.js `state.oddsTimeline`),
     events = the real score events. Both mapped onto one wall-clock axis
     t = (ts - kickoffTs)/1000 — real seconds, breaks included, exactly what the
     detector's wall-clock windows assume. Returns null when the timeline is too
     thin to be a tick tape (caller falls back to buildDemoTape). */
  function buildRealTape(rawEvents, oddsTimeline) {
    const evs = (rawEvents || []).filter(e => e.ts != null && !isNaN(e.ts)).slice().sort((a, b) => a.ts - b.ts);
    if (!evs.length || !Array.isArray(oddsTimeline)) return null;
    const t0 = evs[0].ts, endTs = evs[evs.length - 1].ts;
    const seen = new Map();                       // dedupe same-ts quotes, keep last
    for (const o of oddsTimeline) {
      if (o.ts == null || isNaN(o.ts) || o.home == null) continue;
      if (o.ts >= t0 && o.ts <= endTs + 60000) seen.set(o.ts, o);
    }
    const ticks = [...seen.values()].sort((a, b) => a.ts - b.ts)
      .map(o => ({
        t: (o.ts - t0) / 1000, minute: (o.ts - t0) / 60000,
        // Relative playback time stays in t; these fields retain the exact
        // third-party quote identity needed for odds-validation receipts.
        sourceTs: o.sourceTs != null ? o.sourceTs : o.ts, ts: o.ts,
        messageId: o.messageId, bookmaker: o.bookmaker, market: o.market,
        period: o.period, superOddsType: o.superOddsType, inRunning: o.inRunning,
        home: o.home, draw: o.draw, away: o.away,
      }));
    if (ticks.length < 50) return null;
    const events = evs.map(e => ({ ...e, t: (e.ts - t0) / 1000 }));
    return { ticks, events, real: true };
  }

  return {
    CFG, median, mad, mulberry32, clamp, fmtMin, fmtUsd,
    expectedDir, isMajor, isPressure, pressureDir, isPhase, evName,
    spanAt, zStats, createDetector, detectMoves,
    classifyMove, tryOpenThesis, createAgent,
    shadowPnl, computeScorecard, runBacktest,
    DEMO_INJECTIONS, injOffset, buildDemoTape, buildRealTape
  };
})();
if (typeof module !== "undefined") module.exports = SurpriseAgent;
