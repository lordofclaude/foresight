// FORESIGHT test suite — node test.js (exit 0 = green). Same conventions as
// the sibling final-four suites: pure-core assertions + real-tape integration.
"use strict";
const F = require("./foresight.js");
const fs = require("fs"), path = require("path");

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error("  ✗ " + name); }
}
function eq(a, b, name) { ok(a === b, name + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function close(a, b, tol, name) { ok(Math.abs(a - b) <= tol, name + ` (got ${a}, want ~${b})`); }
function throws(fn, pattern, name) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  ok(!!err && (!pattern || pattern.test(String(err.message))), name + (err ? "" : " (did not throw)"));
}

/* ---------------- sha256 (FIPS vectors) ---------------- */
eq(F.sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "sha256 'abc' FIPS vector");
eq(F.sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "sha256 '' FIPS vector");
eq(F.sha256("The quick brown fox jumps over the lazy dog"),
  "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592", "sha256 fox vector");
ok(F.sha256("é⚽") === F.sha256("é⚽"), "sha256 deterministic on multibyte");

/* ---------------- canonical + commit ---------------- */
eq(F.stableStringify({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}', "stableStringify sorts keys deep");
const basePick = { wallet: "@me", fixtureId: 18222446, pick: "part1", mkt: { home: 0.556, draw: 0.26, away: 0.184 }, oddsTs: 123 };
eq(F.canonicalPick(basePick), F.canonicalPick({ ...basePick }), "canonical stable across object copies");
ok(F.canonicalPick(basePick) !== F.canonicalPick({ ...basePick, pick: "part2" }), "canonical differs by pick");
ok(F.commitHash("x", "s1") !== F.commitHash("x", "s2"), "salt changes hash");
throws(() => F.canonicalPick({ ...basePick, pick: "part3" }), /unsupported pick side/, "canonical rejects unsupported side");
throws(() => F.canonicalPick({ ...basePick, fixtureId: Infinity }), /fixtureId/, "canonical rejects non-finite fixture id");
throws(() => F.canonicalPick({ ...basePick, fixtureId: 1.5 }), /fixtureId/, "canonical rejects fractional fixture id");
throws(() => F.canonicalPick({ ...basePick, oddsTs: NaN }), /oddsTs/, "canonical rejects non-finite odds timestamp");
throws(() => F.canonicalPick({ ...basePick, mkt: { home: 0.8, draw: 0.3, away: 0.2 } }), /sum/, "canonical rejects a non-normalized probability triple");
ok(F.canonicalPick({ ...basePick, pick: "part1", mkt: { home: 0.98999, draw: 0.01, away: 0.00001 } }).includes('"away":0.00001'),
  "canonical preserves a legitimate sub-1% unselected outcome");
ok(F.canonicalPick({ ...basePick, pick: "part2", mkt: { home: 0.98999, draw: 0.01, away: 0.00001 } }).includes('"away":0.00001'),
  "canonical quote serialization does not apply the selected-side grading floor");
throws(() => F.canonicalPick({ ...basePick, mkt: { home: 0.99999, draw: 0.01, away: 0 } }), /positive/, "canonical rejects a zero price");
throws(() => F.canonicalPick({ ...basePick, mkt: { home: 1.01, draw: 0.01, away: 0.01 } }), /between 0 and 1/, "canonical rejects a price above 1");
throws(() => F.canonicalPick({ ...basePick, mkt: { home: Infinity, draw: 0.2, away: 0.2 } }), /finite/, "canonical rejects infinite price");

/* ---------------- legacy anchored-artifact compatibility ---------------- */
{
  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, "anchored-proof-final.json"), "utf8"));
  const originalCanonical = artifact.canonical, originalHash = artifact.hash;
  const imported = F.importAnchoredArtifact(artifact, "foresight-final-onchain-v1");
  eq(imported.rawPick, "away", "v1 anchor retains its raw legacy side in signed bytes");
  eq(imported.pick, "part2", "v1 anchor normalizes away to canonical part2 after verification");
  ok(imported.hashVerified, "v1 anchor hash verifies with its original salt");
  eq(imported.canonical, originalCanonical, "v1 anchor import does not rewrite canonical bytes");
  eq(imported.hash, originalHash, "v1 anchor import does not rewrite hash");
  ok(F.gradePick(imported.pick, imported.mkt, "part2").won, "imported legacy anchor grades through canonical side semantics");
}

