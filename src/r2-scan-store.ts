import type { PreparedPage, ScanCheckpoint, ScanStore, StagedMessage } from './scan';

interface JobRow {
  scan_version: number; scan_generation: number; page_cursor: string | null;
  scanned: number; fetched: number; buffer_count: number; requests: number; scan_done: number;
}

/** Durable page staging. R2 is private. No per-message rows are stored in D1. */
export class R2ScanStore implements ScanStore {
  constructor(private db: D1Database, private bucket: R2Bucket, private jobId: number, private generation: number) {}

  async readCheckpoint(): Promise<ScanCheckpoint> {
    const job = await this.db.prepare('SELECT scan_version, scan_generation, page_cursor, scanned, fetched, buffer_count, requests, scan_done FROM jobs WHERE id = ?').bind(this.jobId).first<JobRow>();
    if (!job || job.scan_generation !== this.generation) throw new Error('Job not found or generation changed');
    return { version: job.scan_version, pageCursor: job.page_cursor, scanned: job.scanned, fetched: job.fetched, buffered: job.buffer_count, requests: job.requests, done: !!job.scan_done };
  }

  async commitPage(expectedVersion: number, page: PreparedPage, guild?: { channelId: string; channelDone: boolean; channelCursor: string | null; scanned: number; fetched: number }): Promise<boolean> {
    if (page.checkpoint.version !== expectedVersion + 1) throw new Error('Invalid checkpoint version');
    // Each attempt owns a unique key. A stale writer must never overwrite the
    // object referenced by a winning concurrent writer.
    const key = `staging/${this.jobId}/${this.generation}/${page.checkpoint.version}-${crypto.randomUUID()}.json`;
    await this.bucket.put(key, JSON.stringify(page.messages), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
    // D1 batch executes both statements in one transaction. A status or
    // generation change invalidates this attempt without publishing its page.
    const statements = [
      this.db.prepare(`INSERT INTO scan_pages (job_id, generation, page_index, r2_key, messages, channel_id)
        SELECT id, scan_generation, ?, ?, ?, ? FROM jobs
        WHERE id = ? AND scan_generation = ? AND scan_version = ? AND status = 'running' AND scan_done = 0`)
        .bind(page.checkpoint.version, key, page.messages.length, guild?.channelId ?? null, this.jobId, this.generation, expectedVersion),
      this.db.prepare(`UPDATE jobs SET scan_version = ?, page_cursor = ?, scanned = ?, fetched = ?, buffer_count = ?, requests = ?, scan_done = ?, updated_at = ?
        WHERE id = ? AND scan_generation = ? AND scan_version = ? AND status = 'running' AND scan_done = 0`)
        .bind(page.checkpoint.version, page.checkpoint.pageCursor, page.checkpoint.scanned, page.checkpoint.fetched, page.checkpoint.buffered,
          page.checkpoint.requests, Number(page.checkpoint.done), Date.now(), this.jobId, this.generation, expectedVersion),
    ];
    if (guild) statements.push(this.db.prepare(`UPDATE guild_channels SET page_cursor=?, scanned=scanned+?, fetched=fetched+?, status=?
      WHERE job_id=? AND channel_id=? AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND scan_generation=? AND scan_version=? AND status='running')`)
      .bind(guild.channelCursor, guild.scanned, guild.fetched, guild.channelDone ? 'done' : 'running', this.jobId, guild.channelId, this.jobId, this.generation, page.checkpoint.version));
    const [insert, update] = await this.db.batch(statements);
    if (insert.meta.changes === 0 && update.meta.changes === 0) {
      // Only delete after D1 positively confirms this object wasn't published.
      try { await this.bucket.delete(key); } catch { /* orphan cleanup is a separate maintenance task */ }
      return false;
    }
    if (insert.meta.changes !== 1 || update.meta.changes !== 1) throw new Error('Inconsistent page checkpoint');
    return true;
  }

  /** Iterate committed pages oldest first without loading all page metadata. */
  async *oldestPages(): AsyncGenerator<StagedMessage[]> {
    const checkpoint = await this.readCheckpoint();
    if (!checkpoint.done) throw new Error('Cannot assemble an unfinished scan');
    let index = checkpoint.version;
    while (index > 0) {
      const row = await this.db.prepare('SELECT r2_key, messages FROM scan_pages WHERE job_id = ? AND generation = ? AND page_index = ?')
        .bind(this.jobId, this.generation, index).first<{ r2_key: string; messages: number }>();
      if (!row) throw new Error('Missing staged page');
      const object = await this.bucket.get(row.r2_key);
      if (!object) throw new Error('Missing staged object');
      const data: unknown = await object.json();
      if (!Array.isArray(data) || data.length !== row.messages || data.some(m => !m || typeof m.id !== 'string' || typeof m.content !== 'string')) throw new Error('Invalid staged page');
      yield data as StagedMessage[];
      index--;
    }
  }
}
