-- Migration evidence is sealed before changing authority. Recovery keeps D1 authoritative.
CREATE TABLE authority_events (
  id TEXT PRIMARY KEY NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE authority_checkpoint (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  user_id TEXT NOT NULL REFERENCES users(id),
  destination_id TEXT NOT NULL REFERENCES destinations(id),
  import_id TEXT NOT NULL REFERENCES import_sessions(id),
  code_sha TEXT NOT NULL,
  state_sha TEXT NOT NULL,
  first_period TEXT NOT NULL,
  proof_json TEXT NOT NULL CHECK(json_valid(proof_json)),
  proof_hash TEXT NOT NULL,
  sealed_at TEXT NOT NULL,
  activated_at TEXT
) STRICT;
CREATE TABLE legacy_vote_inflight (
  id TEXT PRIMARY KEY NOT NULL,
  started_at TEXT NOT NULL
) STRICT;
CREATE TABLE telegram_vote_updates (
  user_id TEXT NOT NULL,
  pmid TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY(user_id,pmid),
  FOREIGN KEY(user_id,pmid) REFERENCES votes(user_id,pmid)
) STRICT;
CREATE TRIGGER authority_events_immutable BEFORE UPDATE ON authority_events
BEGIN SELECT RAISE(ABORT,'authority event immutable'); END;
-- Sealed evidence is immutable; activation only sets activated_at once.
CREATE TRIGGER authority_checkpoint_sealed BEFORE UPDATE ON authority_checkpoint
WHEN OLD.activated_at IS NOT NULL OR NEW.activated_at IS NULL
  OR NEW.singleton IS NOT OLD.singleton OR NEW.user_id IS NOT OLD.user_id OR NEW.destination_id IS NOT OLD.destination_id
  OR NEW.import_id IS NOT OLD.import_id OR NEW.code_sha IS NOT OLD.code_sha OR NEW.state_sha IS NOT OLD.state_sha
  OR NEW.first_period IS NOT OLD.first_period OR NEW.proof_json IS NOT OLD.proof_json
  OR NEW.proof_hash IS NOT OLD.proof_hash OR NEW.sealed_at IS NOT OLD.sealed_at
BEGIN SELECT RAISE(ABORT,'authority checkpoint sealed'); END;
CREATE TRIGGER legacy_vote_claim BEFORE INSERT ON legacy_vote_inflight
WHEN (SELECT mode FROM system_controls WHERE singleton=1)!='legacy'
BEGIN SELECT RAISE(ABORT,'legacy writes disabled'); END;
CREATE TRIGGER authority_no_legacy BEFORE UPDATE OF mode ON system_controls
WHEN NEW.mode='legacy' AND EXISTS(SELECT 1 FROM authority_checkpoint WHERE activated_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'D1 authority cannot be reversed'); END;
CREATE TRIGGER authority_first_period BEFORE INSERT ON digest_runs
WHEN EXISTS(SELECT 1 FROM authority_checkpoint WHERE user_id=NEW.user_id
  AND (activated_at IS NULL OR NEW.kind!='weekly' OR NEW.period IS NULL OR NEW.period<first_period))
BEGIN SELECT RAISE(ABORT,'run precedes activation period'); END;
DROP TRIGGER operation_assertion_guard;
CREATE TRIGGER operation_assertion_guard BEFORE INSERT ON operation_assertions
BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM operation_lock WHERE singleton=1
    AND owner=NEW.owner AND kind=NEW.kind AND expires_at>unixepoch())
    OR NOT EXISTS(SELECT 1 FROM system_controls WHERE singleton=1 AND mode IN ('legacy','maintenance'))
    OR (NEW.kind='import' AND EXISTS(SELECT 1 FROM authority_checkpoint))
    OR (NEW.kind='import' AND (SELECT mode FROM system_controls WHERE singleton=1)='maintenance'
      AND NOT EXISTS(SELECT 1 FROM authority_events WHERE action='maintenance'))
    THEN RAISE(ABORT,'operation lease lost') END);
END;
