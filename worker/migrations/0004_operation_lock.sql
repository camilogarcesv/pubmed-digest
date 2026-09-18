-- Shared lease for deployments and administrative imports. A lost lease fences writes.
CREATE TABLE operation_lock (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  owner TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('deploy','import')),
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE operation_assertions (
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,
  valid INTEGER NOT NULL CHECK(valid=1)
) STRICT;
CREATE TRIGGER operation_assertion_guard BEFORE INSERT ON operation_assertions
BEGIN
  SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM operation_lock WHERE singleton=1
    AND owner=NEW.owner AND kind=NEW.kind AND expires_at>unixepoch())
    OR NOT EXISTS(SELECT 1 FROM system_controls WHERE singleton=1 AND mode='legacy')
    THEN RAISE(ABORT,'operation lease lost') END);
END;
