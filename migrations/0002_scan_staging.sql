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
