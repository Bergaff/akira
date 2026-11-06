ALTER TABLE job_parts ADD COLUMN drive_file_id TEXT;
ALTER TABLE job_parts ADD COLUMN drive_status TEXT NOT NULL DEFAULT 'pending';
