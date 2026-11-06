-- Discovery cursors are durable so long servers can be resumed page by page.
CREATE TABLE thread_discovery (
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  parent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('active','public','private','joined')),
  cursor TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(job_id,parent_id,kind)
);
