export const SIGNING_DOMAIN = "FORESIGHT_AGENT_COMMIT_V1\n";
export const PRICE_TOTAL_PPM = 1_000_000;

export class IngestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "IngestError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, message, status = 400) {
  throw new IngestError(code, message, status);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_schema", `${label} must be an object`);
  return value;
}

function exactKeys(value, allowed, label) {
  object(value, label);
  const extras = Object.keys(value).filter(key => !allowed.includes(key));
  const missing = allowed.filter(key => !(key in value));
  if (extras.length || missing.length) {
    fail("invalid_schema", `${label} keys invalid (missing: ${missing.join(", ") || "none"}; extra: ${extras.join(", ") || "none"})`);
  }
}

function text(value, label, pattern, min = 1, max = 160) {
  if (typeof value !== "string" || value.length < min || value.length > max || (pattern && !pattern.test(value))) {
    fail("invalid_schema", `${label} is invalid`);
  }
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value)) fail("invalid_schema", `${label} must be a safe integer`);
  return value;
}

export function canonicalize(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("invalid_schema", "canonical numbers must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  fail("invalid_schema", "unsupported canonical value");
}

export function decodeBase64Url(value, label = "base64url value") {
  text(value, label, /^[A-Za-z0-9_-]+$/, 1, 2048);
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    fail("invalid_schema", `${label} is not valid base64url`);
  }
}

export function encodeUtf8(value) {
  return new TextEncoder().encode(value);
}

export function validateEnvelope(input) {
  exactKeys(input, ["payload", "signature"], "envelope");
  const payload = object(input.payload, "payload");
  exactKeys(payload, [
    "version", "agentId", "ownerId", "fixtureId", "market", "selection",
    "nonce", "issuedAtMs", "quote", "proof"
  ], "payload");
  if (payload.version !== 1) fail("unsupported_version", "payload.version must be 1");
  text(payload.agentId, "payload.agentId", /^[A-Za-z0-9][A-Za-z0-9_-]*$/, 3, 80);
  text(payload.ownerId, "payload.ownerId", /^[A-Za-z0-9][A-Za-z0-9_-]*$/, 3, 80);
  text(payload.fixtureId, "payload.fixtureId", /^[A-Za-z0-9][A-Za-z0-9_-]*$/, 1, 80);
  text(payload.market, "payload.market", /^[A-Z0-9_]+$/, 2, 64);
  text(payload.selection, "payload.selection", /^[a-z0-9_]+$/, 1, 32);
  text(payload.nonce, "payload.nonce", /^[A-Za-z0-9_-]+$/, 16, 128);
  integer(payload.issuedAtMs, "payload.issuedAtMs");

  exactKeys(payload.quote, ["quoteId", "source", "observedAtMs", "pricesPpm"], "payload.quote");
  text(payload.quote.quoteId, "payload.quote.quoteId", /^[A-Za-z0-9:._/-]+$/, 3, 160);
  text(payload.quote.source, "payload.quote.source", /^[A-Za-z0-9._-]+$/, 2, 64);
  integer(payload.quote.observedAtMs, "payload.quote.observedAtMs");
  exactKeys(payload.quote.pricesPpm, ["part1", "draw", "part2"], "payload.quote.pricesPpm");
  const prices = ["part1", "draw", "part2"].map(side => integer(payload.quote.pricesPpm[side], `price ${side}`));
  if (prices.some(price => price < 0 || price > PRICE_TOTAL_PPM) || prices.reduce((sum, price) => sum + price, 0) !== PRICE_TOTAL_PPM) {
    fail("invalid_prices", `pricesPpm must be non-negative and sum to ${PRICE_TOTAL_PPM}`);
  }

  exactKeys(payload.proof, ["kind", "reference", "quoteDigest"], "payload.proof");
  text(payload.proof.kind, "payload.proof.kind", /^[A-Za-z0-9._-]+$/, 2, 64);
  text(payload.proof.reference, "payload.proof.reference", /^[A-Za-z0-9:._/-]+$/, 3, 200);
  text(payload.proof.quoteDigest, "payload.proof.quoteDigest", /^sha256:[a-f0-9]{64}$/, 71, 71);
  text(input.signature, "signature", /^[A-Za-z0-9_-]+$/, 40, 512);
  return input;
}

export function signingMessage(payload) {
  return `${SIGNING_DOMAIN}${canonicalize(payload)}`;
}

async function requiredCall(label, action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof IngestError) throw error;
    fail("dependency_unavailable", `${label} unavailable`, 503);
  }
}

