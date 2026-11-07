import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Env, JobMessage } from '../src/env';
import { runStep } from '../src/runner';
import { cleanupStep } from '../src/cleanup';

/** Small adapter for the subset of D1 used by the shared export engine. */
export class LocalD1 {
  readonly sqlite: DatabaseSync;
  constructor(file: string) {
    this.sqlite = new DatabaseSync(file);
    this.sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  }
  prepare(sql: string) { return new LocalStatement(this.sqlite, sql); }
  async batch(statements: LocalStatement[]) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return result;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  migrate(files: { name: string; sql: string }[]) {
    this.sqlite.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    for (const file of files) {
      if (this.sqlite.prepare('SELECT name FROM d1_migrations WHERE name=?').get(file.name)) continue;
      this.sqlite.exec('BEGIN IMMEDIATE');
      try {
        this.sqlite.exec(file.sql);
        this.sqlite.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(file.name);
        this.sqlite.exec('COMMIT');
      } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
    }
  }
  close() { this.sqlite.close(); }
}
class LocalStatement {
  private args: SQLInputValue[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...args: SQLInputValue[]) { const bound = new LocalStatement(this.db, this.sql); bound.args = args; return bound; }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.args) ?? null) as T | null; }
  async all<T>() { return {results: this.db.prepare(this.sql).all(...this.args) as T[]}; }
  async run() { const result = this.db.prepare(this.sql).run(...this.args); return {meta:{changes:Number(result.changes)}}; }
}

export async function atomicWrite(file: string, value: string | Uint8Array) {
  await fs.mkdir(path.dirname(file), {recursive:true});
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp,file);
  } catch (error) { await fs.rm(temp,{force:true}); throw error; }
}

/** Private on-disk equivalent of R2, scoped to the current Windows user. */
export class LocalBucket {
  constructor(readonly root: string) {}
  localPath(key: string) {
    if (!/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(key) || key.split('/').some(x => x === '.' || x === '..')) throw new Error('Invalid object key');
    return path.join(this.root, ...key.split('/'));
  }
  async put(key: string, value: string | Uint8Array) { await atomicWrite(this.localPath(key),value); }
  async get(key: string) {
    let buffer: Buffer;
    try { buffer = await fs.readFile(this.localPath(key)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const bytes = Uint8Array.from(buffer);
    return { json: async () => JSON.parse(buffer.toString('utf8')), arrayBuffer: async () => bytes.buffer, body: new Response(bytes).body };
  }
  async delete(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) await fs.rm(this.localPath(key),{force:true}); }
  async list(options: {prefix:string;limit:number}) {
    const prefix = options.prefix.replace(/\/$/,'');
    const objects: {key:string}[] = [];
    const visit = async (dir: string, key: string) => {
      let entries;
      try { entries = await fs.readdir(dir,{withFileTypes:true}); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        if (objects.length >= options.limit) break;
        const next = `${key}/${entry.name}`;
        if (entry.isDirectory()) await visit(path.join(dir,entry.name),next);
        else if (entry.isFile()) objects.push({key:next});
      }
    };
    await visit(this.localPath(prefix),prefix);
    return {objects};
  }
}

/** Delays are local timers; persisted job state is replayed on every launch. */
export class LocalQueue {
  private pending = new Map<string, {message:JobMessage;due:number}>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private closed = false;
  constructor(private env: () => Env) {}
  async send(message: JobMessage, options?: {delaySeconds?:number}) {
    if (this.closed) return;
    const key = `${message.jobId}:${message.generation}:${message.kind ?? 'work'}`;
    const due = Date.now() + (options?.delaySeconds ?? 0)*1000;
    const old = this.pending.get(key);
    if (!old || old.due > due) this.pending.set(key,{message,due});
    this.arm();
  }
  private arm() {
    if (this.closed || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    if (!this.pending.size) { this.timer = null; return; }
    const due = Math.min(...Array.from(this.pending.values(),x=>x.due));
    this.timer = setTimeout(() => { this.timer = null; void this.tick(); },Math.max(0,due-Date.now()));
  }
  private async tick() {
    if (this.running || this.closed) return;
    const next = [...this.pending.entries()].sort((a,b)=>a[1].due-b[1].due)[0];
    if (!next) return;
    if (next[1].due > Date.now()) { this.arm(); return; }
    this.pending.delete(next[0]); this.running = true;
    try { if (next[1].message.kind === 'cleanup') await cleanupStep(this.env(),next[1].message); else await runStep(this.env(),next[1].message); }
    catch { await this.send(next[1].message,{delaySeconds:10}); }
    finally { this.running = false; this.arm(); }
  }
  async recover(db: LocalD1) {
    db.sqlite.exec('UPDATE jobs SET lease_owner=NULL,lease_until=0; UPDATE ratelimit_lock SET owner=NULL,locked_until=0;');
    const rows = await db.prepare("SELECT id,scan_generation,phase FROM jobs WHERE status IN ('running','rate_limited') OR phase='cleanup'").all<{id:number;scan_generation:number;phase:string}>();
    for (const job of rows.results) await this.send({jobId:job.id,generation:job.scan_generation,...(job.phase === 'cleanup' ? {kind:'cleanup' as const} : {})});
  }
  close() { this.closed = true; if (this.timer) clearTimeout(this.timer); this.pending.clear(); }
}
