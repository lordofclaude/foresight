// FORESIGHT inline-logic test suite — node test-inline.js (exit 0 = green).
// Covers the pure functions that live INLINE in index.html's main <script>
// block (streakOf, calibrationOf, insightHtml, marketVol, monSpark,
// newsDriverFor, punditLine, liveMergeScore/liveMergeOdds) plus the relay's
// parseRss/decodeEntities/tag and categorize/titleTokens/dedupe in
// relay/worker.js. Sources are EXTRACTED from those files at run time and
// instantiated with `new Function` + stubbed dependencies, so this suite
// tests the exact shipped code without editing index.html or worker.js.
//
// Extraction is tolerant: a moved/renamed function fails with ONE clear
// "not found — re-run after index.html stabilizes" assertion and its section
// is skipped, instead of crashing the whole suite.
"use strict";
const fs = require("fs"), path = require("path");
const FO = require("./foresight.js");

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error("  ✗ " + name); }
}
function eq(a, b, name) { ok(a === b, name + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function close(a, b, tol, name) { ok(typeof a === "number" && Math.abs(a - b) <= tol, name + ` (got ${a}, want ~${b})`); }

/* ================= extraction harness ================= */
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const scriptRe = /<script>([\s\S]*?)<\/script>/g;
let m, INLINE = null;
while ((m = scriptRe.exec(html))) INLINE = m[1];   // LAST plain <script> block = the app's main script
if (!INLINE || INLINE.length < 1000) {
  console.error("FATAL: could not locate index.html's main inline <script> block — re-run after index.html stabilizes");
  process.exit(1);
}
const WORKER = fs.readFileSync(path.join(__dirname, "relay", "worker.js"), "utf8");

const missing = [];
/** Tolerant slice: [startMarker .. endMarker). null (+1 recorded failure) when the start marker is gone. */
function sliceSrc(src, startMarker, endMarker, label, fileLabel) {
  const i = src.indexOf(startMarker);
  if (i === -1) {
    missing.push(label);
    ok(false, `${label} not found — re-run after ${fileLabel} stabilizes`);
    return null;
  }
  let j = endMarker ? src.indexOf(endMarker, i + startMarker.length) : -1;
  if (j === -1) j = src.length;
  return src.slice(i, j);
}
/** Extract `function NAME(` through the next top-level '\nfunction ' boundary (proven pattern on this codebase). */
function extractFn(src, name, fileLabel) {
  return sliceSrc(src, "function " + name + "(", "\nfunction ", name, fileLabel);
}
/** Instantiate extracted source with stubbed deps. Returns the value of `ret`, or null (+1 failure). */
function build(label, srcText, params, ret, args) {
  if (srcText == null) return null;   // extraction already reported
  try {
    return new Function(...params, srcText + "\n;return " + ret + ";")(...(args || []));
  } catch (e) {
    missing.push(label);
    ok(false, `${label} failed to instantiate (${e.message}) — re-run after source stabilizes`);
    return null;
  }
}

/* ---- inline (index.html) sources ---- */
const streakSrc   = extractFn(INLINE, "streakOf", "index.html");
const calibSrc    = extractFn(INLINE, "calibrationOf", "index.html");
const insightSrc  = extractFn(INLINE, "insightHtml", "index.html");
const mktVolSrc   = extractFn(INLINE, "marketVol", "index.html");
const monSparkSrc = extractFn(INLINE, "monSpark", "index.html");
const newsDrvSrc  = extractFn(INLINE, "newsDriverFor", "index.html");
// punditLine needs its sibling `let punditN` + `const PUNDIT` templates — slice the whole lane
const punditSrc   = sliceSrc(INLINE, "let punditN = 0;", "\nfunction notifyLive", "punditLine (pundit lane)", "index.html");
// live-merge helpers need liveAccum + LIVE_KEEP + liveIsConsensus1x2 + the seed IIFE — slice the block
const liveSrc     = sliceSrc(INLINE, "const liveAccum = {", "\nlet liveRebuildQueued", "liveMergeScore/liveMergeOdds (live block)", "index.html");

/* ---- relay (worker.js) sources ---- */
const rssSrc  = sliceSrc(WORKER, "function decodeEntities(", "\n// Deterministic categorization", "parseRss/decodeEntities/tag", "relay/worker.js");
const newsSrc = sliceSrc(WORKER, "const NEWS_TAGS = [", "\nasync function newsLane", "categorize/titleTokens/dedupe", "relay/worker.js");

/* ================= streakOf ================= */
const mkStreak = L => build("streakOf", streakSrc, ["league"], "streakOf", [L]);
if (streakSrc) {
  const W = t => ({ wallet: "@w", status: "GRADED", grade: { won: true, pnl: 80 }, tCommit: t });
  const Lo = t => ({ wallet: "@w", status: "GRADED", grade: { won: false, pnl: -100 }, tCommit: t });
  const B = t => ({ wallet: "@w", status: "BURNED", grade: null, tCommit: t });

  { const s = mkStreak({ commits: [] })("@w");
    eq(s.cur, 0, "streakOf empty -> cur 0");
    eq(s.best, 0, "streakOf empty -> best 0"); }
  { const s = mkStreak({ commits: [W(1), W(2), W(3), Lo(4), W(5), W(6)] })("@w");
    eq(s.cur, 2, "streakOf W-W-W-L-W-W -> cur 2");
    eq(s.best, 3, "streakOf W-W-W-L-W-W -> best 3"); }
  { const s = mkStreak({ commits: [W(1), W(2), B(3), W(4)] })("@w");
    eq(s.cur, 1, "streakOf BURNED breaks the streak (cur)");
    eq(s.best, 2, "streakOf BURNED breaks the streak (best stays pre-burn)"); }
  { const s = mkStreak({ commits: [B(1), B(2)] })("@w");
    eq(s.best, 0, "streakOf BURNED never counts as a win"); }
  { // an unresolved (REVEALED) commit between wins is filtered out — streak continues through it
    const open = { wallet: "@w", status: "REVEALED", grade: null, tCommit: 3 };
    const s = mkStreak({ commits: [W(1), W(2), open, W(4), W(5)] })("@w");
    eq(s.cur, 4, "streakOf unresolved commits ignored (cur 4 through an open commit)"); }
  { // array order must not matter — streakOf sorts by tCommit
    const s = mkStreak({ commits: [W(5), Lo(4), W(1), W(6), W(3), W(2)] })("@w");
    eq(s.cur, 2, "streakOf sorts by tCommit (shuffled array, same answer)"); }
  { // other wallets' commits excluded
    const other = { wallet: "@x", status: "GRADED", grade: { won: false }, tCommit: 9 };
    const s = mkStreak({ commits: [W(1), W(2), other] })("@w");
    eq(s.cur, 2, "streakOf filters by wallet"); }
}

/* ================= calibrationOf ================= */
const mkCalib = L => build("calibrationOf", calibSrc, ["league", "FO"], "calibrationOf", [L, FO]);
if (calibSrc) {
  // devig is multiplicative (q = p/Σp) so these mkts land on EXACT bucket boundaries:
  const mktQ25 = { home: 1, draw: 1, away: 2 };            // devig home = 0.25 exactly
  const mktQ40 = { home: 2, draw: 1, away: 2 };            // devig home = 0.40 exactly
  const mktQ50 = { home: 1, draw: 0.5, away: 0.5 };        // devig home = 0.50 exactly
  const mktQ45 = { home: 45, draw: 30, away: 25 };         // devig home = 0.45 exactly
  const G = (mkt, won, t) => ({ wallet: "@w", status: "GRADED", pick: "part1", mktAtCommit: mkt, grade: { won }, tCommit: t });

  eq(mkCalib({ commits: [] })("@w").length, 0, "calibrationOf empty -> []");
  { const rows = mkCalib({ commits: [G(mktQ25, true, 1), G(mktQ40, false, 2)] })("@w");
    eq(rows.length, 2, "calibrationOf boundary picks land in 2 distinct buckets");
    eq(rows[0].lo, 0.25, "q exactly 0.25 -> [0.25,0.4) bucket (q >= lo)");
    eq(rows[0].n, 1, "0.25 bucket n=1");
    close(rows[0].impl, 0.25, 1e-12, "0.25 bucket implied = avg q");
    eq(rows[0].act, 1, "0.25 bucket actual = 1/1 win");
    eq(rows[1].lo, 0.4, "q exactly 0.4 -> [0.4,0.6) bucket, not [0.25,0.4)");
    eq(rows[1].act, 0, "0.4 bucket actual = 0/1"); }
  { const rows = mkCalib({ commits: [G(mktQ50, true, 1), G(mktQ45, false, 2)] })("@w");
    eq(rows.length, 1, "two mid picks share the [0.4,0.6) bucket");
    eq(rows[0].n, 2, "shared bucket n=2");
    close(rows[0].impl, 0.475, 1e-12, "implied = mean of de-vigged entry prices (0.475)");
    close(rows[0].act, 0.5, 1e-12, "actual = wins/n (0.5)"); }
  { // BURNED, unresolved, and pickless commits are all excluded
    const burned = { wallet: "@w", status: "BURNED", pick: "part1", mktAtCommit: mktQ50, grade: null };
    const open = { wallet: "@w", status: "REVEALED", pick: "part1", mktAtCommit: mktQ50 };
    const sealed = { wallet: "@w", status: "GRADED", pick: null, mktAtCommit: mktQ50, grade: { won: true } };
    eq(mkCalib({ commits: [burned, open, sealed] })("@w").length, 0,
      "calibrationOf counts only GRADED commits with a known pick"); }
}

/* ================= insightHtml ================= */
if (insightSrc && calibSrc) {
  const league = { commits: [
    { wallet: "@w", status: "GRADED", pick: "part1", mktAtCommit: { home: 1, draw: 1, away: 2 }, grade: { won: true, pnl: 150 }, tCommit: 10 },
    { wallet: "@w", status: "GRADED", pick: "part1", mktAtCommit: { home: 2, draw: 1, away: 2 }, grade: { won: false, pnl: -100 }, tCommit: 20 },
  ] };
  const calib = mkCalib(league);
  const insight = build("insightHtml", insightSrc, ["league", "calibrationOf"], "insightHtml", [league, calib]);
  if (insight) {
    eq(insight("@ghost"), "", "insightHtml no resolved picks -> ''");
    const h = insight("@w");
    ok(h.includes("<polyline"), "insightHtml renders an SVG edge sparkline");
    ok(h.includes("+$50"), "insightHtml cumulative $ = +150 - 100 = +$50");
    ok(h.includes("#c2f04a"), "insightHtml positive cum -> lime stroke");
    ok(h.includes("calrow"), "insightHtml includes calibration rows when buckets exist");
    ok(!/NaN/.test(h), "insightHtml has no NaN coordinates");
  }
}

/* ================= marketVol ================= */
const marketVol = build("marketVol", mktVolSrc, [], "marketVol");
if (marketVol) {
  const Fof = ticks => ({ tape: { ticks } });
  { const ticks = Array.from({ length: 7 }, (_, i) => ({ t: i * 15, home: 0.5, away: 0.3 }));
    eq(marketVol(Fof(ticks), 90), 0, "marketVol flat tape -> 0"); }
  { // alternating ±2pt around the mean @15s -> tick-to-tick deltas of ±4pt -> stddev exactly 4
    const ticks = Array.from({ length: 21 }, (_, i) => ({ t: i * 15, home: i % 2 ? 0.52 : 0.48, away: 0.3 }));
    close(marketVol(Fof(ticks), 300), 4, 1e-9, "marketVol alternating ±2pt @15s -> 4"); }
  { const ticks = [{ t: 0, home: 0.2, away: 0.3 }, { t: 15, home: 0.8, away: 0.1 }, { t: 30, home: 0.2, away: 0.3 }];
    eq(marketVol(Fof(ticks), 30), 0, "marketVol <4 ticks in window -> 0 (even with wild swings)"); }
  { // a violent spike entirely OUTSIDE the 600s window contributes nothing
    const ticks = [
      { t: 0, home: 0.5, away: 0.3 }, { t: 10, home: 0.9, away: 0.05 }, { t: 20, home: 0.5, away: 0.3 },
      ...Array.from({ length: 7 }, (_, i) => ({ t: 1000 + i * 100, home: 0.5, away: 0.3 })),
    ];
    eq(marketVol(Fof(ticks), 1600), 0, "marketVol 600s window excludes an old spike's deltas"); }
  { // playhead t caps the window on the right: ticks after t must not count
    const ticks = [
      ...Array.from({ length: 6 }, (_, i) => ({ t: i * 15, home: 0.5, away: 0.3 })),
      { t: 90, home: 0.95, away: 0.02 },
    ];
    eq(marketVol(Fof(ticks), 75), 0, "marketVol ignores ticks after the playhead"); }
}

/* ================= monSpark ================= */
const monSpark = build("monSpark", monSparkSrc, [], "monSpark");
if (monSpark) {
  const ptsOf = svg => ((svg.match(/points="([^"]+)"/) || [])[1] || "").trim().split(/\s+/).filter(Boolean);
  eq(monSpark([{ t: 0, home: 0.5, away: 0.3 }], "home", 100, "#fff"), "", "monSpark <2 ticks -> ''");
  eq(monSpark([{ t: 0, home: 0.5, away: 0.3 }, { t: 15, home: 0.6, away: 0.2 }], "home", 10, "#fff"), "",
    "monSpark <2 ticks at the playhead -> '' (t filter applies)");
  { const ticks = Array.from({ length: 10 }, (_, i) => ({ t: i * 15, home: 0.4 + i * 0.02, away: 0.3 }));
    const svg = monSpark(ticks, "home", 1000, "#c2f04a");
    ok(svg.startsWith("<svg") && svg.includes("<polyline"), "monSpark home -> SVG polyline");
    ok(svg.includes('stroke="#c2f04a"'), "monSpark uses the given color");
    eq(ptsOf(svg).length, 10, "monSpark 10 ticks -> 10 points (no downsampling needed)");
    ok(!/NaN/.test(svg), "monSpark home has no NaN coords"); }
  { const ticks = Array.from({ length: 10 }, (_, i) => ({ t: i * 15, home: 0.4, away: 0.2 + i * 0.02 }));
    const svg = monSpark(ticks, "away", 1000, "#3b8bf5");
    ok(svg.includes("<polyline") && !/NaN/.test(svg), "monSpark away key works"); }
  { // draw is DERIVED (1 - home - away, floored at 0.02) — including the clamp branch
    const ticks = Array.from({ length: 6 }, (_, i) => ({ t: i * 15, home: 0.6, away: 0.42 }));
    const svg = monSpark(ticks, "draw", 1000, "#8fa3b5");
    ok(svg.includes("<polyline") && !/NaN/.test(svg), "monSpark derived draw (clamped flat) -> valid SVG, no NaN"); }
  { const ticks = Array.from({ length: 500 }, (_, i) => ({ t: i * 15, home: 0.4 + Math.sin(i / 9) * 0.1, away: 0.3 }));
    eq(ptsOf(monSpark(ticks, "home", 1e9, "#fff")).length, 51, "monSpark downsampling caps 500 ticks at 51 points"); }
  { const ticks = Array.from({ length: 150 }, (_, i) => ({ t: i * 15, home: 0.4 + (i % 7) * 0.01, away: 0.3 }));
    eq(ptsOf(monSpark(ticks, "home", 1e9, "#fff")).length, 51, "monSpark 150 ticks -> also 51 points (step + forced last)"); }
}

/* ================= newsDriverFor ================= */
if (newsDrvSrc) {
  const LIVE_ID = 18257865;
  const mkDriver = (liveOn, cache) =>
    build("newsDriverFor", newsDrvSrc, ["liveOn", "LIVE_FIXTURE_ID", "newsCache"], "newsDriverFor", [liveOn, LIVE_ID, cache]);
  const F = { id: LIVE_ID, fx: { Participant1: "France", Participant2: "England", StartTime: "2026-07-18T20:00:00Z" } };
  const kick = Date.parse(F.fx.StartTime);
  const mv = { t: 3600 };                       // move at 60' on the tape
  const wall = kick + mv.t * 1000;              // wall-clock instant of the move
  const hit = { ts: wall - 10 * 60000, title: "France injury blow for star defender", desc: "", source: "BBC Sport", tag: "news", link: "h1" };

  eq(mkDriver(false, [hit])(mv, F), null, "newsDriverFor liveOn=false -> null");
  eq(mkDriver(true, [hit])(mv, { ...F, id: 999 }), null, "newsDriverFor wrong fixture -> null");
  eq(mkDriver(true, [])(mv, F), null, "newsDriverFor empty news cache -> null");
  { const d = mkDriver(true, [hit])(mv, F);
    ok(d && d.title === hit.title, "newsDriverFor team+risk headline in window -> hit");
    if (d) { eq(d.agoMin, 10, "newsDriverFor agoMin = minutes before the move");
             eq(d.source, "BBC Sport", "newsDriverFor carries the source through"); } }
  eq(mkDriver(true, [{ ...hit, ts: wall + 6 * 60000 }])(mv, F), null,
    "newsDriverFor headline >5min AFTER the move -> null");
  ok(mkDriver(true, [{ ...hit, ts: wall + 4 * 60000 }])(mv, F) !== null,
    "newsDriverFor headline 4min after the move is inside the -5min grace window");
  eq(mkDriver(true, [{ ts: wall - 10 * 60000, title: "Stadium roof closed ahead of the big night", desc: "", source: "ESPN", tag: "news" }])(mv, F),
    null, "newsDriverFor no team keyword + no risk term -> null");
  eq(mkDriver(true, [{ ...hit, ts: 0 }])(mv, F), null, "newsDriverFor undated item (ts 0) -> null");
  { // injury/lineup tag boost breaks an otherwise-identical tie
    const a = { ts: wall - 20 * 60000, title: "England press conference penalty update", desc: "", tag: "news", link: "a", source: "X" };
    const b = { ...a, tag: "injury", link: "b" };
    const d = mkDriver(true, [a, b])(mv, F);
    ok(d && d.link === "b", "newsDriverFor injury-tag boost lifts a text-identical item"); }
}

/* ================= punditLine ================= */
const mkPundit = () => build("punditLine", punditSrc, [], "punditLine");
if (punditSrc) {
  const pl = mkPundit();
  if (pl) {
    eq(pl("nope", "FRA"), null, "punditLine unknown kind -> null");
    const a = pl("goal", "FRA"), b = pl("goal", "FRA"), c = pl("goal", "FRA");
    ok(a !== b && b !== c && a !== c, "punditLine rotates: 3 consecutive goal quips all differ");
    eq(pl("goal", "FRA"), a, "punditLine 4th goal call wraps back to the first template");
    ok(a.includes("FRA"), "punditLine injects the team name");
    ok(a.includes("feeditem pundit"), "punditLine wraps output in the feed-item shell");
    ok(pl("settle") !== null, "punditLine settle templates need no team arg");
  }
}

/* ================= liveMergeScore / liveMergeOdds ================= */
const mkLive = () => build("live merge block", liveSrc,
  ["window", "LIVE_FIXTURE_ID", "FIXTURES"],
  "{ liveMergeScore, liveMergeOdds, liveIsConsensus1x2, liveAccum, LIVE_KEEP }",
  [{ TX_TAPES: [] }, 18257865, []]);
if (liveSrc) {
  const lm = mkLive();
  if (lm) {
    // ---- scores: dedup by Seq:Ts:Action, KEEP whitelist ----
    const g = { Seq: 1, Ts: "2026-07-18T20:31:00Z", Action: "goal" };
    eq(lm.liveMergeScore(g), true, "liveMergeScore whitelisted action accepted");
    eq(lm.liveAccum.historical.length, 1, "liveMergeScore pushes accepted event to historical");
    eq(lm.liveMergeScore({ ...g }), false, "liveMergeScore duplicate Seq:Ts:Action -> false");
    eq(lm.liveAccum.historical.length, 1, "liveMergeScore duplicate not pushed twice");
    eq(lm.liveMergeScore({ Seq: 2, Ts: "2026-07-18T20:32:00Z", Action: "possession" }), false,
      "liveMergeScore non-whitelisted action dropped");
    eq(lm.liveAccum.historical.length, 1, "liveMergeScore dropped action never reaches historical");
    eq(lm.liveMergeScore({ Seq: 3, Ts: "2026-07-18T20:33:00Z", Action: "red_card" }), true,
      "liveMergeScore red_card is in the KEEP set");
    eq(lm.liveMergeScore({ Ts: "t9", Action: "corner" }), true, "liveMergeScore missing Seq still accepted (?? '')");
    eq(lm.liveMergeScore({ Ts: "t9", Action: "corner" }), false, "liveMergeScore missing-Seq dedup via Ts:Action");
    ok(lm.LIVE_KEEP.has("game_finalised"), "LIVE_KEEP includes game_finalised (settlement can arrive live)");

    // ---- odds: dedup by MessageId (fallback Ts:SuperOddsType) + consensus filter ----
    const good = { MessageId: "m1", BookmakerId: 10021, MarketPeriod: null, SuperOddsType: "1X2_PARTICIPANT_RESULT",
      PriceNames: ["1", "X", "2"], Pct: [55.1, 25.0, 19.9], Ts: 111 };
    eq(lm.liveMergeOdds(good), true, "liveMergeOdds consensus 1X2 accepted");
    eq(lm.liveAccum.odds.length, 1, "liveMergeOdds accepted odds pushed");
    eq(JSON.stringify(Object.keys(lm.liveAccum.odds[0]).sort()), JSON.stringify(["Pct", "PriceNames", "SuperOddsType", "Ts"]),
      "liveMergeOdds stores only the {Ts,SuperOddsType,PriceNames,Pct} subset");
    eq(lm.liveMergeOdds({ ...good, Pct: [60, 20, 20] }), false, "liveMergeOdds duplicate MessageId -> false even with new prices");
    eq(lm.liveMergeOdds({ ...good, MessageId: "m2", BookmakerId: 9999 }), false,
      "liveMergeOdds non-consensus BookmakerId (not 10021) filtered");
    eq(lm.liveMergeOdds({ ...good, MessageId: "m3", MarketPeriod: 1 }), false,
      "liveMergeOdds period market (MarketPeriod != null) filtered — full-match only");
    eq(lm.liveMergeOdds({ ...good, MessageId: "m4", SuperOddsType: "OVER_UNDER" }), false,
      "liveMergeOdds non-1X2 SuperOddsType filtered");
    eq(lm.liveMergeOdds({ ...good, MessageId: "m5", Pct: ["NA", "NA", "NA"] }), false,
      "liveMergeOdds Pct[0]='NA' filtered");
    eq(lm.liveMergeOdds({ ...good, MessageId: "m6", Pct: undefined }), false,
      "liveMergeOdds missing Pct array filtered");
    eq(lm.liveAccum.odds.length, 1, "liveMergeOdds filtered messages never reach the odds accum");
    { const noId = { BookmakerId: 10021, SuperOddsType: "1X2_PARTICIPANT_RESULT", PriceNames: ["1", "X", "2"], Pct: [50, 27, 23], Ts: 222 };
      eq(lm.liveMergeOdds(noId), true, "liveMergeOdds MarketPeriod undefined passes (== null) + no-MessageId accepted");
      eq(lm.liveMergeOdds({ ...noId, Pct: [51, 26, 23] }), false,
        "liveMergeOdds no-MessageId dedup falls back to Ts:SuperOddsType key"); }
  }
}

/* ================= relay: categorize / titleTokens / dedupe ================= */
const news = build("categorize/titleTokens/dedupe", newsSrc, [], "{ NEWS_TAGS, categorize, titleTokens, dedupe }");
if (news) {
  const cat = it => news.categorize(typeof it === "string" ? { title: it, desc: "" } : it);
  eq(cat("Kane suffers hamstring injury in training").tag, "injury", "categorize injury");
  eq(cat("England team news: three changes expected").tag, "lineup", "categorize lineup (team news)");
  eq(cat("Midfielder suspended after red card").tag, "discipline", "categorize discipline");
  eq(cat("Striker joins United in record fee move").tag, "transfer", "categorize transfer");
  eq(cat("Match report: France beat England 2-0").tag, "match", "categorize match");
  { const c = cat("Fans queue overnight");
    eq(c.tag, "news", "categorize fallthrough -> news");
    eq(c.emoji, "📰", "categorize fallthrough emoji"); }
  eq(cat({ title: "Big update", desc: "captain ruled out for six weeks" }).tag, "injury",
    "categorize scans the description too");

  { const tk = news.titleTokens("Kane & England: RULED out!!");
    eq(tk.size, 3, "titleTokens drops <=3-letter words + punctuation");
    ok(tk.has("ruled") && tk.has("kane") && tk.has("england"), "titleTokens lowercases"); }

  { const items = [
      { title: "England captain Kane ruled out of final", link: "1" },
      { title: "Kane ruled out of England final says boss", link: "2" },     // 4/5 token overlap -> dup
      { title: "Completely different transfer story about Madrid", link: "3" },
    ];
    const kept = news.dedupe(items);
    eq(kept.length, 2, "dedupe collapses >0.6-overlap near-duplicates");
    eq(kept[0].link, "1", "dedupe keeps the FIRST of a duplicate pair");
    eq(kept[1].link, "3", "dedupe keeps distinct stories");
    ok(!("_tk" in kept[0]) && !("_tk" in kept[1]), "dedupe cleans its _tk working field"); }
  { const kept = news.dedupe([{ title: "Alpha beta gamma delta" }, { title: "epsilon zeta theta omega" }]);
    eq(kept.length, 2, "dedupe zero-overlap titles both survive"); }
}

/* ================= relay: parseRss / decodeEntities / tag ================= */
const rss = build("parseRss/decodeEntities/tag", rssSrc, [], "{ decodeEntities, tag, parseRss }");
if (rss) {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item>
      <title><![CDATA[Kane &amp; Bellingham start]]></title>
      <link>https://x</link>
      <pubDate>Fri, 18 Jul 2026 10:00:00 GMT</pubDate>
      <description>Team news</description>
    </item>
    <item><description>headline-less item is skipped</description></item>
    <item>
      <title>Second &lt;b&gt;story&lt;/b&gt;</title>
      <guid>https://y-guid</guid>
    </item>
  </channel></rss>`;
  const items = rss.parseRss(xml, "BBC Sport");
  eq(items.length, 2, "parseRss keeps titled items, skips the title-less one");
  eq(items[0].title, "Kane & Bellingham start", "parseRss decodes CDATA + &amp; in titles");
  eq(items[0].link, "https://x", "parseRss reads <link>");
  eq(items[0].desc, "Team news", "parseRss reads <description>");
  eq(items[0].ts, Date.parse("Fri, 18 Jul 2026 10:00:00 GMT"), "parseRss ts = Date.parse(pubDate)");
  eq(items[0].source, "BBC Sport", "parseRss stamps the source");
  eq(items[1].title, "Second story", "parseRss decodes entities then strips embedded tags");
  eq(items[1].link, "https://y-guid", "parseRss falls back to <guid> when <link> is missing");
  eq(items[1].ts, 0, "parseRss missing pubDate -> ts 0");
  // note: &lt;b&gt; decodes to a literal <b>, which the trailing tag-strip then removes (leaving its spaces)
  eq(rss.decodeEntities("a &lt;b&gt; &quot;c&quot; &#39;d&#x27;"), 'a  "c" \'d\'',
    "decodeEntities handles lt/gt/quot/apos variants (then strips the produced tag)");
  eq(rss.tag("<item><title>T</title></item>", "missing"), "", "tag returns '' for an absent element");
}

/* ================= summary ================= */
console.log(`\ntest-inline: ${passed} passed, ${failed} failed (${passed + failed} assertions)`);
if (missing.length) console.error("could not extract/instantiate: " + missing.join(", ") + " — re-run after the source stabilizes");
process.exit(failed ? 1 : 0);
