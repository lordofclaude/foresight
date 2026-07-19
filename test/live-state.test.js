"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const LiveState = require("../shared/live-state");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (error) { console.error("  ✗ " + name); throw error; }
}

const kickoff = 1_784_408_400_000;
const now = kickoff + 60 * 60000;
const fixture = { FixtureId: 18257865, StartTime: kickoff };

test("CONNECTING requires an active session with no accepted frame", () => {
  assert.equal(LiveState.derive({ active: true, streams: { scores: "open", odds: "open" } }, now).state, "CONNECTING");
});

test("the first accepted frame transitions to LIVE", () => {
  const stat = { active: true, firstFrameAt: now - 1000, lastFrameAt: now - 1000, streams: { scores: "open", odds: "open" } };
  assert.equal(LiveState.derive(stat, now).state, "LIVE");
});

test("clean reconnect preserves fresh evidence while age demotes it to STALE", () => {
  const reconnecting = { active: true, firstFrameAt: now - 1000, lastFrameAt: now - 1000, streams: { scores: "reconnecting", odds: "open" } };
  const aged = { active: true, firstFrameAt: now - 100000, lastFrameAt: now - 91000, streams: { scores: "open", odds: "open" } };
  assert.equal(LiveState.derive(reconnecting, now).state, "LIVE");
  assert.equal(LiveState.derive(reconnecting, now).reconnecting, true);
  assert.equal(LiveState.derive(aged, now).state, "STALE");
});

test("ERROR and ENDED are explicit and ENDED is terminal", () => {
  const error = { active: true, streams: { scores: "error", odds: "open" } };
  const ended = { active: false, endedAt: now, streams: { scores: "error", odds: "open" } };
  assert.equal(LiveState.derive(error, now).state, "ERROR");
  assert.equal(LiveState.derive(ended, now).state, "ENDED");
});

test("verified live requires the target fixture, event window, and fresh odds evidence", () => {
  const stat = { active: true, firstFrameAt: now - 1000, lastFrameAt: now - 1000, lastOddsFrameAt: now - 1000, streams: { scores: "open", odds: "open" } };
  assert.equal(LiveState.verifiedLive({ fixture, targetId: fixture.FixtureId, finalized: false, stat, now }), true);
  assert.equal(LiveState.verifiedLive({ fixture, targetId: 1, finalized: false, stat, now }), false);
  assert.equal(LiveState.verifiedLive({ fixture, targetId: fixture.FixtureId, finalized: true, stat, now }), false);
  assert.equal(LiveState.verifiedLive({ fixture, targetId: fixture.FixtureId, finalized: false, stat: { ...stat, lastOddsFrameAt: now - 91000 }, now }), false);
  assert.equal(LiveState.verifiedLive({ fixture, targetId: fixture.FixtureId, finalized: false, stat, now: kickoff + 4 * 3600000 }), false);
});

test("the exact live edge is selectable only while verified live", () => {
  assert.equal(LiveState.canPickAtPlayhead({ finalized: false, verifiedLive: true, simT: 4200, endT: 4200 }), true);
  assert.equal(LiveState.canPickAtPlayhead({ finalized: false, verifiedLive: false, simT: 4200, endT: 4200 }), false);
  assert.equal(LiveState.canPickAtPlayhead({ finalized: true, verifiedLive: true, simT: 4200, endT: 4200 }), false);
  assert.equal(LiveState.canPickAtPlayhead({ finalized: true, verifiedLive: false, simT: 4199, endT: 4200 }), true);
  assert.equal(LiveState.canPickAtPlayhead({ finalized: false, verifiedLive: false, simT: 4199, endT: 4200 }), true);
});

test("wallet mode permits future or verified fixtures, never finalized or captured-at-edge", () => {
  assert.equal(LiveState.walletEligible({ fixture, finalized: false, verifiedLive: false, now: kickoff - 60000 }), true);
  assert.equal(LiveState.walletEligible({ fixture, finalized: false, verifiedLive: true, now }), true);
  assert.equal(LiveState.walletEligible({ fixture, finalized: true, verifiedLive: true, now }), false);
  assert.equal(LiveState.walletEligible({ fixture, finalized: false, verifiedLive: false, now }), false);
});

test("index wires the policy into both choice and final commit guards", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(html, /function canPickNow\(F/);
  assert.match(html, /if \(!canPickNow\(F\)\)/);
  assert.match(html, /if \(!selPick \|\| !canPickNow\(F\)\)/);
  assert.match(html, /CAPTURED TAPE · incomplete, not live/);
});

console.log(`\nlive-state: ${passed}/8 passed`);
