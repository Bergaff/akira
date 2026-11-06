import type { Env, Job } from './env';
import { fileName, type StagedMessage } from './scan';
import { driveConfigured, validateDriveConfig } from './drive';

/** One bounded assembly step. The partial part is durably stored in R2 between
 * steps. R2 objects are immutable per attempt; D1 points only to committed
 * objects and is updated atomically with a part record. */
export async function assembleStep(env: Env, job: Job): Promise<'more' | 'completed' | 'stale'> {
  const pageIndex = job.assembly_page ?? job.scan_version;
  let offset = job.assembly_offset;
  let partial: StagedMessage[] = [];
  let startPage = job.partial_start_page ?? pageIndex;
  let startOffset = job.partial_start_offset ?? offset;
  if (job.partial_key) {
    const object = await env.BUCKET.get(job.partial_key);
    if (!object) {
      // Reconstruct from the exact beginning of the lost partial, never from
      // the later page cursor, and do not change committed part counters.
      if (job.partial_start_page === null || job.partial_start_offset === null) throw new Error('Потерян буфер части и его граница восстановления');
      const reset = await env.DB.prepare(`UPDATE jobs SET assembly_page=?,assembly_offset=?,partial_key=NULL,partial_count=0,partial_start_page=NULL,partial_start_offset=NULL,assembly_version=assembly_version+1,updated_at=? WHERE id=? AND scan_generation=? AND assembly_version=? AND status='running'`)
        .bind(job.partial_start_page, job.partial_start_offset, Date.now(), job.id, job.scan_generation, job.assembly_version).run();
      return reset.meta.changes === 1 ? 'more' : 'stale';
    }
    const data: unknown = await object.json();
    if (!Array.isArray(data) || data.length !== job.partial_count || data.some(m => !m || typeof m.id !== 'string' || typeof m.content !== 'string')) throw new Error('Повреждён буфер части');
    partial = data as StagedMessage[];
  } else if (job.partial_count !== 0) throw new Error('Отсутствует указатель на буфер');

  let nextPage = pageIndex;
  if (pageIndex > 0 && partial.length < job.part_size) {
    const row = await env.DB.prepare('SELECT r2_key,messages FROM scan_pages WHERE job_id=? AND generation=? AND page_index=?').bind(job.id, job.scan_generation, pageIndex).first<{ r2_key: string; messages: number }>();
    if (!row) throw new Error('Отсутствует сохранённая страница');
    const object = await env.BUCKET.get(row.r2_key);
    if (!object) throw new Error('Отсутствуют данные сохранённой страницы');
    const data: unknown = await object.json();
    if (!Array.isArray(data) || data.length !== row.messages || data.some(m => !m || typeof m.id !== 'string' || typeof m.content !== 'string')) throw new Error('Повреждена сохранённая страница');
    const ordered = (data as StagedMessage[]).reverse();
    if (offset > ordered.length) throw new Error('Некорректная позиция сборки');
    const take = Math.min(job.part_size - partial.length, ordered.length - offset);
    partial.push(...ordered.slice(offset, offset + take));
    offset += take;
    if (offset === ordered.length) { nextPage--; offset = 0; }
  }
  if (partial.length === job.part_size || (nextPage === 0 && partial.length)) {
    const index = job.part_index + 1;
    const from = new Date(job.date_from).toISOString().slice(0, 10), to = new Date(job.date_to).toISOString().slice(0, 10);
    const name = fileName(job.target_user_id, from, to, index);
    const text = partial.map(m => m.content).join(job.blank_line ? '\n\n' : '\n');
    const bytes = new TextEncoder().encode(text);
    // Discord messages have a bounded content size; limit part count at input.
    if (bytes.byteLength > 24 * 1024 * 1024) throw new Error('Часть превышает допустимый размер; уменьшите размер части');
    const key = `parts/${job.id}/${job.scan_generation}/${crypto.randomUUID()}/${name}`;
    await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
    const statements = [
      env.DB.prepare(`INSERT INTO job_parts(job_id,part_index,r2_key,messages,oldest_id,newest_id,created_at,file_name,size_bytes)
        SELECT id,?,?,?,?,?,?,?,? FROM jobs WHERE id=? AND scan_generation=? AND assembly_version=? AND status='running' AND phase='assembly' AND part_index=?`)
        .bind(index, key, partial.length, partial[0].id, partial[partial.length - 1].id, Date.now(), name, bytes.byteLength, job.id, job.scan_generation, job.assembly_version, job.part_index),
      env.DB.prepare(`UPDATE jobs SET part_index=?,written=written+?,buffer_count=buffer_count-?,finalized_through=?,assembly_page=?,assembly_offset=?,partial_key=NULL,partial_count=0,partial_start_page=NULL,partial_start_offset=NULL,assembly_version=assembly_version+1,updated_at=?
        WHERE id=? AND scan_generation=? AND assembly_version=? AND status='running' AND phase='assembly' AND part_index=?`)
        .bind(index, partial.length, partial.length, partial[partial.length - 1].id, nextPage, offset, Date.now(), job.id, job.scan_generation, job.assembly_version, job.part_index),
    ];
    if (job.source_type === 'guild') {
      const counts = new Map<string, number>();
      for (const m of partial) {
        if (!m.channelId) throw new Error('Отсутствует ID канала в буфере');
        counts.set(m.channelId, (counts.get(m.channelId) ?? 0) + 1);
      }
      const channels = Array.from(counts, ([id, count]) => ({id, count}));
      statements.push(env.DB.prepare(`UPDATE guild_channels SET written=written+(SELECT CAST(json_extract(value,'$.count') AS INTEGER) FROM json_each(?) WHERE json_extract(value,'$.id')=guild_channels.channel_id)
        WHERE job_id=? AND channel_id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND scan_generation=? AND status='running' AND phase='assembly' AND assembly_version=? AND part_index=?)`)
        .bind(JSON.stringify(channels), job.id, JSON.stringify(channels), job.id, job.scan_generation, job.assembly_version+1, index));
    }
    const [insert, update] = await env.DB.batch(statements);
    if (insert.meta.changes === 0 && update.meta.changes === 0) { try { await env.BUCKET.delete(key); } catch {} return 'stale'; }
    if (insert.meta.changes !== 1 || update.meta.changes !== 1) throw new Error('Ошибка фиксации части');
    if (job.partial_key) try { await env.BUCKET.delete(job.partial_key); } catch {}
    return 'more';
  }
  if (nextPage === 0 && partial.length === 0) {
    validateDriveConfig(env);
    const useDrive = driveConfigured(env);
    const res = await env.DB.prepare("UPDATE jobs SET status=CASE WHEN ?=1 THEN 'running' WHEN guild_errors>0 THEN 'completed_with_errors' ELSE 'completed' END,phase=CASE WHEN ?=1 THEN 'drive' ELSE 'done' END,updated_at=? WHERE id=? AND scan_generation=? AND assembly_version=? AND status='running' AND phase='assembly' AND buffer_count=0")
      .bind(Number(useDrive), Number(useDrive), Date.now(), job.id, job.scan_generation, job.assembly_version).run();
    return res.meta.changes ? (useDrive ? 'more' : 'completed') : 'stale';
  }
  let key: string | null = null;
  if (partial.length) {
    key = `partial/${job.id}/${job.scan_generation}/${crypto.randomUUID()}.json`;
    await env.BUCKET.put(key, JSON.stringify(partial));
  } else { startPage = nextPage; startOffset = offset; }
  const res = await env.DB.prepare(`UPDATE jobs SET assembly_page=?,assembly_offset=?,partial_key=?,partial_count=?,partial_start_page=?,partial_start_offset=?,assembly_version=assembly_version+1,updated_at=?
    WHERE id=? AND scan_generation=? AND assembly_version=? AND status='running' AND phase='assembly'`)
    .bind(nextPage, offset, key, partial.length, partial.length ? startPage : null, partial.length ? startOffset : null, Date.now(), job.id, job.scan_generation, job.assembly_version).run();
  if (!res.meta.changes) { if (key) try { await env.BUCKET.delete(key); } catch {} return 'stale'; }
  // Any in-flight reader holding the previous version can no longer commit it.
  if (job.partial_key) try { await env.BUCKET.delete(job.partial_key); } catch {}
  return 'more';
}