/* ---------------- memoFor (on-chain memo — shared by CLI anchor + browser wallet) ---------------- */
{
  const p = { wallet: "@you", fixtureId: 18222446, pick: "draw", mkt: { home: 0.556, draw: 0.26, away: 0.184 }, oddsTs: 123, salt: "s1" };
  const m = F.memoFor(p);
  eq(m.canonical, F.canonicalPick(p), "memoFor canonical matches canonicalPick");
  eq(m.hash, F.commitHash(m.canonical, p.salt), "memoFor hash matches commitHash");
  eq(m.memo, "FSGHT1|" + m.hash + "|fx18222446", "memoFor produces the exact FSGHT1|<hash>|fx<id> shape");
  ok(Buffer.byteLength(m.memo, "utf8") < 566, "memo fits Solana's practical size limit");
  const m2 = F.memoFor({ ...p, salt: "s2" });
  ok(m.memo !== m2.memo, "different salt -> different memo (unforgeable per-commit)");
}

/* ---------------- de-vig + grading ---------------- */
const q = F.devig({ home: 0.6, draw: 0.3, away: 0.3 });                 // vigged 1.2 book
close(q.home + q.draw + q.away, 1, 1e-12, "devig sums to 1");
close(q.home, 0.5, 1e-12, "devig multiplicative");
const gWin = F.gradePick("part2", { home: 0.5, draw: 0.3, away: 0.2 }, "part2");
close(gWin.fairOdds, 5, 1e-9, "fair odds 1/q");
close(gWin.pnl, 400, 1e-9, "upset win pays (fair-1)*100");
ok(gWin.upsetCall, "non-favorite pick flagged as upset call");
const gLose = F.gradePick("part1", { home: 0.5, draw: 0.3, away: 0.2 }, "part2");
close(gLose.pnl, -100, 1e-9, "loss costs stake");
ok(!F.gradePick("part1", { home: 0.5, draw: 0.3, away: 0.2 }, "part1").upsetCall, "favorite pick is not an upset call");
throws(() => F.gradePick("part2", { home: 0.99998, draw: 0.00001, away: 0.00001 }, "part2"), /grading floor/,
  "grading rejects near-zero selected probability instead of manufacturing P&L");
throws(() => F.gradePick("bogus", { home: 0.5, draw: 0.3, away: 0.2 }, "part1"), /unsupported pick side/, "grading rejects unsupported pick side");
throws(() => F.gradePick("part1", { home: 0.5, draw: NaN, away: 0.2 }, "part1"), /finite/, "grading rejects non-finite market input");
throws(() => F.gradePick("part1", { home: 0.5, draw: 0.3, away: 0.2 }, "part1", Infinity), /stake/, "grading rejects non-finite stake");

/* ---------------- mark-to-market ---------------- */
{
  const entry = { home: 0.556, draw: 0.285, away: 0.159 };
  const commitOpen = { status: "REVEALED", pick: "draw", mktAtCommit: entry };
  const qEntry = F.devig(entry).draw;
  // price unchanged -> value == stake, unrealized 0
  const m0 = F.markToMarket(commitOpen, entry);
  close(m0.value, 100, 1e-6, "unchanged price -> value = stake");
  close(m0.unrealizedPnl, 0, 1e-6, "unchanged price -> unrealized 0");
  ok(m0.live, "open position is marked live");
  // draw becomes MORE likely -> long-draw position gains value
  const richer = { home: 0.45, draw: 0.40, away: 0.15 };
  const m1 = F.markToMarket(commitOpen, richer);
  ok(m1.value > 100, "draw richening -> mark-to-market value rises");
  close(m1.value, 100 * (F.devig(richer).draw / qEntry), 1e-6, "mark-to-market formula: stake*(qNow/qEntry)");
  // draw becomes LESS likely -> value falls
  const poorer = { home: 0.70, draw: 0.15, away: 0.15 };
  const m2 = F.markToMarket(commitOpen, poorer);
  ok(m2.value < 100, "draw cheapening -> mark-to-market value falls");
  // sealed (no plaintext pick) -> flat at stake, not live
  const sealed = { status: "COMMITTED", pick: null, mktAtCommit: entry };
  const m3 = F.markToMarket(sealed, richer);
  eq(m3.value, 100, "sealed commit marks flat at stake");
  ok(!m3.live, "sealed commit is not live-marked");
  // graded win freezes at realized payout regardless of current market
  const gradedWin = { status: "GRADED", grade: { won: true, pnl: 251 } };
  const m4 = F.markToMarket(gradedWin, poorer);
  close(m4.value, 351, 1e-6, "graded win freezes at stake+pnl");
  ok(!m4.live, "graded position is not live-marked");
  ok(m4.unrealizedPnl === null, "graded position has no unrealized pnl (it's realized)");
  // graded loss / burned -> zero
  eq(F.markToMarket({ status: "GRADED", grade: { won: false, pnl: -100 } }, richer).value, 0, "graded loss freezes at 0");
  eq(F.markToMarket({ status: "BURNED", grade: { won: false } }, richer).value, 0, "burned freezes at 0");
}

