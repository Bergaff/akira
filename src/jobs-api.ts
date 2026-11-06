import { type Env, type Job, getJob, log, schedule } from './env';
import { dateWindow, msFromId } from './scan';
import { notify } from './notify';

function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }); }
function error(text: string, status = 400) { return json({ error: text }, status); }
function numericId(value: unknown, type: 'channel' | 'guild' | 'author'): string | null {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (/^\d{5,20}$/.test(input)) return input;
  if (type === 'author') return null;
  try {
    const u = new URL(input);
    if (u.protocol !== 'https:' || !['discord.com','www.discord.com','discordapp.com'].includes(u.hostname)) return null;
    const m = u.pathname.match(/^\/channels\/(\d{5,20})(?:\/(\d{5,20}))?(?:\/\d{5,20})?\/?$/);
    return m ? (type === 'guild' ? m[1] : m[2] ?? null) : null;
  } catch { return null; }
}
function dateString(value: unknown) { return typeof value === 'string' ? value : ''; }

function jobView(job: Job) {
  let eta_seconds: number | null = null;
  if (job.source_type === 'channel' && job.phase === 'scan' && job.status === 'running' && job.started_at && job.page_cursor) {
    try {
      const p = Math.max(0, Math.min(1, (job.date_to - msFromId(job.page_cursor)) / (job.date_to - job.date_from + 1)));
      if (p > 0 && p < 1) eta_seconds = Math.round(((Date.now() - job.started_at) / 1000) * (1 - p) / p);
    } catch { /* malformed cursor: no estimate */ }
  }
  return { ...job, eta_seconds };
}

