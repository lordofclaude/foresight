const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,127}$/;
const HASH_RE = /^[0-9a-f]{64}$/i;
const IDEMPOTENCY_RE = /^[\x21-\x7e]{8,128}$/;
const VALIDATION_RECEIPT_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,255}$/;
const SIDES = new Set(["part1", "draw", "part2"]);
const LEGACY_SIDES = { home: "part1", away: "part2" };

export class LedgerError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = "LedgerError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const ALLOWED_TRANSITIONS = Object.freeze({
  COMMITTED: new Set(["REVEALED", "BURNED", "INVALID"]),
  REVEALED: new Set(["GRADED", "INVALID"]),
  GRADED: new Set(),
  BURNED: new Set(),
  INVALID: new Set(),
});

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
}

export async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LedgerError(400, "invalid_request", label + " must be an object");
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const extras = Object.keys(value).filter(key => !allowed.includes(key));
  if (extras.length) throw new LedgerError(400, "invalid_request", label + " contains unsupported fields: " + extras.join(", "));
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new LedgerError(400, "invalid_request", label + " must be a safe integer >= " + minimum);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) {
    throw new LedgerError(400, "invalid_request", label + " must be an ISO-8601 timestamp");
  }
  return new Date(value).toISOString();
}

function boundedJson(value, label) {
  object(value, label);
  const json = stableStringify(value);
  if (json.length > 8192) throw new LedgerError(400, "invalid_request", label + " exceeds 8 KiB");
  return JSON.parse(json);
}

export function validateOwnerId(ownerId) {
  if (typeof ownerId !== "string" || !OWNER_RE.test(ownerId)) {
    throw new LedgerError(401, "invalid_auth_subject", "auth verifier returned an invalid stable subject");
  }
  return ownerId;
}

export function validateIdempotencyKey(key) {
  if (typeof key !== "string" || !IDEMPOTENCY_RE.test(key)) {
    throw new LedgerError(400, "invalid_idempotency_key", "Idempotency-Key must be 8-128 visible ASCII characters");
  }
  return key;
}

export function validateReceiptId(receiptId) {
  if (typeof receiptId !== "string" || !/^r_[0-9a-f]{64}$/.test(receiptId)) {
    throw new LedgerError(400, "invalid_receipt_id", "receipt ID is invalid");
  }
  return receiptId;
}

export function normalizeCommit(ownerId, body) {
  validateOwnerId(ownerId);
  body = object(body, "request body");
  exactKeys(body, ["commitHash", "fixtureId", "canonicalVersion", "market", "oddsTs", "committedAt", "revealDeadline", "settleAfter", "anchor"], "request body");
  if (typeof body.commitHash !== "string" || !HASH_RE.test(body.commitHash)) {
    throw new LedgerError(400, "invalid_request", "commitHash must be 64 hexadecimal characters");
  }
  if (body.canonicalVersion !== 1) throw new LedgerError(400, "invalid_request", "canonicalVersion must be 1");
  if (body.market !== "1X2_FT") throw new LedgerError(400, "invalid_request", "market must be 1X2_FT");
  const commitHash = body.commitHash.toLowerCase();
  const committedAt = timestamp(body.committedAt, "committedAt");
  const revealDeadline = timestamp(body.revealDeadline, "revealDeadline");
  const settleAfter = timestamp(body.settleAfter, "settleAfter");
  if (committedAt > revealDeadline || revealDeadline > settleAfter) {
    throw new LedgerError(400, "invalid_deadlines", "deadlines must satisfy committedAt <= revealDeadline <= settleAfter");
  }
  return {
    receiptId: "r_" + commitHash,
    ownerId,
    commitHash,
    fixtureId: integer(body.fixtureId, "fixtureId", 1),
    canonicalVersion: 1,
    market: body.market,
    oddsTs: integer(body.oddsTs, "oddsTs"),
    committedAt, revealDeadline, settleAfter,
    anchor: boundedJson(body.anchor, "anchor"),
  };
}

function normalizedSide(side) {
  const normalized = LEGACY_SIDES[side] || side;
  if (!SIDES.has(normalized)) throw new LedgerError(400, "invalid_request", "pick side is invalid");
  return normalized;
}

