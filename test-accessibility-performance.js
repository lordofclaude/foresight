"use strict";

const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const worldStageDir = path.join(__dirname, "assets", "world-cup");
let passed = 0, failed = 0;

function check(name, ok) {
  if (ok) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}`); }
}

function has(name, re) {
  if (re.test(html)) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}`); }
}
function lacks(name, re) {
  if (!re.test(html)) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}`); }
}

has("global focus indicator", /:where\(a,button,input,select,textarea,summary,\[tabindex\]\):focus-visible/);
has("radar tiles are native buttons", /<button type="button" class="tile/);
has("leaderboard rows are native buttons", /<button type="button" class="prophet/);
has("filters expose pressed state", /id="bfilter" role="group"[\s\S]*aria-pressed="true"/);
has("info disclosure exposes expanded state", /class="infotoggle" aria-expanded="false" aria-controls="commitInfo"/);
has("market table has caption and scoped headers", /<table class="mkt"><caption>[\s\S]*<th scope="col">match/);
has("market selection has a keyboard button", /class="mkt-select" aria-pressed=/);
has("canvas chart has a text alternative", /id="chartSummaryText"[\s\S]*<canvas id="cv"[^>]*aria-hidden="true"/);
has("risk meter exposes value", /id="riskMeter" role="progressbar"[\s\S]*aria-valuenow="0"/);
has("status announcements are deduplicated", /const announcementKeys = new Map\(\)[\s\S]*announcementKeys\.get\(channel\) === key/);
lacks("fast-changing live text avoids aria-live", /id="liveStatus"[^>]*(role="status"|aria-live=)/);
lacks("rendered mode banner avoids aria-live", /id="modeBanner"[^>]*(role="status"|aria-live=)/);
has("modal manages focus and aria visibility", /function openModal\(\)[\s\S]*aria-hidden', 'false'[\s\S]*function closeModal\(\)[\s\S]*modalReturnFocus\.focus/);
has("modal traps tab and supports escape", /if \(e\.key === 'Escape'\)[\s\S]*if \(e\.key !== 'Tab'\)/);
has("reduced motion has discrete replay budget", /reducedMotionReplayHz: 2[\s\S]*PREFERS_REDUCED_MOTION \? 1000 \/ PERF_BUDGET\.reducedMotionReplayHz/);
has("normal replay render budget is 10Hz", /replayRenderHz: 10[\s\S]*1000 \/ PERF_BUDGET\.replayRenderHz/);
lacks("replay uses the former 20Hz interval", /setInterval\([\s\S]{0,220}, 50\)/);
has("guided autoplay is opt-out and fixed at 30x", /demoAutoplay = demoMode && qs\.get\("autoplay"\) !== "0"[\s\S]*\$\('speed'\)\.value = "30"/);
lacks("media autoplays", /<(audio|video)[^>]*\bautoplay\b/i);
has("font stylesheet is nonblocking", /rel="preload" as="style"[\s\S]*onload="this\.onload=null;this\.rel='stylesheet'"/);
has("optional wallet CDN has failure fallback", /defer src="https:\/\/unpkg\.com\/@solana\/web3\.js[\s\S]*SOLANA_WEB3_LOAD_FAILED/);
has("flag images are lazy and fail locally", /loading="lazy" decoding="async"[\s\S]*onerror="this\.hidden=true;this\.nextElementSibling\.hidden=false"/);
has("market table owns horizontal overflow", /\.mkt-scroll\{[^}]*overflow-x:auto/);
has("390px controls reflow", /@media\(max-width:430px\)\{\.pickrow\{grid-template-columns:1fr\}/);
has("detail pages expose native open and back controls", /id="detailBack"[\s\S]*id="portfolioOpen"[\s\S]*id="newsOpen"[\s\S]*id="leaderboardOpen"/);
has("portfolio summary chart supports keyboard activation", /id="pfSpark" role="button" tabindex="0"[\s\S]*event\.key === "Enter" \|\| event\.key === " "/);
has("mobile detail pages collapse KPI and news grids", /@media\(max-width:820px\)[^{]*\{[\s\S]*\.detail-kpis\{grid-template-columns:1fr 1fr\}[\s\S]*\.detail-news-layout\{grid-template-columns:1fr\}/);
has("landing page is a labeled modal surface", /id="gate" role="dialog" aria-modal="true" aria-labelledby="gateTitle" aria-describedby="gateSub"/);
has("landing page makes the workspace inert until entry", /function setGateOpen\(open\)[\s\S]*element\.inert = open/);
has("normal visits are not permanently skipped by local storage", /const skip = demoMode \|\| qs\.get\("nogate"\) === "1";/);
has("landing page states the centralized match intelligence value", /Live odds, market divergence, news, key match events and the moves of top traders/);
has("trend chart switcher uses an accessible tablist", /id="tapeSwitcher" role="tablist" aria-label="Match trend chart"[\s\S]*role="tab" class="on" aria-selected="true"/);
has("trend tabs support arrow-key navigation", /event\.key !== "ArrowRight" && event\.key !== "ArrowLeft"[\s\S]*setTapeView\(buttons\[next\]\.dataset\.tapeView, true\)/);
lacks("fast-changing trend readout avoids live announcements", /id="trendReadout"[^>]*aria-live=/);
has("hydrated DOM budget is published", /hydratedDomElements: 1000/);
const worldStageImages = fs.readdirSync(worldStageDir).filter(file => file.endsWith(".webp"));
const worldStageBytes = worldStageImages.reduce((sum, file) => sum + fs.statSync(path.join(worldStageDir, file)).size, 0);
check("ten world-stage WebP assets exist", worldStageImages.length === 10);
check("world-stage image set stays under 2 MB", worldStageBytes < 2 * 1024 * 1024);
check("main dashboard does not load the decorative image carousel", !/<img[^>]+assets\/world-cup\//.test(html));
has("stadium imagery frames the landing and match hero", /#gate::before\{[^}]*stadium-night-panorama\.webp[\s\S]*\.hero\{background-image:[^}]*stadium-night-panorama\.webp/);
has("reduced-data mode removes decorative imagery and blur", /@media\(prefers-reduced-data:reduce\)\{#gate::before,\.hero\{background-image:none\}\.gate-visual\{backdrop-filter:none\}\}/);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
