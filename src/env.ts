export interface JobMessage { jobId: number; generation: number; kind?: 'cleanup' }
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  QUEUE: Queue<JobMessage>;
  ASSETS: Fetcher;
  DISCORD_TOKEN?: string;
  DISCORD_COOKIES?: string;
  OUTBOUND_PROXY?: string;
  OUTBOUND_PROXY_SECRET?: string;
  PANEL_PASSWORD?: string;
  SESSION_SECRET?: string;
  NOTIFY_WEBHOOK?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  GOOGLE_DRIVE_CLIENT_ID?: string;
  GOOGLE_DRIVE_CLIENT_SECRET?: string;
  GOOGLE_DRIVE_REFRESH_TOKEN?: string;
  GOOGLE_DRIVE_FOLDER_ID?: string;
}
export interface Job {
  id: number; source_type: 'channel' | 'guild'; source_id: string; target_user_id: string;
  date_from: number; date_to: number; mode: string; part_size: number; blank_line: number; skip_empty: number;
  status: string; part_index: number; boundary_cursor: string | null; page_cursor: string | null;
  buffer_count: number; scanned: number; fetched: number; written: number; requests: number;
  last_error: string | null; created_at: number; updated_at: number; dry_run: number;
  delay_min: number; delay_max: number; phase: string; scan_version: number; scan_generation: number; scan_done: number;
  lease_owner: string | null; lease_until: number; assembly_version: number; assembly_page: number | null; assembly_offset: number;
  partial_key: string | null; partial_count: number; partial_start_page: number | null; partial_start_offset: number | null;
  failures: number; started_at: number | null; guild_discovered: number; guild_errors: number;
}
export async function getJob(env: Env, id: number): Promise<Job | null> {
  return env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<Job>();
}
export async function log(env: Env, id: number, level: 'info' | 'warn' | 'error', message: string) {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO job_log(job_id,ts,level,message) VALUES (?,?,?,?)').bind(id, Date.now(), level, message.slice(0, 500)),
    env.DB.prepare('DELETE FROM job_log WHERE job_id=? AND id NOT IN (SELECT id FROM job_log WHERE job_id=? ORDER BY id DESC LIMIT 500)').bind(id, id),
  ]);
}
export async function schedule(env: Env, jobId: number, generation: number, delayMs = 0) {
  await env.QUEUE.send({ jobId, generation }, { delaySeconds: Math.min(43200, Math.max(0, Math.ceil(delayMs / 1000))) });
}
