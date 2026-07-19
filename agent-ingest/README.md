# Authenticated external-agent ingestion

This isolated service accepts signed prediction commitments. It never executes a trade, receives a private key, or accepts agent prompts/secrets.

## Security contract

- The only mutation endpoint is `POST /v1/agent-commits` with the exact `{ "payload", "signature" }` schema described in `schema.json`.
- An Ed25519 signature covers `FORESIGHT_AGENT_COMMIT_V1\n` plus canonical JSON. The separator prevents a signature from another protocol being reused here.
- Agent public keys are registered server-side and bound to an owner. A separate owner bearer credential is mandatory. Missing or failed registry/auth dependencies reject the request.
- Nonces are single-use per agent. A byte-identical retry returns the existing receipt; a changed commit for the same agent/fixture/market returns `duplicate_mutation`.
- Fixtures, markets, selections and closing timestamps are allowlisted server-side.
- Integer parts-per-million prices avoid cross-language float ambiguity and must sum to 1,000,000.
- `proof.quoteDigest` is SHA-256 over canonical `{fixtureId, market, quote}`. A trusted proof adapter must independently confirm the proof reference, fixture, market and prices.
- Rate-limit, quote-proof, registry, owner-auth and durable-storage adapters fail closed.
- The Durable Object performs the idempotency/nonce decision transactionally. Do not replace it with eventually consistent KV.
- The strict schema rejects unknown fields, including `prompt`, `secret`, tool traces and private strategy text.

## Canonical payload

See `schema.json`. Canonical JSON recursively sorts object keys, preserves array order, permits only safe-integer numbers, and has no whitespace. Sign the UTF-8 bytes of:

```text
FORESIGHT_AGENT_COMMIT_V1\n{"agentId":...}
```

The public key is an Ed25519 SPKI DER value encoded with unpadded base64url. The signature is unpadded base64url.

## Production bindings

`worker.mjs` expects:

- `AGENT_REGISTRY_JSON`: secret JSON mapping agent IDs to `{ "ownerId", "publicKey" }`.
- `OWNER_TOKENS_JSON`: secret JSON mapping owner IDs to high-entropy bearer tokens.
- `FIXTURE_POLICY_JSON`: signed/config-managed JSON mapping fixture IDs to allowed markets, selections and `closesAtMs`.
- `QUOTE_PROOF_SERVICE`: service binding returning `{ "valid": true|false }` only after authoritative receipt verification.
- `RATE_LIMIT_SERVICE`: service binding returning `{ "allowed": true|false }`.
- `AGENT_COMMIT_STORE`: the exported Durable Object namespace.

Use secret bindings or a proper identity provider in production. Do not commit environment values. `wrangler.example.toml` contains bindings only and is not deployment authorization.

## Verify locally

```powershell
npm test --prefix agent-ingest
node --check agent-ingest/domain.mjs
node --check agent-ingest/worker.mjs
```

The tests generate ephemeral Ed25519 keys and cover invalid signatures, replay, timestamp windows, immutable duplicate handling, fixture/price proof mismatch, rate rejection, owner auth, allowlists and prompt/secret rejection. No credentials, network requests, trades or deployments are involved.
