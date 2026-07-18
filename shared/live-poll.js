#!/usr/bin/env node
/* live-poll.js — turns an IN-PROGRESS (or not-yet-started) match into a
   continuously-refreshing local tape, reusing the exact same tested
   TxReal.buildTape() transform every replay tape already goes through.

   Why polling instead of a browser SSE mode: `scores/historical` (what every
   replay tape is built from) only unlocks 6h AFTER a match starts — useless
   for watching one live tonight. The LIVE-appropriate endpoints are
   `scores/updates/{fixtureId}` and `odds/updates/{fixtureId}` (current 5-min
   cache, work pre-kickoff and in-play). This script polls both every N
   seconds, accumulates NEW events (deduped by Seq / MessageId — the same
   fields real seq-ordering already relies on elsewhere), and rewrites
   real-data/<id>.tape.js + .surface.js each cycle via build-real-tapes.js's
   own logic path (TxReal.buildTape + the same odds-family filtering).

   This means: no new browser code, no live SSE credentials shipped to a
   public page (this runs locally, holds the token in Node only), and the
   app's ENTIRE tested replay-rendering pipeline (radar, tape, portfolio,
   feed, agents) works on the live match with ZERO changes — just point
   index.html's tape <script> tags at the fixture ID once it's pulled.

   Usage: node live-poll.js <fixtureId> [--interval 15] [--out real-data]
   Ctrl+C to stop; safe to re-run (resumes from the existing tape.js if present).
*/
"use strict";
const fs = require("fs"), path = require("path");
const TxReal = require("./txline-real.js");

const argv = process.argv.slice(2);
const fixtureId = Number(argv.find(a => /^\d+$/.test(a)) || 18257865);
const intervalArg = argv.indexOf("--interval");
const intervalSec = intervalArg >= 0 ? Number(argv[intervalArg + 1]) : 15;
const outArg = argv.indexOf("--out");
const OUT = path.join(__dirname, outArg >= 0 ? argv[outArg + 1] : "real-data");
fs.mkdirSync(OUT, { recursive: true });
const tapeFile = path.join(OUT, fixtureId + ".tape.js");
const stateFile = path.join(OUT, fixtureId + ".live-state.json"); // raw accumulator (gitignored, not the compact tape)

function loadState() {
  if (fs.existsSync(stateFile)) { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch (e) { /* fall through */ } }
  return { fixture: null, historical: [], odds: [], seenSeq: {}, seenOdds: {} };
}
function saveState(st) { fs.writeFileSync(stateFile, JSON.stringify(st)); }

async function fetchFixtureMeta() {
  const day = Math.floor(Date.now() / 86400000);
  for (const d of [day, day - 1, day + 1]) {
    const list = await TxReal.fetchFixtures({ startEpochDay: d, competitionId: 72 }).catch(() => []);
    const hit = (list || []).find(f => f.FixtureId === fixtureId);
    if (hit) return hit;
  }
  return null;
}

// scores/updates returns SSE-framed text (same quirk as scores/historical —
// see fetchHistorical's comment in txline-real.js); odds/updates is plain JSON.
async function fetchLiveScores() {
  const c = require("./.txline.json");
  const url = "https://txline-dev.txodds.com/api/scores/updates/" + fixtureId;
  const res = await fetch(url, { headers: { Authorization: "Bearer " + c.jwt, "X-Api-Token": c.apiToken, Accept: "text/event-stream" } });
  if (!res.ok) throw new Error("scores/updates " + res.status);
  const body = await res.text();
  const events = [];
  if (body.charAt(0) === "[") { try { events.push(...JSON.parse(body)); } catch (e) { /* ignore */ } }
  else TxReal.parseSSEChunk(body + "\n\n", m => { if (m.data && typeof m.data === "object") events.push(m.data); });
  return events;
}

