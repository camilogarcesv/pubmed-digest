-- Append-only ledger captures, applied in bounded atomic blocks under the import lease.
CREATE TABLE ledger_extensions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  manifest_hash TEXT NOT NULL CHECK(length(manifest_hash)=64),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  status TEXT NOT NULL CHECK(status IN ('open','finalized')),
  UNIQUE(user_id,sequence)
) STRICT;
CREATE UNIQUE INDEX ledger_extensions_one_open ON ledger_extensions(user_id) WHERE status='open';
CREATE TABLE ledger_extension_blocks (
  extension_id TEXT NOT NULL REFERENCES ledger_extensions(id),
  block_index INTEGER NOT NULL CHECK(block_index>=0),
  checksum TEXT NOT NULL CHECK(length(checksum)=64),
  records_json TEXT NOT NULL CHECK(json_valid(records_json)),
  PRIMARY KEY(extension_id,block_index)
) STRICT;
CREATE TRIGGER ledger_extension_blocks_open BEFORE INSERT ON ledger_extension_blocks
BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM ledger_extensions WHERE id=NEW.extension_id AND status='open')
    THEN RAISE(ABORT,'ledger extension sealed') END);
END;
CREATE TRIGGER ledger_extension_blocks_immutable BEFORE UPDATE ON ledger_extension_blocks
BEGIN
  SELECT RAISE(ABORT,'ledger block immutable');
END;
CREATE TRIGGER ledger_extension_manifest_immutable BEFORE UPDATE OF id,user_id,sequence,manifest_hash,manifest_json ON ledger_extensions
BEGIN
  SELECT RAISE(ABORT,'ledger manifest immutable');
END;
CREATE TRIGGER ledger_extension_sealed BEFORE UPDATE ON ledger_extensions WHEN OLD.status='finalized'
BEGIN
  SELECT RAISE(ABORT,'ledger extension sealed');
END;
