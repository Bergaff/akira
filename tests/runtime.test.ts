import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env, JobMessage } from '../src/env';
import { jobsApi } from '../src/jobs-api';
import { runStep } from '../src/runner';
import { cleanupStep } from '../src/cleanup';
import { idFromMs } from '../src/scan';

function fixture() {
  const sql = new DatabaseSync(':memory:');
  for (const file of ['0001_initial.sql', '0002_scan_staging.sql', '0003_part_metadata.sql', '0004_runtime.sql', '0005_guild.sql', '0006_drive.sql', '0007_threads.sql']) sql.exec(readFileSync(`migrations/${file}`, 'utf8'));
  function prepared(text: string, args: unknown[] = []) {
    return {
      bind(...values: unknown[]) { return prepared(text, values); },
      async first<T>() { return (sql.prepare(text).get(...args as never[]) ?? null) as T | null; },
      async all<T>() { return { results: sql.prepare(text).all(...args as never[]) as T[] }; },
      async run() { return { meta: { changes: Number(sql.prepare(text).run(...args as never[]).changes) } }; },
    };
  }
  const db = { prepare: prepared, async batch(statements: ReturnType<typeof prepared>[]) { sql.exec('BEGIN'); try { const result = []; for (const s of statements) result.push(await s.run()); sql.exec('COMMIT'); return result; } catch (e) { sql.exec('ROLLBACK'); throw e; } } };
  const objects = new Map<string, string>();
  const bucket = {
    async put(key: string, value: string | Uint8Array) { objects.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value)); },
    async get(key: string) { const v = objects.get(key); return v === undefined ? null : { json: async () => JSON.parse(v), arrayBuffer: async () => new TextEncoder().encode(v).buffer, body: new Response(v).body }; },
    async delete(key: string | string[]) { for (const k of Array.isArray(key) ? key : [key]) objects.delete(k); },
    async list({prefix}: {prefix:string}) { return { objects: [...objects.keys()].filter(k => k.startsWith(prefix)).slice(0,1000).map(key => ({key})) }; },
  };
  const queue: JobMessage[] = [];
  const env = { DB: db, BUCKET: bucket, QUEUE: { send: async (m: JobMessage) => { queue.push(m); } }, DISCORD_TOKEN: 'secret' } as unknown as Env;
  const api = (path: string, method = 'GET', data?: unknown) => jobsApi(new Request(`https://test.example${path}`, { method, ...(data ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : {}) }) as unknown as Parameters<typeof jobsApi>[0], env);
  return { env, sql, queue, objects, api };
}
const input = { source_type: 'channel', source_id: '123456', target_user_id: '456789', date_from: '2020-01-01', date_to: '2020-01-01', mode: 'scan', part_size: 17 };
function fakeDiscord(count = 330) {
  const base = Date.parse('2020-01-01T00:00:00Z');
  const messages = Array.from({ length: count }, (_, i) => ({ id: idFromMs(base + i * 1000), timestamp: new Date(base + i * 1000).toISOString(), author: { id: i % 3 ? '987654' : '456789' }, content: `message-${i}` })).reverse();
  return async (url: string) => {
    const before = BigInt(new URL(url).searchParams.get('before')!);
    return new Response(JSON.stringify(messages.filter(m => BigInt(m.id) < before).slice(0, 100)), { headers: { 'content-type': 'application/json' } });
  };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function drain(f: ReturnType<typeof fixture>, max = 100) {
  for (let i = 0; f.queue.length && i < max; i++) {
    // No real sleeps: reset only the persisted rate limit, never checkpoint state.
    f.sql.exec('UPDATE ratelimit_lock SET next_at=0');
    const message = f.queue.shift()!;
    if (message.kind === 'cleanup') await cleanupStep(f.env, message); else await runStep(f.env, message);
  }
  if (f.queue.length) throw new Error('Queue did not drain');
}
describe('channel export runtime', () => {
  it('creates, runs, stages, assembles and serves ordered parts through actual SQL', async () => {
    const f = fixture(); vi.stubGlobal('fetch', fakeDiscord());
    expect((await f.api('/api/jobs', 'POST', input))!.status).toBe(200);
    expect((await f.api('/api/jobs/1/start', 'POST'))!.status).toBe(200);
    await drain(f);
    const job = f.sql.prepare('SELECT * FROM jobs WHERE id=1').get() as Record<string, unknown>;
    expect(job).toMatchObject({ status: 'completed', scanned: 330, fetched: 110, written: 110, part_index: 7, buffer_count: 0 });
    const parts = f.sql.prepare('SELECT * FROM job_parts ORDER BY part_index').all() as {r2_key:string; file_name:string}[];
    const output = parts.flatMap(p => f.objects.get(p.r2_key)!.split('\n\n'));
    expect(output).toEqual(Array.from({length: 110}, (_, i) => `message-${i * 3}`));
    const file = await f.api(`/files/1/${parts[0].file_name}`);
    expect(await file!.text()).toBe(f.objects.get(parts[0].r2_key));
  });
  it('pause, resume, duplicate queue deliveries and lost partial buffer preserve data', async () => {
    const f = fixture(); vi.stubGlobal('fetch', fakeDiscord());
    await f.api('/api/jobs', 'POST', input); await f.api('/api/jobs/1/start', 'POST');
    const first = f.queue.shift()!; await runStep(f.env, first);
    await f.api('/api/jobs/1/pause', 'POST');
    while (f.queue.length) await runStep(f.env, f.queue.shift()!);
    expect(f.sql.prepare('SELECT status FROM jobs WHERE id=1').get()).toMatchObject({status:'paused'});
    await f.api('/api/jobs/1/resume', 'POST');
    let lost = false;
    for (let i = 0; f.queue.length && i < 100; i++) {
      f.sql.exec('UPDATE ratelimit_lock SET next_at=0');
      const step = f.queue.shift()!; await runStep(f.env, step);
      const job = f.sql.prepare('SELECT partial_key FROM jobs WHERE id=1').get() as {partial_key:string|null};
      if (!lost && job.partial_key) { f.objects.delete(job.partial_key); lost = true; }
    }
    expect(lost).toBe(true); expect(f.queue).toHaveLength(0);
    const job = f.sql.prepare('SELECT status,written FROM jobs WHERE id=1').get();
    expect(job).toMatchObject({status:'completed',written:110});
    const parts = f.sql.prepare('SELECT r2_key FROM job_parts ORDER BY part_index').all() as {r2_key:string}[];
    const output = parts.flatMap(p => f.objects.get(p.r2_key)!.split('\n\n'));
    expect(output).toEqual(Array.from({length:110}, (_, i) => `message-${i * 3}`));
    await runStep(f.env, first); // stale delivery after completion
    expect(f.sql.prepare('SELECT written FROM jobs WHERE id=1').get()).toMatchObject({written:110});
  });
  it('does not advance cursor on 429 or 401 and permits resuming after a token error', async () => {
    const f = fixture(); let calls = 0;
    vi.stubGlobal('fetch', async (url: string) => { calls++; if (calls === 1) return new Response('{"retry_after":2}', {status:429}); if (calls === 2) return new Response('', {status:401}); return fakeDiscord(3)(url); });
    await f.api('/api/jobs','POST',input); await f.api('/api/jobs/1/start','POST');
    await runStep(f.env, f.queue.shift()!);
    expect(f.sql.prepare('SELECT status,page_cursor FROM jobs').get()).toMatchObject({status:'rate_limited',page_cursor:null});
    f.sql.exec('UPDATE ratelimit_lock SET next_at=0'); await runStep(f.env, f.queue.shift()!);
    expect(f.sql.prepare('SELECT status,page_cursor FROM jobs').get()).toMatchObject({status:'failed',page_cursor:null});
    await f.api('/api/jobs/1/resume','POST'); await drain(f);
    expect(f.sql.prepare('SELECT status,written FROM jobs').get()).toMatchObject({status:'completed',written:1});
  });
  it('scans two guild channels and skips a third without failing the export', async () => {
    const f = fixture(); const base = Date.parse('2020-01-01T00:00:00Z');
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/guilds/') && url.includes('/threads/')) return new Response(JSON.stringify({threads:[]}));
      if (url.includes('/guilds/')) return new Response(JSON.stringify([{id:'111111',name:'one',type:0},{id:'222222',name:'two',type:5},{id:'333333',name:'private',type:0},{id:'444444',name:'voice',type:2}]));
      if (url.includes('/threads/')) return new Response(JSON.stringify({threads:[],has_more:false}));
      if (url.includes('/channels/333333/')) return new Response('',{status:403});
      const n = url.includes('/channels/111111/') ? 1 : 2;
      const message = {id:idFromMs(base+n*1000),timestamp:new Date(base+n*1000).toISOString(),author:{id:'456789'},content:`channel-${n}`};
      const before = BigInt(new URL(url).searchParams.get('before')!);
      return new Response(JSON.stringify(BigInt(message.id) < before ? [message] : []));
    });
    const created = await f.api('/api/jobs','POST',{...input,source_type:'guild',source_id:'999999',mode:'guild'});
    expect(created!.status).toBe(200); await f.api('/api/jobs/1/start','POST'); await drain(f);
    expect(f.sql.prepare('SELECT status,written,guild_errors FROM jobs').get()).toMatchObject({status:'completed_with_errors',written:2,guild_errors:1});
    expect(f.sql.prepare('SELECT channel_id,status FROM guild_channels ORDER BY channel_id').all()).toEqual([
      {channel_id:'111111',status:'done'},{channel_id:'222222',status:'done'},{channel_id:'333333',status:'skipped'}
    ]);
    expect(f.sql.prepare('SELECT written FROM guild_channels WHERE channel_id IN (\'111111\',\'222222\') ORDER BY channel_id').all()).toEqual([{written:1},{written:1}]);
    const parts = f.sql.prepare('SELECT r2_key FROM job_parts').all() as {r2_key:string}[];
    expect(f.objects.get(parts[0].r2_key)?.split('\n\n').sort()).toEqual(['channel-1','channel-2']);
  });

  it('uploads to Google Drive with a stable ID and does not duplicate after an ambiguous error', async () => {
    const f = fixture();
    Object.assign(f.env, { GOOGLE_DRIVE_CLIENT_ID:'client', GOOGLE_DRIVE_CLIENT_SECRET:'secret', GOOGLE_DRIVE_REFRESH_TOKEN:'refresh', GOOGLE_DRIVE_FOLDER_ID:'folder123' });
    let uploaded = false, uploads = 0, generated = 0;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://discord.com/')) return fakeDiscord(3)(url);
      if (url.includes('oauth2.googleapis.com')) return new Response(JSON.stringify({access_token:'access'}));
      if (url.includes('generateIds')) { generated++; return new Response(JSON.stringify({ids:['generated123']})); }
      if (url.includes('/upload/')) { uploads++; uploaded = true; throw new Error('connection lost after upload'); }
      if (url.includes('/files/generated123')) return new Response('',{status:uploaded?200:404});
      throw new Error('unexpected URL');
    });
    await f.api('/api/jobs','POST',input); await f.api('/api/jobs/1/start','POST'); await drain(f);
    expect(f.sql.prepare('SELECT status,written FROM jobs').get()).toMatchObject({status:'completed',written:1});
    expect(f.sql.prepare('SELECT drive_file_id,drive_status FROM job_parts').get()).toMatchObject({drive_file_id:'generated123',drive_status:'done'});
    expect(generated).toBe(1); expect(uploads).toBe(1);
  });

  it('completes a full 1832-message export while every third request is rate limited', async () => {
    const f = fixture(); let calls = 0; const discord = fakeDiscord(1832 * 3);
    vi.stubGlobal('fetch', async (url: string) => { calls++; return calls % 3 === 0 ? new Response('{"retry_after":2}',{status:429}) : discord(url); });
    await f.api('/api/jobs','POST',{...input,part_size:300}); await f.api('/api/jobs/1/start','POST');
    await drain(f, 1000);
    expect(f.sql.prepare('SELECT status,written,part_index FROM jobs').get()).toMatchObject({status:'completed',written:1832,part_index:7});
    const parts = f.sql.prepare('SELECT r2_key FROM job_parts ORDER BY part_index').all() as {r2_key:string}[];
    const lines = parts.flatMap(p => f.objects.get(p.r2_key)!.split('\n\n'));
    expect(lines).toEqual(Array.from({length:1832}, (_, i) => `message-${i * 3}`));
    expect(new Set(lines).size).toBe(1832);
    const rate = f.sql.prepare('SELECT multiplier FROM ratelimit_lock').get() as {multiplier:number};
    expect(rate.multiplier).toBeGreaterThan(1);
  });

  it('allows a completed dry run to be followed by a real export with the same unique key', async () => {
    const f = fixture(); vi.stubGlobal('fetch', fakeDiscord(12));
    await f.api('/api/jobs','POST',{...input,dry_run:true}); await f.api('/api/jobs/1/start','POST'); await drain(f);
    expect(f.sql.prepare('SELECT status,fetched,written FROM jobs').get()).toMatchObject({status:'completed',fetched:4,written:0});
    expect(f.sql.prepare('SELECT COUNT(*) AS n FROM job_parts').get()).toMatchObject({n:0});
    expect((await f.api('/api/jobs','POST',input))!.status).toBe(200);
    expect(f.sql.prepare('SELECT status,dry_run,scan_generation FROM jobs').get()).toMatchObject({status:'queued',dry_run:0,scan_generation:1});
    await f.api('/api/jobs/1/start','POST'); await drain(f);
    expect(f.sql.prepare('SELECT status,fetched,written FROM jobs').get()).toMatchObject({status:'completed',fetched:4,written:4});
  });

  it('deletes all R2 generations in bounded background steps but leaves Drive alone', async () => {
    const f = fixture(); vi.stubGlobal('fetch', fakeDiscord(9));
    await f.api('/api/jobs','POST',input); await f.api('/api/jobs/1/start','POST'); await drain(f);
    expect(f.objects.size).toBeGreaterThan(0);
    const response = await f.api('/api/jobs/1', 'DELETE'); expect(response!.status).toBe(200);
    await drain(f);
    expect(f.sql.prepare('SELECT count(*) AS n FROM jobs').get()).toMatchObject({n:0});
    expect(f.sql.prepare('SELECT count(*) AS n FROM job_parts').get()).toMatchObject({n:0});
    expect(f.objects.size).toBe(0);
  });

  it('discovers active and paginated archived threads and exports their messages', async () => {
    const f = fixture(); const base = Date.parse('2020-01-01T00:00:00Z');
    vi.stubGlobal('fetch', async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/guilds/999999/channels')) return new Response(JSON.stringify([{id:'111111',name:'parent',type:0}]));
      if (u.pathname.endsWith('/threads/active')) return new Response(JSON.stringify({threads:[{id:'222222',name:'active',type:11}]}));
      if (u.pathname.endsWith('/threads/archived/public')) {
        if (!u.searchParams.has('before')) return new Response(JSON.stringify({threads:[{id:'333333',name:'archived',type:11,thread_metadata:{archive_timestamp:'2020-02-01T00:00:00Z'}}],has_more:true}));
        return new Response(JSON.stringify({threads:[{id:'444444',name:'older',type:11,thread_metadata:{archive_timestamp:'2020-01-01T00:00:00Z'}}],has_more:false}));
      }
      if (u.pathname.includes('/threads/archived/')) return new Response(JSON.stringify({threads:[],has_more:false}));
      const id = u.pathname.match(/channels\/(\d+)\/messages/)![1];
      const msg = {id:idFromMs(base+Number(id)),timestamp:new Date(base+Number(id)).toISOString(),author:{id:'456789'},content:`channel-${id}`};
      return new Response(JSON.stringify(BigInt(msg.id) < BigInt(u.searchParams.get('before')!) ? [msg] : []));
    });
    await f.api('/api/jobs','POST',{...input,source_type:'guild',source_id:'999999',mode:'guild'}); await f.api('/api/jobs/1/start','POST'); await drain(f,200);
    expect(f.sql.prepare('SELECT status,written FROM jobs').get()).toMatchObject({status:'completed',written:4});
    expect(f.sql.prepare('SELECT channel_id,status FROM guild_channels ORDER BY channel_id').all()).toEqual(['111111','222222','333333','444444'].map(channel_id=>({channel_id,status:'done'})));
  });

  it('preserves already-committed pages after a 401 and resumes without duplicates', async () => {
    const f = fixture(); let calls = 0; const discord = fakeDiscord(330);
    vi.stubGlobal('fetch', async (url:string) => { calls++; return calls === 2 ? new Response('',{status:401}) : discord(url); });
    await f.api('/api/jobs','POST',input); await f.api('/api/jobs/1/start','POST');
    await runStep(f.env,f.queue.shift()!);
    const before = f.sql.prepare('SELECT page_cursor,scanned FROM jobs').get() as {page_cursor:string;scanned:number};
    expect(before.scanned).toBe(100); expect(before.page_cursor).toBeTruthy();
    f.sql.exec('UPDATE ratelimit_lock SET next_at=0'); await runStep(f.env,f.queue.shift()!);
    expect(f.sql.prepare('SELECT status,page_cursor,scanned FROM jobs').get()).toMatchObject({status:'failed',...before});
    await f.api('/api/jobs/1/resume','POST'); await drain(f);
    const parts = f.sql.prepare('SELECT r2_key FROM job_parts ORDER BY part_index').all() as {r2_key:string}[];
    const lines = parts.flatMap(p => f.objects.get(p.r2_key)!.split('\n\n'));
    expect(lines).toEqual(Array.from({length:110}, (_, i) => `message-${i*3}`));
  });

});
