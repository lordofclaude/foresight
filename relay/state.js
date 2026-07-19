export const STREAM_STALE_AFTER_MS = 30_000;
export const STREAM_LEASE_MS = 2 * 60 * 60_000;
// Kept below one thousand so the single durable snapshot remains comfortably
// bounded; oldest inactive rate subjects are evicted first.
const MAX_BUCKETS = 1_000;
const MAX_RECENT_STREAMS = 100;

export class RelayStateCore {
  constructor(snapshot) {
    this.buckets = new Map((snapshot && snapshot.buckets) || []);
    this.connections = new Map((snapshot && snapshot.connections) || []);
    this.streams = new Map((snapshot && snapshot.streams) || []);
  }

  export() {
    return {
      buckets: [...this.buckets],
      connections: [...this.connections],
      streams: [...this.streams]
    };
  }

  sweep(nowMs) {
    for (const [connectionId, connection] of this.connections) {
      if (connection.leaseExpiresAt > nowMs) continue;
      this.connections.delete(connectionId);
      this.finishStream(connection, nowMs, "lease_expired");
    }
    while (this.buckets.size > MAX_BUCKETS) this.buckets.delete(this.buckets.keys().next().value);
    while (this.streams.size > MAX_RECENT_STREAMS) {
      const endedKey = [...this.streams.keys()].find(key => !this.connections.has(key));
      if (!endedKey) break;
      this.streams.delete(endedKey);
    }
  }

  takeRate({ kind, subject, perMinute, nowMs }) {
    this.sweep(nowMs);
    const key = `${kind}:${subject || "unknown"}`;
    let bucket = this.buckets.get(key);
    if (!bucket) bucket = { tokens: perMinute, last: nowMs };
    bucket.tokens = Math.min(perMinute, bucket.tokens + (Math.max(0, nowMs - bucket.last) / 60_000) * perMinute);
    bucket.last = nowMs;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    return { allowed, retryAfterSeconds: allowed ? 0 : 60 };
  }

  admitSse(input) {
    const rate = this.takeRate({ kind: "sse", subject: input.subject, perMinute: input.perMinute, nowMs: input.nowMs });
    if (!rate.allowed) return { allowed: false, reason: "rate_limited", retryAfterSeconds: rate.retryAfterSeconds };
    if (this.connections.has(input.connectionId)) return { allowed: false, reason: "duplicate_connection", retryAfterSeconds: 15 };
    if (this.connections.size >= input.maxConcurrent) {
      return { allowed: false, reason: "concurrency_limited", retryAfterSeconds: 15 };
    }
    const connection = {
      connectionId: input.connectionId,
      kind: input.kind,
      fixtureId: input.fixtureId,
      requestId: input.requestId,
      reservedAt: input.nowMs,
      connectedAt: null,
      firstFrameAt: null,
      lastFrameAt: null,
      framesObserved: 0,
      bytesObserved: 0,
      leaseExpiresAt: input.nowMs + STREAM_LEASE_MS
    };
    this.connections.set(input.connectionId, connection);
    this.streams.set(input.connectionId, { ...connection, endedAt: null, endReason: null });
    return { allowed: true, activeStreams: this.connections.size };
  }

  connected({ connectionId, nowMs }) {
    this.sweep(nowMs);
    const connection = this.connections.get(connectionId);
    if (!connection) return { found: false };
    connection.connectedAt = connection.connectedAt || nowMs;
    connection.leaseExpiresAt = nowMs + STREAM_LEASE_MS;
    this.streams.set(connection.connectionId, { ...connection, endedAt: null, endReason: null });
    return { found: true };
  }

