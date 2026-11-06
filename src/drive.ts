import type { Env, Job } from './env';

type DrivePart = { part_index: number; r2_key: string; file_name: string; drive_file_id: string | null };
export function driveConfigured(env: Env): boolean {
  return !!(env.GOOGLE_DRIVE_CLIENT_ID && env.GOOGLE_DRIVE_CLIENT_SECRET && env.GOOGLE_DRIVE_REFRESH_TOKEN && env.GOOGLE_DRIVE_FOLDER_ID);
}
function configuredCount(env: Env) { return [env.GOOGLE_DRIVE_CLIENT_ID, env.GOOGLE_DRIVE_CLIENT_SECRET, env.GOOGLE_DRIVE_REFRESH_TOKEN, env.GOOGLE_DRIVE_FOLDER_ID].filter(Boolean).length; }
export function validateDriveConfig(env: Env) {
  const count = configuredCount(env);
  if (count && count !== 4) throw new Error('Настройки Google Диска заполнены не полностью');
}
async function accessToken(env: Env): Promise<string> {
  const body = new URLSearchParams({ client_id: env.GOOGLE_DRIVE_CLIENT_ID!, client_secret: env.GOOGLE_DRIVE_CLIENT_SECRET!, refresh_token: env.GOOGLE_DRIVE_REFRESH_TOKEN!, grant_type: 'refresh_token' });
  const response = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers: { 'content-type':'application/x-www-form-urlencoded' }, body, signal:AbortSignal.timeout(10_000), redirect:'manual' });
  if (!response.ok) throw new Error(`Google OAuth HTTP ${response.status}`);
  const data = await response.json() as {access_token?: unknown};
  if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('Google OAuth: неверный ответ');
  return data.access_token;
}
/** Upload one part per step. A generated Google file ID is recorded BEFORE
 * upload, then checked before retry, preventing duplicate remote files. */
export async function uploadDriveStep(env: Env, job: Job): Promise<'more' | 'completed' | 'stale'> {
  validateDriveConfig(env);
  if (!driveConfigured(env)) throw new Error('Google Диск не настроен');
  const folder = env.GOOGLE_DRIVE_FOLDER_ID!;
  if (!/^[A-Za-z0-9_-]{5,200}$/.test(folder)) throw new Error('Некорректный ID папки Google Диска');
  const row = await env.DB.prepare("SELECT part_index,r2_key,file_name,drive_file_id FROM job_parts WHERE job_id=? AND drive_status='pending' ORDER BY part_index LIMIT 1").bind(job.id).first<DrivePart>();
  if (!row) {
    const result = await env.DB.prepare("UPDATE jobs SET status=CASE WHEN guild_errors>0 THEN 'completed_with_errors' ELSE 'completed' END,phase='done',updated_at=? WHERE id=? AND scan_generation=? AND status='running' AND phase='drive'").bind(Date.now(),job.id,job.scan_generation).run();
    return result.meta.changes ? 'completed' : 'stale';
  }
  const token = await accessToken(env);
  const headers = { Authorization: `Bearer ${token}` };
  let fileId = row.drive_file_id;
  if (!fileId) {
    const generated = await fetch('https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive', { headers, signal:AbortSignal.timeout(10_000), redirect:'manual' });
    if (!generated.ok) throw new Error(`Google Drive HTTP ${generated.status}`);
    const data = await generated.json() as {ids?: unknown};
    if (!Array.isArray(data.ids) || typeof data.ids[0] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(data.ids[0])) throw new Error('Google Drive: неверный ID файла');
    const set = await env.DB.prepare("UPDATE job_parts SET drive_file_id=? WHERE job_id=? AND part_index=? AND drive_file_id IS NULL AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND scan_generation=? AND status='running' AND phase='drive')")
      .bind(data.ids[0],job.id,row.part_index,job.id,job.scan_generation).run();
    if (!set.meta.changes) return 'stale';
    fileId = data.ids[0];
  }
  const existing = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id&supportsAllDrives=true`, { headers, signal:AbortSignal.timeout(10_000), redirect:'manual' });
  if (!existing.ok && existing.status !== 404) throw new Error(`Google Drive HTTP ${existing.status}`);
  if (existing.status === 404) {
    const object = await env.BUCKET.get(row.r2_key);
    if (!object) throw new Error('Отсутствует файл для Google Диска');
    const boundary = `akira_${crypto.randomUUID().replace(/-/g,'')}`;
    const meta = JSON.stringify({ id:fileId, name:row.file_name, parents:[folder], mimeType:'text/plain' });
    const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n`, await object.arrayBuffer(), `\r\n--${boundary}--\r\n`]);
    const upload = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', { method:'POST', headers: { ...headers, 'content-type': `multipart/related; boundary=${boundary}` }, body, signal:AbortSignal.timeout(30_000), redirect:'manual' });
    if (!upload.ok) throw new Error(`Google Drive HTTP ${upload.status}`);
  }
  const result = await env.DB.prepare("UPDATE job_parts SET drive_status='done' WHERE job_id=? AND part_index=? AND drive_file_id=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND scan_generation=? AND status='running' AND phase='drive')")
    .bind(job.id,row.part_index,fileId,job.id,job.scan_generation).run();
  return result.meta.changes ? 'more' : 'stale';
}
