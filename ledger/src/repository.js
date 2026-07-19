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
function evidence(row) {
  return row && {
    evidenceId: row.evidence_id, validationReceiptId: row.validation_receipt_id,
    receiptId: row.receipt_id, ownerId: row.owner_id, commitHash: row.commit_hash,
    fixtureId: row.fixture_id, market: row.market, verifier: row.verifier,
    evidenceKind: row.evidence_kind, evidenceStatus: row.evidence_status,
    purpose: row.purpose, transitionType: row.transition_type, rootHash: row.root_hash,
    slot: row.slot, txSignature: row.tx_signature, messageId: row.message_id,
    programId: row.program_id, programOwned: row.program_owned === 1, final: row.final === 1,
    winner: row.winner, observedAt: row.observed_at, metadata: parse(row.metadata_json),
    payloadHash: row.payload_hash, operation: row.operation,
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

  async getEvidence(evidenceId) {
    return evidence(await this.db.prepare("SELECT * FROM validation_evidence WHERE evidence_id = ?").bind(evidenceId).first());
  }

  async getEvidenceByValidationReceipt(validationReceiptId) {
    return evidence(await this.db.prepare("SELECT * FROM validation_evidence WHERE validation_receipt_id = ?").bind(validationReceiptId).first());
  }

  async getEvidenceByIdempotency(ownerId, key) {
    return evidence(await this.db.prepare("SELECT * FROM validation_evidence WHERE owner_id = ? AND idempotency_key = ?").bind(ownerId, key).first());
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

  async createEvidence(value) {
    try {
      await this.db.prepare("INSERT INTO validation_evidence (evidence_id, validation_receipt_id, receipt_id, owner_id, commit_hash, fixture_id, market, verifier, evidence_kind, evidence_status, purpose, transition_type, root_hash, slot, tx_signature, message_id, program_id, program_owned, final, winner, observed_at, metadata_json, payload_hash, operation, request_fingerprint, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(value.evidenceId, value.validationReceiptId, value.receiptId, value.ownerId, value.commitHash, value.fixtureId, value.market, value.verifier, value.evidenceKind, value.evidenceStatus, value.purpose, value.transitionType, value.rootHash, value.slot, value.txSignature, value.messageId, value.programId, value.programOwned ? 1 : 0, value.final ? 1 : 0, value.winner, value.observedAt, JSON.stringify(value.metadata), value.payloadHash, value.operation, value.requestFingerprint, value.idempotencyKey, value.createdAt).run();
    } catch (error) { if (/constraint|unique/i.test(String(error?.message))) throw new RepositoryConflictError(error.message); throw error; }
  }

  async listEvidenceByReceipt(receiptId) {
    const result = await this.db.prepare("SELECT * FROM validation_evidence WHERE receipt_id = ? ORDER BY created_at ASC").bind(receiptId).all();
    return (result.results || []).map(evidence);
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
