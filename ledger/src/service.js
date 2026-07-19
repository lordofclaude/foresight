import {
  LedgerError, assertTransition, normalizeCommit, normalizeTransition, normalizeVerifierResult,
  sha256, stableStringify, validateIdempotencyKey, validateOwnerId, validateReceiptId,
} from "./domain.js";

function publicEvent(event) {
  return {
    eventId: event.eventId,
    sequence: event.sequence,
    type: event.type,
    previousEventId: event.previousEventId,
    payload: event.payload,
    createdAt: event.createdAt,
  };
}

function publicReceipt(receipt, events) {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  return {
    receiptId: receipt.receiptId,
    ownerId: receipt.ownerId,
    fixtureId: receipt.fixtureId,
    commitHash: receipt.commitHash,
    canonicalVersion: receipt.canonicalVersion,
    market: receipt.market,
    oddsTs: receipt.oddsTs,
    committedAt: receipt.committedAt,
    revealDeadline: receipt.revealDeadline,
    settleAfter: receipt.settleAfter,
    anchor: receipt.anchor,
    createdAt: receipt.createdAt,
    state: ordered.at(-1)?.type || "COMMITTED",
    events: ordered.map(publicEvent),
  };
}

export class LedgerService {
  constructor(repository, clock = () => new Date().toISOString(), proofVerifier = null) {
    this.repository = repository;
    this.clock = clock;
    this.proofVerifier = proofVerifier;
  }