function mergeNew(st, scoreEvents, oddsPayloads) {
  let newScores = 0, newOdds = 0;
  for (const e of scoreEvents) {
    const key = (e.Seq != null ? e.Seq : "") + ":" + (e.Ts || "") + ":" + (e.Action || "");
    if (st.seenSeq[key]) continue;
    st.seenSeq[key] = true; st.historical.push(e); newScores++;
  }
  for (const o of oddsPayloads) {
    const key = o.MessageId || (o.Ts + ":" + o.SuperOddsType + ":" + o.MarketParameters);
    if (st.seenOdds[key]) continue;
    st.seenOdds[key] = true; st.odds.push(o); newOdds++;
  }
  return { newScores, newOdds };
}

// Same compaction build-real-tapes.js applies: full-match StablePrice consensus
// only (BookmakerId 10021, MarketPeriod null) — the fix from the ARG-SWI tape
// oscillation bug earlier this project, applied here from day one.
function writeTape(st) {
  const KEEP = new Set(["goal", "yellow_card", "red_card", "corner", "shot", "free_kick",
    "penalty", "penalty_outcome", "var", "var_end", "substitution", "kickoff",
    "halftime_finalised", "game_finalised", "additional_time", "action_amend", "suspend"]);
  const events = st.historical.filter(e => KEEP.has(e.Action));
  const isConsensus = o => o.BookmakerId === 10021 && o.MarketPeriod == null;
  const oneX2 = st.odds
    .filter(o => o.SuperOddsType === "1X2_PARTICIPANT_RESULT" && isConsensus(o) && Array.isArray(o.Pct) && o.Pct[0] !== "NA" && o.Pct[0] != null)
    .map(o => ({ Ts: o.Ts, SuperOddsType: o.SuperOddsType, PriceNames: o.PriceNames, Pct: o.Pct }))
    .sort((a, b) => a.Ts - b.Ts);
  const odds = []; let lastTs = -1e15;
  for (const o of oneX2) if (o.Ts - lastTs >= 8000) { odds.push(o); lastTs = o.Ts; }
  const bundle = { fixture: st.fixture || { FixtureId: fixtureId }, historical: events, odds };
  fs.writeFileSync(tapeFile, "window.TXLINE_TAPE = " + JSON.stringify(bundle) + ";\n");
  return { events: events.length, odds: odds.length, totalScoreRaw: st.historical.length, totalOddsRaw: st.odds.length };
}

async function tick(st) {
  if (!st.fixture) { st.fixture = await fetchFixtureMeta(); if (st.fixture) console.log("fixture:", st.fixture.Participant1, "v", st.fixture.Participant2, "kickoff", new Date(st.fixture.StartTime).toISOString()); }
  const [scoreEvents, oddsPayloads] = await Promise.all([
    fetchLiveScores().catch(e => { console.warn("scores/updates error:", e.message); return []; }),
    TxReal.oddsUpdates(fixtureId).catch(e => { console.warn("odds/updates error:", e.message); return []; }),
  ]);
  const { newScores, newOdds } = mergeNew(st, scoreEvents, Array.isArray(oddsPayloads) ? oddsPayloads : []);
  saveState(st);
  const written = writeTape(st);
  const now = new Date().toISOString().slice(11, 19);
  console.log(`[${now}] +${newScores} score / +${newOdds} odds this poll  |  tape now: ${written.events} events, ${written.odds} odds pts (raw accum ${written.totalScoreRaw}/${written.totalOddsRaw})`);
}

async function main() {
  console.log(`live-poll: fixture ${fixtureId}, every ${intervalSec}s -> ${tapeFile}`);
  console.log(`(reminder: /api/scores/updates + /api/odds/updates only return each match's CURRENT 5-min window —`);
  console.log(` this script must stay running to accumulate history; stopping and restarting loses the gap in between)`);
  let st = loadState();
  await tick(st);
  setInterval(() => tick(st).catch(e => console.error("tick failed:", e.message)), intervalSec * 1000);
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