/* ---------------- league state machine ---------------- */
{
  const L = F.createLeague();
  const mkt = { home: 0.5, draw: 0.3, away: 0.2 };
  const c1 = L.commit({ wallet: "@a", fixtureId: 1, pick: "part1", salt: "s", tCommit: 10, mkt, oddsTs: 1 });
  eq(c1.status, "COMMITTED", "commit starts COMMITTED");
  ok(!c1.pick, "plaintext pick not stored at commit");
  const bad = L.reveal(c1.id, { pick: "part2", salt: "s" });
  eq(bad.status, "INVALID", "wrong reveal → INVALID");
  const c2 = L.commit({ wallet: "@a", fixtureId: 1, pick: "part1", salt: "s", tCommit: 10, mkt, oddsTs: 1 });
  eq(L.reveal(c2.id, { pick: "part1", salt: "s" }).status, "REVEALED", "correct reveal verifies");
  const c3 = L.commit({ wallet: "@b", fixtureId: 1, pick: "part2", salt: "z", tCommit: 10, mkt, oddsTs: 1 }); // never revealed
  L.gradeAll("part1");
  eq(c2.status, "GRADED", "revealed → GRADED");
  eq(c3.status, "BURNED", "unrevealed → BURNED (reveal-or-burn)");
  close(c3.grade.pnl, -100, 1e-9, "burn costs full stake");
  eq(c1.status, "INVALID", "invalid reveal stays INVALID (not graded)");
  throws(() => L.commit({ wallet: "@a", fixtureId: 1, pick: "part1", salt: "s", tCommit: Infinity, mkt, oddsTs: 1 }), /tCommit/,
    "league rejects a non-finite commit timestamp");
  throws(() => L.commit({ wallet: "@a", fixtureId: 1, pick: "part2", salt: "s", tCommit: 10,
    mkt: { home: 0.98999, draw: 0.01, away: 0.00001 }, oddsTs: 1 }), /acceptance floor/,
    "league acceptance rejects only a selected side below the 1% payout floor");
}

/* ---------------- per-fixture settlement (multi-match league) ---------------- */
{
  const L = F.createLeague();
  const mkt = { home: 0.5, draw: 0.3, away: 0.2 };
  const a = L.commit({ wallet: "@m", fixtureId: 1, pick: "part1", salt: "a", tCommit: 0, mkt, oddsTs: 1 });
  const b = L.commit({ wallet: "@m", fixtureId: 2, pick: "part1", salt: "b", tCommit: 0, mkt, oddsTs: 1 });
  L.reveal(a.id, { pick: "part1", salt: "a" }); L.reveal(b.id, { pick: "part1", salt: "b" });
  L.gradeAll("part1", 100, 1);
  eq(a.status, "GRADED", "fixture 1 settled");
  eq(b.status, "REVEALED", "fixture 2 untouched by fixture-1 settlement");
  L.gradeAll("part2", 100, 2);
  eq(b.status, "GRADED", "fixture 2 settled separately");
  ok(a.grade.won && !b.grade.won, "same wallet, different fixtures, different outcomes");
  close(L.profile("@m").pnl, F.gradePick("part1", mkt, "part1").pnl - 100, 1e-9, "profile aggregates across fixtures");
}

