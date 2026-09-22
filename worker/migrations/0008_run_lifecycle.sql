-- Run lifecycle for the D1 digest path. Writes additionally require system mode 'd1' in each
-- transaction. Conditions live in WHEN clauses so no CASE ... END appears in a trigger body.
ALTER TABLE digest_runs ADD COLUMN period TEXT CHECK(period IS NULL OR (period GLOB '[0-9][0-9][0-9][0-9]-W[0-5][0-9]' AND substr(period,7,2) BETWEEN '01' AND '53'));
-- One live weekly run per user and ISO week; an aborted draft frees the week for a new attempt.
CREATE UNIQUE INDEX runs_one_per_period ON digest_runs(user_id,kind,period) WHERE status != 'aborted' AND period IS NOT NULL;

-- In-transaction preconditions: a false or NULL condition aborts the whole batch. The named
-- constraint lets the Worker report a failed precondition as a conflict.
CREATE TABLE digest_assertions (
  valid INTEGER NOT NULL CONSTRAINT digest_precondition CHECK(valid=1)
) STRICT;

CREATE TRIGGER runs_terminal BEFORE UPDATE ON digest_runs
WHEN OLD.status IN ('succeeded','aborted')
BEGIN
  SELECT RAISE(ABORT,'run is final');
END;
CREATE TRIGGER runs_status_transition BEFORE UPDATE OF status ON digest_runs
WHEN OLD.status != NEW.status AND NOT (
  (OLD.status='draft' AND NEW.status IN ('prepared','aborted'))
  OR (OLD.status='prepared' AND NEW.status IN ('delivering','aborted'))
  OR (OLD.status='delivering' AND NEW.status IN ('succeeded','needs_reconciliation'))
  OR (OLD.status='needs_reconciliation' AND NEW.status IN ('delivering','succeeded')))
BEGIN
  SELECT RAISE(ABORT,'invalid run transition');
END;
CREATE TRIGGER runs_identity_immutable BEFORE UPDATE OF id,user_id,profile_version,run_key,payload_hash,kind,expected_items,profile_snapshot_json,period,created_at ON digest_runs
WHEN OLD.id IS NOT NEW.id OR OLD.user_id IS NOT NEW.user_id OR OLD.profile_version IS NOT NEW.profile_version
  OR OLD.run_key IS NOT NEW.run_key OR OLD.payload_hash IS NOT NEW.payload_hash OR OLD.kind IS NOT NEW.kind
  OR OLD.expected_items IS NOT NEW.expected_items OR OLD.profile_snapshot_json IS NOT NEW.profile_snapshot_json
  OR OLD.period IS NOT NEW.period OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT,'run identity immutable');
END;
CREATE TRIGGER runs_metrics_at_prepare BEFORE UPDATE OF metrics_json ON digest_runs
WHEN OLD.metrics_json IS NOT NEW.metrics_json AND NOT (OLD.status='draft' AND NEW.status='prepared')
BEGIN
  SELECT RAISE(ABORT,'run metrics are fixed at prepare');
END;

CREATE TRIGGER items_immutable BEFORE UPDATE ON digest_items
BEGIN
  SELECT RAISE(ABORT,'run item immutable');
END;

-- Messages are created pending, only while their run is prepared.
CREATE TRIGGER messages_require_prepared BEFORE INSERT ON delivery_messages
WHEN NEW.status != 'pending' OR NEW.attempts != 0 OR NEW.telegram_message_id IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM digest_runs WHERE user_id=NEW.user_id AND id=NEW.run_id AND status='prepared')
BEGIN
  SELECT RAISE(ABORT,'messages start pending in a prepared run');
END;
CREATE TRIGGER messages_delivered_final BEFORE UPDATE ON delivery_messages
WHEN OLD.status IN ('sent','reconciled_sent')
BEGIN
  SELECT RAISE(ABORT,'message already delivered');
END;
CREATE TRIGGER messages_content_immutable BEFORE UPDATE OF id,user_id,run_id,destination_id,position,kind,pmid,votable,payload_json ON delivery_messages
WHEN OLD.id IS NOT NEW.id OR OLD.user_id IS NOT NEW.user_id OR OLD.run_id IS NOT NEW.run_id
  OR OLD.destination_id IS NOT NEW.destination_id OR OLD.position IS NOT NEW.position OR OLD.kind IS NOT NEW.kind
  OR OLD.pmid IS NOT NEW.pmid OR OLD.votable IS NOT NEW.votable OR OLD.payload_json IS NOT NEW.payload_json
BEGIN
  SELECT RAISE(ABORT,'message content immutable');
END;
-- An attempt is claimed once; its outcome is recorded once; failed/unknown only leave by resolution.
CREATE TRIGGER messages_status_transition BEFORE UPDATE OF status,attempts,telegram_message_id ON delivery_messages
WHEN NOT (
  (OLD.status IN ('pending','reconciled_retry') AND NEW.status='sending' AND NEW.attempts=OLD.attempts+1 AND NEW.telegram_message_id IS NULL)
  OR (OLD.status='sending' AND NEW.status='sent' AND NEW.attempts=OLD.attempts AND NEW.telegram_message_id IS NOT NULL)
  OR (OLD.status='sending' AND NEW.status IN ('failed','unknown','pending') AND NEW.attempts=OLD.attempts AND NEW.telegram_message_id IS NULL)
  OR (OLD.status IN ('failed','unknown') AND NEW.status='reconciled_sent' AND NEW.attempts=OLD.attempts)
  OR (OLD.status IN ('failed','unknown') AND NEW.status='reconciled_retry' AND NEW.attempts=OLD.attempts AND NEW.telegram_message_id IS NULL))
BEGIN
  SELECT RAISE(ABORT,'invalid message transition');
END;

CREATE TRIGGER resolutions_require_unresolved BEFORE INSERT ON delivery_resolutions
WHEN NOT EXISTS(SELECT 1 FROM delivery_messages WHERE user_id=NEW.user_id AND id=NEW.message_id AND status IN ('failed','unknown'))
BEGIN
  SELECT RAISE(ABORT,'message is not awaiting resolution');
END;
CREATE TRIGGER resolutions_immutable BEFORE UPDATE ON delivery_resolutions
BEGIN
  SELECT RAISE(ABORT,'resolution immutable');
END;

-- History comes only from a weekly run, and only after every message of that run was delivered
-- (ad-hoc search keeps no history, as in the legacy digest).
CREATE TRIGGER user_articles_after_delivery BEFORE INSERT ON user_articles
WHEN NEW.run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM digest_runs WHERE user_id=NEW.user_id AND id=NEW.run_id AND status='succeeded' AND kind='weekly')
BEGIN
  SELECT RAISE(ABORT,'history waits for a delivered run');
END;
CREATE TRIGGER user_articles_run_after_delivery BEFORE UPDATE OF run_id ON user_articles
WHEN NEW.run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM digest_runs WHERE user_id=NEW.user_id AND id=NEW.run_id AND status='succeeded' AND kind='weekly')
BEGIN
  SELECT RAISE(ABORT,'history waits for a delivered run');
END;