export function createCommitService(dependencies, options = {}) {
  const required = ["registry", "ownerAuth", "signatureVerifier", "hasher", "fixturePolicy", "quoteProofVerifier", "rateLimiter", "store"];
  for (const name of required) {
    if (!dependencies || !dependencies[name]) throw new Error(`missing required dependency: ${name}`);
  }
  const maxAgeMs = options.maxAgeMs ?? 5 * 60_000;
  const maxFutureSkewMs = options.maxFutureSkewMs ?? 15_000;
  const maxQuoteAgeMs = options.maxQuoteAgeMs ?? 10 * 60_000;

  return {
    async submit({ body, authorization, nowMs = Date.now() }) {
      validateEnvelope(body);
      const { payload, signature } = body;
      integer(nowMs, "nowMs");

      const agent = await requiredCall("agent registry", () => dependencies.registry.get(payload.agentId));
      if (!agent || typeof agent !== "object" || !agent.publicKey || !agent.ownerId) {
        fail("agent_not_registered", "agent is not registered", 401);
      }
      if (agent.ownerId !== payload.ownerId) fail("owner_mismatch", "agent is not registered to this owner", 403);
      const ownerAllowed = await requiredCall("owner authentication", () =>
        dependencies.ownerAuth.verify({ ownerId: payload.ownerId, authorization }));
      if (ownerAllowed !== true) fail("owner_auth_failed", "owner authentication failed", 401);

      if (payload.issuedAtMs < nowMs - maxAgeMs) fail("stale_timestamp", "submission timestamp is too old");
      if (payload.issuedAtMs > nowMs + maxFutureSkewMs) fail("future_timestamp", "submission timestamp is too far in the future");
      if (payload.quote.observedAtMs > payload.issuedAtMs + maxFutureSkewMs) fail("future_quote", "quote is newer than the signed submission");
      if (payload.quote.observedAtMs < payload.issuedAtMs - maxQuoteAgeMs) fail("stale_quote", "quote is too old for the submission");

      const policy = await requiredCall("fixture policy", () => dependencies.fixturePolicy.get(payload.fixtureId));
      if (!policy) fail("fixture_not_allowed", "fixture is not allowlisted", 403);
      if (!Array.isArray(policy.markets) || !policy.markets.includes(payload.market)) {
        fail("market_not_allowed", "market is not allowlisted for fixture", 403);
      }
      if (!Array.isArray(policy.selections) || !policy.selections.includes(payload.selection)) {
        fail("selection_not_allowed", "selection is not valid for fixture market", 403);
      }
      if (!Number.isSafeInteger(policy.closesAtMs) || payload.issuedAtMs >= policy.closesAtMs) {
        fail("fixture_closed", "fixture commitment window is closed", 409);
      }

      const rateDecision = await requiredCall("rate limiter", () => dependencies.rateLimiter.take({
        agentId: payload.agentId,
        ownerId: payload.ownerId,
        fixtureId: payload.fixtureId,
        nowMs
      }));
      if (!rateDecision || typeof rateDecision !== "object") fail("dependency_unavailable", "rate limiter returned no decision", 503);
      if (rateDecision.allowed !== true) fail("rate_limited", "submission rate limit exceeded", 429);

      const verifiedSignature = await requiredCall("signature verifier", () => dependencies.signatureVerifier.verify({
        publicKey: agent.publicKey,
        message: encodeUtf8(signingMessage(payload)),
        signature: decodeBase64Url(signature, "signature")
      }));
      if (verifiedSignature !== true) fail("invalid_signature", "signature verification failed", 401);

      const quoteBinding = canonicalize({ fixtureId: payload.fixtureId, market: payload.market, quote: payload.quote });
      const quoteHash = await requiredCall("hash service", () => dependencies.hasher.sha256Hex(encodeUtf8(quoteBinding)));
      if (typeof quoteHash !== "string" || !/^[a-f0-9]{64}$/.test(quoteHash)) fail("dependency_unavailable", "hash service returned an invalid digest", 503);
      const computedQuoteDigest = `sha256:${quoteHash}`;
      if (computedQuoteDigest !== payload.proof.quoteDigest) fail("quote_digest_mismatch", "quote does not match its proof digest", 422);
      const proofDecision = await requiredCall("quote proof verifier", () => dependencies.quoteProofVerifier.verify({
        fixtureId: payload.fixtureId,
        market: payload.market,
        quote: payload.quote,
        proof: payload.proof
      }));
      if (!proofDecision || typeof proofDecision !== "object") fail("dependency_unavailable", "quote proof verifier returned no decision", 503);
      if (proofDecision.valid !== true) fail("quote_proof_rejected", "quote proof did not match fixture, market, or prices", 422);

      const submissionHash = await requiredCall("hash service", () =>
        dependencies.hasher.sha256Hex(encodeUtf8(signingMessage(payload))));
      if (typeof submissionHash !== "string" || !/^[a-f0-9]{64}$/.test(submissionHash)) fail("dependency_unavailable", "hash service returned an invalid digest", 503);
      const submissionDigest = `sha256:${submissionHash}`;
      const idempotencyKey = `${payload.agentId}:${payload.fixtureId}:${payload.market}`;
      const nonceKey = `${payload.agentId}:${payload.nonce}`;
      const acceptedAtMs = nowMs;
      const result = await requiredCall("commit store", () => dependencies.store.accept({
        idempotencyKey,
        nonceKey,
        submissionDigest,
        record: {
          version: 1,
          agentId: payload.agentId,
          ownerId: payload.ownerId,
          fixtureId: payload.fixtureId,
          market: payload.market,
          selection: payload.selection,
          issuedAtMs: payload.issuedAtMs,
          quoteDigest: payload.proof.quoteDigest,
          proofKind: payload.proof.kind,
          proofReference: payload.proof.reference,
          submissionDigest,
          acceptedAtMs
        }
      }));
      if (result.status === "mutation") fail("duplicate_mutation", "an immutable commitment already exists for this agent/fixture/market", 409);
      if (result.status === "replay") fail("nonce_replay", "nonce has already been used by this agent", 409);
      if (!['created', 'existing'].includes(result.status) || !result.record) {
        fail("dependency_unavailable", "commit store returned an invalid decision", 503);
      }
      return {
        status: result.status === "created" ? "accepted" : "idempotent",
        receipt: result.record
      };
    }
  };
}

export class MemoryCommitStore {
  constructor() {
    this.records = new Map();
    this.nonces = new Set();
  }

  async accept(input) {
    const existing = this.records.get(input.idempotencyKey);
    if (existing) {
      return existing.submissionDigest === input.submissionDigest
        ? { status: "existing", record: existing }
        : { status: "mutation" };
    }
    if (this.nonces.has(input.nonceKey)) return { status: "replay" };
    this.records.set(input.idempotencyKey, input.record);
    this.nonces.add(input.nonceKey);
    return { status: "created", record: input.record };
  }
}
