import { createCommitService, decodeBase64Url, IngestError } from "./domain.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

function parseJsonEnv(env, name) {
  if (!env[name]) throw new Error(`${name} is required`);
  return JSON.parse(env[name]);
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index % a.length] || 0) ^ (b[index % b.length] || 0);
  return difference === 0;
}

function serviceAdapter(binding, path) {
  if (!binding || typeof binding.fetch !== "function") return null;
  return async body => {
    const response = await binding.fetch(`https://service.internal${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`service returned ${response.status}`);
    return response.json();
  };
}

function dependencies(env) {
  const agents = parseJsonEnv(env, "AGENT_REGISTRY_JSON");
  const ownerTokens = parseJsonEnv(env, "OWNER_TOKENS_JSON");
  const fixtures = parseJsonEnv(env, "FIXTURE_POLICY_JSON");
  const proofService = serviceAdapter(env.QUOTE_PROOF_SERVICE, "/v1/verify-quote");
  const rateService = serviceAdapter(env.RATE_LIMIT_SERVICE, "/v1/take");
  if (!proofService || !rateService || !env.AGENT_COMMIT_STORE) throw new Error("proof, rate, and Durable Object bindings are required");
  const storeId = env.AGENT_COMMIT_STORE.idFromName("foresight-agent-commits-v1");
  const store = env.AGENT_COMMIT_STORE.get(storeId);
  return {
    registry: { get: async agentId => agents[agentId] || null },
    ownerAuth: {
      verify: async ({ ownerId, authorization }) => {
        const expected = ownerTokens[ownerId];
        if (typeof expected !== "string" || expected.length < 16 || !authorization?.startsWith("Bearer ")) return false;
        return constantTimeEqual(authorization.slice(7), expected);
      }
    },
    signatureVerifier: {
      verify: async ({ publicKey, message, signature }) => {
        const key = await crypto.subtle.importKey("spki", decodeBase64Url(publicKey, "registered public key"), { name: "Ed25519" }, false, ["verify"]);
        return crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
      }
    },
    hasher: {
      sha256Hex: async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map(value => value.toString(16).padStart(2, "0")).join("")
    },
    fixturePolicy: { get: async fixtureId => fixtures[fixtureId] || null },
    quoteProofVerifier: { verify: proofService },
    rateLimiter: { take: rateService },
    store: {
      accept: async input => {
        const response = await store.fetch("https://store.internal/accept", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input)
        });
        if (!response.ok) throw new Error(`store returned ${response.status}`);
        return response.json();
      }
    }
  };
}

export class AgentCommitStore {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/accept") return json({ error: "not_found" }, 404);
    const input = await request.json();
    const result = await this.state.storage.transaction(async transaction => {
      const idKey = `id:${input.idempotencyKey}`;
      const nonceKey = `nonce:${input.nonceKey}`;
      const existing = await transaction.get(idKey);
      if (existing) return existing.submissionDigest === input.submissionDigest
        ? { status: "existing", record: existing }
        : { status: "mutation" };
      if (await transaction.get(nonceKey)) return { status: "replay" };
      await transaction.put(idKey, input.record);
      await transaction.put(nonceKey, { submissionDigest: input.submissionDigest });
      return { status: "created", record: input.record };
    });
    return json(result);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "foresight-agent-ingest", executesTrades: false });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/agent-commits") return json({ error: "not_found" }, 404);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return json({ error: "content_type_required" }, 415);
    }
    try {
      const contentLength = Number(request.headers.get("content-length") || 0);
      if (contentLength > 32_768) return json({ error: "body_too_large" }, 413);
      const rawBody = await request.text();
      if (new TextEncoder().encode(rawBody).byteLength > 32_768) return json({ error: "body_too_large" }, 413);
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      const service = createCommitService(dependencies(env), {
        maxAgeMs: Number(env.MAX_AGE_MS || 300_000),
        maxFutureSkewMs: Number(env.MAX_FUTURE_SKEW_MS || 15_000),
        maxQuoteAgeMs: Number(env.MAX_QUOTE_AGE_MS || 600_000)
      });
      const result = await service.submit({ body, authorization: request.headers.get("authorization") });
      return json(result, result.status === "accepted" ? 201 : 200);
    } catch (error) {
      if (error instanceof IngestError) return json({ error: error.code, message: error.message }, error.status);
      return json({ error: "service_unavailable", message: "ingestion dependency or configuration unavailable" }, 503);
    }
  }
};
