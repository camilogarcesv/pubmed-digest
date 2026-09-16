-- Phase 2.1: local foundation only. Do not apply remotely before the 2.2 checkpoint.
-- Tenant-bearing foreign keys include user_id: an otherwise valid UUID is not authority.
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL UNIQUE CHECK(length(slug) BETWEEN 1 AND 64),
  email TEXT NOT NULL UNIQUE CHECK(email = lower(trim(email)) AND length(email) > 3),
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'paused' CHECK(status IN ('active','paused')),
  auth_subject TEXT UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE profile_versions (
  user_id TEXT NOT NULL REFERENCES users(id),
  version INTEGER NOT NULL CHECK(version > 0),
  config_json TEXT NOT NULL CHECK(json_valid(config_json) AND json_type(config_json) = 'object'),
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,version)
) STRICT;
CREATE UNIQUE INDEX profile_one_active ON profile_versions(user_id) WHERE active = 1;

CREATE TABLE profile_sources (
  user_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('journal','query')),
  value TEXT NOT NULL CHECK(length(value) > 0),
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(user_id,profile_version,kind,position),
  UNIQUE(user_id,profile_version,kind,value),
  FOREIGN KEY(user_id,profile_version) REFERENCES profile_versions(user_id,version)
) STRICT;

CREATE TABLE destinations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL DEFAULT 'telegram' CHECK(provider = 'telegram'),
  external_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('active','paused')),
  digest_enabled INTEGER NOT NULL CHECK(digest_enabled IN (0,1)),
  ops_enabled INTEGER NOT NULL CHECK(ops_enabled IN (0,1)),
  UNIQUE(user_id,id)
) STRICT;

CREATE TABLE articles (
  pmid TEXT PRIMARY KEY NOT NULL CHECK(length(pmid) BETWEEN 1 AND 16 AND pmid NOT GLOB '*[^0-9]*'),
  title TEXT NOT NULL,
  abstract TEXT,
  metadata_json TEXT CHECK(metadata_json IS NULL OR (json_valid(metadata_json) AND json_type(metadata_json) = 'object')),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE digest_runs (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  profile_version INTEGER NOT NULL,
  run_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  kind TEXT NOT NULL CHECK(kind IN ('weekly','search')),
  status TEXT NOT NULL CHECK(status IN ('draft','prepared','delivering','needs_reconciliation','succeeded','aborted')),
  expected_items INTEGER NOT NULL CHECK(expected_items BETWEEN 0 AND 250),
  profile_snapshot_json TEXT NOT NULL CHECK(json_valid(profile_snapshot_json) AND json_type(profile_snapshot_json) = 'object'),
  metrics_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metrics_json) AND json_type(metrics_json) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id,run_key),
  UNIQUE(user_id,id),
  FOREIGN KEY(user_id,profile_version) REFERENCES profile_versions(user_id,version)
) STRICT;
CREATE INDEX runs_user_status ON digest_runs(user_id,status);

CREATE TABLE digest_chunks (
  user_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
  PRIMARY KEY(user_id,run_id,chunk_index),
  FOREIGN KEY(user_id,run_id) REFERENCES digest_runs(user_id,id)
) STRICT;

CREATE TABLE digest_items (
  user_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  pmid TEXT NOT NULL REFERENCES articles(pmid),
  relevance REAL CHECK(relevance BETWEEN 0 AND 10),
  reason TEXT,
  source TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('selected','near_miss','below_threshold','filtered')),
  PRIMARY KEY(user_id,run_id,pmid),
  FOREIGN KEY(user_id,run_id) REFERENCES digest_runs(user_id,id),
  CHECK((disposition = 'filtered' AND relevance IS NULL) OR (disposition != 'filtered' AND relevance IS NOT NULL))
) STRICT;
CREATE INDEX items_user_pmid ON digest_items(user_id,pmid,run_id);

CREATE TABLE user_articles (
  user_id TEXT NOT NULL REFERENCES users(id),
  pmid TEXT NOT NULL REFERENCES articles(pmid),
  first_seen TEXT NOT NULL,
  relevance REAL CHECK(relevance BETWEEN 0 AND 10),
  reason TEXT,
  source TEXT,
  run_id TEXT,
  delivered INTEGER NOT NULL CHECK(delivered IN (0,1)),
  delivered_at TEXT,
  PRIMARY KEY(user_id,pmid),
  FOREIGN KEY(user_id,run_id) REFERENCES digest_runs(user_id,id),
  CHECK(delivered = 1 OR delivered_at IS NULL)
) STRICT;
CREATE INDEX user_articles_history ON user_articles(user_id,first_seen,pmid);

CREATE TABLE delivery_messages (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position >= 0),
  kind TEXT NOT NULL CHECK(kind IN ('header','paper','near_miss','footer','empty')),
  pmid TEXT,
  votable INTEGER NOT NULL DEFAULT 0 CHECK(votable IN (0,1)),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object'),
  status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','unknown','reconciled_sent','reconciled_retry')),
  telegram_message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  updated_at TEXT NOT NULL,
  UNIQUE(user_id,id),
  UNIQUE(run_id,destination_id,position),
  UNIQUE(destination_id,telegram_message_id),
  FOREIGN KEY(user_id,run_id) REFERENCES digest_runs(user_id,id),
  FOREIGN KEY(user_id,destination_id) REFERENCES destinations(user_id,id),
  FOREIGN KEY(user_id,run_id,pmid) REFERENCES digest_items(user_id,run_id,pmid),
  CHECK(votable = 0 OR (pmid IS NOT NULL AND kind IN ('paper','near_miss'))),
  CHECK(status != 'sent' OR telegram_message_id IS NOT NULL)
) STRICT;
CREATE INDEX messages_run_status ON delivery_messages(user_id,run_id,status);

CREATE TABLE delivery_resolutions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('mark_sent','retry')),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(reason) > 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id,message_id) REFERENCES delivery_messages(user_id,id)
) STRICT;

CREATE TABLE votes (
  user_id TEXT NOT NULL REFERENCES users(id),
  pmid TEXT NOT NULL REFERENCES articles(pmid),
  destination_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK(value IN (0,1)),
  source TEXT NOT NULL CHECK(source IN ('telegram','legacy_import')),
  voted_at TEXT NOT NULL,
  PRIMARY KEY(user_id,pmid),
  FOREIGN KEY(user_id,destination_id) REFERENCES destinations(user_id,id)
) STRICT;
CREATE INDEX votes_user_time ON votes(user_id,voted_at DESC,pmid);

CREATE TABLE data_imports (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('profile','state','votes')),
  source_ref TEXT NOT NULL,
  code_sha TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK(length(checksum) = 64),
  counts_json TEXT NOT NULL CHECK(json_valid(counts_json) AND json_type(counts_json) = 'object'),
  created_at TEXT NOT NULL,
  UNIQUE(user_id,kind,source_ref)
) STRICT;

CREATE TABLE system_controls (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  mode TEXT NOT NULL CHECK(mode IN ('legacy','maintenance','d1')),
  updated_at TEXT NOT NULL
) STRICT;
INSERT INTO system_controls VALUES(1,'legacy','1970-01-01T00:00:00.000Z');