/* ---------------- hedging is pointless (L3 arithmetic) ---------------- */
{
  const L = F.createLeague();
  const mkt = { home: 0.5, draw: 0.3, away: 0.2 };
  const a = L.commit({ wallet: "@hedge", fixtureId: 1, pick: "part1", salt: "1", tCommit: 0, mkt, oddsTs: 1 });
  const b = L.commit({ wallet: "@hedge", fixtureId: 1, pick: "part2", salt: "2", tCommit: 0, mkt, oddsTs: 1 });
  L.reveal(a.id, { pick: "part1", salt: "1" }); L.reveal(b.id, { pick: "part2", salt: "2" });
  L.gradeAll("part1");
  const p = L.profile("@hedge");
  const singleWin = F.gradePick("part1", mkt, "part1").pnl;
  ok(p.pnl < singleWin, "hedged pair earns less than one honest win");
  close(p.pnl, singleWin - 100, 1e-9, "hedge = win pnl minus one full loss");
}

/* ---------------- shrinkage leaderboard ---------------- */
{
  const L = F.createLeague();
  const mkt = { home: 0.5, draw: 0.3, away: 0.2 };
  // @streak: 1 upset win. @grind: 8 picks, 6 favorite wins 2 losses.
  const s1 = L.commit({ wallet: "@streak", fixtureId: 1, pick: "part2", salt: "s", tCommit: 0, mkt, oddsTs: 1 });
  L.reveal(s1.id, { pick: "part2", salt: "s" });
  for (let i = 0; i < 8; i++) {
    const pick = i < 6 ? "part2" : "part1";
    const c = L.commit({ wallet: "@grind", fixtureId: 1, pick, salt: "g" + i, tCommit: 0, mkt, oddsTs: 1 });
    L.reveal(c.id, { pick, salt: "g" + i });
  }
  L.gradeAll("part2");
  const board = L.leaderboard();
  eq(board[0].wallet, "@grind", "shrinkage: sustained record outranks 1-pick streak");
  const st = L.profile("@streak");
  ok(Math.abs(st.shrunk) < Math.abs(st.avgReturnPct), "shrunk pulls toward 0 for small n");
}

/* ---------------- earliness ---------------- */
{
  const moves = [
    { t: 100, emittedT: 130, dir: -1, magnitude: 0.05 },
    { t: 500, emittedT: 520, dir: 1, magnitude: 0.04 },
  ];
  const e = F.earliness(40, "part1", moves);
  eq(e.leadSec, 480, "earliness = first vindicating move after commit");
  eq(F.earliness(40, "part2", moves, 0.02, 0).leadSec, 90, "part2 vindicated by home-down move (noise gate off)");
  eq(F.earliness(40, "part2", moves), null, "90s lead inside ±110s lag-noise band → NO receipt (calibrated gate)");
  eq(F.earliness(600, "part1", moves), null, "no later move → no receipt");
  eq(F.earliness(0, "draw", moves), null, "draw picks get no earliness in v1");
  eq(F.earliness(40, "part1", [{ t: 90, emittedT: 95, dir: 1, magnitude: 0.01 }], 0.02, 0), null, "sub-threshold move ignored");
}

/* ---------------- upset risk ---------------- */
{
  const ticks = [{ t: 0, home: 0.6, away: 0.15 }, { t: 3000, home: 0.45, away: 0.28 }, { t: 4000, home: 0.35, away: 0.4 }];
  const evTrail = [
    { t: 100, type: "kickoff", team: 0, stats: { g1: 0, g2: 0 } },
    { t: 2500, type: "goal", team: 2, stats: { g1: 0, g2: 1 } },
    { t: 3500, type: "corner", team: 2, stats: { g1: 0, g2: 1 } },
    { t: 3600, type: "shot", team: 2, stats: { g1: 0, g2: 1 } },
  ];
  const rTrail = F.upsetRisk(ticks, evTrail, 4000);
  const rEarly = F.upsetRisk(ticks, evTrail.slice(0, 1), 500);
  ok(rTrail.risk > rEarly.risk, "trailing favorite risk > pre-goal risk");
  ok(rTrail.risk >= 0 && rTrail.risk <= 100, "risk bounded");
  eq(rTrail.favSide, "home", "kickoff favorite detected");
  ok(rTrail.trailing === 1, "favorite trailing detected from stats");
}

