-- Только для новой пустой базы D1. Запустить целиком в SQL Console один раз.
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL CHECK (source_type IN ('channel', 'guild')),
  source_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  date_from INTEGER NOT NULL,
  date_to INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('scan', 'search', 'guild')),
  part_size INTEGER NOT NULL DEFAULT 3000,
  blank_line INTEGER NOT NULL DEFAULT 1,
  skip_empty INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued',
  part_index INTEGER NOT NULL DEFAULT 0,
  boundary_cursor TEXT,
  page_cursor TEXT,
  buffer_count INTEGER NOT NULL DEFAULT 0,
  scanned INTEGER NOT NULL DEFAULT 0,
  fetched INTEGER NOT NULL DEFAULT 0,
  written INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (source_type, source_id, target_user_id, date_from, date_to, mode)
);

CREATE TABLE job_parts (
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  part_index INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  messages INTEGER NOT NULL,
  oldest_id TEXT,
  newest_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, part_index)
);

CREATE TABLE job_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX job_log_job_id_id ON job_log(job_id, id DESC);

CREATE TABLE guild_channels (
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  channel_id TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  page_cursor TEXT,
  boundary_cursor TEXT,
  part_index INTEGER NOT NULL DEFAULT 0,
  scanned INTEGER NOT NULL DEFAULT 0,
  fetched INTEGER NOT NULL DEFAULT 0,
  written INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, channel_id)
);

-- One short-lived lease for ALL Discord API calls, including health checks.
CREATE TABLE ratelimit_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT,
  locked_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO ratelimit_lock (id) VALUES (1);
-- Version is an optimistic checkpoint guard; generation isolates restarted jobs.
ALTER TABLE jobs ADD COLUMN scan_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN scan_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN scan_done INTEGER NOT NULL DEFAULT 0;

CREATE TABLE scan_pages (
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  generation INTEGER NOT NULL,
  page_index INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  messages INTEGER NOT NULL,
  PRIMARY KEY (job_id, generation, page_index),
  UNIQUE (r2_key)
);
-- Preserve immutable files from older generations while using a human-readable
-- download name in the current generation's metadata.
ALTER TABLE job_parts ADD COLUMN file_name TEXT;
ALTER TABLE job_parts ADD COLUMN size_bytes INTEGER;
ALTER TABLE jobs ADD COLUMN finalized_through TEXT;
ALTER TABLE jobs ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN delay_min INTEGER NOT NULL DEFAULT 1200;
ALTER TABLE jobs ADD COLUMN delay_max INTEGER NOT NULL DEFAULT 2800;
ALTER TABLE jobs ADD COLUMN phase TEXT NOT NULL DEFAULT 'scan';
ALTER TABLE jobs ADD COLUMN lease_owner TEXT;
ALTER TABLE jobs ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN assembly_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN assembly_page INTEGER;
ALTER TABLE jobs ADD COLUMN assembly_offset INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN partial_key TEXT;
ALTER TABLE jobs ADD COLUMN partial_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN partial_start_page INTEGER;
ALTER TABLE jobs ADD COLUMN partial_start_offset INTEGER;
ALTER TABLE jobs ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN started_at INTEGER;
ALTER TABLE ratelimit_lock ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ratelimit_lock ADD COLUMN request_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ratelimit_lock ADD COLUMN multiplier REAL NOT NULL DEFAULT 1;
CREATE INDEX jobs_watchdog ON jobs(status,updated_at);
ALTER TABLE jobs ADD COLUMN guild_discovered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN guild_errors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_pages ADD COLUMN channel_id TEXT;
ALTER TABLE job_parts ADD COLUMN drive_file_id TEXT;
ALTER TABLE job_parts ADD COLUMN drive_status TEXT NOT NULL DEFAULT 'pending';
-- Discovery cursors are durable so long servers can be resumed page by page.
CREATE TABLE thread_discovery (
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  parent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('active','public','private','joined')),
  cursor TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(job_id,parent_id,kind)
);
CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
INSERT INTO d1_migrations(name) VALUES ('0001_initial.sql'),('0002_scan_staging.sql'),('0003_part_metadata.sql'),('0004_runtime.sql'),('0005_guild.sql'),('0006_drive.sql'),('0007_threads.sql');
