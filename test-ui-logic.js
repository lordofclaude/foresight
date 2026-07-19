/* UI-logic tests — pure functions extracted from index.html's inline script.
   No copies: the exact shipped source of each pure function is sliced out of
   index.html and evaluated, so a regression in the page fails here too.
   Run: node test-ui-logic.js  (separate from the core suite in test.js) */
const fs = require("fs");
const path = require("path");
global.LiveState = require("./shared/live-state");
global.fixtureFinalized = F => !!(F && F.tape.events.some(e => e.type === "game_finalised"));

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

// pull a top-level `function name(...) { ... }` out of the inline script by
// brace-matching from its declaration (the pure fns are dependency-free).
function extractFn(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in index.html`);
  let i = html.indexOf("{", start), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) break;
  }
  const src = html.slice(start, i + 1);
  return new Function(`return (${src})`)();
}

let passed = 0, failed = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); }
}
function close(name, got, want, eps = 1e-9) {
  const ok = Math.abs(got - want) <= eps;
  if (ok) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}  got ${got} want ${want}`); }
}

/* ---------- chartYRange: the away-line clipping fix ---------- */
const chartYRange = extractFn("chartYRange");

// home-only range would be [.55,.60]; away dips to .20 — must be included
let r = chartYRange([
  { t: 0, home: 0.60, away: 0.20 },
  { t: 60, home: 0.55, away: 0.25 },
]);
close("yLo spans away minimum (the clip bug)", r.yLo, 0.20 - 0.05);
close("yHi spans home maximum", r.yHi, 0.60 + 0.05);

// away ABOVE home (underdog tape flipped) — top of range must follow away
r = chartYRange([
  { t: 0, home: 0.25, away: 0.65 },
  { t: 60, home: 0.30, away: 0.70 },
]);
close("yHi spans away maximum", r.yHi, 0.70 + 0.05);
close("yLo spans home minimum", r.yLo, 0.25 - 0.05);

// single tick — degenerate but valid
r = chartYRange([{ t: 0, home: 0.5, away: 0.3 }]);
close("single tick lo", r.yLo, 0.25);
close("single tick hi", r.yHi, 0.55);

// empty tape — guard defaults, never an inverted axis
r = chartYRange([]);
close("empty tape guard lo", r.yLo, 0.15);
close("empty tape guard hi", r.yHi, 0.85);
eq("empty tape guard never inverted", r.yLo < r.yHi, true);

// range is never inverted for any sane input
r = chartYRange([{ t: 0, home: 0.5, away: 0.5 }]);
eq("flat tape still ordered", r.yLo < r.yHi, true);

/* ---------- market divergence: same-outcome source comparison ---------- */
const marketDivergence = extractFn("marketDivergence");
let divergence = marketDivergence(
  { home: 0.44, draw: 0.31, away: 0.25 },
  { home: 0.40, draw: 0.33, away: 0.27 },
);
close("home divergence is TxLINE minus Polymarket", divergence[0].delta, 0.04);
close("draw divergence preserves negative sign", divergence[1].delta, -0.02);
eq("missing external quote stays unavailable", marketDivergence({ home: 0.4 }, { home: null })[0].delta, null);

/* ---------- timeline: rich events are included and transport duplicates collapse ---------- */
global.TIMELINE_META = { goal: {}, shot: {}, corner: {}, card: {}, freekick: {} };
const timelineEvents = extractFn("timelineEvents");
let timeline = timelineEvents([
  { type: "shot", team: 1, minute: 4, t: 240, seq: 1, detail: "" },
  { type: "shot", team: 1, minute: 4, t: 241, seq: 2, detail: "On target" },
  { type: "corner", team: 2, minute: 7, t: 420, seq: 3 },
  { type: "goal", team: 1, minute: 9, t: 540, seq: 4, stats: { g1: 1, g2: 0 } },
  { type: "unknown", team: 1, minute: 10, t: 600, seq: 5 },
], 500);
eq("timeline includes shots and corners before playhead", timeline.map(event => event.type), ["corner", "shot"]);
eq("timeline keeps the richer duplicate detail", timeline[1].detail, "On target");