  orderedEvents(events) {
    const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i].sequence !== i || (i === 0 ? ordered[i].type !== "COMMITTED" || ordered[i].previousEventId !== null : ordered[i].previousEventId !== ordered[i - 1].eventId)) {
        throw new LedgerError(500, "ledger_integrity_error", "stored receipt event chain is not contiguous");
      }
    }
    return ordered;
  }

  async auditedError(error, ownerId, receiptId, idempotencyKey, body, current = null) {
    if (!(error instanceof LedgerError) || error.details?.rejection) return error;
    const requestFingerprint = await sha256(stableStringify({ receiptId, body }));
    const rejectionId = "rej_" + await sha256(String(ownerId) + "|" + String(idempotencyKey) + "|" + requestFingerprint);
    error.details = { rejection: {
      accepted: false, rejectionId, receiptId, requestFingerprint,
      requestedType: body && typeof body === "object" ? body.type || null : null,
      expectedSequence: body && typeof body === "object" && Number.isSafeInteger(body.expectedSequence) ? body.expectedSequence : null,
      actualSequence: current?.sequence ?? null, currentState: current?.type ?? null,
      code: error.code, rejectedAt: this.clock(),
    } };
    return error;
  }

  async replay(ownerId, idempotencyKey, operation, fingerprint) {
    const existing = await this.repository.getEventByIdempotency(ownerId, idempotencyKey);
    if (!existing) return null;
    if (existing.operation !== operation || existing.requestFingerprint !== fingerprint) {
      throw new LedgerError(409, "idempotency_conflict", "Idempotency-Key was already used for a different write");
    }
    const receipt = await this.getReceipt(existing.receiptId);
    return { ...receipt, idempotentReplay: true };
  }

  async createReceipt(ownerId, body, idempotencyKey) {
    validateIdempotencyKey(idempotencyKey);
    const normalized = normalizeCommit(ownerId, body);
    const operation = "CREATE:" + normalized.receiptId;
    const fingerprint = await sha256(stableStringify({ operation, normalized }));
    const replayed = await this.replay(ownerId, idempotencyKey, operation, fingerprint);
    if (replayed) return replayed;
    if (await this.repository.getReceipt(normalized.receiptId)) {
      throw new LedgerError(409, "receipt_exists", "commitment already has a receipt; retry with the original Idempotency-Key");
    }
    const createdAt = this.clock();
    if (!Number.isFinite(Date.parse(createdAt))) throw new LedgerError(500, "invalid_server_clock", "ledger clock returned an invalid timestamp");
    if (normalized.committedAt > createdAt) throw new LedgerError(409, "commitment_from_future", "committedAt cannot be later than server receipt creation");
    if (createdAt > normalized.revealDeadline) throw new LedgerError(409, "commit_window_closed", "receipt cannot be created after revealDeadline");
    const eventId = "e_" + await sha256(ownerId + "|" + idempotencyKey);
    const receipt = { ...normalized, createdAt };
    const event = {
      eventId, receiptId: receipt.receiptId, ownerId, sequence: 0,
      type: "COMMITTED", previousEventId: null,
      payload: { commitHash: receipt.commitHash }, operation,
      requestFingerprint: fingerprint, idempotencyKey, createdAt,
    };
    try { await this.repository.createReceipt(receipt, event); }
    catch (error) {
      if (error?.code !== "repository_conflict") throw error;
      const raced = await this.replay(ownerId, idempotencyKey, operation, fingerprint);
      if (raced) return raced;
      throw new LedgerError(409, "receipt_exists", "commitment or idempotency key already exists");
    }
    return publicReceipt(receipt, [event]);
  }

  async appendTransition(ownerId, receiptId, body, idempotencyKey) {
    let current = null;
    try {
      validateOwnerId(ownerId);
      validateReceiptId(receiptId);
      validateIdempotencyKey(idempotencyKey);
      const receipt = await this.repository.getReceipt(receiptId);
      if (!receipt) throw new LedgerError(404, "receipt_not_found", "receipt not found");
      if (receipt.ownerId !== ownerId) throw new LedgerError(403, "owner_mismatch", "authenticated subject does not own this receipt");
      const normalized = await normalizeTransition(body, receipt);
      const operation = "TRANSITION:" + receiptId + ":" + normalized.type;
      const fingerprint = await sha256(stableStringify({ operation, normalized }));
      const replayed = await this.replay(ownerId, idempotencyKey, operation, fingerprint);
      if (replayed) return replayed;
      const events = this.orderedEvents(await this.repository.getEvents(receiptId));
      current = events.at(-1);
      if (!current) throw new LedgerError(500, "ledger_integrity_error", "receipt has no COMMITTED event");
      if (normalized.expectedSequence !== current.sequence) throw new LedgerError(409, "stale_sequence", "expectedSequence does not match the latest event");
      assertTransition(current.type, normalized.type);
      const createdAt = this.clock();
      if (!Number.isFinite(Date.parse(createdAt))) throw new LedgerError(500, "invalid_server_clock", "ledger clock returned an invalid timestamp");
      if (normalized.type === "REVEALED" && createdAt > receipt.revealDeadline) throw new LedgerError(409, "reveal_deadline_passed", "revealDeadline has passed");
      if (["GRADED", "BURNED"].includes(normalized.type) && createdAt < receipt.settleAfter) throw new LedgerError(409, "settlement_not_open", "settlement is not eligible before settleAfter");

      let payload = normalized.payload;
      if (["GRADED", "BURNED", "INVALID"].includes(normalized.type)) {
        if (typeof this.proofVerifier !== "function") throw new LedgerError(503, "proof_verifier_not_configured", "authoritative transitions require a server-side proof verifier");
        const action = { GRADED: "GRADE", BURNED: "BURN", INVALID: "INVALID" }[normalized.type];
        const expected = { action, validationReceiptId: normalized.payload.validationReceiptId, receiptId, ownerId, commitHash: receipt.commitHash, fixtureId: receipt.fixtureId, market: receipt.market };
        let verifierResult;
        try { verifierResult = await this.proofVerifier({ ...expected, receiptId, ownerId, commitHash: receipt.commitHash, currentState: current.type }); }
        catch (error) {
          if (error instanceof LedgerError) throw error;
          throw new LedgerError(502, "proof_verifier_unavailable", "proof verifier is unavailable");
        }
        const validation = normalizeVerifierResult(verifierResult, expected);
        if (validation.verifiedAt > createdAt || (["GRADED", "BURNED"].includes(normalized.type) && validation.verifiedAt < receipt.settleAfter)) {
          throw new LedgerError(409, "validation_receipt_time_mismatch", "validation receipt timestamp is outside the authoritative transition window");
        }
        if (normalized.type === "GRADED") {
          const probability = current.payload.probability;
          if (!Number.isFinite(probability) || probability <= 0) throw new LedgerError(500, "ledger_integrity_error", "revealed probability is unavailable");
          const result = current.payload.pick === validation.winner ? "WIN" : "LOSS";
          const pnl = result === "WIN" ? Math.round((100 * (1 / probability - 1)) * 100) / 100 : -100;
          payload = { result, winner: validation.winner, pnl, settledAt: validation.verifiedAt, validation };
        } else if (normalized.type === "BURNED") {
          payload = { reason: "unrevealed_at_settlement", pnl: -100, settledAt: validation.verifiedAt, validation };
        } else {
          payload = { reason: validation.reason, invalidatedAt: validation.verifiedAt, validation };
        }
      }
      const event = {
        eventId: "e_" + await sha256(ownerId + "|" + idempotencyKey),
        receiptId, ownerId, sequence: current.sequence + 1,
        type: normalized.type, previousEventId: current.eventId,
        payload, operation, requestFingerprint: fingerprint, idempotencyKey, createdAt,
      };
      try { await this.repository.appendEvent(event); }
      catch (error) {
        if (error?.code !== "repository_conflict") throw error;
        const raced = await this.replay(ownerId, idempotencyKey, operation, fingerprint);
        if (raced) return raced;
        throw new LedgerError(409, "concurrent_transition", "receipt changed; reload before appending another transition");
      }
      return publicReceipt(receipt, [...events, event]);
    } catch (error) {
      throw await this.auditedError(error, ownerId, receiptId, idempotencyKey, body, current);
    }
  }

  async getReceipt(receiptId) {
    validateReceiptId(receiptId);
    const receipt = await this.repository.getReceipt(receiptId);
    if (!receipt) throw new LedgerError(404, "receipt_not_found", "receipt not found");
    return publicReceipt(receipt, this.orderedEvents(await this.repository.getEvents(receiptId)));
  }

  async getProfile(ownerId) {
    validateOwnerId(ownerId);
    const rows = await this.repository.listReceiptsByOwner(ownerId);
    const receipts = [];
    for (const row of rows) receipts.push(publicReceipt(row.receipt, this.orderedEvents(row.events)));
    const counts = { COMMITTED: 0, REVEALED: 0, GRADED: 0, BURNED: 0, INVALID: 0 };
    let wins = 0, pnl = 0;
    for (const receipt of receipts) {
      counts[receipt.state]++;
      const terminal = receipt.events.at(-1);
      if (receipt.state === "GRADED") { wins += terminal.payload.result === "WIN" ? 1 : 0; pnl += terminal.payload.pnl; }
      if (receipt.state === "BURNED") pnl += terminal.payload.pnl;
    }
    return {
      ownerId, receiptCount: receipts.length, settledCount: counts.GRADED + counts.BURNED,
      wins, pnl, stateCounts: counts,
      receipts: receipts.map(({ events, ...receipt }) => ({ ...receipt, latestEvent: events.at(-1) })),
    };
  }
}
