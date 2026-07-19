export class RepositoryConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "RepositoryConflictError";
    this.code = "repository_conflict";
  }
}

function parse(value) { return JSON.parse(value); }
function receipt(row) {
  return row && {
    receiptId: row.receipt_id, ownerId: row.owner_id, fixtureId: row.fixture_id,
    commitHash: row.commit_hash, canonicalVersion: row.canonical_version,
    market: row.market, oddsTs: row.odds_ts, committedAt: row.committed_at,
    revealDeadline: row.reveal_deadline, settleAfter: row.settle_after,
    anchor: parse(row.anchor_json), createdAt: row.created_at,
  };
}
function event(row) {
  return row && {
    eventId: row.event_id, receiptId: row.receipt_id, ownerId: row.owner_id,
    sequence: row.sequence, type: row.event_type, previousEventId: row.previous_event_id,
    payload: parse(row.payload_json), operation: row.operation,
    requestFingerprint: row.request_fingerprint, idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

export class D1LedgerRepository {
  constructor(db) {
    if (!db) throw new Error("D1 binding DB is required");
    this.db = db;
  }

  async getReceipt(receiptId) {
    return receipt(await this.db.prepare("SELECT * FROM receipts WHERE receipt_id = ?").bind(receiptId).first());
  }

  async getEvents(receiptId) {
    const result = await this.db.prepare("SELECT * FROM receipt_events WHERE receipt_id = ? ORDER BY sequence ASC").bind(receiptId).all();
    return (result.results || []).map(event);
  }

  async getEventByIdempotency(ownerId, key) {
    return event(await this.db.prepare("SELECT * FROM receipt_events WHERE owner_id = ? AND idempotency_key = ?").bind(ownerId, key).first());
  }

  async createReceipt(value, initialEvent) {
    const statements = [
      this.db.prepare("INSERT INTO receipts (receipt_id, owner_id, fixture_id, commit_hash, canonical_version, market, odds_ts, committed_at, reveal_deadline, settle_after, anchor_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(value.receiptId, value.ownerId, value.fixtureId, value.commitHash, value.canonicalVersion, value.market, value.oddsTs, value.committedAt, value.revealDeadline, value.settleAfter, JSON.stringify(value.anchor), value.createdAt),
      this.insertEvent(initialEvent),
    ];
    try { await this.db.batch(statements); }
    catch (error) { if (/constraint|unique/i.test(String(error?.message))) throw new RepositoryConflictError(error.message); throw error; }
  }

  insertEvent(value) {
    return this.db.prepare("INSERT INTO receipt_events (event_id, receipt_id, owner_id, sequence, event_type, previous_event_id, payload_json, operation, request_fingerprint, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(value.eventId, value.receiptId, value.ownerId, value.sequence, value.type, value.previousEventId, JSON.stringify(value.payload), value.operation, value.requestFingerprint, value.idempotencyKey, value.createdAt);
  }

  async appendEvent(value) {
    try { await this.insertEvent(value).run(); }
    catch (error) { if (/constraint|unique/i.test(String(error?.message))) throw new RepositoryConflictError(error.message); throw error; }
  }

  async listReceiptsByOwner(ownerId) {
    const result = await this.db.prepare("SELECT * FROM receipts WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100").bind(ownerId).all();
    const rows = [];
    for (const row of result.results || []) {
      const value = receipt(row);
      rows.push({ receipt: value, events: await this.getEvents(value.receiptId) });
    }
    return rows;
  }
}
