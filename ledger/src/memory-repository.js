import { RepositoryConflictError } from "./repository.js";
import { assertTransition } from "./domain.js";

export class MemoryLedgerRepository {
  constructor() {
    this.receipts = new Map();
    this.events = new Map();
    this.idempotency = new Map();
  }
  async getReceipt(id) { return this.receipts.get(id) || null; }
  async getEvents(id) { return [...(this.events.get(id) || [])]; }
  async getEventByIdempotency(ownerId, key) { return this.idempotency.get(ownerId + "|" + key) || null; }
  async createReceipt(receipt, event) {
    if (this.receipts.has(receipt.receiptId) || this.idempotency.has(event.ownerId + "|" + event.idempotencyKey)) throw new RepositoryConflictError("unique constraint");
    if (event.receiptId !== receipt.receiptId || event.ownerId !== receipt.ownerId || event.sequence !== 0 || event.type !== "COMMITTED" || event.previousEventId !== null) throw new RepositoryConflictError("invalid initial event");
    this.receipts.set(receipt.receiptId, structuredClone(receipt));
    this.events.set(receipt.receiptId, [structuredClone(event)]);
    this.idempotency.set(event.ownerId + "|" + event.idempotencyKey, structuredClone(event));
  }
  async appendEvent(event) {
    const events = this.events.get(event.receiptId) || [];
    if (events.some(value => value.sequence === event.sequence) || this.idempotency.has(event.ownerId + "|" + event.idempotencyKey)) throw new RepositoryConflictError("unique constraint");
    const receipt = this.receipts.get(event.receiptId), previous = events.at(-1);
    if (!receipt || receipt.ownerId !== event.ownerId || !previous || event.sequence !== previous.sequence + 1 || event.previousEventId !== previous.eventId) throw new RepositoryConflictError("event chain conflict");
    assertTransition(previous.type, event.type);
    events.push(structuredClone(event));
    this.events.set(event.receiptId, events);
    this.idempotency.set(event.ownerId + "|" + event.idempotencyKey, structuredClone(event));
  }
  async listReceiptsByOwner(ownerId) {
    return [...this.receipts.values()]
      .filter(receipt => receipt.ownerId === ownerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(receipt => ({ receipt: structuredClone(receipt), events: structuredClone(this.events.get(receipt.receiptId) || []) }));
  }
}
