"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Poll = require("../shared/live-poll");

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("  ✓ " + name); }
  catch (error) { console.error("  ✗ " + name); throw error; }
}
function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foresight-capture-"));
  fs.mkdirSync(path.join(root, "real-data"), { recursive: true });
  fs.mkdirSync(path.join(root, "shared"), { recursive: true });
  return root;
}
function args(extra = {}) {
  return { fixtureId: 18257865, intervalSec: 5, out: null, config: null, write: true, confirmed: true, once: true, help: false, ...extra };
}
function settings(root, env = {}) {
  return Poll.buildSettings(args(), { repoRoot: root, env: { TXLINE_JWT: "jwt-super-secret", TXLINE_API_TOKEN: "token-super-secret", ...env } });
}
function response(value, kind = "json") {
  return { ok: true, status: 200, json: async () => value, text: async () => kind === "text" ? value : JSON.stringify(value) };
}
function mockFetch(final = false) {
  const kickoff = { FixtureId: 18257865, Seq: 1, Ts: 1784408400000, Action: "kickoff" };
  const finished = { FixtureId: 18257865, Seq: 2, Ts: 1784414400000, Action: "game_finalised", Stats: { 1001: 1, 1002: 0, 3001: 0, 3002: 0 } };
  const scores = [kickoff].concat(final ? [finished] : []).map((event, i) => `id: s${i}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const odds = [{ FixtureId: 18257865, MessageId: "o1", Ts: 1784408300000, BookmakerId: 10021, MarketPeriod: null, SuperOddsType: "1X2_PARTICIPANT_RESULT", PriceNames: ["part1", "draw", "part2"], Pct: ["40", "30", "30"] }];
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.Authorization, "Bearer jwt-super-secret");
    assert.equal(options.headers["X-Api-Token"], "token-super-secret");
    if (url.includes("/fixtures/snapshot")) return response([{ FixtureId: 18257865, Participant1: "France", Participant2: "England", StartTime: 1784408400000 }]);
    if (url.includes("/scores/updates/")) return response(scores, "text");
    if (url.includes("/odds/updates/")) return response(odds);
    throw new Error("unexpected mock URL");
  };
  return { fetch, calls };
}

(async () => {
  await test("CLI is dry-run by default and write mode needs explicit confirmation", () => {
    const parsed = Poll.parseArgs(["--fixture", "18257865"]);
    assert.equal(parsed.write, false);
    assert.throws(() => Poll.parseArgs(["--fixture", "18257865", "--write"]), /requires --yes-i-understand/);
    assert.equal(Poll.parseArgs(["18257865", "--write", Poll.WRITE_CONFIRMATION]).write, true);
  });

  await test("default CLI performs no network and writes no files", () => {
    const script = path.join(__dirname, "..", "shared", "live-poll.js");
    const run = spawnSync(process.execPath, [script, "--fixture", "18257865"], { encoding: "utf8", env: {} });
    assert.equal(run.status, 0, run.stderr);
    const plan = JSON.parse(run.stdout);
    assert.equal(plan.mode, "dry-run");
    assert.equal(plan.networkRequests, 0);
    assert.equal(plan.filesWritten, 0);
  });

  await test("output and fixture allowlists reject unsafe targets", () => {
    const root = tempRepo();
    assert.throws(() => Poll.resolveOutputDir(path.join(root, "..", "escape"), root), /inside repository real-data/);
    assert.equal(Poll.resolveOutputDir("real-data/captures", root), path.join(root, "real-data", "captures"));
    assert.throws(() => Poll.buildSettings(args({ fixtureId: 999 }), { repoRoot: root, env: { TXLINE_JWT: "x", TXLINE_API_TOKEN: "y" } }), /not in the capture allowlist/);
  });

  await test("only explicit private or ignored config paths may contain credentials", () => {
    const root = tempRepo();
    const ignored = path.join(root, ".txline.json");
    const unsafe = path.join(root, "capture.json");
    fs.writeFileSync(ignored, JSON.stringify({ jwt: "j", apiToken: "t", allowedFixtureIds: [18257865] }));
    fs.writeFileSync(unsafe, JSON.stringify({ jwt: "j", apiToken: "t" }));
    assert.equal(Poll.resolveConfigPath(ignored, root), ignored);
    assert.throws(() => Poll.resolveConfigPath(unsafe, root), /gitignored/);
    const built = Poll.buildSettings(args({ config: ignored }), { repoRoot: root, env: {} });
    assert.equal(built.authSource, "explicit-private-config");
  });

  await test("mocked SSE capture writes incomplete tape, manifest, state and recovery backup", async () => {
    const root = tempRepo(), config = settings(root), paths = Poll.capturePaths(config);
    fs.writeFileSync(paths.tape, "original tape\n");
    const mock = mockFetch(false);
    const result = await Poll.captureOnce(config, { fetch: mock.fetch, now: () => 1784409000000 });
    assert.equal(result.status, "incomplete");
    assert.equal(result.manifest.status, "incomplete");
    assert.equal(result.manifest.counts.newScores, 1);
    assert.equal(result.manifest.counts.newOdds, 1);
    assert.match(fs.readFileSync(paths.tape, "utf8"), /FORESIGHT_CAPTURE status=incomplete/);
    assert.equal(fs.readFileSync(paths.tape + ".bak", "utf8"), "original tape\n");
    assert.equal(result.manifest.source.authentication, "environment");
    assert.equal(mock.calls.length, 3);
    const written = [paths.tape, paths.state, paths.manifest].map(file => fs.readFileSync(file, "utf8")).join("\n");
    assert.equal(written.includes("jwt-super-secret"), false);
    assert.equal(written.includes("token-super-secret"), false);
  });

  await test("resume is idempotent for repeated score and odds windows", async () => {
    const root = tempRepo(), config = settings(root), mock = mockFetch(false);
    const first = await Poll.captureOnce(config, { fetch: mock.fetch, now: () => 1784409000000 });
    const second = await Poll.captureOnce(config, { fetch: mock.fetch, now: () => 1784409060000 });
    assert.equal(first.manifest.counts.scoreRaw, 1);
    assert.equal(second.resumed, true);
    assert.equal(second.merged.newScores, 0);
    assert.equal(second.merged.newOdds, 0);
    assert.equal(second.manifest.counts.scoreRaw, 1);
    assert.equal(second.manifest.counts.oddsRaw, 1);
    assert.equal(second.manifest.polls, 2);
  });

  await test("game_finalised produces explicit final markers and provenance", async () => {
    const root = tempRepo(), config = settings(root), mock = mockFetch(true);
    const result = await Poll.captureOnce(config, { fetch: mock.fetch, now: () => 1784414460000 });
    const manifest = JSON.parse(fs.readFileSync(result.paths.manifest, "utf8"));
    assert.equal(result.status, "final");
    assert.equal(result.state.status, "final");
    assert.equal(manifest.status, "final");
    assert.equal(manifest.finalObservedAt, "2026-07-18T22:41:00.000Z");
    assert.equal(manifest.provenance.scores.first, "2026-07-18T21:00:00.000Z");
    assert.match(fs.readFileSync(result.paths.tape, "utf8"), /FORESIGHT_CAPTURE status=final/);
  });

  await test("a first poll with both windows failed leaves existing output untouched", async () => {
    const root = tempRepo(), config = settings(root), paths = Poll.capturePaths(config);
    fs.writeFileSync(paths.tape, "keep me\n");
    const fetch = async url => {
      if (url.includes("/fixtures/snapshot")) return response([{ FixtureId: 18257865, StartTime: 1784408400000 }]);
      throw new Error("upstream failed jwt-super-secret");
    };
    await assert.rejects(Poll.captureOnce(config, { fetch, now: () => 1784409000000 }), /both capture windows failed.*REDACTED/);
    assert.equal(fs.readFileSync(paths.tape, "utf8"), "keep me\n");
    assert.equal(fs.existsSync(paths.state), false);
    assert.equal(fs.existsSync(paths.manifest), false);
  });

  await test("SIGINT-style stop aborts a pending mocked request and redacts secrets", async () => {
    const root = tempRepo(), config = settings(root), logs = [];
    const fetch = (_url, options) => new Promise((_resolve, reject) => {
      if (options.signal.aborted) { const error = new Error("aborted jwt-super-secret token-super-secret"); error.name = "AbortError"; reject(error); return; }
      options.signal.addEventListener("abort", () => { const error = new Error("aborted jwt-super-secret token-super-secret"); error.name = "AbortError"; reject(error); }, { once: true });
    });
    const runner = Poll.startCapture(config, { fetch, log: line => logs.push(line), warn: line => logs.push(line), now: () => 1784409000000 });
    await new Promise(resolve => setImmediate(resolve));
    runner.stop("SIGINT jwt-super-secret");
    await runner.done;
    assert.equal(runner.stopped, true);
    assert.equal(logs.join("\n").includes("jwt-super-secret"), false);
    assert.equal(logs.join("\n").includes("token-super-secret"), false);
  });

  await test("redaction removes bearer values and both configured secrets", () => {
    const root = tempRepo(), config = settings(root);
    const value = Poll.redact("Bearer jwt-super-secret token-super-secret", config);
    assert.equal(value.includes("jwt-super-secret"), false);
    assert.equal(value.includes("token-super-secret"), false);
    assert.match(value, /REDACTED/);
  });

  console.log(`\nlive-poll: ${passed}/10 passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
