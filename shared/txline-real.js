/* ============================================================
   TxLINE REAL CLIENT + REPLAY (TxReal) — universal (browser + node), no deps.

   Drop-in replacement for shared/txline-mock.js:
     - exposes the SAME surface: FIXTURE, EVENTS, stream({speed,onEvent,onOdds,onDone,from}),
       historical(), fixtures(), oddsSnapshot(), proofFor(), hash, fakeSig
     - browser: <script src="../shared/txline-real.js"></script> defines window.TxReal
       and ALSO aliases window.TxMock = TxReal when the mock is not loaded,
       so swapping the script tag is the only change an app needs.
     - node: const TxReal = require("./txline-real.js")

   Data source resolution order (TxReplay):
     1. configure({data: bundle}) / load({data})
     2. window.TXLINE_TAPE  (written by `node txline-cli.js pull <id>` as <id>.tape.js
        — synchronous, offline, no CORS/auth in the browser: the recommended demo path)
     3. node: fixtures-cache/<fixtureId>.json (written by the CLI `pull`)
     4. live API: GET /api/scores/historical/{id} + hourly odds intervals
        GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}?fixtureId=

   Auth (real API):
     POST {host}/auth/guest/start                 → guest JWT (30d), no body needed
     POST /api/token/activate (after on-chain sub)→ X-Api-Token
     every data call: Authorization: Bearer <jwt> AND X-Api-Token: <token>
     401 → auto refresh JWT once, then error "refresh JWT"
     403 → error "re-activate token"

   Config: TxReal.configure({host, network, jwt, apiToken, fixtureId, fetchImpl, cacheDir})
     defaults: devnet. Env fallbacks (node): TXLINE_HOST, TXLINE_NETWORK, TXLINE_JWT,
     TXLINE_API_TOKEN, TXLINE_FIXTURE. File fallback (node): ./.txline.json (gitignored).
   ============================================================ */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(root);
  else { root.TxReal = factory(root); if (!root.TxMock) root.TxMock = root.TxReal; }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var IS_NODE = typeof process !== "undefined" && !!(process.versions && process.versions.node);

  var HOSTS = {
    mainnet: "https://txline.txodds.com",
    devnet: "https://txline-dev.txodds.com",
  };
  var PROGRAM_IDS = {
    mainnet: "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA",
    devnet: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
  };

  var DAY = 86400000, HOUR = 3600000, FIVE_MIN = 300000;

  // ---------------------------------------------------------- time math
  function epochDayOf(ts) { return Math.floor(ts / DAY); }
  function hourOf(ts) { return Math.floor((ts % DAY) / HOUR); }
  function intervalOf(ts) { return Math.floor((ts % HOUR) / FIVE_MIN); } // 0..11
  function bucketOf(ts) { return { epochDay: epochDayOf(ts), hourOfDay: hourOf(ts), interval: intervalOf(ts) }; }
  /** All 5-min odds buckets covering [startTs, endTs] inclusive. */
  function intervalsBetween(startTs, endTs) {
    var out = [];
    var t = Math.floor(startTs / FIVE_MIN) * FIVE_MIN;
    for (; t <= endTs; t += FIVE_MIN) out.push(bucketOf(t));
    return out;
  }

  // ---------------------------------------------------------- statKeys
  // statKey = period_prefix + base_key. Base 1–8 = per-participant Goals/Yellow/Red/Corners.
  var PERIOD = { TOTAL: 0, H1: 1000, HT: 2000, H2: 3000, ET1: 4000, ET2: 5000, PENS: 6000, ET_TOTAL: 7000 };
  var BASE_KEYS = { goals: { 1: 1, 2: 2 }, yellow: { 1: 3, 2: 4 }, red: { 1: 5, 2: 6 }, corners: { 1: 7, 2: 8 } };
  function statKeyFor(stat, participant, period) {
    var base = BASE_KEYS[stat] && BASE_KEYS[stat][participant];
    if (!base) throw new Error("statKeyFor: unknown stat/participant " + stat + "/" + participant);
    var prefix = period == null ? 0 : (typeof period === "number" ? period : PERIOD[period]);
    if (prefix == null) throw new Error("statKeyFor: unknown period " + period);
    return prefix + base;
  }
  function decodeStatKey(key) {
    var prefix = Math.floor(key / 1000) * 1000, base = key % 1000;
    var periodName = null;
    for (var p in PERIOD) if (PERIOD[p] === prefix) periodName = p;
    var stat = null, participant = null;
    for (var s in BASE_KEYS) for (var pt in BASE_KEYS[s]) if (BASE_KEYS[s][pt] === base) { stat = s; participant = Number(pt); }
    return { period: periodName, periodPrefix: prefix, baseKey: base, stat: stat, participant: participant };
  }

  // ---------------------------------------------------------- pseudo hashes (mock-compatible; offline proof fallback)
  function hash(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); }
  function fakeSig(seed) { var out = ""; for (var i = 0; i < 8; i++) out += hash(seed + ":" + i); return out.slice(0, 64); }

  // ---------------------------------------------------------- config / state
  var PLACEHOLDER_FIXTURE = {
    FixtureId: null, Competition: "TxLINE (tape not loaded — call TxReal.load() or preload TXLINE_TAPE)",
    Participant1: "Home", Participant2: "Away", Participant1IsHome: true, StartTime: null,
  };
  var DEFAULT_ODDS = { home: 1 / 3, draw: 1 / 3, away: 1 / 3, synthetic: true };

  function freshState() {
    return {
      host: null, network: null, jwt: null, apiToken: null, fixtureId: null,
      fetchImpl: null, cacheDir: "fixtures-cache",
      fixture: null, events: [], oddsTimeline: [], loaded: false, offline: false, lastError: null,
      _resolved: false,
    };
  }
  var state = freshState();

  function envVal(name) {
    return (IS_NODE && process.env && process.env[name]) || null;
  }
  function fileCfg() {
    if (!IS_NODE) return {};
    try {
      var fs = require("fs"), path = require("path");
      var candidates = [path.resolve(process.cwd(), ".txline.json"), path.resolve(__dirname, ".txline.json")];
      for (var i = 0; i < candidates.length; i++) {
        if (fs.existsSync(candidates[i])) return JSON.parse(fs.readFileSync(candidates[i], "utf8"));
      }
    } catch (e) { /* unreadable config is not fatal */ }
    return {};
  }
  /** Lazily fill host/jwt/apiToken/fixtureId from env + .txline.json (explicit configure() wins). */
  function resolve() {
    if (state._resolved) return state;
    var f = fileCfg();
    state.network = state.network || envVal("TXLINE_NETWORK") || f.network || "devnet";
    state.host = state.host || envVal("TXLINE_HOST") || f.host || HOSTS[state.network] || HOSTS.devnet;
    state.jwt = state.jwt || envVal("TXLINE_JWT") || f.jwt || null;
    state.apiToken = state.apiToken || envVal("TXLINE_API_TOKEN") || f.apiToken || null;
    state.fixtureId = state.fixtureId || Number(envVal("TXLINE_FIXTURE") || f.fixtureId || 0) || null;
    state._resolved = true;
    return state;
  }
  function configure(opts) {
    opts = opts || {};
    if (opts.network) { state.network = opts.network; state.host = HOSTS[opts.network] || state.host; }
    if (opts.host) state.host = opts.host;
    if (opts.jwt !== undefined) state.jwt = opts.jwt;
    if (opts.apiToken !== undefined) state.apiToken = opts.apiToken;
    if (opts.fixtureId !== undefined) state.fixtureId = opts.fixtureId ? Number(opts.fixtureId) : null;
    if (opts.fetchImpl) state.fetchImpl = opts.fetchImpl;
    if (opts.cacheDir) state.cacheDir = opts.cacheDir;
    if (opts.data) useBundle(opts.data);
    return resolve();
  }
  function _reset() { state = freshState(); }

  // ---------------------------------------------------------- errors + http
  function TxRealError(status, message, hint) {
    var e = new Error("TxLINE " + status + ": " + message + (hint ? " — " + hint : ""));
    e.name = "TxRealError"; e.status = status; e.hint = hint || null;
    return e;
  }

  function getFetch() {
    if (state.fetchImpl) return state.fetchImpl;
    if (typeof fetch !== "undefined") return fetch.bind(typeof globalThis !== "undefined" ? globalThis : root);
    throw TxRealError(0, "no fetch available", "Node >= 18 required, or configure({fetchImpl})");
  }

  function buildHeaders(extra) {
    var h = {};
    if (state.jwt) h["Authorization"] = "Bearer " + state.jwt;
    if (state.apiToken) h["X-Api-Token"] = state.apiToken;
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  function buildQs(params) {
    if (!params) return "";
    var parts = [];
    for (var k in params) {
      if (params[k] === undefined || params[k] === null) continue;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k])));
    }
    return parts.length ? "?" + parts.join("&") : "";
  }

  /** POST {host}/auth/guest/start → guest JWT (30-day). No body / no auth required. */
  function auth() {
    resolve();
    var f = getFetch();
    return f(state.host + "/auth/guest/start", { method: "POST" }).then(function (res) {
      if (!res.ok) throw TxRealError(res.status, "guest/start failed", "check host (" + state.host + ") / connectivity");
      return res.json();
    }).then(function (body) {
      state.jwt = (body && (body.token || body.jwt)) || body;
      return state.jwt;
    });
  }

  function api(path, params, _retried) {
    resolve();
    var f = getFetch();
    var pre = state.jwt ? Promise.resolve() : auth();
    return pre.then(function () {
      var url = state.host + "/api" + path + buildQs(params);
      return f(url, { headers: buildHeaders() }).then(function (res) {
        if (res.status === 401) {
          if (!_retried) return auth().then(function () { return api(path, params, true); });
          throw TxRealError(401, "unauthorized after JWT refresh",
            "refresh JWT: POST " + state.host + "/auth/guest/start (expired or wrong host — refresh from the SAME host)");
        }
        if (res.status === 403) {
          throw TxRealError(403, "API token missing/misaligned with subscription",
            "re-activate token: on-chain subscribe then POST /api/token/activate (README-INTEGRATION.md step 3)");
        }
        if (!res.ok) {
          return (res.text ? res.text().catch(function () { return ""; }) : Promise.resolve("")).then(function (t) {
            throw TxRealError(res.status, (t || "request failed").slice(0, 300), url);
          });
        }
        return res.json();
      });
    });
  }

  // ---------------------------------------------------------- REST surface (OpenAPI docs.yaml)
  function fetchFixtures(params) { return api("/fixtures/snapshot", params || {}); }
  function fixtureUpdates(epochDay, hourOfDay) { return api("/fixtures/updates/" + epochDay + "/" + hourOfDay); }
  function fixtureValidation(fixtureId, timestamp) { return api("/fixtures/validation", { fixtureId: fixtureId, timestamp: timestamp }); }
  function fetchOddsSnapshot(fixtureId, asOf) { return api("/odds/snapshot/" + fixtureId, { asOf: asOf }); }
  function oddsUpdates(fixtureId) { return api("/odds/updates/" + fixtureId); }
  function oddsInterval(epochDay, hourOfDay, interval, fixtureId) { return api("/odds/updates/" + epochDay + "/" + hourOfDay + "/" + interval, { fixtureId: fixtureId }); }
  function oddsValidation(messageId, ts) { return api("/odds/validation", { messageId: messageId, ts: ts }); }
  function scoresSnapshot(fixtureId, asOf) { return api("/scores/snapshot/" + fixtureId, { asOf: asOf }); }
  /**
   * Historical scores. REAL BEHAVIOUR (verified live 2026-07-18): this endpoint
   * responds `text/event-stream` (SSE frames), NOT JSON — even for finished
   * matches. We read the whole body as text and parse the `data:` frames into an
   * array of score updates. (api() would call res.json() and throw on `data: {`.)
   */
  function fetchHistorical(fixtureId, _retried) {
    resolve();
    var f = getFetch();
    var pre = state.jwt ? Promise.resolve() : auth();
    return pre.then(function () {
      var url = state.host + "/api/scores/historical/" + fixtureId;
      var headers = buildHeaders({ Accept: "text/event-stream", "Cache-Control": "no-cache" });
      return f(url, { headers: headers }).then(function (res) {
        if (res.status === 401) {
          if (!_retried) return auth().then(function () { return fetchHistorical(fixtureId, true); });
          throw TxRealError(401, "unauthorized after JWT refresh",
            "refresh JWT: POST " + state.host + "/auth/guest/start");
        }
        if (res.status === 403) {
          throw TxRealError(403, "API token missing/misaligned",
            "re-activate token (README-INTEGRATION.md step 3)");
        }
        if (!res.ok) {
          return (res.text ? res.text() : Promise.resolve("")).then(function (t) {
            throw TxRealError(res.status, (t || "historical failed").slice(0, 200), url);
          });
        }
        return (res.text ? res.text() : Promise.resolve("")).then(function (body) {
          var events = [];
          // Accept both real SSE framing and a plain JSON array (future-proof).
          if (body.charAt(0) === "[") {
            try { events = JSON.parse(body); } catch (e) { events = []; }
          } else {
            parseSSEChunk(body + "\n\n", function (m) {
              if (m.data && typeof m.data === "object") events.push(m.data);
            });
          }
          return events;
        });
      });
    });
  }
  function scoresInterval(epochDay, hourOfDay, interval, fixtureId) { return api("/scores/updates/" + epochDay + "/" + hourOfDay + "/" + interval, { fixtureId: fixtureId }); }
  function statValidation(fixtureId, seq, statKeys) {
    return api("/scores/stat-validation", {
      fixtureId: fixtureId, seq: seq,
      statKeys: Array.isArray(statKeys) ? statKeys.join(",") : statKeys,
    });
  }

  // ---------------------------------------------------------- SSE
  /** Parse a text/event-stream buffer; emit({id,event,data}) per complete message; return unconsumed remainder. */
  function parseSSEChunk(buffer, emit) {
    var blocks = buffer.split(/\r?\n\r?\n/);
    var rest = blocks.pop();
    for (var b = 0; b < blocks.length; b++) {
      var msg = { id: null, event: "message", data: [] };
      var lines = blocks[b].split(/\r?\n/);
      for (var l = 0; l < lines.length; l++) {
        var line = lines[l];
        if (!line || line.charAt(0) === ":") continue; // comment / keep-alive
        var i = line.indexOf(":");
        var field = i === -1 ? line : line.slice(0, i);
        var value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
        if (field === "id") msg.id = value;
        else if (field === "event") msg.event = value;
        else if (field === "data") msg.data.push(value);
      }
      if (msg.data.length) {
        var joined = msg.data.join("\n"), parsed;
        try { parsed = JSON.parse(joined); } catch (e) { parsed = joined; }
        emit({ id: msg.id, event: msg.event, data: parsed });
      }
    }
    return rest;
  }

  /**
   * Live SSE with auto-reconnect + Last-Event-ID resume + gzip accept.
   * kind: "odds" | "scores". Returns {stop}.  (Open connection ≠ data flowing.)
   */
  function streamLive(kind, opts) {
    opts = opts || {};
    var fixtureId = opts.fixtureId, onMessage = opts.onMessage, onStatus = opts.onStatus;
    var stopped = false, lastEventId = opts.lastEventId || null, attempt = 0;
    var activeController = null, activeReader = null, reconnectTimer = null;
    (function loop() {
      if (stopped) return;
      resolve();
      var f = getFetch();
      var pre = state.jwt ? Promise.resolve() : auth();
      pre.then(function () {
        if (stopped) return null;
        var headers = buildHeaders({ Accept: "text/event-stream", "Cache-Control": "no-cache" });
        try { headers["Accept-Encoding"] = "gzip"; } catch (e) { /* browsers manage this themselves */ }
        if (lastEventId) headers["Last-Event-ID"] = lastEventId;
        activeController = typeof AbortController !== "undefined" ? new AbortController() : null;
        var request = { headers: headers };
        if (activeController) request.signal = activeController.signal;
        return f(state.host + "/api/" + kind + "/stream" + buildQs({ fixtureId: fixtureId }), request);
      }).then(function (res) {
        if (stopped || !res) return;
        if (res.status === 401) { return auth().then(loop); }
        if (!res.ok) throw TxRealError(res.status, kind + " stream rejected");
        onStatus && onStatus({ state: "open", attempt: attempt });
        attempt = 0;
        var reader = res.body.getReader();
        activeReader = reader;
        var decoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
        var buf = "";
        function pump() {
          return reader.read().then(function (r) {
            if (stopped || r.done) return;
            buf += decoder ? decoder.decode(r.value, { stream: true }) : String(r.value);
            buf = parseSSEChunk(buf, function (m) {
              if (m.id) lastEventId = m.id;
              onMessage && onMessage(m);
            });
            return pump();
          });
        }
        return pump();
      }).catch(function (e) {
        if (!stopped && (!e || e.name !== "AbortError")) {
          onStatus && onStatus({ state: "error", error: String(e && e.message || e), attempt: attempt });
        }
      }).then(function () {
        if (stopped) return;
        activeReader = null; activeController = null;
        attempt++;
        onStatus && onStatus({ state: "reconnecting", attempt: attempt });
        reconnectTimer = setTimeout(loop, Math.min(30000, 1000 * Math.pow(2, attempt)));
      });
    })();
    return { stop: function () {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (activeReader && activeReader.cancel) {
        try { Promise.resolve(activeReader.cancel()).catch(function () {}); } catch (e) { /* already closed */ }
      }
      if (activeController) activeController.abort();
    } };
  }

  // ---------------------------------------------------------- action mapping (real soccer feed → mock event types)
  function normAction(s) { return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, ""); }

  // Exact table first, then heuristics. Target types (the mock's contract):
  // goal corner card var var_verdict shot freekick penalty sub kickoff halftime fulltime game_finalised
  var ACTION_MAP = {
    goal: "goal", owngoal: "goal", goalscored: "goal",
    corner: "corner", cornerkick: "corner", cornerawarded: "corner",
    card: "card", yellowcard: "card", redcard: "card", secondyellowcard: "card", booking: "card",
    "var": "var", varreview: "var", varunderway: "var", varinprogress: "var", varstarted: "var",
    videoassistantreferee: "var", varcheck: "var",
    varverdict: "var_verdict", varresult: "var_verdict", vardecision: "var_verdict",
    varoutcome: "var_verdict", varend: "var_verdict", varended: "var_verdict",
    varcomplete: "var_verdict", varcompleted: "var_verdict", varover: "var_verdict",
    shot: "shot", shotontarget: "shot", shotofftarget: "shot", shotwoodwork: "shot",
    shotblocked: "shot", attempt: "shot", woodwork: "shot",
    freekick: "freekick", dangerousfreekick: "freekick",
    penalty: "penalty", penaltyawarded: "penalty", penaltyscored: "penalty",
    penaltymissed: "penalty", penaltyretake: "penalty",
    substitution: "sub", sub: "sub", playersubstitution: "sub",
    kickoff: "kickoff", periodstart: "kickoff", matchstart: "kickoff", matchstarted: "kickoff",
    halftime: "halftime", halftimefinalised: "halftime", ht: "halftime",
    fulltime: "fulltime", finished: "fulltime", matchfinished: "fulltime", ft: "fulltime",
    gamefinalised: "game_finalised", finalised: "game_finalised", gamefinal: "game_finalised",
    matchfinalised: "game_finalised",
  };

  var VERDICT_WORDS = /(confirm|amend|uphold|upheld|overturn|cancel|noaction|rejected|awarded|decision)/;

  /** Map a raw action string (+ optional full update for context) to a mock event type. */
  function mapAction(raw, u) {
    var n = normAction(raw);
    // statusId=100 → final outcome regardless of naming
    if (u && Number(u.statusId != null ? u.statusId : (u.StatusId != null ? u.StatusId : NaN)) === 100) return "game_finalised";
    if (ACTION_MAP[n]) {
      // A VAR action whose payload carries a verdict word is the amend/confirm transition.
      if (ACTION_MAP[n] === "var" && u && VERDICT_WORDS.test(normAction(JSON.stringify(detailFields(u))))) return "var_verdict";
      return ACTION_MAP[n];
    }
    // heuristics — order matters (verdicty VAR before VAR, final before fulltime)
    if (n.indexOf("var") !== -1) return VERDICT_WORDS.test(n) ? "var_verdict" : "var";
    if (n.indexOf("goal") !== -1) return "goal";
    if (n.indexOf("corner") !== -1) return "corner";
    if (n.indexOf("card") !== -1 || n.indexOf("yellow") !== -1 || n.indexOf("red") !== -1) return "card";
    if (n.indexOf("penal") !== -1) return "penalty";
    if (n.indexOf("free") !== -1) return "freekick";
    if (n.indexOf("shot") !== -1 || n.indexOf("woodwork") !== -1 || n.indexOf("attempt") !== -1) return "shot";
    if (n.indexOf("sub") !== -1) return "sub";
    if (n.indexOf("final") !== -1) return "game_finalised";
    if (n.indexOf("kickoff") !== -1 || n.indexOf("start") !== -1) return "kickoff";
    if (n.indexOf("half") !== -1) return "halftime";
    if (n.indexOf("full") !== -1 || n.indexOf("finish") !== -1 || n.indexOf("end") !== -1) return "fulltime";
    return n || "unknown"; // pass through unmapped actions so apps can ignore them
  }

  // ---------------------------------------------------------- normalization
  function pick(o) {
    if (!o) return undefined;
    for (var i = 1; i < arguments.length; i++) {
      var k = arguments[i];
      if (o[k] !== undefined && o[k] !== null) return o[k];
    }
    return undefined;
  }
  function normTs(u) { var v = pick(u, "Ts", "ts", "Timestamp", "timestamp", "time"); return v == null ? NaN : Number(v); }
  function normSeq(u) { var v = pick(u, "Seq", "seq", "Sequence", "sequence"); return v == null ? null : Number(v); }
  function rawAction(u) {
    var a = pick(u, "Action", "action", "ActionType", "actionType", "event", "Event", "type", "Type");
    if (a && typeof a === "object") a = pick(a, "Type", "type", "Name", "name", "Action", "action");
    return a;
  }
  function detailFields(u) {
    var a = pick(u, "Action", "action");
    var src = (a && typeof a === "object") ? a : u;
    // Some feeds nest the actual outcome under u.Data (e.g. { Action: "var_end",
    // Data: { Outcome: "Overturned" } }) rather than as a top-level field —
    // check it between the action-object and the bare event.
    var data = (u.Data && typeof u.Data === "object") ? u.Data : (u.data && typeof u.data === "object") ? u.data : {};
    var out = {};
    var names = ["VarType", "varType", "VarResult", "varResult", "VarOutcome", "varOutcome",
      "ShotType", "shotType", "CardType", "cardType", "Card", "card",
      "Danger", "danger", "FreeKickType", "freeKickType", "FreeKickDanger", "freeKickDanger",
      "PenaltyOutcome", "penaltyOutcome", "Outcome", "outcome", "Result", "result",
      "Detail", "detail", "SubType", "subType", "Verdict", "verdict", "State", "state"];
    for (var i = 0; i < names.length; i++) {
      var v = src[names[i]] !== undefined ? src[names[i]] : (data[names[i]] !== undefined ? data[names[i]] : u[names[i]]);
      if (v !== undefined && v !== null && typeof v !== "object") out[names[i]] = v;
    }
    return out;
  }
  function extractDetail(u, type) {
    var d = detailFields(u);
    // most specific field for the type first
    var prefs = {
      "var": ["VarType", "varType"], var_verdict: ["VarResult", "varResult", "VarOutcome", "varOutcome", "Verdict", "verdict", "Outcome", "outcome", "Result", "result"],
      shot: ["ShotType", "shotType", "Outcome", "outcome"], card: ["CardType", "cardType", "Card", "card"],
      freekick: ["Danger", "danger", "FreeKickDanger", "freeKickDanger", "FreeKickType", "freeKickType"],
      penalty: ["PenaltyOutcome", "penaltyOutcome", "Outcome", "outcome", "Result", "result"],
    };
    var order = (prefs[type] || []).concat(["Detail", "detail", "Result", "result", "Outcome", "outcome"]);
    for (var i = 0; i < order.length; i++) if (d[order[i]] !== undefined) return String(d[order[i]]);
    // encode card colour from the action name itself
    if (type === "card") {
      var n = normAction(rawAction(u));
      if (n.indexOf("red") !== -1 || n.indexOf("secondyellow") !== -1) return "Red";
      if (n.indexOf("yellow") !== -1) return "Yellow";
    }
    var vals = []; for (var k in d) vals.push(d[k]);
    return vals.length ? String(vals[0]) : "";
  }
  function fxPartName(fx, n) {
    var v = fx && fx["Participant" + n];
    if (v && typeof v === "object") return pick(v, "Name", "name") || ("P" + n);
    return v != null ? String(v) : (n === 1 ? "Home" : "Away");
  }
  function fxPartId(fx, n) {
    if (!fx) return undefined;
    var flat = pick(fx, "Participant" + n + "Id", "participant" + n + "Id");
    if (flat != null) return Number(flat);
    var v = fx["Participant" + n];
    if (v && typeof v === "object") { var id = pick(v, "Id", "id", "ParticipantId", "participantId"); return id != null ? Number(id) : undefined; }
    return undefined;
  }
  function normalizeFixture(fx) {
    if (!fx) return null;
    return {
      FixtureId: Number(pick(fx, "FixtureId", "fixtureId", "id") || 0) || null,
      Competition: pick(fx, "Competition", "competition") || "",
      CompetitionId: pick(fx, "CompetitionId", "competitionId"),
      Participant1: fxPartName(fx, 1), Participant2: fxPartName(fx, 2),
      Participant1Id: fxPartId(fx, 1), Participant2Id: fxPartId(fx, 2),
      Participant1IsHome: pick(fx, "Participant1IsHome", "participant1IsHome") !== false,
      StartTime: pick(fx, "StartTime", "startTime") || null,
      raw: fx,
    };
  }
  /** Resolve which side (1|2) a score update belongs to; 0 = neutral/unknown. */
  function resolveTeam(u, fixture) {
    var a = pick(u, "Action", "action");
    var src = (a && typeof a === "object") ? a : {};
    var v = pick(u, "ParticipantId", "participantId", "Participant", "participant", "Team", "team", "side", "Side");
    if (v === undefined) v = pick(src, "ParticipantId", "participantId", "Participant", "participant", "Team", "team");
    if (v === undefined || v === null) return 0;
    if (v && typeof v === "object") v = pick(v, "Id", "id", "Name", "name");
    if (v === 1 || v === 2 || v === "1" || v === "2") return Number(v);
    var num = Number(v);
    if (fixture) {
      if (!isNaN(num)) {
        if (num === fixture.Participant1Id) return 1;
        if (num === fixture.Participant2Id) return 2;
      }
      var s = String(v).toLowerCase();
      if (s && s === String(fixture.Participant1).toLowerCase()) return 1;
      if (s && s === String(fixture.Participant2).toLowerCase()) return 2;
    }
    return 0;
  }

  // Real on-chain stats map keys 1..8 → mock stats fields.
  var STATKEY_TO_MOCK = { 1: "g1", 2: "g2", 3: "y1", 4: "y2", 5: "r1", 6: "r2", 7: "c1", 8: "c2" };
  /** Apply a real stats map (total period, keys 1..8) onto the running mock stats. Returns true if any key applied. */
  function applyStatsMap(statsMap, running) {
    if (!statsMap || typeof statsMap !== "object") return false;
    var applied = false;
    for (var k in statsMap) {
      var num = Number(k);
      if (STATKEY_TO_MOCK[num] !== undefined) { running[STATKEY_TO_MOCK[num]] = Number(statsMap[k]) || 0; applied = true; }
    }
    return applied;
  }
  function accumulateFromEvent(type, detail, team, running) {
    if (!team) return;
    var d = String(detail || "");
    if (type === "goal" || (type === "penalty" && /scored/i.test(d))) running["g" + team]++;
    if (type === "corner") running["c" + team]++;
    if (type === "card" && /red/i.test(d)) running["r" + team]++;
    else if (type === "card") running["y" + team]++;
    if (type === "shot") running["s" + team]++;
  }

  // ---------------------------------------------------------- odds normalization
  /** OddsPayload → {ts, home, draw, away} or null (non-3-way markets skipped). */
  function normalizeOddsPayload(p) {
    if (!p) return null;
    var ts = Number(pick(p, "Ts", "ts", "Timestamp", "timestamp"));
    var pct = pick(p, "Pct", "pct");
    var prices = pick(p, "Prices", "prices");
    var vals = null;
    if (Array.isArray(pct) && pct.length === 3) {
      vals = pct.map(Number);
      var mx = Math.max.apply(null, vals);
      if (mx > 1.5) vals = vals.map(function (v) { return v / 100; }); // implied % → probability
    } else if (Array.isArray(prices) && prices.length === 3) {
      var imp = prices.map(function (v) { return v > 0 ? 1 / Number(v) : 0; });
      var sum = imp[0] + imp[1] + imp[2];
      vals = sum > 0 ? imp.map(function (v) { return v / sum; }) : null; // de-vig by normalization
    }
    if (!vals || isNaN(ts)) return null;
    return {
      ts: ts, sourceTs: ts, home: vals[0], draw: vals[1], away: vals[2],
      superOddsType: pick(p, "SuperOddsType", "superOddsType"),
      inRunning: pick(p, "InRunning", "inRunning"),
      messageId: pick(p, "MessageId", "messageId"),
      bookmaker: pick(p, "Bookmaker", "bookmaker", "BookmakerName", "bookmakerName", "BookmakerId", "bookmakerId"),
      market: pick(p, "Market", "market", "MarketName", "marketName", "MarketType", "marketType"),
      period: pick(p, "MarketPeriod", "marketPeriod", "Period", "period"),
      priceNames: pick(p, "PriceNames", "priceNames"),
      raw: p,
    };
  }
  var RESULTISH = /(1x2|result|match|ftr|money|winner|outright)/i;
  /** Flatten interval arrays → time-sorted 3-way (result) odds timeline. */
  function buildOddsTimeline(odds) {
    var flat = [];
    (odds || []).forEach(function (item) {
      if (Array.isArray(item)) flat = flat.concat(item); else flat.push(item);
    });
    var norm = flat.map(normalizeOddsPayload).filter(Boolean);
    // If any payload self-identifies as a result market, keep only that family.
    var resultish = norm.filter(function (o) { return typeof o.superOddsType === "string" && RESULTISH.test(o.superOddsType); });
    var chosen = resultish.length ? resultish : norm;
    chosen.sort(function (a, b) { return a.ts - b.ts; });
    return chosen;
  }
  /** Latest odds at-or-before ts (falls back to earliest, then synthetic). */
  function oddsAtTs(timeline, ts) {
    if (!timeline || !timeline.length) return DEFAULT_ODDS;
    var best = null;
    for (var i = 0; i < timeline.length; i++) {
      if (timeline[i].ts <= ts) best = timeline[i]; else break;
    }
    var o = best || timeline[0];
    return {
      home: o.home, draw: o.draw, away: o.away, ts: o.ts, sourceTs: o.sourceTs,
      messageId: o.messageId, bookmaker: o.bookmaker, market: o.market, period: o.period,
      superOddsType: o.superOddsType, inRunning: o.inRunning, priceNames: o.priceNames,
    };
  }

  // ---------------------------------------------------------- TxReplay tape builder
  // Game phase codes → in-play base minute (real ts includes breaks; this collapses them).
  var GS_CODES = { NS: 1, H1: 2, HT: 3, H2: 4, Finished: 5, WET: 6, ET1: 7, HTET: 8, ET2: 9, FET: 10, WPE: 11, PE: 12, FPE: 13 };
  var GS_INPLAY_BASE = { 2: 0, 4: 45, 7: 90, 9: 105, 12: 120 };
  var KICKOFF_BASES = [0, 45, 90, 105, 120];
  function inPlayBase(gs) {
    if (gs == null) return null;
    var code = typeof gs === "number" ? gs : (GS_CODES[gs] !== undefined ? GS_CODES[gs] : Number(gs));
    return GS_INPLAY_BASE[code] !== undefined ? GS_INPLAY_BASE[code] : null;
  }

  /**
   * Merge real historical scores + odds intervals into one time-ordered, TxMock-shaped tape.
   * bundle: {fixture?, historical: ScoreUpdate[], odds?: OddsPayload[]|OddsPayload[][]}
   * Returns {fixture, events, oddsTimeline}. Real seq values are preserved untouched.
   */
  function buildTape(bundle) {
    bundle = bundle || {};
    var fixture = normalizeFixture(bundle.fixture) || null;
    var historical = Array.isArray(bundle.historical) ? bundle.historical : (Array.isArray(bundle) ? bundle : []);
    var oddsTimeline = buildOddsTimeline(bundle.odds);

    var sorted = historical.slice().sort(function (a, b) {
      var ta = normTs(a), tb = normTs(b);
      if (ta !== tb) return (isNaN(ta) ? 0 : ta) - (isNaN(tb) ? 0 : tb);
      return (normSeq(a) || 0) - (normSeq(b) || 0);
    });

    var running = { c1: 0, c2: 0, g1: 0, g2: 0, y1: 0, y2: 0, r1: 0, r2: 0, s1: 0, s2: 0 };
    var periodBase = 0, periodStartTs = null, kickoffCount = 0;
    var events = [];

    sorted.forEach(function (u) {
      var ts = normTs(u);
      var raw = rawAction(u);
      var type = mapAction(raw, u);
      var team = resolveTeam(u, fixture);
      var detail = extractDetail(u, type);
      // StatusId is numeric and matches GS_CODES/GS_INPLAY_BASE directly; prefer it —
      // some feeds leave the string GameState stuck at a placeholder (e.g. "scheduled")
      // for the whole match, which silently disables period tracking below.
      var gs = pick(u, "StatusId", "statusId", "GameState", "gameState");

      // period tracking (collapses HT/ET breaks into mock-style match minutes)
      var base = inPlayBase(gs);
      if (base !== null && (periodStartTs === null || base !== periodBase)) {
        periodBase = base; periodStartTs = ts; kickoffCount++;
      } else if (base === null && type === "kickoff") {
        periodBase = KICKOFF_BASES[Math.min(kickoffCount, KICKOFF_BASES.length - 1)];
        periodStartTs = ts; kickoffCount++;
      }
      var minute = periodStartTs === null || isNaN(ts) ? 0
        : periodBase + Math.max(0, Math.floor((ts - periodStartTs) / 60000));

      // stats: trust the real on-chain stats map when present; otherwise accumulate like the mock
      var statsMap = pick(u, "Stats", "stats");
      var applied = applyStatsMap(statsMap, running);
      if (!applied) accumulateFromEvent(type, detail, team, running);
      else if (type === "shot" && team) running["s" + team]++; // shots aren't in statKeys 1–8

      var e = {
        seq: normSeq(u),                 // REAL seq — never synthesized (proofs require it)
        minute: minute,
        ts: ts,
        type: type,
        team: team,
        detail: detail,
        gameState: gs,
        stats: { c1: running.c1, c2: running.c2, g1: running.g1, g2: running.g2, y1: running.y1, y2: running.y2, r1: running.r1, r2: running.r2, s1: running.s1, s2: running.s2 },
        teamName: team === 1 ? fxPartName(fixture, 1) : team === 2 ? fxPartName(fixture, 2) : "—",
        odds: oddsAtTs(oddsTimeline, ts),
        raw: u,
      };
      events.push(e);
    });

    return { fixture: fixture, events: events, oddsTimeline: oddsTimeline };
  }

  /** VAR go/no-go: count VAR actions + verdict transitions. PASS needs >= 2 clean review→verdict pairs. */
  function varCheck(eventsOrHistorical) {
    var arr = eventsOrHistorical || [];
    var events = arr.map(function (e) {
      if (e && typeof e.type === "string") return e;
      return { type: mapAction(rawAction(e), e), seq: normSeq(e), ts: normTs(e) };
    }).slice().sort(function (a, b) { return (a.ts || 0) - (b.ts || 0) || (a.seq || 0) - (b.seq || 0); });
    var varActions = 0, verdicts = 0, clean = 0, open = 0, samples = [];
    events.forEach(function (e) {
      if (e.type === "var") { varActions++; open++; samples.push({ seq: e.seq, type: "var", detail: e.detail }); }
      else if (e.type === "var_verdict") {
        verdicts++;
        samples.push({ seq: e.seq, type: "var_verdict", detail: e.detail });
        if (open > 0) { clean++; open--; }
      }
    });
    return { varActions: varActions, verdicts: verdicts, cleanReviews: clean, verdict: clean >= 2 ? "PASS" : "THIN", samples: samples };
  }

  // ---------------------------------------------------------- loading (cache-first, then network)
  function useBundle(bundle) {
    var tape = buildTape(bundle);
    state.fixture = tape.fixture || (tape.events.length ? normalizeFixture({ FixtureId: state.fixtureId }) : null);
    state.events = tape.events;
    state.oddsTimeline = tape.oddsTimeline;
    state.loaded = tape.events.length > 0;
    if (bundle && bundle.fixtureId && state.fixture && !state.fixture.FixtureId) state.fixture.FixtureId = Number(bundle.fixtureId);
    return tape;
  }

  function readCacheFile(fixtureId, explicitPath) {
    if (!IS_NODE) return null;
    try {
      var fs = require("fs"), path = require("path");
      var candidates = explicitPath ? [explicitPath] : [
        path.resolve(process.cwd(), state.cacheDir, fixtureId + ".json"),
        path.resolve(__dirname, state.cacheDir, fixtureId + ".json"),
      ];
      for (var i = 0; i < candidates.length; i++) {
        if (fs.existsSync(candidates[i])) return JSON.parse(fs.readFileSync(candidates[i], "utf8"));
      }
    } catch (e) { /* fall through to network */ }
    return null;
  }

  /** Fetch historical scores + all covering 5-min odds intervals + fixture meta from the live API. */
  function fetchBundle(fixtureId) {
    return fetchHistorical(fixtureId).then(function (historical) {
      if (!Array.isArray(historical) || !historical.length) {
        throw TxRealError(0, "historical empty for fixture " + fixtureId,
          "fixture must have STARTED 6h–2 weeks ago; pick another via txline-cli.js fixtures");
      }
      var tss = historical.map(normTs).filter(function (t) { return !isNaN(t); });
      var lo = Math.min.apply(null, tss) - 10 * 60000, hi = Math.max.apply(null, tss) + 10 * 60000;
      var buckets = intervalsBetween(lo, hi);
      var odds = [];
      var chain = Promise.resolve();
      buckets.forEach(function (b) {
        chain = chain.then(function () {
          return oddsInterval(b.epochDay, b.hourOfDay, b.interval, fixtureId).then(function (page) {
            if (Array.isArray(page) && page.length) odds = odds.concat(page);
          }).catch(function () { /* empty/missing bucket — fine */ });
        });
      });
      return chain.then(function () {
        return fetchFixtures({ startEpochDay: epochDayOf(lo) }).catch(function () { return []; }).then(function (fxs) {
          var fixture = null;
          (fxs || []).forEach(function (f) {
            var nf = normalizeFixture(f);
            if (nf && nf.FixtureId === Number(fixtureId)) fixture = f;
          });
          return { fixtureId: Number(fixtureId), fixture: fixture, historical: historical, odds: odds, pulledAt: new Date().toISOString() };
        });
      });
    });
  }

  /**
   * Load the replay tape. Priority: opts.data > window.TXLINE_TAPE > fixtures-cache/<id>.json (node) > live API.
   * Resolves {fixture, events}.
   */
  function load(opts) {
    opts = opts || {};
    resolve();
    if (opts.fixtureId) state.fixtureId = Number(opts.fixtureId);
    var bundle = opts.data || (root && root.TXLINE_TAPE) || null;
    if (!bundle) bundle = readCacheFile(state.fixtureId, opts.cacheFile);
    if (bundle) { useBundle(bundle); return Promise.resolve({ fixture: state.fixture, events: state.events }); }
    if (!state.fixtureId) {
      return Promise.reject(TxRealError(0, "no tape and no fixtureId",
        "configure({fixtureId}) / TXLINE_FIXTURE env / .txline.json, or preload window.TXLINE_TAPE"));
    }
    return fetchBundle(state.fixtureId).then(function (b) {
      useBundle(b);
      return { fixture: state.fixture, events: state.events };
    });
  }

  // ---------------------------------------------------------- mock-parity surface
  /**
   * Same semantics as TxMock.stream: replays the tape. speed = sim-minutes per real second.
   * Auto-loads the tape first if needed (add onError to observe load failures).
   */
  function stream(opts) {
    opts = opts || {};
    var speed = opts.speed == null ? 2 : opts.speed;
    var from = opts.from || 0;
    var stopped = false, iv = null;
    var handle = { seeded: [], stop: function () { stopped = true; if (iv) clearInterval(iv); } };

    function start() {
      var EVENTS = state.events;
      var i = 0;
      while (i < EVENTS.length && EVENTS[i].minute < from) i++;
      handle.seeded = EVENTS.slice(0, i);
      var simMin = from;
      iv = setInterval(function () {
        if (stopped) return;
        simMin += speed * 0.25;
        while (i < EVENTS.length && EVENTS[i].minute <= simMin) {
          var e = EVENTS[i++];
          opts.onEvent && opts.onEvent(e);
          opts.onOdds && opts.onOdds(e.odds, e.minute);
          if (e.type === "game_finalised") { clearInterval(iv); opts.onDone && opts.onDone(e); return; }
        }
        if (i >= EVENTS.length) { clearInterval(iv); opts.onDone && opts.onDone(EVENTS[EVENTS.length - 1] || null); }
      }, 250);
    }

    if (state.loaded) start();
    else load({ fixtureId: opts.fixtureId }).then(function () { if (!stopped) start(); })
      .catch(function (err) {
        state.lastError = err;
        if (opts.onError) opts.onError(err);
        else if (typeof console !== "undefined") console.warn("[TxReal] stream: tape load failed:", err.message);
      });
    return handle;
  }

  /**
   * Real proof via GET /api/scores/stat-validation (mock-compatible fields kept).
   * Async (the mock's is sync — await it). Network failure returns explicitly
   * labeled simulated data and never claims cryptographic verification.
   */
  function proofFor(statKey, value, seq) {
    resolve();
    var fixtureId = (state.fixture && state.fixture.FixtureId) || state.fixtureId;
    var network = state.network || "devnet";
    function offlineFallback(error) {
      var leaf = hash("leaf:" + fixtureId + ":" + statKey + ":" + value + ":" + seq);
      var path = [1, 2, 3, 4].map(function (i) { return { hash: hash("node:" + leaf + ":" + i), isRightSibling: i % 2 === 0 }; });
      var rootHash = hash("root:" + leaf + ":" + path.map(function (p) { return p.hash; }).join(""));
      return {
        fixtureId: fixtureId, statKey: statKey, value: value, seq: seq,
        leaf: null, path: null, onChainRoot: null, rootPda: null, txSig: null,
        proofStatus: "offline_simulated", verificationStatus: "not_verified",
        verified: false, cryptographicallyVerified: false,
        offline: true, simulated: true, apiReceived: false, real: null,
        simulatedProof: {
          leaf: leaf, path: path, rootHash: rootHash,
          rootPda: PROGRAM_IDS[network] + "/daily_scores_roots/" + epochDayOf(Date.now()),
          pseudoTxSig: fakeSig("settle:" + statKey + ":" + seq),
        },
        error: error,
      };
    }
    return statValidation(fixtureId, seq, [statKey]).then(function (real) {
      var sub = real && (pick(real, "subTreeProof", "SubTreeProof") || null);
      var main = real && (pick(real, "mainTreeProof", "MainTreeProof") || null);
      var leaf = (real && pick(real, "leaf", "Leaf")) || (sub && pick(sub, "leaf", "Leaf")) || null;
      var path = (sub && (pick(sub, "path", "Path", "proof", "Proof") || (Array.isArray(sub) ? sub : null))) || null;
      var rootHash = (real && pick(real, "root", "Root", "mainTreeRoot", "MainTreeRoot")) ||
        (main && pick(main, "root", "Root")) || null;
      return {
        fixtureId: fixtureId, statKey: statKey, value: value, seq: seq,
        leaf: leaf, path: path, onChainRoot: rootHash, rootPda: null, txSig: null,
        proofStatus: "api_received", verificationStatus: "not_verified",
        verified: false, cryptographicallyVerified: false,
        offline: false, simulated: false, apiReceived: true, real: real,
      };
    }).catch(function (e) {
      return offlineFallback(String(e && e.message || e));
    });
  }

  // sync (cached) mock-parity getters
  function fixtures() { return state.fixture ? [state.fixture] : [PLACEHOLDER_FIXTURE]; }
  function historical() { return state.events; }
  function oddsSnapshot() {
    if (state.oddsTimeline.length) {
      var o = state.oddsTimeline[0];
      return { home: o.home, draw: o.draw, away: o.away };
    }
    return state.events.length ? state.events[0].odds : DEFAULT_ODDS;
  }

  // ---------------------------------------------------------- exports
  var TxReal = {
    // ---- mock-parity surface (same names as TxMock) ----
    proofFor: proofFor, stream: stream, hash: hash, fakeSig: fakeSig,
    fixtures: fixtures, historical: historical, oddsSnapshot: oddsSnapshot,
    // ---- config / auth / loading ----
    configure: configure, auth: auth, refreshJwt: auth, load: load, _reset: _reset,
    // ---- raw REST getters (async, live API) ----
    fetchFixtures: fetchFixtures, fixtureUpdates: fixtureUpdates, fixtureValidation: fixtureValidation,
    fetchOddsSnapshot: fetchOddsSnapshot, oddsUpdates: oddsUpdates, oddsInterval: oddsInterval,
    oddsValidation: oddsValidation, scoresSnapshot: scoresSnapshot, fetchHistorical: fetchHistorical,
    scoresInterval: scoresInterval, statValidation: statValidation, fetchBundle: fetchBundle,
    // ---- live SSE ----
    streamLive: streamLive, parseSSEChunk: parseSSEChunk,
    // ---- replay internals (unit-tested) ----
    buildTape: buildTape, useBundle: useBundle, mapAction: mapAction, varCheck: varCheck,
    buildOddsTimeline: buildOddsTimeline, normalizeOddsPayload: normalizeOddsPayload,
    normalizeFixture: normalizeFixture, buildHeaders: buildHeaders, buildQs: buildQs,
    // ---- math / encoding helpers ----
    epochDayOf: epochDayOf, hourOf: hourOf, intervalOf: intervalOf, bucketOf: bucketOf,
    intervalsBetween: intervalsBetween, statKeyFor: statKeyFor, decodeStatKey: decodeStatKey,
    PERIOD: PERIOD, BASE_KEYS: BASE_KEYS, HOSTS: HOSTS, PROGRAM_IDS: PROGRAM_IDS,
    TxRealError: TxRealError,
  };
  Object.defineProperty(TxReal, "FIXTURE", { enumerable: true, get: function () { return state.fixture || PLACEHOLDER_FIXTURE; } });
  Object.defineProperty(TxReal, "EVENTS", { enumerable: true, get: function () { return state.events; } });
  Object.defineProperty(TxReal, "state", { enumerable: false, get: function () { return state; } });

  // Synchronous boot from a preloaded tape (written by `txline-cli.js pull` as <id>.tape.js).
  if (root && root.TXLINE_TAPE) {
    try { useBundle(root.TXLINE_TAPE); }
    catch (e) { if (typeof console !== "undefined") console.warn("[TxReal] TXLINE_TAPE preload rejected:", e.message); }
  }

  return TxReal;
});