/* ---------- liveFixturePick: which fixture GO LIVE targets ---------- */
const liveFixturePick = extractFn("liveFixturePick");
const KICK = 1784487600000;                    // FINAL kickoff 2026-07-19T19:00:00Z
eq("?fixture=18257739 forces the final", liveFixturePick("18257739", 0), 18257739);
eq("?fixture=18257865 forces France-England", liveFixturePick("18257865", KICK + 1), 18257865);
eq("no param, night before -> France-England", liveFixturePick(null, KICK - 3 * 3600e3), 18257865);
eq("no param, exactly kickoff-2h -> the final", liveFixturePick(null, KICK - 2 * 3600e3), 18257739);
eq("no param, during the final -> the final", liveFixturePick(null, KICK + 3600e3), 18257739);
eq("unknown fixture id falls back to the time rule", liveFixturePick("999", KICK - 3 * 3600e3), 18257865);

/* ---------- wallet signing: historical captures are practice-only ---------- */
const walletCommitEligible = extractFn("walletCommitEligible");
const fixture = (start, finalised = false) => ({ fx: { StartTime: start }, tape: { events: finalised ? [{ type: "game_finalised" }] : [] } });
eq("completed historical fixture is never wallet-eligible", walletCommitEligible(fixture(KICK - 86400e3, true), KICK, true), false);
eq("incomplete past capture is practice without verified live state", walletCommitEligible(fixture(KICK - 86400e3), KICK, false), false);
eq("future fixture is pre-kickoff wallet-eligible", walletCommitEligible(fixture(KICK + 3600e3), KICK, false), true);
eq("active verified-live fixture is wallet-eligible", walletCommitEligible(fixture(KICK - 3600e3), KICK, true), true);

/* ---------- relay allowlist ---------- */
const safeRelayBase = extractFn("safeRelayBase");
eq("deployed relay is allowed", safeRelayBase("https://foresight-relay.lordofclaude.workers.dev/"), "https://foresight-relay.lordofclaude.workers.dev");
eq("localhost relay is allowed", safeRelayBase("http://127.0.0.1:8799/"), "http://127.0.0.1:8799");
let blockedRelay = false;
try { safeRelayBase("https://evil.example/?x=<img>"); } catch (e) { blockedRelay = true; }
eq("untrusted relay host/query is blocked", blockedRelay, true);

/* ---------- static invariants of the fixed behaviors ----------
   Not pure functions, so assert their load-bearing source survives edits. */
