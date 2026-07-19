# Foresight receipt ledger

This is a small, append-only Cloudflare Worker + D1 service for durable public
prediction receipts. It is isolated from the static demo until a production
identity verifier and deployment are ready.

## Trust boundary

- Public reads need no token: `GET /v1/receipts/:receiptId` and
  `GET /v1/profiles/:ownerId` are suitable for shareable links.
- Every write needs a bearer token and an external `AUTH_VERIFY_URL`.
- The verifier must return `{ "active": true, "subject": "stable:owner-id" }`.
  The subject is the ledger owner; an owner supplied in a request body is never
  accepted.
- If `AUTH_VERIFY_URL` is absent or invalid, writes return
  `503 auth_not_configured`. This service does not pretend to verify Clerk JWTs.
- Receipt and event rows cannot be updated or deleted; SQL triggers enforce the
  append-only rule for direct database access too.
- `GRADED`, `BURNED`, and `INVALID` additionally require a server-only
  `PROOF_VERIFY_URL` + `PROOF_VERIFY_TOKEN`. Browser `verified`, winner, result,
  P&L, and proof-status fields are never accepted as authority.

The verifier contract is intentionally provider-neutral. A real integration
can point it at a separately deployed endpoint that verifies the issuer,
signature, audience, expiry and revocation state of the chosen identity token.
The ledger forwards the bearer token and a JSON body containing `audience`,
`method`, and `path`. Use HTTPS in production.

## Write API

All writes require `Content-Type: application/json`, `Authorization: Bearer …`,
and an `Idempotency-Key` of 8-128 visible ASCII characters.

Create a receipt:

```http
POST /v1/receipts
{
  "commitHash": "<64 lowercase hex characters>",
  "fixtureId": 18257739,
  "canonicalVersion": 1,
  "market": "1X2_FT",
  "oddsTs": 1784418232498,
  "committedAt": "2026-07-18T23:50:18.000Z",
  "revealDeadline": "2026-07-19T00:55:00.000Z",
  "settleAfter": "2026-07-19T02:00:00.000Z",
  "anchor": {
    "kind": "solana_memo",
    "network": "devnet",
    "signature": "Lo1V…"
  }
}
```

The receipt ID is deterministic: `r_<commitHash>`. An exact retry with the
same key returns the existing receipt with `idempotentReplay: true`. Reusing a
key for different bytes, or trying to recreate a hash under another owner,
returns `409`.

Append a transition:

```http
POST /v1/receipts/:receiptId/transitions
{
  "type": "REVEALED",
  "expectedSequence": 0,
  "payload": {
    "canonical": "{...stable canonical JSON bytes...}",
    "salt": "original secret salt"
  }
}
```

The service recomputes `SHA-256(canonical + "|" + salt)` and rejects a mismatch.
Legal paths are:

```text
COMMITTED -> REVEALED -> GRADED
          -> BURNED
          -> INVALID
REVEALED  -> INVALID
```

Every command supplies the last observed `expectedSequence`; stale concurrent
writes fail with `409 stale_sequence`. Reveal commands must arrive by the
server-enforced `revealDeadline`. Grade and burn commands cannot run before
`settleAfter`.

Authoritative commands accept only a validation receipt reference:

```json
{
  "type": "GRADED",
  "expectedSequence": 1,
  "payload": { "validationReceiptId": "txline-validation-…" }
}
```

The ledger calls its server-side verifier, requires an exact `VERIFIED` binding
to the owner, receipt, commitment hash, fixture, market and command, and derives
winner/result/P&L itself. `GRADED`, `BURNED`, and `INVALID` are terminal. An
illegal command returns and logs a deterministic rejection envelope containing
`rejectionId`, request fingerprint, current state and sequence; request bodies,
bearer tokens and proof-verifier credentials are never logged.

## Local verification

```powershell
cd ledger
npm test
npm run db:migrate:local
npm run dev
```

Tests have no credentials, network calls, or third-party packages. They use the
same service layer with a deterministic in-memory repository.

## Deployment checklist (do not put secrets in Git)

1. Run `npm run db:create` and place the returned D1 database ID in
   `wrangler.toml`.
2. Run `npm run db:migrate:remote`.
3. Deploy real HTTPS identity and proof verifiers. Configure `AUTH_VERIFY_URL`
   and `PROOF_VERIFY_URL`, then store `PROOF_VERIFY_TOKEN` as a Worker secret.
4. Add a narrow browser-origin policy before wiring direct browser writes. The
   current service is API-first and emits no permissive CORS headers.
5. Run `wrangler deploy`, then verify `/health` reports both database and write
   configuration. No deployment is performed by this repository.
