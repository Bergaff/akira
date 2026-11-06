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
