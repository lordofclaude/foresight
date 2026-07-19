export const RECEIPT_ID_RE = /^r_[0-9a-f]{64}$/;
export const EVIDENCE_ID_RE = /^evd_[0-9a-f]{64}$/;
export const OWNER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,127}$/;
export const SOLANA_SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const SOLANA_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{32,100}$/;
const EVIDENCE_KINDS = new Set(["API_RECEIPT", "SOLANA_MEMO", "ATOMIC_CLIENT_SETTLEMENT", "PROGRAM_STATE"]);
const EVIDENCE_STATUSES = new Set(["RECEIVED_UNVERIFIED", "VERIFIED", "MECHANISM_ONLY", "NOT_SHIPPED"]);
export const DEFAULT_LEDGER_ALLOWLIST = Object.freeze([
  "https://foresight-ledger.lordofclaude.workers.dev",
  "http://127.0.0.1:8787",
  "http://localhost:8787"
]);

export class ProofPageError extends Error {
  constructor(code, message) { super(message); this.name = "ProofPageError"; this.code = code; }
}

function fail(code, message) { throw new ProofPageError(code, message); }
export function validateReceiptId(value) {
  if (typeof value !== "string" || !RECEIPT_ID_RE.test(value)) fail("invalid_receipt_id", "Receipt ID must be r_ followed by 64 lowercase hexadecimal characters.");
  return value;
}
export function validateOwnerId(value) {
  if (typeof value !== "string" || !OWNER_ID_RE.test(value)) fail("invalid_owner_id", "Owner ID is missing or invalid.");
  return value;
}
export function validateEvidenceId(value) {
  if (typeof value !== "string" || !EVIDENCE_ID_RE.test(value)) fail("invalid_evidence_id", "Evidence ID is invalid.");
  return value;
}

export function resolveLedgerOrigin(config = {}) {
  if (typeof config.ledgerOrigin !== "string" || !config.ledgerOrigin) fail("missing_ledger_origin", "No trusted ledger origin is configured.");
  let url;
  try { url = new URL(config.ledgerOrigin); } catch (_) { fail("invalid_ledger_origin", "Ledger origin is not a valid URL."); }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) fail("invalid_ledger_origin", "Ledger configuration must be a bare HTTP(S) origin.");
  const allowed = Array.isArray(config.allowedLedgerOrigins) ? config.allowedLedgerOrigins : DEFAULT_LEDGER_ALLOWLIST;
  if (!allowed.includes(url.origin)) fail("untrusted_ledger_origin", "Configured ledger origin is not allowlisted.");
  return url.origin;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_ledger_response", label + " must be an object.");
  return value;
}
function array(value, label) { if (!Array.isArray(value)) fail("invalid_ledger_response", label + " must be an array."); return value; }
function boundedString(value, label, max = 8192) {
  if (typeof value !== "string" || value.length > max) fail("invalid_ledger_response", label + " is invalid.");
  return value;
}
function finiteInteger(value, label) { if (!Number.isSafeInteger(value) || value < 0) fail("invalid_ledger_response", label + " is invalid."); return value; }
function timestamp(value, label) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail("invalid_ledger_response", label + " is invalid."); return new Date(value).toISOString(); }