  frame({ connectionId, nowMs, frameCount = 1, byteCount = 0 }) {
    this.sweep(nowMs);
    const connection = this.connections.get(connectionId);
    if (!connection) return { found: false };
    connection.firstFrameAt = connection.firstFrameAt || nowMs;
    connection.lastFrameAt = nowMs;
    connection.framesObserved += Math.max(1, Number(frameCount) || 1);
    connection.bytesObserved += Math.max(0, Number(byteCount) || 0);
    connection.leaseExpiresAt = nowMs + STREAM_LEASE_MS;
    this.streams.set(connection.connectionId, { ...connection, endedAt: null, endReason: null });
    return { found: true };
  }

  finishStream(connection, nowMs, reason) {
    this.streams.set(connection.connectionId, {
      ...connection,
      endedAt: nowMs,
      endReason: reason,
      leaseExpiresAt: null
    });
  }

  close({ connectionId, nowMs, reason = "ended" }) {
    this.sweep(nowMs);
    const connection = this.connections.get(connectionId);
    if (!connection) return { found: false, activeStreams: this.connections.size };
    this.connections.delete(connectionId);
    this.finishStream(connection, nowMs, reason);
    return { found: true, activeStreams: this.connections.size };
  }

  snapshot(nowMs) {
    this.sweep(nowMs);
    const streams = [...this.streams.values()].map(stream => {
      const active = this.connections.has(stream.connectionId);
      const connected = active && stream.connectedAt != null;
      const hasFirstFrame = stream.firstFrameAt != null;
      const lastFrameAgeMs = hasFirstFrame ? Math.max(0, nowMs - stream.lastFrameAt) : null;
      const stale = connected && hasFirstFrame && lastFrameAgeMs > STREAM_STALE_AFTER_MS;
      const status = !active
        ? (stream.endReason === "upstream_error" || stream.endReason === "upstream_rejected" ? "error" : "ended")
        : !connected ? "connecting_upstream"
          : !hasFirstFrame ? "connected_waiting_first_frame"
            : stale ? "stale" : "fresh";
      return {
        connectionId: stream.connectionId,
        kind: stream.kind,
        fixtureId: stream.fixtureId,
        requestId: stream.requestId,
        connected,
        hasFirstFrame,
        stale,
        status,
        reservedAt: stream.reservedAt,
        connectedAt: stream.connectedAt,
        firstFrameAt: stream.firstFrameAt,
        lastFrameAt: stream.lastFrameAt,
        lastFrameAgeMs,
        framesObserved: stream.framesObserved,
        bytesObserved: stream.bytesObserved,
        endedAt: stream.endedAt,
        endReason: stream.endReason
      };
    }).sort((a, b) => (b.connectedAt || b.reservedAt || 0) - (a.connectedAt || a.reservedAt || 0));
    return { activeStreams: this.connections.size, staleAfterMs: STREAM_STALE_AFTER_MS, streams };
  }
}

export class LocalRelayStateClient {
  constructor(core = new RelayStateCore()) {
    this.core = core;
    this.scope = "per_isolate_fallback";
  }
  async takeRate(input) { return this.core.takeRate(input); }
  async admitSse(input) { return this.core.admitSse(input); }
  async connected(input) { return this.core.connected(input); }
  async frame(input) { return this.core.frame(input); }
  async close(input) { return this.core.close(input); }
  async snapshot(nowMs) { return this.core.snapshot(nowMs); }
}

export class DurableRelayStateClient {
  constructor(namespace) {
    const id = namespace.idFromName("foresight-relay-shared-v1");
    this.stub = namespace.get(id);
    this.scope = "durable_object_shared";
  }
  async call(path, body) {
    const response = await this.stub.fetch(`https://relay-state.internal${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`relay shared state rejected ${path}`);
    return response.json();
  }
  takeRate(input) { return this.call("/rate", input); }
  admitSse(input) { return this.call("/sse/admit", input); }
  connected(input) { return this.call("/sse/connected", input); }
  frame(input) { return this.call("/sse/frame", input); }
  close(input) { return this.call("/sse/close", input); }
  snapshot(nowMs) { return this.call("/snapshot", { nowMs }); }
}
