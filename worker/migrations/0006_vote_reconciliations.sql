-- Sealed record of every legacy vote reconciliation step (KV capture -> D1). Each row carries
-- the exact before/after of the votes it changed, so the imported votes plus these rows,
-- replayed by sequence, must reproduce the votes table. One capture may take several steps:
-- D1 Free allows 50 queries per invocation, so each step applies a bounded number of changes.
CREATE TABLE vote_reconciliations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  capture_id TEXT NOT NULL,
  capture_checksum TEXT NOT NULL CHECK(length(capture_checksum) = 64),
  captured_at TEXT NOT NULL,
  code_sha TEXT NOT NULL CHECK(length(code_sha) = 40),
  counts_json TEXT NOT NULL CHECK(json_valid(counts_json) AND json_type(counts_json) = 'object'),
  changes_json TEXT NOT NULL CHECK(json_valid(changes_json) AND json_type(changes_json) = 'array'),
  created_at TEXT NOT NULL,
  UNIQUE(user_id, sequence)
) STRICT;
CREATE TRIGGER vote_reconciliations_immutable BEFORE UPDATE ON vote_reconciliations
BEGIN
  SELECT RAISE(ABORT,'reconciliation immutable');
END;