export function normalizeEvidence(input) {
  const value = object(input, "Evidence");
  const commitHash = boundedString(value.commitHash, "commitHash", 64);
  if (!HASH_RE.test(commitHash)) fail("invalid_ledger_response", "Evidence commitHash is invalid.");
  if (!EVIDENCE_KINDS.has(value.evidenceKind) || !EVIDENCE_STATUSES.has(value.evidenceStatus)) fail("invalid_ledger_response", "Evidence kind or status is invalid.");
  if (typeof value.programOwned !== "boolean" || typeof value.final !== "boolean") fail("invalid_ledger_response", "Evidence booleans are invalid.");
  if (value.rootHash !== null && (typeof value.rootHash !== "string" || !HASH_RE.test(value.rootHash))) fail("invalid_ledger_response", "Evidence rootHash is invalid.");
  if (value.txSignature !== null && (typeof value.txSignature !== "string" || !SOLANA_SIGNATURE_RE.test(value.txSignature))) fail("invalid_ledger_response", "Evidence transaction signature is invalid.");
  if (value.programId !== null && (typeof value.programId !== "string" || !SOLANA_ID_RE.test(value.programId))) fail("invalid_ledger_response", "Evidence program ID is invalid.");
  return Object.freeze({
    evidenceId: validateEvidenceId(value.evidenceId),
    validationReceiptId: boundedString(value.validationReceiptId, "validationReceiptId", 256),
    receiptId: validateReceiptId(value.receiptId), ownerId: validateOwnerId(value.ownerId),
    commitHash, fixtureId: finiteInteger(value.fixtureId, "fixtureId"),
    market: boundedString(value.market, "market", 32), verifier: boundedString(value.verifier, "verifier", 128),
    evidenceKind: boundedString(value.evidenceKind, "evidenceKind", 64), evidenceStatus: boundedString(value.evidenceStatus, "evidenceStatus", 64),
    purpose: boundedString(value.purpose, "purpose", 64), transitionType: boundedString(value.transitionType, "transitionType", 16),
    rootHash: value.rootHash,
    slot: value.slot === null ? null : finiteInteger(value.slot, "slot"),
    txSignature: value.txSignature,
    messageId: value.messageId === null ? null : boundedString(value.messageId, "messageId", 512),
    programId: value.programId,
    programOwned: value.programOwned, final: value.final,
    winner: value.winner === null ? null : boundedString(value.winner, "winner", 16),
    observedAt: timestamp(value.observedAt, "observedAt"),
    metadata: object(value.metadata || {}, "metadata"), payloadHash: boundedString(value.payloadHash, "payloadHash", 64),
    createdAt: timestamp(value.createdAt, "createdAt")
  });
}

function normalizeEvent(input) {
  const value = object(input, "Event");
  return Object.freeze({
    eventId: boundedString(value.eventId, "eventId", 80), sequence: finiteInteger(value.sequence, "sequence"),
    type: boundedString(value.type, "event type", 16), previousEventId: value.previousEventId === null ? null : boundedString(value.previousEventId, "previousEventId", 80),
    payload: object(value.payload || {}, "event payload"), createdAt: timestamp(value.createdAt, "event createdAt")
  });
}

export function normalizeReceipt(input) {
  const value = object(input, "Receipt");
  const receiptId = validateReceiptId(value.receiptId), commitHash = boundedString(value.commitHash, "commitHash", 64);
  if (receiptId !== "r_" + commitHash || !/^[0-9a-f]{64}$/.test(commitHash)) fail("invalid_ledger_response", "Receipt ID does not bind commitHash.");
  const receipt = {
    receiptId, ownerId: validateOwnerId(value.ownerId), fixtureId: finiteInteger(value.fixtureId, "fixtureId"), commitHash,
    canonicalVersion: value.canonicalVersion, market: boundedString(value.market, "market", 32), oddsTs: finiteInteger(value.oddsTs, "oddsTs"),
    committedAt: timestamp(value.committedAt, "committedAt"), revealDeadline: timestamp(value.revealDeadline, "revealDeadline"),
    settleAfter: timestamp(value.settleAfter, "settleAfter"), anchor: object(value.anchor || {}, "anchor"),
    createdAt: timestamp(value.createdAt, "createdAt"), state: boundedString(value.state, "state", 16),
    events: array(value.events || [], "events").map(normalizeEvent),
    evidenceChain: array(value.evidenceChain || [], "evidenceChain").map(normalizeEvidence)
  };
  for (let index = 0; index < receipt.events.length; index++) {
    const event = receipt.events[index], previous = receipt.events[index - 1];
    if (event.sequence !== index || (index === 0 ? event.type !== "COMMITTED" || event.previousEventId !== null : event.previousEventId !== previous.eventId)) fail("invalid_ledger_response", "Receipt event chain is not contiguous.");
  }
  if (receipt.events.length && receipt.state !== receipt.events.at(-1).type) fail("invalid_ledger_response", "Receipt state does not match its latest event.");
  for (const evidence of receipt.evidenceChain) {
    if (evidence.receiptId !== receiptId || evidence.ownerId !== receipt.ownerId || evidence.commitHash !== commitHash || evidence.fixtureId !== receipt.fixtureId || evidence.market !== receipt.market) fail("invalid_ledger_response", "Evidence chain contains a cross-receipt binding.");
  }
  if (new Set(receipt.evidenceChain.map(item => item.evidenceId)).size !== receipt.evidenceChain.length) fail("invalid_ledger_response", "Evidence chain contains duplicate IDs.");
  return Object.freeze(receipt);
}

