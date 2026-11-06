-- Preserve immutable files from older generations while using a human-readable
-- download name in the current generation's metadata.
ALTER TABLE job_parts ADD COLUMN file_name TEXT;
ALTER TABLE job_parts ADD COLUMN size_bytes INTEGER;
ALTER TABLE jobs ADD COLUMN finalized_through TEXT;
