PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  fixture_id INTEGER NOT NULL CHECK (fixture_id > 0),
  commit_hash TEXT NOT NULL UNIQUE CHECK (length(commit_hash) = 64),
  canonical_version INTEGER NOT NULL CHECK (canonical_version = 1),
  market TEXT NOT NULL CHECK (market = '1X2_FT'),
  odds_ts INTEGER NOT NULL CHECK (odds_ts >= 0),
  committed_at TEXT NOT NULL,
  reveal_deadline TEXT NOT NULL,
  settle_after TEXT NOT NULL,
  anchor_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (committed_at <= reveal_deadline AND reveal_deadline <= settle_after),
  CHECK (committed_at <= created_at AND created_at <= reveal_deadline)
);

CREATE INDEX IF NOT EXISTS receipts_owner_created
  ON receipts(owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS receipt_events (
  event_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES receipts(receipt_id),
  owner_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('COMMITTED', 'REVEALED', 'GRADED', 'BURNED', 'INVALID')),
  previous_event_id TEXT,
  payload_json TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (receipt_id, sequence),
  UNIQUE (owner_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS receipt_events_receipt_sequence
  ON receipt_events(receipt_id, sequence ASC);

-- Enforce the same state machine even when a caller bypasses the Worker.
CREATE TRIGGER IF NOT EXISTS receipt_events_validate_insert
BEFORE INSERT ON receipt_events BEGIN
  SELECT CASE
    WHEN NEW.owner_id != (SELECT owner_id FROM receipts WHERE receipt_id = NEW.receipt_id)
      THEN RAISE(ABORT, 'event owner must match receipt owner')
    WHEN NEW.sequence = 0 AND (NEW.event_type != 'COMMITTED' OR NEW.previous_event_id IS NOT NULL)
      THEN RAISE(ABORT, 'first event must be COMMITTED')
    WHEN NEW.sequence > 0 AND NOT EXISTS (
      SELECT 1 FROM receipt_events previous
      WHERE previous.receipt_id = NEW.receipt_id
        AND previous.sequence = NEW.sequence - 1
        AND previous.event_id = NEW.previous_event_id
        AND (
          (previous.event_type = 'COMMITTED' AND NEW.event_type IN ('REVEALED', 'BURNED', 'INVALID')) OR
          (previous.event_type = 'REVEALED' AND NEW.event_type IN ('GRADED', 'INVALID'))
        )
    ) THEN RAISE(ABORT, 'illegal receipt transition')
    WHEN NEW.event_type = 'REVEALED' AND NEW.created_at > (
      SELECT reveal_deadline FROM receipts WHERE receipt_id = NEW.receipt_id
    ) THEN RAISE(ABORT, 'reveal deadline passed')
    WHEN NEW.event_type IN ('GRADED', 'BURNED') AND NEW.created_at < (
      SELECT settle_after FROM receipts WHERE receipt_id = NEW.receipt_id
    ) THEN RAISE(ABORT, 'settlement not open')
    WHEN NEW.event_type IN ('GRADED', 'BURNED', 'INVALID') AND (
      json_extract(NEW.payload_json, '$.validation.status') IS NOT 'VERIFIED' OR
      json_extract(NEW.payload_json, '$.validation.receiptId') != NEW.receipt_id OR
      json_extract(NEW.payload_json, '$.validation.ownerId') != NEW.owner_id OR
      json_extract(NEW.payload_json, '$.validation.commitHash') != (SELECT commit_hash FROM receipts WHERE receipt_id = NEW.receipt_id) OR
      json_extract(NEW.payload_json, '$.validation.fixtureId') != (SELECT fixture_id FROM receipts WHERE receipt_id = NEW.receipt_id) OR
      json_extract(NEW.payload_json, '$.validation.market') != (SELECT market FROM receipts WHERE receipt_id = NEW.receipt_id) OR
      json_extract(NEW.payload_json, '$.validation.final') IS NOT 1 OR
      json_extract(NEW.payload_json, '$.validation.action') != CASE NEW.event_type WHEN 'GRADED' THEN 'GRADE' WHEN 'BURNED' THEN 'BURN' ELSE 'INVALID' END
    ) THEN RAISE(ABORT, 'authoritative transition requires matching verified validation receipt')
    WHEN NEW.event_type IN ('GRADED', 'BURNED', 'INVALID') AND json_extract(NEW.payload_json, '$.validation.verifiedAt') > NEW.created_at
      THEN RAISE(ABORT, 'validation receipt timestamp is in the future')
    WHEN NEW.event_type IN ('GRADED', 'BURNED') AND json_extract(NEW.payload_json, '$.validation.verifiedAt') < (
      SELECT settle_after FROM receipts WHERE receipt_id = NEW.receipt_id
    ) THEN RAISE(ABORT, 'validation receipt predates settlement window')
  END;
END;

-- The ledger is append-only even for direct SQL callers. Corrections must be
-- represented as a new legal event, never by rewriting history.
CREATE TRIGGER IF NOT EXISTS receipts_no_update
BEFORE UPDATE ON receipts BEGIN
  SELECT RAISE(ABORT, 'receipts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS receipts_no_delete
BEFORE DELETE ON receipts BEGIN
  SELECT RAISE(ABORT, 'receipts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS receipt_events_no_update
BEFORE UPDATE ON receipt_events BEGIN
  SELECT RAISE(ABORT, 'receipt events are immutable');
END;

CREATE TRIGGER IF NOT EXISTS receipt_events_no_delete
BEFORE DELETE ON receipt_events BEGIN
  SELECT RAISE(ABORT, 'receipt events are immutable');
END;
