-- Guards execute inside the same transaction as chunk/item writes, closing read/write races.
CREATE TRIGGER chunks_require_draft BEFORE INSERT ON digest_chunks
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM digest_runs WHERE user_id=NEW.user_id AND id=NEW.run_id AND status='draft')
    THEN RAISE(ABORT,'run is not a draft') END;
END;
CREATE TRIGGER items_require_draft BEFORE INSERT ON digest_items
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM digest_runs WHERE user_id=NEW.user_id AND id=NEW.run_id AND status='draft')
    THEN RAISE(ABORT,'run is not a draft') END;
  SELECT CASE WHEN (SELECT count(*) FROM digest_items WHERE user_id=NEW.user_id AND run_id=NEW.run_id)
    >= (SELECT expected_items FROM digest_runs WHERE user_id=NEW.user_id AND id=NEW.run_id)
    THEN RAISE(ABORT,'too many run items') END;
END;
CREATE TRIGGER profile_config_immutable BEFORE UPDATE OF config_json ON profile_versions
WHEN OLD.config_json != NEW.config_json
BEGIN
  SELECT RAISE(ABORT,'create a new profile version');
END;
