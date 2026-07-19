import { LedgerError } from "./src/domain.js";
import { D1LedgerRepository } from "./src/repository.js";
import { LedgerService } from "./src/service.js";

const VERSION = "0.3.0";

function headers(extra = {}) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extra,
  };
}
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: headers(extra) });
}
async function readBody(request) {
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) {
    throw new LedgerError(415, "unsupported_media_type", "writes require application/json");
  }
  try { return await request.json(); }
  catch (_) { throw new LedgerError(400, "invalid_json", "request body is not valid JSON"); }
}
function verifierUrl(env) {
  if (!env?.AUTH_VERIFY_URL) throw new LedgerError(503, "auth_not_configured", "write authentication is not configured");
  let url;
  try { url = new URL(env.AUTH_VERIFY_URL); }
  catch (_) { throw new LedgerError(503, "auth_not_configured", "AUTH_VERIFY_URL is invalid"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new LedgerError(503, "auth_not_configured", "AUTH_VERIFY_URL must use HTTPS");
  }
  return url.toString();
}

function proofVerifierUrl(env) {
  if (!env?.PROOF_VERIFY_URL || !env?.PROOF_VERIFY_TOKEN) throw new LedgerError(503, "proof_verifier_not_configured", "server-side proof verification is not configured");
  let url;
  try { url = new URL(env.PROOF_VERIFY_URL); }
  catch (_) { throw new LedgerError(503, "proof_verifier_not_configured", "PROOF_VERIFY_URL is invalid"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new LedgerError(503, "proof_verifier_not_configured", "PROOF_VERIFY_URL must use HTTPS");
  }
  return url.toString();
}

export async function verifyValidationReceipt(input, env, fetchImpl = fetch) {
  const url = proofVerifierUrl(env);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + env.PROOF_VERIFY_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (_) {
    throw new LedgerError(502, "proof_verifier_unavailable", "proof verifier is unavailable");
  }
  if (!response.ok) {
    if ([400, 404, 409, 422].includes(response.status)) throw new LedgerError(409, "validation_receipt_rejected", "validation receipt was rejected");
    throw new LedgerError(502, "proof_verifier_unavailable", "proof verifier returned an error");
  }
  const result = await response.json().catch(() => null);
  if (!result || typeof result !== "object") throw new LedgerError(502, "invalid_proof_verifier_response", "proof verifier returned invalid JSON");
  return result;
}

export async function authorizeWrite(request, env, fetchImpl = fetch) {
  const url = verifierUrl(env);
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) {
    throw new LedgerError(401, "authentication_required", "a bearer token is required");
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ audience: "foresight-ledger", method: request.method, path: new URL(request.url).pathname }),
    });
  } catch (_) {
    throw new LedgerError(502, "auth_verifier_unavailable", "authentication verifier is unavailable");
  }
  if (response.status === 401 || response.status === 403) throw new LedgerError(401, "invalid_token", "bearer token was rejected");
  if (!response.ok) throw new LedgerError(502, "auth_verifier_unavailable", "authentication verifier returned an error");
  const result = await response.json().catch(() => null);
  if (result?.active !== true || typeof result.subject !== "string") throw new LedgerError(401, "invalid_token", "authentication verifier did not return an active subject");
  return result.subject;
}

export async function handleRequest(request, env, options = {}) {
  const logger = options.logger || console;
  try {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "foresight-ledger", version: VERSION, databaseConfigured: !!env?.DB, writesConfigured: !!env?.AUTH_VERIFY_URL, proofVerifierConfigured: !!(env?.PROOF_VERIFY_URL && env?.PROOF_VERIFY_TOKEN) });
    }
    const repository = options.repository || new D1LedgerRepository(env?.DB);
    const proofVerifier = options.proofVerifier || (input => verifyValidationReceipt(input, env, options.proofFetchImpl));
    const service = options.service || new LedgerService(repository, options.clock, proofVerifier);
    const receiptMatch = url.pathname.match(/^\/v1\/receipts\/(r_[0-9a-f]{64})$/);
    const transitionMatch = url.pathname.match(/^\/v1\/receipts\/(r_[0-9a-f]{64})\/transitions$/);
    const receiptEvidenceMatch = url.pathname.match(/^\/v1\/receipts\/(r_[0-9a-f]{64})\/evidence$/);
    const evidenceMatch = url.pathname.match(/^\/v1\/evidence\/(evd_[0-9a-f]{64})$/);
    const profileMatch = url.pathname.match(/^\/v1\/profiles\/([^/]+)$/);
    if (request.method === "GET" && receiptMatch) return json(await service.getReceipt(receiptMatch[1]), 200, { "Cache-Control": "public, max-age=15" });
    if (request.method === "GET" && profileMatch) return json(await service.getProfile(decodeURIComponent(profileMatch[1])), 200, { "Cache-Control": "public, max-age=15" });
    if (request.method === "GET" && evidenceMatch) return json(await service.getEvidence(evidenceMatch[1]), 200, { "Cache-Control": "public, max-age=60" });
    if (request.method === "POST" && url.pathname === "/v1/receipts") {
      const ownerId = await authorizeWrite(request, env, options.fetchImpl);
      return json(await service.createReceipt(ownerId, await readBody(request), request.headers.get("Idempotency-Key")), 201);
    }
    if (request.method === "POST" && transitionMatch) {
      const ownerId = await authorizeWrite(request, env, options.fetchImpl);
      return json(await service.appendTransition(ownerId, transitionMatch[1], await readBody(request), request.headers.get("Idempotency-Key")), 201);
    }
    if (request.method === "POST" && receiptEvidenceMatch) {
      const ownerId = await authorizeWrite(request, env, options.fetchImpl);
      return json(await service.registerEvidence(ownerId, receiptEvidenceMatch[1], await readBody(request), request.headers.get("Idempotency-Key")), 201);
    }
    if (["GET", "POST"].includes(request.method)) return json({ error: "not found", code: "not_found" }, 404);
    return json({ error: "method not allowed", code: "method_not_allowed" }, 405, { Allow: "GET, POST" });
  } catch (error) {
    if (error instanceof LedgerError) {
      if (error.details?.rejection) logger.warn("ledger_transition_rejected", JSON.stringify(error.details.rejection));
      return json({ error: error.message, code: error.code, ...(error.details || {}) }, error.status);
    }
    return json({ error: "internal ledger error", code: "internal_error" }, 500);
  }
}

export default { fetch: handleRequest };