function has(name, re) {
  if (re.test(html)) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name} — pattern gone: ${re}`); }
}
function lacks(name, re) {
  if (!re.test(html)) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name} — forbidden pattern present: ${re}`); }
}
has("sizeCanvas uses chartYRange (not home-only)", /chartYRange\(FIXTURES\[sel\]\.tape\.ticks\)/);
has("live pin respects browse flag", /liveOn && !liveBrowse\) \{ sel = FIXTURES\.indexOf\(F\)/);
has("selectFixture sets browse flag", /if \(liveOn\) liveBrowse = FIXTURES\[i\]\.id !== LIVE_FIXTURE_ID/);
has("monitor throttled to 1/sec", /now - monLast < 1000/);
has("monitor forced on fixture switch", /monLast = 0;/);
has("gate honors prefers-reduced-motion", /matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
has("tape crosshair bound to pointer events", /addEventListener\("pointermove", xhairPtr\)/);
has("guided demo autoplay is explicit and can be disabled", /demoAutoplay = demoMode && qs\.get\("autoplay"\) !== "0"[\s\S]*if \(demoAutoplay\) \{ \$\('speed'\)\.value = "30"; startReplay\(\); \}/);
has("replay speed is a true wall-clock multiplier", /simT = Math\.min\(GLOBAL_END, simT \+ speed \* \(frameMs \/ 1000\)\)/);
has("empty live bundle created from registry meta", /TX_TAPES\.push\(\{ fixture: meta, historical: \[\], odds: \[\] \}\)/);
has("live status names the fixture", /`LIVE · \$\{liveName\(\)\} · last accepted frame/);
has("only accepted score frames count as live evidence", /if \(liveOn && !liveStat\.endedAt && d && typeof d === "object" && liveMergeScore\(d\)\) \{ noteLiveFrame\("scores"\)/);
has("only accepted odds frames count as live evidence", /if \(liveOn && !liveStat\.endedAt && d && typeof d === "object" && liveMergeOdds\(d\)\) \{ noteLiveFrame\("odds"\)/);
has("both live streams report transport state", /onStatus: s => noteLiveStreamStatus\("scores", s\)[\s\S]*onStatus: s => noteLiveStreamStatus\("odds", s\)/);
has("stopping live clears a queued rebuild", /clearTimeout\(liveRebuildTimer\)/);
has("Clerk pk passed via script attribute", /data-clerk-publishable-key/);
has("Clerk prefers the self-initialized instance", /window\.Clerk\.load \? window\.Clerk : new window\.Clerk\(CLERK_PK\)/);
has("streak badge uses best streak", /s\.best >= 2 \? ` <span class="g" title="best win streak/);
has("RE-RUN gates exempt live fixtures", /every\(F => F\.settled \|\| F\.liveMatch\)/);
has("anchor hero is the pre-kickoff FINAL proof", /ANCHOR_PROOF_FINAL/);
has("old anchor honestly labeled post-match", /Anchored <b>post-match<\/b>/);
has("anchor recompute is scoped to the bundled artifact", /recompute the bundled proof hash[\s\S]*MATCHES the bundled artifact hash/);
has("anchor wallet copy preserves fixture eligibility", /eligible pre-kickoff or fresh verified-live fixture[\s\S]*Completed historical replays always stay practice-local/);
has("newsDriver requires a team keyword", /if \(!teamHit\) continue;/);
has("newsDriver recency bonus capped at 1", /Math\.min\(1, Math\.max\(0, 1 - dt \/ \(45 \* 60000\)\)\)/);
has("Polymarket comparison aligns by replay quote timestamp", /params\.set\("atMs"[\s\S]*api\/polymarket\?\$\{params\}/);
has("Polymarket rows require the current replay-time bucket", /marketCompareState\.key === target\.key \? marketCompareState\.data : null/);
has("market comparison stays read only", /Polymarket public API · read only/);
has("news context loads for the selected fixture", /fetchNewsOnce\(F\)/);
has("X widget is lazy-loaded from the official host", /script\.src = "https:\/\/platform\.x\.com\/widgets\.js"/);
has("timeline exposes shots corners and set pieces", /shot: \{ icon:[\s\S]*corner: \{ icon:[\s\S]*freekick: \{ icon:/);
has("marketVol deltas stay intra-window", /if \(ticks\[lo\]\.t < t - 600\) lo\+\+;/);
has("demo mode skips gate", /const skip = demoMode \|\| qs\.get\("nogate"\)/);
has("boot restores identity before optional guided autoplay", /restoreClerkSession\(\);[\s\S]*if \(demoAutoplay\)/);
has("guided demo offers an honest local wallet fallback", /if \(demoMode\) \{[\s\S]*DEMO WALLET · LOCAL[\s\S]*no extension, signature, funds, or on-chain transaction/);
has("guided demo focuses existing surfaces", /data-focus="pickrow"[\s\S]*data-focus="run"[\s\S]*data-focus="forgeBtn"[\s\S]*data-focus="anchorCard"/);
has("prediction choices use native keyboard-accessible buttons", /<button type="button" class="pick" data-pick="part1" aria-pressed="false">[\s\S]*<button type="button" class="pick" data-pick="draw" aria-pressed="false">[\s\S]*<button type="button" class="pick" data-pick="part2" aria-pressed="false">/);
has("prediction choice state is exposed to assistive technology", /p\.setAttribute\('aria-pressed', String\(selected\)\)/);
has("prediction choices have a visible keyboard focus state", /\.pick:focus-visible\{outline:2px solid var\(--cyan\)/);
lacks("known-missing final tape is not requested", /src="real-data\/18257739\.tape\.js"/);
has("relay input assigned through DOM property", /\$\('relayUrl'\)\.value = RELAY_BASE/);
has("relay URL is allowlisted", /throw new Error\("relay URL is not allowlisted"\)/);
lacks("Clerk query override removed", /qs\.get\("clerk_pk"\)/);
has("Clerk loads from fixed trusted CDN", /s\.src = "https:\/\/cdn\.jsdelivr\.net\/npm\/@clerk\/clerk-js@5\/dist\/clerk\.browser\.js"/);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
