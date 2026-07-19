# Relay shared state and freshness

`wrangler.toml` binds `RELAY_SHARED_STATE` to the exported `RelaySharedState` Durable Object and includes the first SQLite-class migration. The object serializes updates and persists bounded token buckets, SSE reservations, and the most recent stream telemetry under one global object ID. No credentials are stored in this state.

Deployments made from an older configuration without the binding keep the original per-isolate behavior. `/health` reports `capabilityStatus.stateScope: "per_isolate_fallback"` and a warning in that case. When the binding is present but unavailable, proof, news, and SSE admission fail closed with `state_unavailable`; `/health` remains reachable and reports the state failure.

Stream telemetry is server-observed and makes no claim about an upstream before bytes arrive:

- `connecting_upstream`: admission reserved; upstream response not established.
- `connected_waiting_first_frame`: upstream response established; no complete SSE frame seen.
- `fresh`: at least one complete frame seen within 30 seconds.
- `stale`: connection remains open but the last complete frame is older than 30 seconds.
- `ended`: upstream ended or the downstream disconnected/pipe closed.
- `error`: upstream connection failed or rejected the stream.

Every public response has `X-Request-ID`; accepted caller IDs must match the bounded safe pattern, otherwise the relay generates one. Sanitized upstream failures include the ID and a structured category without exception messages, URLs, JWTs, or API tokens.

Before deployment:

```powershell
npm test --prefix relay
node --check relay/worker.js
node --check relay/state.js
Push-Location relay
npm exec wrangler -- deploy --dry-run
Pop-Location
```

The dry run must list `env.RELAY_SHARED_STATE (RelaySharedState)`. Also inspect `relay/wrangler.toml` for the `relay-shared-state-v1` SQLite-class migration before the first deployment from this configuration. Deployment and secret changes are intentionally operator actions and are not performed by this workstream.

After an intentional deployment, verify these read-only checks before recording the demo:

1. `/health` reports version `1.3.0-market-intelligence-2026-07-18`, capability `polymarket_public_prices`, `stateScope: "durable_object_shared"`, and `stateStatus: "ready"`.
2. `/api/polymarket?home=England&away=Argentina&atMs=1784142020504` returns either `HISTORICAL_ASOF`, `PARTIAL_HISTORICAL_ASOF`, or `HISTORICAL_UNAVAILABLE`—never `LATEST_AVAILABLE` for an as-of request.
3. Every non-null `quoteTimes` value is less than or equal to `requestedAtMs`. Missing historical outcomes stay `null`; they must not be replaced with current prices.
4. The deployed static app renders three comparison rows, labels partial coverage, and retains TxLINE data when the public market route is unavailable.
