/** The scan core is independent of Cloudflare bindings; the eventual D1/R2
 * adapter must implement ScanStore's atomic checkpoint contract below. */
export const DISCORD_EPOCH = 1420070400000n;
const MAX_SNOWFLAKE = (1n << 64n) - 1n;

export function idFromMs(ms: number): string {
  if (!Number.isSafeInteger(ms) || BigInt(ms) < DISCORD_EPOCH) throw new Error('Invalid Discord timestamp');
  const result = (BigInt(ms) - DISCORD_EPOCH) << 22n;
  if (result > MAX_SNOWFLAKE) throw new Error('Discord timestamp out of range');
  return result.toString();
}
export function msFromId(id: string): number {
  if (!/^[0-9]{1,20}$/.test(id)) throw new Error('Invalid snowflake');
  const value = BigInt(id);
  if (value > MAX_SNOWFLAKE) throw new Error('Invalid snowflake');
  return Number((value >> 22n) + DISCORD_EPOCH);
}

/** Inclusive UTC day boundaries. */
export function dateWindow(from: string, to: string): { dateFrom: number; dateTo: number; initialCursor: string } {
  const day = (value: string): number => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid date');
    const ms = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new Error('Invalid date');
    return ms;
  };
  const dateFrom = day(from), dateTo = day(to) + 86_400_000 - 1;
  if (dateFrom > dateTo || dateFrom < Number(DISCORD_EPOCH)) throw new Error('Invalid date range');
  return { dateFrom, dateTo, initialCursor: idFromMs(dateTo + 1) };
}

export type DiscordMessage = { id: string; timestamp: string; author: { id: string }; content: string };
export type StagedMessage = { id: string; content: string; channelId?: string };
export type ScanConfig = { channelId: string; targetUserId: string; dateFrom: number; dateTo: number; skipEmpty: boolean };
export type ScanCheckpoint = {
  /** Incremented on each successful page, used for compare-and-swap. */
  version: number;
  pageCursor: string | null;
  scanned: number;
  fetched: number;
  buffered: number;
  requests: number;
  done: boolean;
};
export type PreparedPage = { messages: StagedMessage[]; checkpoint: ScanCheckpoint };

/**
 * commitPage MUST write the page to durable storage before atomically committing
 * its metadata AND checkpoint, and reject stale versions without changing state.
 * A retry after an interrupted write must be idempotent. This is an interface,
 * not yet a D1/R2 implementation.
 */
export interface ScanStore {
  readCheckpoint(): Promise<ScanCheckpoint>;
  commitPage(expectedVersion: number, page: PreparedPage): Promise<boolean>;
}
export type FetchPage = (channelId: string, before: string) => Promise<DiscordMessage[]>;

/** Validate a whole Discord response before advancing the checkpoint. */
export function preparePage(config: ScanConfig, previous: ScanCheckpoint, page: DiscordMessage[]): PreparedPage {
  if (previous.done) throw new Error('Scan is already complete');
  if (!Array.isArray(page) || page.length > 100) throw new Error('Invalid Discord page');
  if (!Number.isSafeInteger(config.dateFrom) || !Number.isSafeInteger(config.dateTo) || config.dateFrom > config.dateTo) throw new Error('Invalid scan window');
  const before = previous.pageCursor ?? idFromMs(config.dateTo + 1);
  msFromId(before);
  let lastId = BigInt(before);
  let reachedStart = false;
  let fetched = 0;
  const messages: StagedMessage[] = [];
  for (const message of page) {
    if (!message || typeof message.id !== 'string' || typeof message.timestamp !== 'string' || typeof message.author?.id !== 'string' || typeof message.content !== 'string') throw new Error('Invalid Discord message');
    msFromId(message.id);
    const id = BigInt(message.id);
    if (id >= lastId) throw new Error('Discord page is not strictly descending');
    lastId = id;
    const timestamp = Date.parse(message.timestamp);
    if (!Number.isFinite(timestamp)) throw new Error('Invalid Discord timestamp');
    if (timestamp < config.dateFrom) { reachedStart = true; continue; }
    if (timestamp > config.dateTo || message.author.id !== config.targetUserId) continue;
    fetched++;
    if (config.skipEmpty && !message.content.trim()) continue;
    messages.push({ id: message.id, content: message.content });
  }
  return {
    messages,
    checkpoint: {
      version: previous.version + 1,
      pageCursor: page.length ? page[page.length - 1].id : previous.pageCursor,
      scanned: previous.scanned + page.length,
      fetched: previous.fetched + fetched,
      buffered: previous.buffered + messages.length,
      requests: previous.requests + 1,
      done: page.length === 0 || reachedStart,
    },
  };
}

/** One request/page per call; policy, rate limits, retries and scheduling live in the adapter. */
export async function scanPage(config: ScanConfig, store: ScanStore, fetchPage: FetchPage): Promise<{ committed: boolean; checkpoint: ScanCheckpoint }> {
  const previous = await store.readCheckpoint();
  if (previous.done) return { committed: false, checkpoint: previous };
  const cursor = previous.pageCursor ?? idFromMs(config.dateTo + 1);
  const page = preparePage(config, previous, await fetchPage(config.channelId, cursor));
  const committed = await store.commitPage(previous.version, page);
  return { committed, checkpoint: committed ? page.checkpoint : await store.readCheckpoint() };
}

export function fileName(targetUserId: string, from: string, to: string, part: number): string {
  if (!/^\d{1,20}$/.test(targetUserId) || !Number.isSafeInteger(part) || part < 1) throw new Error('Invalid file parameters');
  dateWindow(from, to);
  return `discord_from-${targetUserId}_${from}_${to}_part-${String(part).padStart(3, '0')}.txt`;
}
export type Part = { index: number; messages: number; oldestId: string; newestId: string; content: string };

/**
 * Pages must be supplied oldest-page-first; each page itself is in Discord's
 * newest-to-oldest order. Buffers at most one part, not the complete export.
 * The integration layer must persist each output before acknowledging it.
 */
export async function* makeParts(pages: AsyncIterable<readonly StagedMessage[]>, partSize: number, blankLine: boolean): AsyncGenerator<Part> {
  if (!Number.isSafeInteger(partSize) || partSize < 1 || partSize > 3000) throw new Error('Invalid part size');
  let pending: StagedMessage[] = [];
  let previousId: bigint | null = null;
  let index = 0;
  const part = (): Part => ({ index: ++index, messages: pending.length, oldestId: pending[0].id, newestId: pending[pending.length - 1].id, content: pending.map(message => message.content).join(blankLine ? '\n\n' : '\n') });
  for await (const page of pages) {
    for (let i = page.length - 1; i >= 0; i--) {
      const message = page[i];
      msFromId(message.id);
      const id = BigInt(message.id);
      if (previousId !== null && id <= previousId) throw new Error('Staged messages are not strictly chronological');
      previousId = id;
      pending.push(message);
      if (pending.length === partSize) { yield part(); pending = []; }
    }
  }
  if (pending.length) yield part();
}
