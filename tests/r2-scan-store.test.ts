import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { R2ScanStore } from '../src/r2-scan-store';
import { dateWindow, idFromMs, preparePage, type ScanCheckpoint } from '../src/scan';

// Exercise the real D1 SQL with SQLite and an R2-compatible in-memory bucket.
function setup() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync('migrations/0001_initial.sql', 'utf8'));
  sql.exec(readFileSync('migrations/0002_scan_staging.sql', 'utf8'));
  sql.exec(readFileSync('migrations/0003_part_metadata.sql', 'utf8'));
  sql.exec(readFileSync('migrations/0004_runtime.sql', 'utf8'));
  sql.exec(readFileSync('migrations/0005_guild.sql', 'utf8'));
  sql.exec(readFileSync('migrations/0006_drive.sql', 'utf8'));
  sql.exec(readFileSync('migrations/0007_threads.sql', 'utf8'));  
  sql.exec(`INSERT INTO jobs (source_type,source_id,target_user_id,date_from,date_to,mode,status,created_at,updated_at)
    VALUES ('channel','123','456',1575850000000,1615420799999,'scan','running',0,0)`);
  let failBatch = false;
  const db = {
    prepare(text: string) {
      return { bind(...args: unknown[]) { return {
        first: async () => sql.prepare(text).get(...args as never[]),
        run: () => ({ meta: { changes: Number(sql.prepare(text).run(...args as never[]).changes) } }),
      }; } };
    },
    async batch(statements: { run: () => { meta: { changes: number } } }[]) {
      if (failBatch) throw new Error('D1 unavailable');
      sql.exec('BEGIN');
      try { const result = statements.map(s => s.run()); sql.exec('COMMIT'); return result; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  const objects = new Map<string, string>(); let failPut = false;
  const bucket = {
    async put(key: string, value: string | Uint8Array) { if (failPut) throw new Error('R2 unavailable'); objects.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value)); },
    async get(key: string) { const value = objects.get(key); return value === undefined ? null : { json: async () => JSON.parse(value) }; },
    async delete(key: string) { objects.delete(key); },
  };
  const store = new R2ScanStore(db as unknown as D1Database, bucket as unknown as R2Bucket, 1, 0);
  return { sql, objects, store, setFailBatch: (v: boolean) => { failBatch = v; }, setFailPut: (v: boolean) => { failPut = v; } };
}
const checkpoint: ScanCheckpoint = { version: 0, pageCursor: null, scanned: 0, fetched: 0, buffered: 0, requests: 0, done: false };
const dates = dateWindow('2019-12-09', '2021-03-10');
const config = { channelId: '123', targetUserId: '456', ...dates, skipEmpty: true };
const ms = dates.dateFrom + 1000;
const page = preparePage(config, checkpoint, [{ id: idFromMs(ms), timestamp: new Date(ms).toISOString(), author: { id: '456' }, content: 'hello' }]);

describe('D1/R2 page staging', () => {
  it('persists a page and checkpoint together; a stale writer cannot overwrite it', async () => {
    const { store, objects, sql } = setup();
    expect(await store.commitPage(0, page)).toBe(true);
    const stale = { ...page, messages: [{ ...page.messages[0], content: 'different' }] };
    expect(await store.commitPage(0, stale)).toBe(false);
    expect(objects.size).toBe(1);
    expect([...objects.values()][0]).toContain('hello');
    expect(await store.readCheckpoint()).toEqual(page.checkpoint);
    expect(sql.prepare('SELECT count(*) AS n FROM scan_pages').get()).toMatchObject({ n: 1 });
  });
  it('does not move checkpoints if R2 or D1 fails; an orphan cannot corrupt a retry', async () => {
    const { store, objects, sql, setFailBatch, setFailPut } = setup();
    setFailPut(true); await expect(store.commitPage(0, page)).rejects.toThrow(); setFailPut(false);
    expect(await store.readCheckpoint()).toEqual(checkpoint);
    setFailBatch(true); await expect(store.commitPage(0, page)).rejects.toThrow(); setFailBatch(false);
    expect(await store.readCheckpoint()).toEqual(checkpoint);
    expect(objects.size).toBe(1); // harmless orphan: commit outcome may have been ambiguous
    expect(await store.commitPage(0, page)).toBe(true);
    expect(objects.size).toBe(2);
    expect(sql.prepare('SELECT count(*) AS n FROM scan_pages').get()).toMatchObject({ n: 1 });
  });
  it('does not publish a page after a pause or restart', async () => {
    const { store, sql, objects } = setup();
    sql.exec("UPDATE jobs SET status='paused' WHERE id=1");
    expect(await store.commitPage(0, page)).toBe(false); expect(objects.size).toBe(0);
    sql.exec("UPDATE jobs SET status='running', scan_generation=1 WHERE id=1");
    expect(await store.commitPage(0, page)).toBe(false);
    await expect(store.readCheckpoint()).rejects.toThrow('generation changed');
  });
  it('only assembles complete scans, oldest page first, and fails closed on missing objects', async () => {
    const { store, objects } = setup();
    expect(await store.commitPage(0, page)).toBe(true);
    await expect(async () => { for await (const _ of store.oldestPages()) { /* no-op */ } }).rejects.toThrow('unfinished');
    const final = preparePage(config, page.checkpoint, []);
    expect(await store.commitPage(1, final)).toBe(true);
    const staged = []; for await (const items of store.oldestPages()) staged.push(items);
    expect(staged).toEqual([[], page.messages]);
    objects.clear();
    await expect(async () => { for await (const _ of store.oldestPages()) { /* no-op */ } }).rejects.toThrow('Missing staged object');
  });
});

