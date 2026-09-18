-- Preserve unknown legacy titles separately from the global article display fallback.
ALTER TABLE user_articles ADD COLUMN legacy_title TEXT;
CREATE TABLE import_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  manifest_hash TEXT NOT NULL CHECK(length(manifest_hash)=64),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  status TEXT NOT NULL CHECK(status IN ('open','finalized')),
  created_at TEXT NOT NULL,
  finalized_at TEXT
) STRICT;
CREATE TABLE import_blocks (
  session_id TEXT NOT NULL REFERENCES import_sessions(id),
  block_index INTEGER NOT NULL CHECK(block_index>=0),
  checksum TEXT NOT NULL CHECK(length(checksum)=64),
  records_json TEXT NOT NULL CHECK(json_valid(records_json)),
  PRIMARY KEY(session_id,block_index)
) STRICT;
CREATE TRIGGER import_blocks_open BEFORE INSERT ON import_blocks
BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM import_sessions WHERE id=NEW.session_id AND status='open')
    THEN RAISE(ABORT,'import sealed') END);
END;
CREATE TRIGGER import_blocks_immutable BEFORE UPDATE ON import_blocks
BEGIN
  SELECT RAISE(ABORT,'import block immutable');
END;
CREATE TRIGGER import_session_manifest_immutable BEFORE UPDATE OF user_id,manifest_hash,manifest_json,created_at ON import_sessions
BEGIN
  SELECT RAISE(ABORT,'import manifest immutable');
END;
CREATE TRIGGER import_session_sealed BEFORE UPDATE ON import_sessions WHEN OLD.status='finalized'
BEGIN
  SELECT RAISE(ABORT,'import sealed');
END;