async function normalizeReveal(payload, receipt) {
  exactKeys(payload, ["canonical", "salt"], "REVEALED payload");
  if (typeof payload.canonical !== "string" || !payload.canonical || payload.canonical.length > 8192) {
    throw new LedgerError(400, "invalid_request", "REVEALED canonical must be a non-empty string no larger than 8 KiB");
  }
  if (typeof payload.salt !== "string" || !payload.salt || payload.salt.length > 512) {
    throw new LedgerError(400, "invalid_request", "REVEALED salt must be a non-empty string no larger than 512 characters");
  }
  let canonical;
  try { canonical = JSON.parse(payload.canonical); }
  catch (_) { throw new LedgerError(400, "invalid_request", "REVEALED canonical is not valid JSON"); }
  if (stableStringify(canonical) !== payload.canonical) {
    throw new LedgerError(400, "non_canonical_reveal", "REVEALED canonical bytes are not stable canonical JSON");
  }
  object(canonical, "REVEALED canonical");
  exactKeys(canonical, ["v", "wallet", "fixtureId", "market", "pick", "mkt", "oddsTs"], "REVEALED canonical");
  if (canonical.v !== receipt.canonicalVersion || canonical.fixtureId !== receipt.fixtureId || canonical.market !== receipt.market || canonical.oddsTs !== receipt.oddsTs) {
    throw new LedgerError(409, "commitment_mismatch", "revealed canonical fields do not match the committed public metadata");
  }
  if (canonical.wallet !== receipt.ownerId) {
    throw new LedgerError(409, "owner_binding_mismatch", "revealed canonical owner does not match the authenticated receipt owner");
  }
  const actualHash = await sha256(payload.canonical + "|" + payload.salt);
  if (actualHash !== receipt.commitHash) {
    throw new LedgerError(409, "commitment_mismatch", "revealed canonical bytes and salt do not match the commitment hash");
  }
  const mkt = object(canonical.mkt, "REVEALED canonical mkt");
  exactKeys(mkt, ["home", "draw", "away"], "REVEALED canonical mkt");
  for (const key of ["home", "draw", "away"]) {
    if (!Number.isFinite(mkt[key]) || mkt[key] <= 0 || mkt[key] > 1) throw new LedgerError(400, "invalid_request", "canonical market probabilities must be finite values in (0, 1]");
  }
  if (Math.abs(mkt.home + mkt.draw + mkt.away - 1) > 0.01) throw new LedgerError(400, "invalid_request", "canonical market probabilities must sum to 1");
  const pick = normalizedSide(canonical.pick);
  return { canonical: payload.canonical, salt: payload.salt, pick, probability: mkt[{ part1: "home", draw: "draw", part2: "away" }[pick]] };
}

function validationReceiptId(value) {
  if (typeof value !== "string" || !VALIDATION_RECEIPT_RE.test(value)) throw new LedgerError(400, "invalid_validation_receipt", "validationReceiptId must be 8-256 safe characters");
  return value;
}

export async function normalizeTransition(body, receipt) {
  body = object(body, "request body");
  exactKeys(body, ["type", "expectedSequence", "payload"], "request body");
  if (typeof body.type !== "string" || !Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, body.type)) {
    throw new LedgerError(400, "invalid_transition", "unsupported transition type");
  }
  const expectedSequence = integer(body.expectedSequence, "expectedSequence");
  const payload = object(body.payload, body.type + " payload");
  if (body.type === "REVEALED") return { type: body.type, expectedSequence, payload: await normalizeReveal(payload, receipt) };
  exactKeys(payload, ["validationReceiptId"], body.type + " payload");
  return { type: body.type, expectedSequence, payload: { validationReceiptId: validationReceiptId(payload.validationReceiptId) } };
}

export function normalizeVerifierResult(value, expected) {
  value = object(value, "proof verifier result");
  const common = ["status", "validationReceiptId", "action", "receiptId", "ownerId", "commitHash", "fixtureId", "market", "final", "verifiedAt", "verifier"];
  const allowed = expected.action === "GRADE" ? [...common, "winner"] : expected.action === "INVALID" ? [...common, "reason"] : common;
  exactKeys(value, allowed, "proof verifier result");
  if (value.status !== "VERIFIED" || value.validationReceiptId !== expected.validationReceiptId || value.action !== expected.action || value.receiptId !== expected.receiptId || value.ownerId !== expected.ownerId || value.commitHash !== expected.commitHash || value.fixtureId !== expected.fixtureId || value.market !== expected.market || value.final !== true) {
    throw new LedgerError(409, "validation_receipt_mismatch", "proof verifier did not verify this exact owner, receipt, commitment, fixture, and command");
  }
  const normalized = {
    status: "VERIFIED", validationReceiptId: value.validationReceiptId, action: value.action,
    receiptId: value.receiptId, ownerId: value.ownerId, commitHash: value.commitHash,
    fixtureId: value.fixtureId, market: value.market, final: true,
    verifiedAt: timestamp(value.verifiedAt, "proof verifier verifiedAt"), verifier: validateOwnerId(value.verifier),
  };
  if (expected.action === "GRADE") normalized.winner = normalizedSide(value.winner);
  if (expected.action === "INVALID") {
    if (typeof value.reason !== "string" || value.reason.length < 3 || value.reason.length > 256) throw new LedgerError(502, "invalid_proof_verifier_response", "proof verifier INVALID reason must be 3-256 characters");
    normalized.reason = value.reason;
  }
  return normalized;
}

export function assertTransition(current, next) {
  if (!ALLOWED_TRANSITIONS[current] || !ALLOWED_TRANSITIONS[current].has(next)) {
    throw new LedgerError(409, "illegal_transition", current + " cannot transition to " + next);
  }
}