/* ---------------- agent engine ---------------- */
{
  // prompt compiler
  const p1 = F.compilePrompt("when a team is winning by 2 and it's past 80 minutes, back them");
  ok(!p1.unsupported, "prompt compiles to a supported rule");
  ok(p1.when.some(c => c.k === "leadAny" && c.v === 2), "extracts 2-goal lead");
  ok(p1.when.some(c => c.k === "minGte" && c.v === 80), "extracts minute 80");
  eq(p1.bet, "leader", "bet = leader");
  const p2 = F.compilePrompt("every time Messi enters the pitch bet they will win");
  ok(p2.unsupported, "player/lineup prompt flagged unsupported (no lineup data)");
  const p3 = F.compilePrompt("back the favourite from kickoff");
  ok(!p3.unsupported && p3.bet === "fav" && p3.when.some(c => c.k === "kickoff"), "kickoff+favourite compiles");
  const p4 = F.compilePrompt("when a red card is shown back the other team");
  ok(!p4.unsupported && p4.when.some(c => c.k === "red") && p4.bet === "nonRed", "red-card fade compiles");
  ok(F.compilePrompt("do something clever").unsupported, "vague prompt is unsupported, not faked");

  // trigger evaluation over a synthetic tape
  const synthEvents = [
    { minute: 0, t: 0, type: "kickoff", stats: { g1: 0, g2: 0, r1: 0, r2: 0, s1: 0, s2: 0, c1: 0, c2: 0 }, odds: { home: 0.6, draw: 0.25, away: 0.15 } },
    { minute: 30, t: 1800, type: "goal", stats: { g1: 1, g2: 0, r1: 0, r2: 0, s1: 3, s2: 1, c1: 2, c2: 0 }, odds: { home: 0.78, draw: 0.15, away: 0.07 } },
    { minute: 78, t: 4680, type: "goal", stats: { g1: 2, g2: 0, r1: 0, r2: 0, s1: 6, s2: 2, c1: 4, c2: 1 }, odds: { home: 0.93, draw: 0.05, away: 0.02 } },
    { minute: 85, t: 5100, type: "card", detail: "Red", stats: { g1: 2, g2: 0, r1: 0, r2: 1, s1: 6, s2: 2, c1: 4, c2: 1 }, odds: { home: 0.96, draw: 0.03, away: 0.01 } },
  ];
  const synthTape = { ticks: [{ t: 0, home: 0.6, away: 0.15 }, { t: 5100, home: 0.96, away: 0.01 }], events: synthEvents, real: false };
  const favP = F.openingFavourite(synthTape);
  eq(favP, 1, "opening favourite = participant 1");

  // @two-nil-shield: leadAny>=2 & min>=75 -> leader ; should fire at the 78' event
  {
    const L = F.createLeague();
    const agent = F.AGENT_ROSTER.find(a => a.name === "@two-nil-shield");
    const c = F.runAgentOnTape(agent, synthTape, 99, L);
    ok(c && c.status === "REVEALED", "two-nil-shield triggered and auto-revealed");
    eq(c.pick, "part1", "backed the leader (part1)");
    ok(Math.abs(c.tCommit - 4680) < 1, "fired at the 78' event, not before");
    eq(c.by, "rule", "tagged as a rule agent");
  }
  // @red-fade: back the team still at 11 (part1, since p2 got the red)
  {
    const L = F.createLeague();
    const c = F.runAgentOnTape(F.AGENT_ROSTER.find(a => a.name === "@red-fade"), synthTape, 99, L);
    eq(c.pick, "part1", "red-fade backs the 11-man side");
  }
  // @chalk fires at kickoff on the favourite
  {
    const L = F.createLeague();
    const c = F.runAgentOnTape(F.AGENT_ROSTER.find(a => a.name === "@chalk"), synthTape, 99, L);
    eq(c.pick, "part1", "chalk backs favourite at kickoff");
    ok(c.tCommit <= 1, "chalk fired at kickoff");
  }
  // an agent whose condition never holds makes no commit
  {
    const L = F.createLeague();
    const never = { name: "@never", kind: "rule", visibility: "public", rules: { when: [{ k: "leadAny", v: 5 }], bet: "leader" } };
    eq(F.runAgentOnTape(never, synthTape, 99, L), null, "non-triggering agent makes no commit");
    eq(L.commits.length, 0, "no phantom commits");
  }
  // walletKind distinguishes provenance
  {
    const L = F.createLeague();
    F.runAgentOnTape(F.AGENT_ROSTER.find(a => a.name === "@polyquant-ml"), { ticks: synthTape.ticks, events: [{ minute: 22, t: 1320, type: "shot", stats: { g1: 0, g2: 0, r1: 0, r2: 0, s1: 1, s2: 0, c1: 0, c2: 0 }, odds: { home: 0.40, draw: 0.30, away: 0.30 } }], real: false }, 99, L);
    eq(L.walletKind("@polyquant-ml").by, "api", "API agent tagged 'api'");
    eq(L.walletKind("@polyquant-ml").visibility, "private", "API agent is private");
  }
}

