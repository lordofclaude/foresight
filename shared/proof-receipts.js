/* =====================================================================
   FORESIGHT proof receipts — deterministic, fail-closed relay evidence

   Relay JSON proves that an API answered a fixed validation query. It is
   not a cryptographic proof unless the response explicitly says so and
   includes the root and slot needed to audit that claim.
   ===================================================================== */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.ForesightProofReceipts = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = 1;
  const API_RECEIVED = "api_received_not_cryptographically_verified";
  const CRYPTOGRAPHICALLY_VERIFIED = "cryptographically_verified";
  const DEFAULT_MAX_AGE_MS = 60 * 1000;
  const DEFAULT_TIMEOUT_MS = 8 * 1000;
  const FUTURE_TOLERANCE_MS = 5 * 1000;

  const SEAMS = Object.freeze({
    fixture_deadline_validation: Object.freeze({
      route: "/api/fixtures/validation",
      params: ["fixtureId", "timestamp"],
    }),
    odds_validation: Object.freeze({
      route: "/api/odds/validation",
      params: ["messageId", "ts"],
    }),
    score_stat_validation: Object.freeze({
      route: "/api/scores/stat-validation",
      params: ["fixtureId", "seq", "statKeys", "expectedValue"],
    }),
  });

  class ProofReceiptError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "ProofReceiptError";
      this.code = code;
    }
  }

  function fail(code, message) {
    throw new ProofReceiptError(code, message);
  }

  function isPlainObject(value) {
    if (!value || Object.prototype.toString.call(value) !== "[object Object]") return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function canonicalValue(value, seen) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail("non_json_evidence", "proof evidence contains a non-finite number");
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      fail("non_json_evidence", "proof evidence must contain only JSON values");
    }
    if (seen.has(value)) fail("cyclic_evidence", "proof evidence must not contain cycles");
    seen.add(value);
    let normalized;
    if (Array.isArray(value)) {
      normalized = value.map(item => canonicalValue(item, seen));
    } else {
      if (!isPlainObject(value)) fail("non_json_evidence", "proof evidence must contain only plain JSON objects");
      normalized = {};
      Object.keys(value).sort().forEach(key => {
        if (typeof value[key] === "undefined") fail("non_json_evidence", "proof evidence must not contain undefined fields");
        normalized[key] = canonicalValue(value[key], seen);
      });
    }
    seen.delete(value);
    return normalized;
  }

  function canonicalize(value) {
    return canonicalValue(value, new Set());
  }

  function deterministicSerialize(value) {
    return JSON.stringify(canonicalize(value));
  }

  function positiveInteger(value, field, allowZero) {
    const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(number) || (allowZero ? number < 0 : number <= 0)) {
      fail("invalid_" + field, field + " must be a " + (allowZero ? "non-negative" : "positive") + " safe integer");
    }
    return number;
  }

  function safeToken(value, field, max) {
    if (typeof value !== "string" || !value || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(value)) {
      fail("invalid_" + field, field + " contains unsupported characters");
    }
    return value;
  }

  function normalizeBinding(binding) {
    if (!isPlainObject(binding)) fail("invalid_binding", "a canonical proof binding is required");
    const fixtureId = positiveInteger(binding.fixtureId, "fixture_id", false);
    const market = safeToken(binding.market, "market", 80);
    const side = safeToken(binding.side, "side", 40);
    const price = Number(binding.price);
    if (!Number.isFinite(price) || price <= 0 || price > 1) {
      fail("invalid_price", "price must be a finite StablePrice probability in (0, 1]");
    }
    const quoteTimestampMs = positiveInteger(binding.quoteTimestampMs, "quote_timestamp", true);
    const predictionTimestampMs = positiveInteger(binding.predictionTimestampMs, "prediction_timestamp", true);
    const fixtureDeadlineMs = positiveInteger(binding.fixtureDeadlineMs, "fixture_deadline", false);
    if (quoteTimestampMs > predictionTimestampMs) fail("invalid_timestamp_order", "quote timestamp cannot follow prediction timestamp");
    if (predictionTimestampMs >= fixtureDeadlineMs) fail("post_deadline_prediction", "prediction timestamp must precede the fixture deadline");
    return { fixtureId, market, side, price, quoteTimestampMs, predictionTimestampMs, fixtureDeadlineMs };
  }

  function normalizeRequest(kind, request, binding) {
    if (!SEAMS[kind]) fail("invalid_seam", "unsupported proof seam");
    if (!isPlainObject(request)) fail("invalid_request", "proof request must be an object");
    let normalized;
    if (kind === "fixture_deadline_validation") {
      normalized = {
        fixtureId: positiveInteger(request.fixtureId, "fixture_id", false),
        timestamp: positiveInteger(request.timestamp, "timestamp", true),
      };
      if (normalized.fixtureId !== binding.fixtureId) fail("fixture_mismatch", "deadline proof fixture does not match canonical binding");
      if (normalized.timestamp !== binding.predictionTimestampMs) fail("timestamp_mismatch", "deadline proof timestamp does not match prediction timestamp");
    } else if (kind === "odds_validation") {
      normalized = {
        messageId: safeToken(request.messageId, "message_id", 200),
        ts: positiveInteger(request.ts, "timestamp", true),
      };
      if (normalized.ts !== binding.quoteTimestampMs) fail("timestamp_mismatch", "odds proof timestamp does not match quote timestamp");
    } else {
      const fixtureId = positiveInteger(request.fixtureId, "fixture_id", false);
      const seq = positiveInteger(request.seq, "seq", true);
      if (fixtureId !== binding.fixtureId) fail("fixture_mismatch", "score proof fixture does not match canonical binding");
      if (request.statKey != null) {
        if (request.statKeys != null) fail("invalid_stat_key", "provide statKey or statKeys, not both");
        const statKey = positiveInteger(request.statKey, "stat_key", false);
        const expectedValue = positiveInteger(request.expectedValue != null ? request.expectedValue : request.value, "stat_value", true);
        normalized = { fixtureId, seq, statKeys: String(statKey), expectedValue };
      } else {
        const keys = Array.isArray(request.statKeys) ? request.statKeys : String(request.statKeys || "").split(",");
        if (!keys.length || keys.length > 8 || keys.some(key => key === "")) fail("invalid_stat_key", "statKeys must contain 1 to 8 keys");
        normalized = { fixtureId, seq, statKeys: keys.map(key => positiveInteger(key, "stat_key", false)).join(",") };
      }
    }
    return normalized;
  }

  function relayRequested(request) {
    const requested = {};
    Object.keys(request).forEach(key => { requested[key] = String(request[key]); });
    return requested;
  }

  function compareRequested(expected, actual) {
    if (!isPlainObject(actual)) fail("incomplete_response", "relay response is missing requested parameters");
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    if (expectedKeys.join("|") !== actualKeys.join("|")) fail("request_mismatch", "relay response requested parameters do not match the query");
    expectedKeys.forEach(key => {
      if (String(actual[key]) !== String(expected[key])) fail("request_mismatch", "relay response requested parameters do not match the query");
    });
  }

  function firstDefined(source, paths) {
    for (const path of paths) {
      let value = source;
      for (const key of path) value = value != null ? value[key] : undefined;
      if (value !== undefined && value !== null) return value;
    }
    return null;
  }

  function compareResponseBindings(response, binding) {
    const fixture = firstDefined(response, [["fixtureId"], ["FixtureId"], ["fixture", "id"], ["provenance", "fixtureId"]]);
    if (fixture != null && String(fixture) !== String(binding.fixtureId)) fail("fixture_mismatch", "response fixture does not match canonical binding");
    const market = firstDefined(response, [["market"], ["marketKey"], ["provenance", "market"]]);
    if (market != null && String(market) !== binding.market) fail("market_mismatch", "response market does not match canonical binding");
    const side = firstDefined(response, [["side"], ["pick"], ["selection"], ["provenance", "side"]]);
    if (side != null && String(side) !== binding.side) fail("side_mismatch", "response side does not match canonical binding");
    const price = firstDefined(response, [["price"], ["stablePrice"], ["StablePrice"], ["provenance", "price"]]);
    if (price != null && Number(price) !== binding.price) fail("price_mismatch", "response price does not match canonical binding");
    const quoteTs = firstDefined(response, [["quoteTimestampMs"], ["oddsTs"], ["provenance", "quoteTimestampMs"]]);
    if (quoteTs != null && Number(quoteTs) !== binding.quoteTimestampMs) fail("timestamp_mismatch", "response quote timestamp does not match canonical binding");
    const deadline = firstDefined(response, [["fixtureDeadlineMs"], ["deadline"], ["provenance", "fixtureDeadlineMs"]]);
    if (deadline != null && Number(deadline) !== binding.fixtureDeadlineMs) fail("timestamp_mismatch", "response fixture deadline does not match canonical binding");
  }

  function normalizeVerification(response, root, slot) {
    const crypto = response.cryptographicallyVerified === true && response.verified === true;
    if (crypto) {
      if (response.proofStatus !== CRYPTOGRAPHICALLY_VERIFIED && response.proofStatus !== "verified") {
        fail("contradictory_verification", "cryptographic verification fields contradict proofStatus");
      }
      if (root == null || slot == null) fail("incomplete_verified_proof", "verified proof requires root and slot metadata");
      return { status: CRYPTOGRAPHICALLY_VERIFIED, apiReceived: true, cryptographicallyVerified: true, verified: true };
    }
    if (response.proofStatus !== API_RECEIVED || response.apiReceived !== true || response.cryptographicallyVerified !== false || response.verified !== false) {
      fail("incomplete_response", "unverified API proof must explicitly declare its non-cryptographic status");
    }
    return { status: API_RECEIVED, apiReceived: true, cryptographicallyVerified: false, verified: false };
  }

  function normalizeProofReceipt(kind, request, binding, response, options) {
    options = options || {};
    if (!isPlainObject(response) || response.error) fail("invalid_response", "relay proof response must be a successful JSON object");
    const canonicalBinding = normalizeBinding(binding);
    const canonicalRequest = normalizeRequest(kind, request, canonicalBinding);
    const relay = response.relayReceipt;
    if (!isPlainObject(relay)) fail("incomplete_response", "relay response is missing relayReceipt");
    if (relay.capability !== kind) fail("capability_mismatch", "relay capability does not match requested proof seam");
    compareRequested(relayRequested(canonicalRequest), relay.requested);

    const receivedAtMs = Date.parse(relay.receivedAt);
    if (!Number.isFinite(receivedAtMs)) fail("incomplete_response", "relay response has no valid receivedAt timestamp");
    const nowMs = options.nowMs == null ? Date.now() : positiveInteger(options.nowMs, "now", true);
    const maxAgeMs = options.maxAgeMs == null ? DEFAULT_MAX_AGE_MS : positiveInteger(options.maxAgeMs, "max_age", true);
    if (receivedAtMs > nowMs + FUTURE_TOLERANCE_MS) fail("future_response", "relay response timestamp is in the future");
    if (nowMs - receivedAtMs > maxAgeMs) fail("stale_response", "relay proof response is stale");

    compareResponseBindings(response, canonicalBinding);
    const provenance = firstDefined(response, [["provenance"], ["proof", "provenance"], ["metadata", "provenance"]]);
    const root = firstDefined(response, [["root"], ["merkleRoot"], ["proof", "root"], ["provenance", "root"]]);
    const slotRaw = firstDefined(response, [["slot"], ["proof", "slot"], ["provenance", "slot"]]);
    const slot = slotRaw == null ? null : positiveInteger(slotRaw, "slot", true);
    const verification = normalizeVerification(response, root, slot);
    const raw = canonicalize(response);

    return canonicalize({
      version: VERSION,
      kind,
      binding: canonicalBinding,
      request: canonicalRequest,
      verification,
      evidence: {
        capability: kind,
        receivedAt: new Date(receivedAtMs).toISOString(),
        provenance: provenance == null ? null : provenance,
        root: root == null ? null : root,
        slot,
        raw,
      },
    });
  }

  function validRelayOrigin(relayOrigin, allowedOrigins) {
    let url;
    try { url = new URL(relayOrigin); } catch (_) { fail("invalid_relay_origin", "relay origin must be an absolute URL"); }
    const localHttp = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    if (url.protocol !== "https:" && !localHttp) fail("invalid_relay_origin", "relay origin must use HTTPS (HTTP is allowed only for localhost)");
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) fail("invalid_relay_origin", "relay origin must not contain credentials, a path, query, or fragment");
    const allowed = (allowedOrigins || []).map(value => {
      try { return new URL(value).origin; } catch (_) { fail("invalid_relay_allowlist", "relay allowlist contains an invalid origin"); }
    });
    if (!allowed.includes(url.origin)) fail("relay_origin_not_allowed", "relay origin is not allowlisted");
    return url.origin;
  }

  function buildSearch(kind, request) {
    const params = new URLSearchParams();
    if (kind === "score_stat_validation") {
      params.set("fixtureId", String(request.fixtureId));
      params.set("seq", String(request.seq));
      const keys = request.statKeys.split(",");
      if (keys.length === 1 && Object.prototype.hasOwnProperty.call(request, "expectedValue")) {
        params.set("statKey", keys[0]);
        params.set("value", String(request.expectedValue));
      } else {
        params.set("statKeys", request.statKeys);
      }
    } else {
      SEAMS[kind].params.forEach(key => params.set(key, String(request[key])));
    }
    return params;
  }

  function abortError(reason) {
    if (reason instanceof Error) return reason;
    if (typeof DOMException !== "undefined") return new DOMException("The operation was aborted", "AbortError");
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    return error;
  }

  function createProofReceiptClient(config) {
    config = config || {};
    const fetchImpl = config.fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    if (!fetchImpl) fail("missing_fetch", "fetch implementation is required");
    const origin = validRelayOrigin(config.relayOrigin, config.allowedOrigins);
    const timeoutMs = config.timeoutMs == null ? DEFAULT_TIMEOUT_MS : positiveInteger(config.timeoutMs, "timeout", false);
    const defaultMaxAgeMs = config.maxAgeMs == null ? DEFAULT_MAX_AGE_MS : positiveInteger(config.maxAgeMs, "max_age", true);
    const now = typeof config.now === "function" ? config.now : Date.now;

    async function requestProof(kind, request, binding, callOptions) {
      callOptions = callOptions || {};
      const canonicalBinding = normalizeBinding(binding);
      const canonicalRequest = normalizeRequest(kind, request, canonicalBinding);
      const controller = new AbortController();
      const external = callOptions.signal;
      const onAbort = () => controller.abort(external.reason);
      if (external) {
        if (external.aborted) throw abortError(external.reason);
        external.addEventListener("abort", onAbort, { once: true });
      }
      const timer = setTimeout(() => controller.abort(abortError()), timeoutMs);
      try {
        const url = origin + SEAMS[kind].route + "?" + buildSearch(kind, canonicalRequest).toString();
        const response = await fetchImpl(url, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: controller.signal,
        });
        if (!response || !response.ok) fail("relay_http_error", "relay proof request failed with HTTP " + (response ? response.status : "unknown"));
        const contentType = response.headers && response.headers.get ? response.headers.get("content-type") : null;
        if (contentType && !/^application\/json\b/i.test(contentType)) fail("invalid_content_type", "relay proof response must be JSON");
        const body = await response.json();
        return normalizeProofReceipt(kind, request, canonicalBinding, body, {
          nowMs: Number(now()),
          maxAgeMs: callOptions.maxAgeMs == null ? defaultMaxAgeMs : callOptions.maxAgeMs,
        });
      } finally {
        clearTimeout(timer);
        if (external) external.removeEventListener("abort", onAbort);
      }
    }

    return Object.freeze({
      fixtureDeadline: (request, binding, options) => requestProof("fixture_deadline_validation", request, binding, options),
      odds: (request, binding, options) => requestProof("odds_validation", request, binding, options),
      scoreStat: (request, binding, options) => requestProof("score_stat_validation", request, binding, options),
    });
  }

  return Object.freeze({
    VERSION,
    API_RECEIVED,
    CRYPTOGRAPHICALLY_VERIFIED,
    SEAMS,
    ProofReceiptError,
    normalizeBinding,
    normalizeProofReceipt,
    deterministicSerialize,
    createProofReceiptClient,
  });
});
