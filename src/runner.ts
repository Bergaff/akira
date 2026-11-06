import { discordFetchPage, discordFetchChannels, discordFetchThreads, type ThreadCursor, DiscordError } from './discord';
import { type Env, type JobMessage, getJob, log, schedule } from './env';
import { DiscordBusy, limitedDiscord } from './limits';
import { notify } from './notify';
import { R2ScanStore } from './r2-scan-store';
import { preparePage } from './scan';
import { assembleStep } from './assembly';
import { uploadDriveStep } from './drive';

/** A step performs at most one Discord request or one bounded assembly step. */
export async function runStep(env: Env, message: JobMessage): Promise<void> {
  const { jobId, generation } = message;
  if (!Number.isSafeInteger(jobId) || jobId < 1 || !Number.isSafeInteger(generation) || generation < 0) return;
  const owner = crypto.randomUUID(), now = Date.now();
  const leased = await env.DB.prepare("UPDATE jobs SET lease_owner=?,lease_until=?,updated_at=? WHERE id=? AND scan_generation=? AND status IN ('queued','running','rate_limited') AND lease_until<?")
    .bind(owner, now + 60_000, now, jobId, generation, now).run();
  if (!leased.meta.changes) return;
  let delay = 0, again = false;
  let guildChannel: {channel_id: string} | null = null;
  let discovery: ThreadCursor | null = null;
  try {
    let job = await getJob(env, jobId);
    if (!job || job.scan_generation !== generation) return;
    if (job.status === 'queued' || job.status === 'rate_limited') {
      await env.DB.prepare("UPDATE jobs SET status='running',updated_at=? WHERE id=? AND scan_generation=? AND lease_owner=? AND status IN ('queued','rate_limited')").bind(Date.now(), jobId, generation, owner).run();
      job = await getJob(env, jobId);
      if (!job || job.status !== 'running') return;
    }
    if (job.phase === 'scan') {
      if (!env.DISCORD_TOKEN) throw new DiscordError(401, null, 'Discord token missing');
      if (job.source_type === 'guild' && !job.guild_discovered) {
        const channels = await limitedDiscord(env, job.delay_min, job.delay_max, send => discordFetchChannels(job!.source_id, env.DISCORD_TOKEN!, env.DISCORD_COOKIES, send));
        await env.DB.batch([
          env.DB.prepare(`INSERT OR IGNORE INTO guild_channels(job_id,channel_id,name)
            SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.name') FROM json_each(?)
            WHERE json_extract(value,'$.type') IN (0,5,10,11,12) AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND scan_generation=? AND status='running' AND guild_discovered=0)`)
            .bind(jobId, JSON.stringify(channels), jobId, generation),
          env.DB.prepare(`INSERT OR IGNORE INTO thread_discovery(job_id,parent_id,kind)
            SELECT id,source_id,'active' FROM jobs WHERE id=? AND scan_generation=? AND status='running' AND guild_discovered=0`).bind(jobId,generation),
          env.DB.prepare(`INSERT OR IGNORE INTO thread_discovery(job_id,parent_id,kind)
            SELECT ?,json_extract(value,'$.id'),k.kind FROM json_each(?) CROSS JOIN (SELECT 'public' kind UNION ALL SELECT 'private' UNION ALL SELECT 'joined') k
            WHERE json_extract(value,'$.type') IN (0,5,15,16) AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND scan_generation=? AND status='running' AND guild_discovered=0)`)
            .bind(jobId,JSON.stringify(channels),jobId,generation),
          env.DB.prepare("UPDATE jobs SET guild_discovered=1,requests=requests+1,updated_at=? WHERE id=? AND scan_generation=? AND status='running' AND guild_discovered=0")
            .bind(Date.now(), jobId, generation),
        ]);
        await log(env, jobId, 'info', `Найдено каналов: ${channels.length}; поиск активных и архивных тредов`);
        again = true;
      } else {
        if (job.source_type === 'guild') discovery = await env.DB.prepare("SELECT parent_id,kind,cursor FROM thread_discovery WHERE job_id=? AND done=0 ORDER BY CASE kind WHEN 'active' THEN 0 ELSE 1 END,parent_id,kind LIMIT 1").bind(jobId).first<ThreadCursor>();
        if (discovery) {
          const threads = await limitedDiscord(env,job.delay_min,job.delay_max,send => discordFetchThreads(discovery!,env.DISCORD_TOKEN!,env.DISCORD_COOKIES,send));
          await env.DB.batch([
            env.DB.prepare(`INSERT OR IGNORE INTO guild_channels(job_id,channel_id,name)
              SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.name') FROM json_each(?)
              WHERE EXISTS(SELECT 1 FROM jobs WHERE id=? AND scan_generation=? AND status='running')`)
              .bind(jobId,JSON.stringify(threads.threads),jobId,generation),
            env.DB.prepare(`UPDATE thread_discovery SET cursor=?,done=? WHERE job_id=? AND parent_id=? AND kind=? AND cursor IS ? AND done=0
              AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND scan_generation=? AND status='running')`)
              .bind(threads.next,Number(threads.done),jobId,discovery.parent_id,discovery.kind,discovery.cursor,jobId,generation),
            env.DB.prepare("UPDATE jobs SET requests=requests+1,failures=0,last_error=NULL,updated_at=? WHERE id=? AND scan_generation=? AND status='running'").bind(Date.now(),jobId,generation),
          ]);
          again = true;
        } else {
        if (job.source_type === 'guild') {
          guildChannel = await env.DB.prepare("SELECT channel_id FROM guild_channels WHERE job_id=? AND status IN ('pending','running') ORDER BY channel_id LIMIT 1").bind(jobId).first<{channel_id: string}>();
          if (!guildChannel) {
            const counts = await env.DB.prepare("SELECT count(*) AS total, sum(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done FROM guild_channels WHERE job_id=?").bind(jobId).first<{total:number; done:number|null}>();
            if (counts?.total && !counts.done) {
              await env.DB.prepare("UPDATE jobs SET status='failed',last_error='Нет доступа ни к одному каналу',updated_at=? WHERE id=? AND scan_generation=? AND status='running'").bind(Date.now(), jobId, generation).run();
              await log(env, jobId, 'error', 'Нет доступа ни к одному каналу');
            } else if (job.dry_run) {
              await env.DB.prepare("UPDATE jobs SET status=CASE WHEN guild_errors>0 THEN 'completed_with_errors' ELSE 'completed' END,phase='done',scan_done=1,updated_at=? WHERE id=? AND scan_generation=? AND status='running'").bind(Date.now(), jobId, generation).run();
              await log(env, jobId, 'info', `Пробный проход завершён: найдено ${job.fetched}`);
              await notify(env, `Пробный проход #${jobId}: найдено ${job.fetched} сообщений.`, jobId);
            } else {
              await env.DB.prepare("UPDATE jobs SET scan_done=1,phase='assembly',updated_at=? WHERE id=? AND scan_generation=? AND status='running'").bind(Date.now(), jobId, generation).run();
              again = true;
            }
          }
        }
        if (job.source_type === 'channel' || guildChannel) {
          const channelId = guildChannel?.channel_id ?? job.source_id;
          const store = new R2ScanStore(env.DB, env.BUCKET, job.id, generation);
          const previous = await store.readCheckpoint();
          if (previous.done) {
            await env.DB.prepare("UPDATE jobs SET phase='assembly',updated_at=? WHERE id=? AND scan_generation=? AND status='running' AND scan_done=1").bind(Date.now(), jobId, generation).run();
            again = true;
          } else {
            const cursor = previous.pageCursor ?? ((BigInt(job.date_to + 1) - 1420070400000n) << 22n).toString();
            const page = await limitedDiscord(env, job.delay_min, job.delay_max, send => discordFetchPage(env.DISCORD_TOKEN!, env.DISCORD_COOKIES, send)(channelId, cursor));
            const prepared = preparePage({ channelId, targetUserId: job.target_user_id, dateFrom: job.date_from, dateTo: job.date_to, skipEmpty: !!job.skip_empty }, previous, page);
            const channelDone = prepared.checkpoint.done;
            const channelCursor = prepared.checkpoint.pageCursor;
            if (guildChannel) prepared.messages = prepared.messages.map(m => ({ ...m, channelId }));
            const scannedDelta = prepared.checkpoint.scanned - previous.scanned, fetchedDelta = prepared.checkpoint.fetched - previous.fetched;
            if (guildChannel && channelDone) { prepared.checkpoint.done = false; prepared.checkpoint.pageCursor = null; }
            if (job.dry_run) { prepared.messages = []; prepared.checkpoint.buffered = 0; }
            const committed = await store.commitPage(previous.version, prepared, guildChannel ? { channelId, channelDone, channelCursor, scanned: scannedDelta, fetched: fetchedDelta } : undefined);
            if (committed) {
              await env.DB.prepare("UPDATE jobs SET failures=0,last_error=NULL WHERE id=? AND scan_generation=? AND status='running'").bind(jobId, generation).run();
              if (channelDone && guildChannel) await log(env, jobId, 'info', `Канал ${channelId} обработан`);
              if (prepared.checkpoint.done && job.dry_run) {
                await env.DB.prepare("UPDATE jobs SET status='completed',phase='done',updated_at=? WHERE id=? AND scan_generation=? AND status='running'").bind(Date.now(), jobId, generation).run();
                await log(env, jobId, 'info', `Пробный проход завершён: найдено ${prepared.checkpoint.fetched}`);
                await notify(env, `Пробный проход #${jobId}: найдено ${prepared.checkpoint.fetched} сообщений.`, jobId);
              } else again = true;
            }
          }
        }
        }
      }
    } else if (job.phase === 'assembly') {
      const result = await assembleStep(env, job);
      if (result === 'more') {
        await env.DB.prepare("UPDATE jobs SET failures=0,last_error=NULL WHERE id=? AND scan_generation=? AND status='running'").bind(jobId, generation).run();
        again = true;
        const updated = await getJob(env, jobId);
        if (updated && updated.part_index > job.part_index && updated.part_index % 10 === 0) {
          await log(env, jobId, 'info', `Готово частей: ${updated.part_index}`);
          await notify(env, `Выгрузка #${jobId}: готово ${updated.part_index} частей.`, jobId);
        }
      }
      if (result === 'completed') {
        const completed = await getJob(env, jobId);
        await log(env, jobId, 'info', `Завершено: ${completed?.written ?? 0} сообщений, ${completed?.part_index ?? 0} частей`);
        await notify(env, `Выгрузка #${jobId} завершена: ${completed?.written ?? 0} сообщений, ${completed?.part_index ?? 0} частей.`, jobId);
      }
    } else if (job.phase === 'drive') {
      const result = await uploadDriveStep(env, job);
      if (result === 'more') { again = true; await env.DB.prepare("UPDATE jobs SET failures=0,last_error=NULL,updated_at=? WHERE id=? AND scan_generation=? AND status='running'").bind(Date.now(),jobId,generation).run(); }
      if (result === 'completed') {
        const completed = await getJob(env, jobId);
        await log(env, jobId, 'info', `Завершено: ${completed?.written ?? 0} сообщений, ${completed?.part_index ?? 0} частей; файлы скопированы на Google Диск`);
        await notify(env, `Выгрузка #${jobId} завершена: ${completed?.written ?? 0} сообщений, ${completed?.part_index ?? 0} частей. Файлы на Google Диске.`, jobId);
      }
    }
  } catch (error) {
    if (error instanceof DiscordError) await env.DB.prepare("UPDATE jobs SET requests=requests+1 WHERE id=? AND scan_generation=? AND status='running'").bind(jobId,generation).run();
    if (error instanceof DiscordBusy) { delay = error.waitMs; again = true; }
    else if (error instanceof DiscordError && error.status === 429) {
      delay = Math.max(2000, error.retryAfterMs ?? 5000);
      await env.DB.prepare("UPDATE jobs SET status='rate_limited',last_error=?,updated_at=? WHERE id=? AND scan_generation=? AND status='running'").bind('Discord 429: ожидание лимита', Date.now(), jobId, generation).run();
      await log(env, jobId, 'warn', 'Discord 429: ожидание лимита'); await notify(env, `Выгрузка #${jobId}: Discord вернул 429, ожидание лимита.`, jobId); again = true;
    } else if (error instanceof DiscordError && (error.status === 403 || error.status === 404) && discovery) {
      await env.DB.batch([
        env.DB.prepare("UPDATE thread_discovery SET done=1 WHERE job_id=? AND parent_id=? AND kind=? AND cursor IS ? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND scan_generation=? AND status='running')")
          .bind(jobId,discovery.parent_id,discovery.kind,discovery.cursor,jobId,generation),
        env.DB.prepare("UPDATE jobs SET guild_errors=guild_errors+1,updated_at=? WHERE id=? AND scan_generation=? AND status='running'").bind(Date.now(),jobId,generation),
      ]);
      await log(env,jobId,'warn',`Не удалось перечислить треды ${discovery.kind} канала ${discovery.parent_id}: Discord ${error.status}`);
      if (error.status === 403) await notify(env,`Выгрузка #${jobId}: доступ к части тредов ограничен (403).`,jobId);
      again = true;
    } else if (error instanceof DiscordError && error.status === 403 && guildChannel) {
      await env.DB.batch([
        env.DB.prepare("UPDATE guild_channels SET status='skipped' WHERE job_id=? AND channel_id=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND scan_generation=? AND status='running')").bind(jobId, guildChannel.channel_id, jobId, generation),
        env.DB.prepare("UPDATE jobs SET page_cursor=NULL,guild_errors=guild_errors+1,updated_at=? WHERE id=? AND scan_generation=? AND status='running'").bind(Date.now(), jobId, generation),
      ]);
      await log(env, jobId, 'warn', `Канал ${guildChannel.channel_id} пропущен: нет доступа (403)`);
      await notify(env, `Выгрузка #${jobId}: канал ${guildChannel.channel_id} недоступен (403).`, jobId);
      again = true;
    } else if (error instanceof DiscordError && (error.status === 401 || error.status === 403)) {
      const text = error.status === 401 ? 'Токен Discord недействителен' : 'Нет доступа к каналу (403), либо требуются свежие cookies';
      await env.DB.prepare("UPDATE jobs SET status='failed',last_error=?,updated_at=? WHERE id=? AND scan_generation=? AND status='running'").bind(text, Date.now(), jobId, generation).run();
      await log(env, jobId, 'error', text); await notify(env, `Выгрузка #${jobId}: ${text}.`, jobId);
    } else {
      const current = await getJob(env, jobId);
      if (current && current.scan_generation === generation && current.status === 'running') {
        const failures = current.failures + 1;
        const text = error instanceof DiscordError ? 'Ошибка сети или Discord' : current.phase === 'drive' ? 'Ошибка Google Диска: проверьте настройки и доступ' : 'Ошибка обработки или хранилища';
        await env.DB.prepare("UPDATE jobs SET failures=?,status=?,last_error=?,updated_at=? WHERE id=? AND scan_generation=? AND status='running'").bind(failures, failures >= 5 ? 'failed' : 'running', text, Date.now(), jobId, generation).run();
        await log(env, jobId, 'error', `${text}; попытка ${failures} из 5`);
        if (failures < 5) { delay = Math.min(60_000, 1000 * 2 ** failures); again = true; }
      }
    }
  } finally {
    await env.DB.prepare('UPDATE jobs SET lease_owner=NULL,lease_until=0 WHERE id=? AND lease_owner=?').bind(jobId, owner).run();
  }
  if (again) {
    // Enqueue after releasing the lease. If this fails, the cron watchdog retries.
    await schedule(env, jobId, generation, delay);
  }
}