/* ---------------- real-tape integration ---------------- */
{
  // Layout-aware: this repo flattens the monorepo (shared/ + real-data/ at the
  // root, agent.js inside shared/); the war-room monorepo keeps ../shared and
  // ../t3-surprise-index. Try local first so `git clone && node test.js` works.
  const local = fs.existsSync(path.join(__dirname, "shared", "txline-real.js"));
  const shared = local ? path.join(__dirname, "shared") : path.join(__dirname, "..", "shared");
  const tapeDir = local ? path.join(__dirname, "real-data") : path.join(shared, "real-data");
  const TxReal = require(path.join(shared, "txline-real.js"));
  const SA = local ? require(path.join(shared, "agent.js"))
    : require(path.join(__dirname, "..", "t3-surprise-index", "agent.js"));
  const exactFixtureIds = [18222446, 18237038, 18241006, 18257865];
  const exactTapes = exactFixtureIds.map(fixtureId => {
    const src = fs.readFileSync(path.join(tapeDir, fixtureId + ".tape.js"), "utf8");
    const bundle = JSON.parse(src.slice(src.indexOf("=") + 1).trim().replace(/;\s*$/, ""));
    TxReal._reset();
    TxReal.load({ data: bundle });
    return { fixtureId, tape: SA.buildRealTape(TxReal.EVENTS, TxReal.state.oddsTimeline) };
  });
  exactTapes.forEach(({ fixtureId, tape }) => {
    ok(tape && tape.real, fixtureId + " exact real tape builds");
    const endT = tape && Math.max(tape.ticks[tape.ticks.length - 1].t, tape.events[tape.events.length - 1].t);
    ok(Number.isFinite(endT), fixtureId + " exact real tape has a finite end time");
  });
  const tape = exactTapes[0].tape;
  ok(tape && tape.real, "real tape builds");
  ok(tape.ticks[0].sourceTs === tape.ticks[0].ts && Number.isFinite(tape.ticks[0].sourceTs),
    "real ticks preserve absolute quote timestamp separately from relative t");

  const provenanceTimeline = Array.from({ length: 50 }, (_, i) => TxReal.normalizeOddsPayload({
    Ts: 100000 + i * 1000, MessageId: "quote-" + i, Bookmaker: "TXStable",
    Market: "1X2", MarketPeriod: "FT", SuperOddsType: "1X2_PARTICIPANT_RESULT", Pct: [40, 30, 30],
  }));
  const provenanceTape = SA.buildRealTape([{ ts: 100000 }, { ts: 149000 }], provenanceTimeline);
  ok(!!provenanceTape, "synthetic provenance tape builds");
  eq(provenanceTape.ticks[0].t, 0, "real tick keeps relative playback t");
  eq(provenanceTape.ticks[0].sourceTs, 100000, "real tick preserves source Ts");
  eq(provenanceTape.ticks[0].messageId, "quote-0", "real tick preserves MessageId");
  eq(provenanceTape.ticks[0].bookmaker, "TXStable", "real tick preserves bookmaker");
  eq(provenanceTape.ticks[0].market, "1X2", "real tick preserves market");
  eq(provenanceTape.ticks[0].period, "FT", "real tick preserves period");

  const outcome = F.outcomeFromTape(tape.events);
  eq(outcome.winner, "draw", "90' outcome from statKeys: 1-1 draw (ET win does NOT settle FT 1X2)");
  eq(outcome.source, "statKeys", "outcome read from the real on-chain statKey map");
  eq(outcome.g1, 1, "H1+H2 goals p1 = 1"); eq(outcome.g2, 1, "H1+H2 goals p2 = 1");

  const moves = SA.detectMoves(tape.ticks, SA.CFG);
  ok(moves.length >= 5, "detector finds moves on the real consensus");

  // full league round-trip on real data
  const L = F.createLeague();
  const sims = F.simulatedProphets(L, tape, moves, 18222446, 777);
  ok(sims.length >= 8, "simulated prophets committed");
  const mkt0 = { home: tape.ticks[0].home, draw: 1 - tape.ticks[0].home - tape.ticks[0].away, away: tape.ticks[0].away };
  const me = L.commit({ wallet: "@tiago", fixtureId: 18222446, pick: "draw", salt: "demo", tCommit: 0, mkt: mkt0, oddsTs: 0 });
  L.reveal(me.id, { pick: "draw", salt: "demo" });
  const wrong = L.commit({ wallet: "@fav", fixtureId: 18222446, pick: "part1", salt: "fav", tCommit: 0, mkt: mkt0, oddsTs: 0 });
  L.reveal(wrong.id, { pick: "part1", salt: "fav" });
  L.gradeAll(outcome.winner);
  const myProfile = L.profile("@tiago");
  ok(myProfile.pnl > 200, "pre-match DRAW call pays upset odds (~26% implied)");
  ok(L.profile("@fav").pnl === -100, "favorite pick honestly loses the FT market");
  ok(me.grade.upsetCall, "draw call flagged as upset call");
  ok(L.commits.some(c => c.status === "BURNED"), "one sim prophet burned (reveal-or-burn shown)");
  const board = L.leaderboard(1);
  ok(board.length >= 8, "leaderboard populated");

  // determinism: same seed → identical board
  const L2 = F.createLeague();
  F.simulatedProphets(L2, tape, moves, 18222446, 777);
  L2.gradeAll(outcome.winner);
  eq(JSON.stringify(L2.leaderboard(1)), JSON.stringify(L.leaderboard(1).filter(p => p.wallet !== "@tiago" && p.wallet !== "@fav")),
    "simulated league deterministic across runs");

  // agentField over the real tape: agents deploy, grade, and tag correctly
  {
    const L2 = F.createLeague();
    const deployed = F.agentField(L2, [{ fixtureId: 18222446, tape }], 4242);
    ok(deployed.length >= 6, "agent roster deployed");
    L2.gradeAll(outcome.winner, 100, 18222446);
    const board = L2.leaderboard(1);
    ok(board.some(p => p.by === "rule"), "leaderboard has rule agents");
    ok(board.some(p => p.by === "api"), "leaderboard has an API agent");
    ok(board.some(p => p.by === "human"), "leaderboard has manual humans");
    ok(board.some(p => p.visibility === "private"), "leaderboard has a private-strategy agent");
    // @chalk backed the favourite (Argentina, part1) at kickoff → lost on the 90' draw
    const chalk = L2.commits.find(c => c.wallet === "@chalk");
    ok(chalk && chalk.pick === "part1", "chalk backed the pre-match favourite");
    // determinism
    const L3 = F.createLeague(); F.agentField(L3, [{ fixtureId: 18222446, tape }], 4242); L3.gradeAll(outcome.winner, 100, 18222446);
    eq(JSON.stringify(L3.leaderboard(1)), JSON.stringify(L2.leaderboard(1)), "agentField deterministic across runs");
  }

  // Browser resetLeague equivalent: all exact tapes must populate the field
  // together without a thin (<1%) unselected quote leg aborting startup.
  {
    const startupLeague = F.createLeague();
    let deployed = null, startupError = null;
    try { deployed = F.agentField(startupLeague, exactTapes, 4242); }
    catch (err) { startupError = err; }
    ok(!startupError, "agentField starts across all four exact tapes without throwing");
    eq(deployed && deployed.length, F.AGENT_ROSTER.length, "reset-equivalent deploys the full agent roster");
    ok(exactFixtureIds.every(fixtureId => startupLeague.commits.some(c => c.fixtureId === fixtureId)),
      "reset-equivalent creates expected commits for every exact fixture");
    let settlementError = null;
    try {
      exactTapes.forEach(({ fixtureId, tape }) => startupLeague.gradeAll(F.outcomeFromTape(tape.events).winner, 100, fixtureId));
    } catch (err) { settlementError = err; }
    ok(!settlementError, "accepted exact-tape commits settle without violating the selected-side payout cap");
    ok(startupLeague.commits.every(c => !c.grade || Number.isFinite(c.grade.pnl)),
      "reset-equivalent settlement produces only finite P&L");
  }

  // earliness on a real move for a skilled sim commit
  const anyReceipt = L.commits.map(c => c.status === "GRADED" && c.pick ? F.earliness(c.tCommit, c.pick, moves) : null).find(Boolean);
  ok(!!anyReceipt, "at least one earliness receipt on real moves");

  // upset risk trace across the real match is bounded and moves
  const risks = [0, 1800, 3600, 5400, 7000].map(t => F.upsetRisk(tape.ticks, tape.events, t).risk);
  ok(risks.every(r => r >= 0 && r <= 100), "real-tape risk bounded");
}

