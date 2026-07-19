/* Pure live-state policy shared by the browser UI and deterministic tests. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LiveState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DEFAULT_STALE_MS = 90000;

  function kickoffMs(fixture) {
    var raw = fixture && fixture.StartTime;
    var value = typeof raw === "number" ? raw : Date.parse(raw);
    return Number.isFinite(value) ? value : null;
  }

  function derive(stat, now, staleMs) {
    stat = stat || {};
    now = Number.isFinite(now) ? now : Date.now();
    staleMs = Number.isFinite(staleMs) ? staleMs : DEFAULT_STALE_MS;
    var streams = stat.streams || {};
    var phases = Object.keys(streams).map(function (k) { return streams[k]; });
    var ageMs = stat.lastFrameAt ? Math.max(0, now - stat.lastFrameAt) : null;

    if (stat.endedAt) return { state: "ENDED", ageMs: ageMs };
    if (!stat.active) return { state: "IDLE", ageMs: ageMs };
    if (phases.indexOf("error") !== -1) return { state: "ERROR", ageMs: ageMs };
    if (!stat.firstFrameAt) return { state: "CONNECTING", ageMs: null };
    if (ageMs > staleMs) return { state: "STALE", ageMs: ageMs };
    // A clean EOF/reconnect does not erase recent accepted evidence. It remains
    // fresh until the same 90-second boundary, but the UI can disclose that the
    // transport is reconnecting through this flag.
    return { state: "LIVE", ageMs: ageMs, reconnecting: phases.indexOf("reconnecting") !== -1 };
  }

  function verifiedLive(opts) {
    opts = opts || {};
    var fixture = opts.fixture;
    var now = Number.isFinite(opts.now) ? opts.now : Date.now();
    var staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : DEFAULT_STALE_MS;
    if (!fixture || fixture.FixtureId !== opts.targetId || opts.finalized) return false;
    if (derive(opts.stat, now, staleMs).state !== "LIVE") return false;
    var kickoff = kickoffMs(fixture);
    if (kickoff === null || now < kickoff - 30 * 60000 || now > kickoff + 3 * 3600000) return false;
    var oddsAge = now - Number(opts.stat && opts.stat.lastOddsFrameAt || 0);
    return oddsAge >= 0 && oddsAge <= staleMs;
  }

  function canPickAtPlayhead(opts) {
    opts = opts || {};
    if (opts.verifiedLive && !opts.finalized) return true;
    // Finalized tapes are still valid PRACTICE replays before their own end.
    // They are never allowed at/after the known result, and walletEligible()
    // independently prevents any real signature for them.
    return Number.isFinite(opts.simT) && Number.isFinite(opts.endT) && opts.simT < opts.endT;
  }

  function walletEligible(opts) {
    opts = opts || {};
    if (!opts.fixture || opts.finalized) return false;
    if (opts.verifiedLive) return true;
    var kickoff = kickoffMs(opts.fixture);
    return kickoff !== null && kickoff > (Number.isFinite(opts.now) ? opts.now : Date.now());
  }

  return {
    DEFAULT_STALE_MS: DEFAULT_STALE_MS,
    derive: derive,
    verifiedLive: verifiedLive,
    canPickAtPlayhead: canPickAtPlayhead,
    walletEligible: walletEligible,
  };
});
