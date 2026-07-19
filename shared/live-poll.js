#!/usr/bin/env node
/*
 * Safe TxLINE capture helper for the flattened Foresight deploy repository.
 * Default invocation is a no-network/no-write plan. Material capture requires
 * both --write and --yes-i-understand-this-writes-capture-files.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const TxReal = require("./txline-real.js");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT = path.join(REPO_ROOT, "real-data");
const DEFAULT_HOST = "https://txline-dev.txodds.com";
const DEFAULT_FIXTURES = Object.freeze([18257865, 18257739]);
const SCHEMA_VERSION = 1;
const WRITE_CONFIRMATION = "--yes-i-understand-this-writes-capture-files";
const KEEP_ACTIONS = new Set(["goal", "yellow_card", "red_card", "corner", "shot", "free_kick",
  "penalty", "penalty_outcome", "var", "var_end", "substitution", "kickoff",
  "halftime_finalised", "game_finalised", "additional_time", "action_amend", "suspend"]);

function usage() {
  return [
    "Usage: node shared/live-poll.js --fixture <id> [options]",
    "",
    "Default: print a validated plan; perform no network requests and write nothing.",
    "  --write                                   enable credentialed capture",
    `  ${WRITE_CONFIRMATION}  confirm material output`,
    "  --once                                    capture one update window and exit",
    "  --interval <seconds>                      polling interval (minimum 5; default 15)",
    "  --out <path>                              target under repository real-data/",
    "  --config <path>                           explicit ignored/private JSON config",
    "  --dry-run                                 force safe plan mode",
  ].join("\n");
}

function parseArgs(argv) {
  const out = { fixtureId: null, intervalSec: 15, out: null, config: null, write: false, confirmed: false, once: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (/^\d+$/.test(arg) && out.fixtureId == null) out.fixtureId = Number(arg);
    else if (arg === "--fixture") out.fixtureId = Number(argv[++i]);
    else if (arg === "--interval") out.intervalSec = Number(argv[++i]);
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--config") out.config = argv[++i];
    else if (arg === "--write") out.write = true;
    else if (arg === "--dry-run") out.write = false;
    else if (arg === WRITE_CONFIRMATION) out.confirmed = true;
    else if (arg === "--once") out.once = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (out.help) return out;
  if (!Number.isSafeInteger(out.fixtureId) || out.fixtureId <= 0) throw new Error("--fixture must be a positive integer");
  if (!Number.isFinite(out.intervalSec) || out.intervalSec < 5 || out.intervalSec > 3600) throw new Error("--interval must be between 5 and 3600 seconds");
  if (out.write && !out.confirmed) throw new Error(`--write requires ${WRITE_CONFIRMATION}`);
  return out;
}

function isWithin(base, target) {
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveOutputDir(candidate, repoRoot = REPO_ROOT, fsImpl = fs) {
  const root = path.resolve(repoRoot);
  const realData = path.join(root, "real-data");
  const requested = path.resolve(root, candidate || "real-data");
  if (!isWithin(realData, requested)) throw new Error("capture output must stay inside repository real-data/");
  if (!fsImpl.existsSync(realData)) throw new Error("repository real-data/ directory does not exist");
  const realRoot = fsImpl.realpathSync(realData);
  let probe = requested;
  while (!fsImpl.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realParent = fsImpl.realpathSync(probe);
  if (!isWithin(realRoot, realParent)) throw new Error("capture output resolves outside repository real-data/");
  return requested;
}

function resolveConfigPath(candidate, repoRoot = REPO_ROOT, fsImpl = fs) {
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  if (!fsImpl.existsSync(resolved) || !fsImpl.statSync(resolved).isFile()) throw new Error("explicit capture config file does not exist");
  const root = path.resolve(repoRoot);
  if (isWithin(root, resolved)) {
    const allowed = [path.join(root, ".txline.json"), path.join(root, "shared", ".txline.json")];
    if (!allowed.includes(resolved)) throw new Error("in-repo capture config must be an explicitly gitignored .txline.json path");
  }
  return resolved;
}

function readConfig(configPath, fsImpl = fs) {
  if (!configPath) return {};
  let value;
  try { value = JSON.parse(fsImpl.readFileSync(configPath, "utf8")); }
  catch (_) { throw new Error("capture config is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("capture config must be a JSON object");
  return value;
}

function parseFixtureAllowlist(envValue, configured) {
  const source = envValue ? String(envValue).split(",") : (Array.isArray(configured) ? configured : DEFAULT_FIXTURES);
  const ids = [...new Set(source.map(Number).filter(Number.isSafeInteger).filter(n => n > 0))];
  if (!ids.length) throw new Error("capture fixture allowlist is empty");
  return ids;
}

function validateHost(candidate) {
  const url = new URL(candidate || DEFAULT_HOST);
  const allowed = url.protocol === "https:" && (url.hostname === "txline-dev.txodds.com" || url.hostname === "txline.txodds.com") && (url.pathname === "/" || url.pathname === "");
  if (!allowed || url.username || url.password || url.search || url.hash) throw new Error("TXLINE_HOST must be an allowlisted TxLINE HTTPS origin");
  return url.origin;
}

function buildSettings(args, deps = {}) {
  const fsImpl = deps.fs || fs;
  const env = deps.env || process.env;
  const repoRoot = path.resolve(deps.repoRoot || REPO_ROOT);
  const configPath = resolveConfigPath(args.config, repoRoot, fsImpl);
  const config = readConfig(configPath, fsImpl);
  const allowedFixtureIds = parseFixtureAllowlist(env.FORESIGHT_CAPTURE_FIXTURES, config.allowedFixtureIds);
  if (!allowedFixtureIds.includes(args.fixtureId)) throw new Error(`fixture ${args.fixtureId} is not in the capture allowlist`);
  const outDir = resolveOutputDir(args.out, repoRoot, fsImpl);
  const jwt = env.TXLINE_JWT || config.jwt || null;
  const apiToken = env.TXLINE_API_TOKEN || config.apiToken || null;
  if (args.write && (!jwt || !apiToken)) throw new Error("capture writes require TXLINE_JWT and TXLINE_API_TOKEN (env or explicit private config)");
  return {
    fixtureId: args.fixtureId,
    intervalSec: args.intervalSec,
    once: args.once,
    write: args.write,
    repoRoot,
    outDir,
    host: validateHost(env.TXLINE_HOST || config.host || DEFAULT_HOST),
    network: env.TXLINE_NETWORK || config.network || "devnet",
    credentials: { jwt, apiToken },
    authSource: env.TXLINE_JWT || env.TXLINE_API_TOKEN ? "environment" : configPath ? "explicit-private-config" : "none",
    allowedFixtureIds,
  };
}

function capturePaths(settings) {
  const base = path.join(settings.outDir, String(settings.fixtureId));
  const paths = {
    tape: base + ".tape.js",
    state: base + ".live-state.json",
    manifest: base + ".capture-manifest.json",
  };
  for (const value of Object.values(paths)) if (!isWithin(settings.outDir, path.resolve(value))) throw new Error("capture target escaped output directory");
  return paths;
}

function blankState(fixtureId, nowIso) {
  return { schemaVersion: SCHEMA_VERSION, fixtureId, status: "incomplete", startedAt: nowIso, updatedAt: nowIso, finalObservedAt: null, polls: 0, fixture: null, historical: [], odds: [], seenSeq: {}, seenOdds: {} };
}

function validateState(value, fixtureId) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || value.fixtureId !== fixtureId) throw new Error("capture state schema/fixture mismatch; restore its .bak or choose the correct fixture");
  if (!Array.isArray(value.historical) || !Array.isArray(value.odds) || !value.seenSeq || !value.seenOdds) throw new Error("capture state is malformed; restore its .bak");
  return value;
}

function loadState(file, fixtureId, nowIso, fsImpl = fs) {
  if (!fsImpl.existsSync(file)) return { state: blankState(fixtureId, nowIso), resumed: false };
  let value;
  try { value = JSON.parse(fsImpl.readFileSync(file, "utf8")); }
  catch (_) { throw new Error("capture state is unreadable; restore its .bak before continuing"); }
  return { state: validateState(value, fixtureId), resumed: true };
}

function scoreKey(e) { return `${e && e.Seq != null ? e.Seq : ""}:${e && e.Ts || ""}:${e && e.Action || ""}`; }
function oddsKey(o) { return o && (o.MessageId || `${o.Ts || ""}:${o.SuperOddsType || ""}:${o.MarketParameters || ""}`); }

function mergeNew(state, scoreEvents, oddsPayloads) {
  let newScores = 0, newOdds = 0;
  for (const event of Array.isArray(scoreEvents) ? scoreEvents : []) {
    if (!event || typeof event !== "object") continue;
    const key = scoreKey(event); if (state.seenSeq[key]) continue;
    state.seenSeq[key] = true; state.historical.push(event); newScores++;
  }
  for (const odds of Array.isArray(oddsPayloads) ? oddsPayloads : []) {
    if (!odds || typeof odds !== "object") continue;
    const key = oddsKey(odds); if (!key || state.seenOdds[key]) continue;
    state.seenOdds[key] = true; state.odds.push(odds); newOdds++;
  }
  return { newScores, newOdds };
}

function compactBundle(state, capturedAt, manifestName) {
  const historical = state.historical.filter(event => KEEP_ACTIONS.has(event.Action));
  const candidates = state.odds.filter(o => o.BookmakerId === 10021 && o.MarketPeriod == null && o.SuperOddsType === "1X2_PARTICIPANT_RESULT" && Array.isArray(o.Pct) && o.Pct[0] !== "NA" && o.Pct[0] != null)
    .map(o => ({ Ts: o.Ts, SuperOddsType: o.SuperOddsType, PriceNames: o.PriceNames, Pct: o.Pct })).sort((a, b) => a.Ts - b.Ts);
  const odds = []; let lastTs = -Infinity;
  for (const point of candidates) if (Number(point.Ts) - lastTs >= 8000) { odds.push(point); lastTs = Number(point.Ts); }
  const final = historical.some(event => event.Action === "game_finalised");
  return {
    bundle: {
      fixture: state.fixture || { FixtureId: state.fixtureId },
      historical,
      odds,
      capture: { schemaVersion: SCHEMA_VERSION, status: final ? "final" : "incomplete", capturedAt, manifest: manifestName },
    },
    status: final ? "final" : "incomplete",
  };
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function isoFromTs(value) {
  const n = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}
function observedRange(rows) {
  const values = rows.map(row => typeof row.Ts === "number" ? row.Ts : Date.parse(row.Ts)).filter(Number.isFinite).sort((a, b) => a - b);
  return { first: values.length ? new Date(values[0]).toISOString() : null, last: values.length ? new Date(values[values.length - 1]).toISOString() : null };
}
function relativePortable(root, file) { return path.relative(root, file).split(path.sep).join("/"); }

function buildArtifacts(settings, state, paths, resumed, merged, capturedAt, errors) {
  const compact = compactBundle(state, capturedAt, path.basename(paths.manifest));
  state.status = compact.status; state.updatedAt = capturedAt; state.polls = Number(state.polls || 0) + 1;
  if (compact.status === "final" && !state.finalObservedAt) state.finalObservedAt = capturedAt;
  const tape = `/* FORESIGHT_CAPTURE status=${compact.status} capturedAt=${capturedAt} */\nwindow.TXLINE_TAPE = ${JSON.stringify(compact.bundle)};\n`;
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    fixtureId: settings.fixtureId,
    status: compact.status,
    captureStartedAt: state.startedAt,
    capturedAt,
    finalObservedAt: state.finalObservedAt,
    resumed,
    polls: state.polls,
    source: {
      provider: "TxLINE",
      host: settings.host,
      network: settings.network,
      authentication: settings.authSource,
      endpoints: [`/api/fixtures/snapshot`, `/api/scores/updates/${settings.fixtureId}`, `/api/odds/updates/${settings.fixtureId}`],
    },
    provenance: {
      fixtureStartTime: isoFromTs(state.fixture && state.fixture.StartTime),
      scores: observedRange(state.historical),
      odds: observedRange(state.odds),
    },
    counts: { scoreRaw: state.historical.length, oddsRaw: state.odds.length, scoreCompact: compact.bundle.historical.length, oddsCompact: compact.bundle.odds.length, newScores: merged.newScores, newOdds: merged.newOdds },
    files: { tape: relativePortable(settings.repoRoot, paths.tape), state: relativePortable(settings.repoRoot, paths.state) },
    errors: errors.map(message => String(message).slice(0, 200)),
    integrity: { tapeSha256: sha256(tape) },
  };
  return { tape, manifest, state, status: compact.status };
}

function replaceFile(source, target, fsImpl) {
  try { fsImpl.renameSync(source, target); }
  catch (error) {
    if (!fsImpl.existsSync(target) || !["EEXIST", "EPERM", "ENOTEMPTY"].includes(error.code)) throw error;
    const rollback = `${target}.rollback-${process.pid}`;
    fsImpl.renameSync(target, rollback);
    try { fsImpl.renameSync(source, target); fsImpl.rmSync(rollback, { force: true }); }
    catch (inner) { if (!fsImpl.existsSync(target) && fsImpl.existsSync(rollback)) fsImpl.renameSync(rollback, target); throw inner; }
  }
}

function atomicWrite(file, data, options = {}) {
  const fsImpl = options.fs || fs;
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const nonce = crypto.randomBytes(6).toString("hex");
  const temp = `${file}.tmp-${process.pid}-${nonce}`;
  const backupTemp = `${file}.bak.tmp-${process.pid}-${nonce}`;
  let fd;
  try {
    fd = fsImpl.openSync(temp, "wx", 0o600);
    fsImpl.writeFileSync(fd, data);
    fsImpl.fsyncSync(fd); fsImpl.closeSync(fd); fd = null;
    if (options.backup && fsImpl.existsSync(file) && !fsImpl.existsSync(`${file}.bak`)) {
      fsImpl.copyFileSync(file, backupTemp, fs.constants.COPYFILE_EXCL);
      replaceFile(backupTemp, `${file}.bak`, fsImpl);
    }
    replaceFile(temp, file, fsImpl);
  } finally {
    if (fd != null) try { fsImpl.closeSync(fd); } catch (_) {}
    for (const leftover of [temp, backupTemp]) if (fsImpl.existsSync(leftover)) try { fsImpl.rmSync(leftover, { force: true }); } catch (_) {}
  }
}

function writeArtifacts(paths, artifacts, fsImpl = fs) {
  atomicWrite(paths.state, JSON.stringify(artifacts.state), { fs: fsImpl, backup: true });
  atomicWrite(paths.tape, artifacts.tape, { fs: fsImpl, backup: true });
  atomicWrite(paths.manifest, JSON.stringify(artifacts.manifest, null, 2) + "\n", { fs: fsImpl, backup: true });
}

function requestHeaders(settings, accept) {
  return { Authorization: `Bearer ${settings.credentials.jwt}`, "X-Api-Token": settings.credentials.apiToken, Accept: accept };
}
async function checkedFetch(fetchImpl, url, options, label) {
  const response = await fetchImpl(url, options);
  if (!response || !response.ok) throw new Error(`${label} returned HTTP ${response && response.status || "unknown"}`);
  return response;
}
async function fetchFixtureMeta(settings, fetchImpl, signal, nowMs) {
  const day = Math.floor(nowMs / 86400000);
  for (const epochDay of [day, day - 1, day + 1]) {
    const url = `${settings.host}/api/fixtures/snapshot?startEpochDay=${epochDay}&competitionId=72`;
    const response = await checkedFetch(fetchImpl, url, { signal, headers: requestHeaders(settings, "application/json") }, "fixtures/snapshot");
    const list = await response.json();
    const match = (Array.isArray(list) ? list : []).find(item => item && item.FixtureId === settings.fixtureId);
    if (match) return match;
  }
  return null;
}
async function fetchScores(settings, fetchImpl, signal) {
  const response = await checkedFetch(fetchImpl, `${settings.host}/api/scores/updates/${settings.fixtureId}`, { signal, headers: requestHeaders(settings, "text/event-stream") }, "scores/updates");
  const body = await response.text(); const events = [];
  if (body.trim().startsWith("[")) {
    const parsed = JSON.parse(body); if (Array.isArray(parsed)) events.push(...parsed);
  } else TxReal.parseSSEChunk(body + "\n\n", message => { if (message.data && typeof message.data === "object") events.push(message.data); });
  return events;
}
async function fetchOdds(settings, fetchImpl, signal) {
  const response = await checkedFetch(fetchImpl, `${settings.host}/api/odds/updates/${settings.fixtureId}`, { signal, headers: requestHeaders(settings, "application/json") }, "odds/updates");
  const value = await response.json(); return Array.isArray(value) ? value : [];
}

function redact(message, settings) {
  let value = String(message == null ? "" : message).replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]");
  for (const secret of [settings && settings.credentials.jwt, settings && settings.credentials.apiToken]) if (secret) value = value.split(String(secret)).join("[REDACTED]");
  return value;
}

async function captureOnce(settings, deps = {}) {
  if (!settings.write) throw new Error("captureOnce requires write mode");
  const fsImpl = deps.fs || fs, fetchImpl = deps.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const nowMs = (deps.now || Date.now)(); const capturedAt = new Date(nowMs).toISOString();
  const paths = capturePaths(settings);
  const loaded = loadState(paths.state, settings.fixtureId, capturedAt, fsImpl);
  const state = loaded.state, errors = [];
  if (!state.fixture) {
    try { state.fixture = await fetchFixtureMeta(settings, fetchImpl, deps.signal, nowMs); }
    catch (error) { errors.push(redact(error.message, settings)); }
  }
  if (deps.signal && deps.signal.aborted) { const error = new Error("capture aborted"); error.name = "AbortError"; throw error; }
  const [scoreResult, oddsResult] = await Promise.allSettled([
    fetchScores(settings, fetchImpl, deps.signal),
    fetchOdds(settings, fetchImpl, deps.signal),
  ]);
  const scoreEvents = scoreResult.status === "fulfilled" ? scoreResult.value : [];
  const oddsPayloads = oddsResult.status === "fulfilled" ? oddsResult.value : [];
  if (scoreResult.status === "rejected") errors.push(redact(scoreResult.reason && scoreResult.reason.message, settings));
  if (oddsResult.status === "rejected") errors.push(redact(oddsResult.reason && oddsResult.reason.message, settings));
  if (scoreResult.status === "rejected" && oddsResult.status === "rejected" && !state.historical.length && !state.odds.length) {
    throw new Error(`both capture windows failed; no files written (${errors.join("; ")})`);
  }
  const merged = mergeNew(state, scoreEvents, oddsPayloads);
  const artifacts = buildArtifacts(settings, state, paths, loaded.resumed, merged, capturedAt, errors);
  writeArtifacts(paths, artifacts, fsImpl);
  return { ...artifacts, paths, resumed: loaded.resumed, merged };
}

function startCapture(settings, deps = {}) {
  const log = deps.log || console.log, warn = deps.warn || console.warn;
  let stopped = false, controller = null, timer = null, wake = null;
  function stop(reason) {
    if (stopped) return; stopped = true;
    if (controller) controller.abort();
    if (timer) clearTimeout(timer);
    if (wake) wake();
    log(`capture stopped safely${reason ? ` (${redact(reason, settings)})` : ""}`);
  }
  const done = (async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const result = await captureOnce(settings, { ...deps, signal: controller.signal });
        log(`[${result.manifest.capturedAt}] ${result.status} +${result.merged.newScores} scores +${result.merged.newOdds} odds; raw ${result.manifest.counts.scoreRaw}/${result.manifest.counts.oddsRaw}`);
        if (result.status === "final" || settings.once) break;
      } catch (error) {
        if (!stopped || error.name !== "AbortError") warn(`capture tick failed: ${redact(error.message, settings)}`);
      } finally { controller = null; }
      if (stopped) break;
      await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, settings.intervalSec * 1000); });
      wake = null; timer = null;
    }
  })();
  return { stop, done, get stopped() { return stopped; } };
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs(argv); }
  catch (error) { console.error(`ERROR: ${error.message}\n\n${usage()}`); process.exitCode = 2; return; }
  if (args.help) { console.log(usage()); return; }
  let settings;
  try { settings = buildSettings(args); }
  catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 2; return; }
  const paths = capturePaths(settings);
  if (!settings.write) {
    console.log(JSON.stringify({ mode: "dry-run", networkRequests: 0, filesWritten: 0, fixtureId: settings.fixtureId, allowedFixtureIds: settings.allowedFixtureIds, intervalSec: settings.intervalSec, targets: paths, next: `add --write ${WRITE_CONFIRMATION}` }, null, 2));
    return;
  }
  const runner = startCapture(settings);
  const onSigint = () => { process.exitCode = 130; runner.stop("SIGINT"); };
  process.once("SIGINT", onSigint);
  try { await runner.done; }
  finally { process.removeListener("SIGINT", onSigint); runner.stop(); }
}

module.exports = {
  DEFAULT_FIXTURES, WRITE_CONFIRMATION, parseArgs, resolveOutputDir, resolveConfigPath,
  buildSettings, capturePaths, blankState, loadState, mergeNew, compactBundle,
  buildArtifacts, atomicWrite, captureOnce, startCapture, redact, usage,
};

if (require.main === module) main();