async function runAsyncIntegrityTests() {
  // layout-aware, same convention as the real-tape section above
  const TxReal = fs.existsSync(path.join(__dirname, "shared", "txline-real.js"))
    ? require(path.join(__dirname, "shared", "txline-real.js"))
    : require(path.join(__dirname, "..", "shared", "txline-real.js"));

  TxReal._reset();
  TxReal.configure({ fixtureId: 7, jwt: "test", apiToken: "test", fetchImpl: () => Promise.reject(new Error("offline")) });
  const fallback = await TxReal.proofFor(1001, 1, 9);
  eq(fallback.proofStatus, "offline_simulated", "offline proof is explicitly labeled simulated");
  eq(fallback.verified, false, "offline proof never claims verification");
  eq(fallback.cryptographicallyVerified, false, "offline proof never claims crypto verification");
  eq(fallback.txSig, null, "offline proof does not expose a fake tx signature as real");
  ok(!!fallback.simulatedProof && !!fallback.simulatedProof.pseudoTxSig, "offline diagnostics remain available under simulatedProof");

  TxReal._reset();
  TxReal.configure({ fixtureId: 7, jwt: "test", apiToken: "test", fetchImpl: () => Promise.resolve({
    ok: true, status: 200, json: () => Promise.resolve({ leaf: "api-leaf", root: "api-root", subTreeProof: { path: ["api-node"] } }),
  }) });
  const received = await TxReal.proofFor(1001, 1, 9);
  eq(received.proofStatus, "api_received", "API proof is labeled received, not verified");
  eq(received.verified, false, "unverified API response does not claim crypto verification");
  ok(received.apiReceived && received.real, "API proof retains genuine response provenance");

  let requestSignal = null, readerCancelled = false;
  TxReal._reset();
  TxReal.configure({ fixtureId: 7, jwt: "test", apiToken: "test", fetchImpl: (_url, opts) => {
    requestSignal = opts.signal;
    return Promise.resolve({ ok: true, status: 200, body: { getReader: () => ({
      read: () => new Promise(() => {}),
      cancel: () => { readerCancelled = true; return Promise.resolve(); },
    }) } });
  } });
  const stream = TxReal.streamLive("odds", { fixtureId: 7 });
  await new Promise(resolve => setImmediate(resolve));
  stream.stop();
  await Promise.resolve();
  ok(requestSignal && requestSignal.aborted, "streamLive.stop aborts the in-flight fetch");
  ok(readerCancelled, "streamLive.stop cancels the active response reader");
}

runAsyncIntegrityTests().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