export async function jobsApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname;
  if (path === '/api/jobs' && request.method === 'GET') {
    const result = await env.DB.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 200').all<Job>();
    return json({ jobs: result.results.map(jobView) });
  }
  if (path === '/api/jobs' && request.method === 'POST') {
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return error('Ожидается JSON', 415);
    let data: Record<string, unknown>;
    try {
      const text = await request.text();
      if (text.length > 4096) return error('Слишком большой запрос', 413);
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return error('Неверные параметры');
      data = parsed as Record<string, unknown>;
    } catch { return error('Неверный JSON'); }
    const type = data.source_type;
    if (type !== 'channel' && type !== 'guild') return error('Укажите канал или сервер');
    if ((type === 'channel' && data.mode !== 'scan') || (type === 'guild' && data.mode !== 'guild')) return error('Выберите режим scan для канала или guild для сервера');
    const channel = numericId(data.source_id, type), target = numericId(data.target_user_id, 'author');
    if (!channel || !target) return error('Укажите корректные ID источника и автора');
    let dates: ReturnType<typeof dateWindow>;
    try { dates = dateWindow(dateString(data.date_from), dateString(data.date_to)); }
    catch { return error('Проверьте даты периода'); }
    const partSize = Number(data.part_size ?? 3000), min = Number(data.delay_min ?? 1200), max = Number(data.delay_max ?? 2800);
    if (!Number.isSafeInteger(partSize) || partSize < 1 || partSize > 3000) return error('Размер части: от 1 до 3000');
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1200 || max < min || max > 10000) return error('Паузы должны быть от 1200 до 10000 мс');
    const dry = data.dry_run === true ? 1 : 0, blank = data.blank_line_between === false ? 0 : 1, skip = data.skip_empty === false ? 0 : 1;
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO jobs(source_type,source_id,target_user_id,date_from,date_to,mode,part_size,blank_line,skip_empty,dry_run,delay_min,delay_max,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?, ?,?,?,?,?,?, 'queued',?,?) ON CONFLICT(source_type,source_id,target_user_id,date_from,date_to,mode) DO NOTHING`)
      .bind(type, channel, target, dates.dateFrom, dates.dateTo, data.mode, partSize, blank, skip, dry, min, max, now, now).run();
    let job = await env.DB.prepare("SELECT * FROM jobs WHERE source_type=? AND source_id=? AND target_user_id=? AND date_from=? AND date_to=? AND mode=?")
      .bind(type, channel, target, dates.dateFrom, dates.dateTo, data.mode).first<Job>();
    if (!job) throw new Error('Job creation failed');
    // The unique key intentionally excludes dry_run. Reuse a finished count
    // when the user subsequently requests an actual export for the same key.
    if (job.dry_run === 1 && dry === 0 && ['completed','completed_with_errors'].includes(job.status)) {
      const oldGeneration = job.scan_generation;
      await env.DB.batch([
        env.DB.prepare(`UPDATE jobs SET dry_run=0,part_size=?,blank_line=?,skip_empty=?,delay_min=?,delay_max=?,status='queued',scan_generation=scan_generation+1,scan_version=0,scan_done=0,phase='scan',page_cursor=NULL,boundary_cursor=NULL,part_index=0,buffer_count=0,scanned=0,fetched=0,written=0,requests=0,last_error=NULL,lease_owner=NULL,lease_until=0,assembly_version=0,assembly_page=NULL,assembly_offset=0,partial_key=NULL,partial_count=0,partial_start_page=NULL,partial_start_offset=NULL,finalized_through=NULL,guild_discovered=0,guild_errors=0,failures=0,started_at=NULL,updated_at=? WHERE id=? AND scan_generation=? AND dry_run=1 AND status IN ('completed','completed_with_errors')`)
          .bind(partSize,blank,skip,min,max,now,job.id,oldGeneration),
        env.DB.prepare("DELETE FROM scan_pages WHERE job_id=? AND generation=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND scan_generation=? AND status='queued' AND dry_run=0)")
          .bind(job.id,oldGeneration,job.id,oldGeneration+1),
        env.DB.prepare("DELETE FROM guild_channels WHERE job_id=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND scan_generation=? AND status='queued' AND dry_run=0)")
          .bind(job.id,job.id,oldGeneration+1),
        env.DB.prepare("DELETE FROM thread_discovery WHERE job_id=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND scan_generation=? AND status='queued' AND dry_run=0)")
          .bind(job.id,job.id,oldGeneration+1),
      ]);
      job = await getJob(env, job.id);
      if (!job) throw new Error('Job disappeared');
    }
    if (job.dry_run !== dry || job.part_size !== partSize || job.blank_line !== blank || job.skip_empty !== skip) return error('Задание с таким источником и периодом уже существует с другими настройками. Изменение настроек и повторный запуск пока не поддерживаются.', 409);
    return json({ job }, 200);
  }
  const match = path.match(/^\/api\/jobs\/(\d+)(?:\/(start|pause|resume|restart|cancel|parts))?$/);
  if (match) {
    const id = Number(match[1]), action = match[2];
    if (!Number.isSafeInteger(id) || id < 1) return error('Неверный ID');
    let job = await getJob(env, id);
    if (!job) return error('Задание не найдено', 404);
    if (!action && request.method === 'GET') {
      const logs = await env.DB.prepare('SELECT ts,level,message FROM job_log WHERE job_id=? ORDER BY id DESC LIMIT 500').bind(id).all();
      const channels = job.source_type === 'guild' ? (await env.DB.prepare('SELECT channel_id,name,status,scanned,fetched,written FROM guild_channels WHERE job_id=? ORDER BY channel_id').bind(id).all()).results : [];
      return json({ job: jobView(job), logs: logs.results, channels });
    }
    if (!action && request.method === 'DELETE') {
      if (['running','rate_limited','queued'].includes(job.status)) return error('Сначала остановите или отмените задание', 409);
      if (job.phase === 'cleanup') return json({ ok: true });
      const result = await env.DB.prepare("UPDATE jobs SET status='cancelled',phase='cleanup',scan_generation=scan_generation+1,updated_at=? WHERE id=? AND status NOT IN ('running','rate_limited','queued') AND phase!='cleanup'")
        .bind(Date.now(),id).run();
      if (!result.meta.changes) return error('Состояние задания изменилось', 409);
      const updated = await getJob(env, id);
      if (updated) await env.QUEUE.send({jobId:id,generation:updated.scan_generation,kind:'cleanup'}, {delaySeconds:65});
      return json({ok:true});
    }
    if (job.phase === 'cleanup' && request.method !== 'GET') return error('Удаление уже выполняется', 409);
    if (action === 'parts' && request.method === 'GET') {
      const parts = await env.DB.prepare('SELECT part_index,file_name,size_bytes,messages,drive_file_id,drive_status FROM job_parts WHERE job_id=? ORDER BY part_index').bind(id).all<{part_index: number; file_name: string; size_bytes: number; messages: number; drive_file_id: string | null; drive_status: string}>();
      return json({ parts: parts.results.map(p => ({ ...p, url: `/files/${id}/${encodeURIComponent(p.file_name)}`, drive_url: p.drive_status === 'done' && p.drive_file_id ? `https://drive.google.com/file/d/${encodeURIComponent(p.drive_file_id)}/view` : null })) });
    }
    if (request.method !== 'POST') return error('Метод не поддерживается', 405);
    const now = Date.now();
    if (action === 'start' || action === 'resume') {
      if (['running', 'rate_limited'].includes(job.status)) return json({ job });
      if (!['queued', 'paused', 'failed'].includes(job.status)) return error('Для завершённого задания используйте «Начать заново»', 409);
      const update = await env.DB.prepare("UPDATE jobs SET status='running',failures=0,last_error=NULL,updated_at=?,started_at=COALESCE(started_at,?) WHERE id=? AND status IN ('queued','paused','failed')")
        .bind(now, now, id).run();
      if (!update.meta.changes) return error('Состояние задания изменилось', 409);
      await log(env, id, 'info', 'Выгрузка запущена или продолжена');
      // If sending fails, watchdog will recover the running job.
      await schedule(env, id, job.scan_generation);
      await notify(env, `Выгрузка #${id} запущена или продолжена.`, id);
    } else if (action === 'pause' || action === 'cancel') {
      const status = action === 'pause' ? 'paused' : 'cancelled';
      const update = await env.DB.prepare("UPDATE jobs SET status=?,updated_at=? WHERE id=? AND status IN ('queued','running','rate_limited','paused','failed')").bind(status, now, id).run();
      if (!update.meta.changes) return error('Задание уже завершено или отменено', 409);
      await log(env, id, 'info', action === 'pause' ? 'Задание приостановлено' : 'Задание отменено');
    } else if (action === 'restart') {
      // Generation invalidates all in-flight steps; existing R2 objects remain.
      await env.DB.batch([
        env.DB.prepare(`UPDATE jobs SET status='running',scan_generation=scan_generation+1,scan_version=0,scan_done=0,phase='scan',page_cursor=NULL,boundary_cursor=NULL,part_index=0,buffer_count=0,scanned=0,fetched=0,written=0,requests=0,last_error=NULL,lease_owner=NULL,lease_until=0,assembly_version=0,assembly_page=NULL,assembly_offset=0,partial_key=NULL,partial_count=0,partial_start_page=NULL,partial_start_offset=NULL,finalized_through=NULL,guild_discovered=0,guild_errors=0,failures=0,started_at=?,updated_at=? WHERE id=?`).bind(now, now, id),
        env.DB.prepare('DELETE FROM job_parts WHERE job_id=?').bind(id),
        env.DB.prepare('DELETE FROM scan_pages WHERE job_id=?').bind(id),
        env.DB.prepare('DELETE FROM guild_channels WHERE job_id=?').bind(id),
        env.DB.prepare('DELETE FROM thread_discovery WHERE job_id=?').bind(id),
      ]);
      job = await getJob(env, id);
      if (!job) return error('Задание не найдено', 404);
      await log(env, id, 'info', 'Задание начато заново');
      await schedule(env, id, job.scan_generation);
      await notify(env, `Выгрузка #${id} начата заново.`, id);
    } else return error('Неизвестное действие', 404);
    return json({ job: await getJob(env, id) });
  }
  const file = path.match(/^\/files\/(\d+)\/([^/]+)$/);
  if (file && request.method === 'GET') {
    let name: string;
    try { name = decodeURIComponent(file[2]); } catch { return error('Неверное имя файла'); }
    const row = await env.DB.prepare('SELECT r2_key,file_name FROM job_parts WHERE job_id=? AND file_name=?').bind(Number(file[1]), name).first<{r2_key: string; file_name: string}>();
    if (!row) return error('Файл не найден', 404);
    const object = await env.BUCKET.get(row.r2_key);
    if (!object) return error('Файл отсутствует в хранилище', 404);
    return new Response(object.body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${row.file_name}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
  }
  return null;
}