export function normalizeProfile(input) {
  const value = object(input, "Profile");
  const ownerId = validateOwnerId(value.ownerId);
  const receipts = array(value.receipts || [], "receipts").map(item => {
    const row = object(item, "profile receipt");
    const evidenceChain = array(row.evidenceChain || [], "profile evidenceChain").map(normalizeEvidence);
    if (validateOwnerId(row.ownerId) !== ownerId) fail("invalid_ledger_response", "Profile contains another owner.");
    const receiptId = validateReceiptId(row.receiptId), commitHash = boundedString(row.commitHash, "commitHash", 64), fixtureId = finiteInteger(row.fixtureId, "fixtureId"), market = boundedString(row.market, "market", 32);
    if (receiptId !== "r_" + commitHash || !HASH_RE.test(commitHash)) fail("invalid_ledger_response", "Profile receipt ID does not bind commitHash.");
    for (const evidence of evidenceChain) if (evidence.receiptId !== receiptId || evidence.ownerId !== ownerId || evidence.commitHash !== commitHash || evidence.fixtureId !== fixtureId || evidence.market !== market) fail("invalid_ledger_response", "Profile evidence contains a cross-receipt binding.");
    if (new Set(evidenceChain.map(item => item.evidenceId)).size !== evidenceChain.length) fail("invalid_ledger_response", "Profile evidence contains duplicate IDs.");
    const state = boundedString(row.state, "state", 16);
    const latestEvent = row.latestEvent ? normalizeEvent(row.latestEvent) : null;
    if (latestEvent && latestEvent.type !== state) fail("invalid_ledger_response", "Profile receipt state does not match its latest event.");
    return Object.freeze({
      receiptId, ownerId, fixtureId,
      commitHash, market,
      committedAt: timestamp(row.committedAt, "committedAt"), state,
      latestEvent, evidenceChain
    });
  });
  return Object.freeze({ ownerId, receipts });
}

async function fetchJson(fetchImpl, url) {
  let response;
  try { response = await fetchImpl(url, { headers: { Accept: "application/json" }, credentials: "omit", referrerPolicy: "no-referrer" }); }
  catch (_) { fail("ledger_unavailable", "Ledger request failed."); }
  if (!response || !response.ok) fail(response?.status === 404 ? "not_found" : "ledger_unavailable", response?.status === 404 ? "Public ledger record was not found." : "Ledger request failed.");
  const contentType = response.headers?.get?.("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) fail("invalid_ledger_response", "Ledger did not return JSON.");
  let body; try { body = await response.json(); } catch (_) { fail("invalid_ledger_response", "Ledger returned invalid JSON."); }
  return body;
}

export function createLedgerClient(config = {}, fetchImpl = globalThis.fetch) {
  const origin = resolveLedgerOrigin(config);
  if (typeof fetchImpl !== "function") fail("ledger_unavailable", "Fetch is unavailable.");
  return Object.freeze({
    origin,
    async getReceipt(receiptId) { return normalizeReceipt(await fetchJson(fetchImpl, origin + "/v1/receipts/" + validateReceiptId(receiptId))); },
    async getProfile(ownerId) { return normalizeProfile(await fetchJson(fetchImpl, origin + "/v1/profiles/" + encodeURIComponent(validateOwnerId(ownerId)))); }
  });
}

export function safeExplorerUrl(signature, network) {
  if (typeof signature !== "string" || !SOLANA_SIGNATURE_RE.test(signature)) return null;
  if (!new Set(["devnet", "mainnet-beta"]).has(network)) return null;
  const url = new URL("https://explorer.solana.com/tx/" + signature);
  if (network === "devnet") url.searchParams.set("cluster", "devnet");
  return url.toString();
}
