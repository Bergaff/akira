import type { Env, JobMessage } from './env';
/** Deletes R2 objects in bounded queue steps. Files copied to Google Drive are
 * intentionally left untouched. Generation prevents old work from committing. */
export async function cleanupStep(env: Env, message: JobMessage): Promise<void> {
  const {jobId, generation} = message;
  if (!Number.isSafeInteger(jobId) || jobId < 1 || !Number.isSafeInteger(generation)) return;
  const owner = crypto.randomUUID(), now = Date.now();
  const lease = await env.DB.prepare("UPDATE jobs SET lease_owner=?,lease_until=?,updated_at=? WHERE id=? AND scan_generation=? AND phase='cleanup' AND lease_until<?")
    .bind(owner,now+60_000,now,jobId,generation,now).run();
  if (!lease.meta.changes) return;
  let again = false;
  try {
    for (const prefix of ['staging','partial','parts']) {
      const list = await env.BUCKET.list({ prefix:`${prefix}/${jobId}/`, limit:1000 });
      if (list.objects.length) {
        await env.BUCKET.delete(list.objects.map(x => x.key));
        again = true;
        break;
      }
    }
    if (!again) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM job_parts WHERE job_id=?').bind(jobId),
        env.DB.prepare('DELETE FROM scan_pages WHERE job_id=?').bind(jobId),
        env.DB.prepare('DELETE FROM guild_channels WHERE job_id=?').bind(jobId),
        env.DB.prepare('DELETE FROM thread_discovery WHERE job_id=?').bind(jobId),
        env.DB.prepare('DELETE FROM job_log WHERE job_id=?').bind(jobId),
        env.DB.prepare("DELETE FROM jobs WHERE id=? AND scan_generation=? AND phase='cleanup'").bind(jobId,generation),
      ]);
    }
  } finally {
    await env.DB.prepare('UPDATE jobs SET lease_owner=NULL,lease_until=0 WHERE id=? AND lease_owner=?').bind(jobId,owner).run();
  }
  if (again) await env.QUEUE.send({jobId,generation,kind:'cleanup'});
}
