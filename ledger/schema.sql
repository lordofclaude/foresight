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

CREATE TABLE IF NOT EXISTS validation_evidence (
  evidence_id TEXT PRIMARY KEY CHECK (length(evidence_id) = 68 AND evidence_id LIKE 'evd_%'),
  validation_receipt_id TEXT NOT NULL UNIQUE,
  receipt_id TEXT NOT NULL REFERENCES receipts(receipt_id),
  owner_id TEXT NOT NULL,
  commit_hash TEXT NOT NULL CHECK (length(commit_hash) = 64),
  fixture_id INTEGER NOT NULL CHECK (fixture_id > 0),
  market TEXT NOT NULL CHECK (market = '1X2_FT'),
  verifier TEXT NOT NULL,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('API_RECEIPT', 'SOLANA_MEMO', 'ATOMIC_CLIENT_SETTLEMENT', 'PROGRAM_STATE')),
  evidence_status TEXT NOT NULL CHECK (evidence_status IN ('RECEIVED_UNVERIFIED', 'VERIFIED', 'MECHANISM_ONLY', 'NOT_SHIPPED')),
  purpose TEXT NOT NULL CHECK (purpose IN ('PRE_KICKOFF_COMMIT', 'OUTCOME_VALIDATION', 'SETTLEMENT_MECHANISM', 'PROGRAM_OWNED_GRADE')),
  transition_type TEXT NOT NULL CHECK (transition_type IN ('NONE', 'GRADED', 'BURNED', 'INVALID')),
  root_hash TEXT,
  slot INTEGER CHECK (slot IS NULL OR slot >= 0),
  tx_signature TEXT,
  message_id TEXT,
  program_id TEXT,
  program_owned INTEGER NOT NULL CHECK (program_owned IN (0, 1)),
  final INTEGER NOT NULL CHECK (final IN (0, 1)),
  winner TEXT CHECK (winner IS NULL OR winner IN ('part1', 'draw', 'part2')),
  observed_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  operation TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (owner_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS validation_evidence_receipt
  ON validation_evidence(receipt_id, created_at ASC);

CREATE TRIGGER IF NOT EXISTS validation_evidence_validate_insert
BEFORE INSERT ON validation_evidence BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM receipts r WHERE r.receipt_id = NEW.receipt_id AND r.owner_id = NEW.owner_id
        AND r.commit_hash = NEW.commit_hash AND r.fixture_id = NEW.fixture_id AND r.market = NEW.market
    ) THEN RAISE(ABORT, 'evidence binding does not match receipt')
    WHEN NEW.evidence_kind = 'API_RECEIPT' AND NEW.evidence_status = 'VERIFIED' AND NEW.root_hash IS NULL
      THEN RAISE(ABORT, 'verified API evidence requires root')
    WHEN NEW.evidence_kind = 'ATOMIC_CLIENT_SETTLEMENT' AND (NEW.evidence_status != 'MECHANISM_ONLY' OR NEW.program_owned != 0)
      THEN RAISE(ABORT, 'atomic client settlement is mechanism-only')
    WHEN NEW.evidence_kind = 'PROGRAM_STATE' AND (NEW.evidence_status != 'NOT_SHIPPED' OR NEW.program_owned != 0)
      THEN RAISE(ABORT, 'program-owned state is not shipped')
  END;
END;

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
    WHEN NEW.event_type IN ('GRADED', 'BURNED', 'INVALID') AND NOT EXISTS (
      SELECT 1 FROM validation_evidence e
      WHERE e.evidence_id = json_extract(NEW.payload_json, '$.evidenceId')
        AND e.receipt_id = NEW.receipt_id AND e.owner_id = NEW.owner_id
        AND e.commit_hash = (SELECT commit_hash FROM receipts WHERE receipt_id = NEW.receipt_id)
        AND e.fixture_id = (SELECT fixture_id FROM receipts WHERE receipt_id = NEW.receipt_id)
        AND e.market = (SELECT market FROM receipts WHERE receipt_id = NEW.receipt_id)
        AND e.evidence_kind = 'API_RECEIPT' AND e.evidence_status = 'VERIFIED'
        AND e.purpose = 'OUTCOME_VALIDATION' AND e.transition_type = NEW.event_type
        AND e.final = 1 AND e.root_hash IS NOT NULL
        AND (NEW.event_type != 'GRADED' OR e.winner = json_extract(NEW.payload_json, '$.winner'))
    ) THEN RAISE(ABORT, 'authoritative transition requires stored verified evidence')
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

CREATE TRIGGER IF NOT EXISTS validation_evidence_no_update
BEFORE UPDATE ON validation_evidence BEGIN
  SELECT RAISE(ABORT, 'validation evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS validation_evidence_no_delete
BEFORE DELETE ON validation_evidence BEGIN
  SELECT RAISE(ABORT, 'validation evidence is immutable');
END;
