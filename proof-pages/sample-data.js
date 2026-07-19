export const SAMPLE_RECEIPT_ID = "r_" + "a".repeat(64);
export const SAMPLE_OWNER_ID = "sample:foresight-proof";
const AUTHORITATIVE_EVIDENCE_ID = "evd_" + "b".repeat(64);
const MECHANISM_EVIDENCE_ID = "evd_" + "c".repeat(64);
const PLANNED_EVIDENCE_ID = "evd_" + "d".repeat(64);
const COMMIT_HASH = "a".repeat(64);
const canonical = JSON.stringify({
  fixtureId: 424242, market: "1X2_FT", mkt: { away: 0.25, draw: 0.3, home: 0.45 },
  oddsTs: 1784400000000, pick: "part2", v: 1, wallet: SAMPLE_OWNER_ID
});

const baseEvidence = {
  receiptId: SAMPLE_RECEIPT_ID, ownerId: SAMPLE_OWNER_ID, commitHash: COMMIT_HASH,
  fixtureId: 424242, market: "1X2_FT", verifier: "sample:verifier",
  rootHash: null, slot: null, txSignature: null, messageId: null, programId: null,
  programOwned: false, final: false, winner: null,
  observedAt: "2026-07-19T02:00:00.000Z", metadata: { network: "sample", label: "SAMPLE" },
  payloadHash: "e".repeat(64), createdAt: "2026-07-19T02:00:01.000Z"
};

export const SAMPLE_RECEIPT = Object.freeze({
  receiptId: SAMPLE_RECEIPT_ID, ownerId: SAMPLE_OWNER_ID, fixtureId: 424242,
  commitHash: COMMIT_HASH, canonicalVersion: 1, market: "1X2_FT", oddsTs: 1784400000000,
  committedAt: "2026-07-19T00:00:00.000Z", revealDeadline: "2026-07-19T01:00:00.000Z",
  settleAfter: "2026-07-19T02:00:00.000Z", anchor: { kind: "sample", network: "sample", signature: null, slot: null },
  createdAt: "2026-07-19T00:00:01.000Z", state: "GRADED",
  events: Object.freeze([
    { eventId: "e_sample_commit", sequence: 0, type: "COMMITTED", previousEventId: null, payload: { commitHash: COMMIT_HASH }, createdAt: "2026-07-19T00:00:01.000Z" },
    { eventId: "e_sample_reveal", sequence: 1, type: "REVEALED", previousEventId: "e_sample_commit", payload: { canonical, salt: "sample-only", pick: "part2", probability: 0.25 }, createdAt: "2026-07-19T00:30:00.000Z" },
    { eventId: "e_sample_grade", sequence: 2, type: "GRADED", previousEventId: "e_sample_reveal", payload: { evidenceId: AUTHORITATIVE_EVIDENCE_ID, validationReceiptId: "sample-validation-grade", result: "WIN", winner: "part2", pnl: 300, settledAt: "2026-07-19T02:00:00.000Z" }, createdAt: "2026-07-19T02:00:01.000Z" }
  ]),
  evidenceChain: Object.freeze([
    Object.freeze({ ...baseEvidence, evidenceId: AUTHORITATIVE_EVIDENCE_ID, validationReceiptId: "sample-validation-grade", evidenceKind: "API_RECEIPT", evidenceStatus: "VERIFIED", purpose: "OUTCOME_VALIDATION", transitionType: "GRADED", rootHash: "f".repeat(64), messageId: "sample-message-1", final: true, winner: "part2" }),
    Object.freeze({ ...baseEvidence, evidenceId: MECHANISM_EVIDENCE_ID, validationReceiptId: "sample-atomic-mechanism", evidenceKind: "ATOMIC_CLIENT_SETTLEMENT", evidenceStatus: "MECHANISM_ONLY", purpose: "SETTLEMENT_MECHANISM", transitionType: "NONE", slot: 123456, txSignature: "1".repeat(64), programId: "Vote111111111111111111111111111111111111111", final: true }),
    Object.freeze({ ...baseEvidence, evidenceId: PLANNED_EVIDENCE_ID, validationReceiptId: "sample-program-plan", evidenceKind: "PROGRAM_STATE", evidenceStatus: "NOT_SHIPPED", purpose: "PROGRAM_OWNED_GRADE", transitionType: "GRADED", programId: "Vote111111111111111111111111111111111111111" })
  ])
});

export const SAMPLE_PROFILE = Object.freeze({
  ownerId: SAMPLE_OWNER_ID,
  receipts: Object.freeze([Object.freeze({
    receiptId: SAMPLE_RECEIPT.receiptId, ownerId: SAMPLE_RECEIPT.ownerId,
    fixtureId: SAMPLE_RECEIPT.fixtureId, commitHash: SAMPLE_RECEIPT.commitHash,
    market: SAMPLE_RECEIPT.market, committedAt: SAMPLE_RECEIPT.committedAt,
    state: SAMPLE_RECEIPT.state, latestEvent: SAMPLE_RECEIPT.events.at(-1),
    evidenceChain: SAMPLE_RECEIPT.evidenceChain
  })])
});
