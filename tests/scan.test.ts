import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { dateWindow, fileName, idFromMs, msFromId, makeParts, preparePage, scanPage, type DiscordMessage, type ScanCheckpoint, type PreparedPage, type ScanStore } from '../src/scan';

const window = dateWindow('2019-12-09', '2021-03-10');
const config = { channelId: '123', targetUserId: '503801259925700610', dateFrom: window.dateFrom, dateTo: window.dateTo, skipEmpty: true };
const initial = (): ScanCheckpoint => ({ version: 0, pageCursor: null, scanned: 0, fetched: 0, buffered: 0, requests: 0, done: false });
const msg = (ms: number, content = 'text', author = config.targetUserId): DiscordMessage => ({ id: idFromMs(ms), timestamp: new Date(ms).toISOString(), content, author: { id: author } });
class MemoryStore implements ScanStore {
  checkpoint = initial(); pages: PreparedPage[] = []; fail = false;
  async readCheckpoint() { return { ...this.checkpoint }; }
  async commitPage(version: number, page: PreparedPage) {
    if (this.fail) throw new Error('storage failed');
    if (version !== this.checkpoint.version) return false;
    this.pages.push(page); this.checkpoint = { ...page.checkpoint }; return true;
  }
}
async function* oldestPages(store: MemoryStore) { for (const page of [...store.pages].reverse()) yield page.messages; }
async function allParts(store: MemoryStore, size = 3000, blank = false) { const parts = []; for await (const part of makeParts(oldestPages(store), size, blank)) parts.push(part); return parts; }
let server: Server | undefined;
afterEach(async () => { if (server) { await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } });

describe('snowflakes and output', () => {
  it('roundtrips epoch and leap-day timestamps, including low snowflake bits', () => {
    for (const ms of [1420070400000, Date.parse('2020-02-29T23:59:59.999Z'), Date.parse('2021-03-10T23:59:59.999Z')]) {
      expect(msFromId(idFromMs(ms))).toBe(ms);
      expect(msFromId((BigInt(idFromMs(ms)) + 4194303n).toString())).toBe(ms);
    }
    expect(() => idFromMs(1420070399999)).toThrow(); expect(() => msFromId('no')).toThrow();
  });
  it('uses inclusive UTC days and rejects impossible dates', () => {
    const leap = dateWindow('2020-02-29', '2020-02-29');
    expect(leap.dateFrom).toBe(Date.parse('2020-02-29T00:00:00.000Z'));
    expect(leap.dateTo).toBe(Date.parse('2020-02-29T23:59:59.999Z'));
    expect(msFromId(leap.initialCursor)).toBe(Date.parse('2020-03-01T00:00:00.000Z'));
    expect(() => dateWindow('2019-02-29', '2019-03-01')).toThrow();
    expect(() => dateWindow('2021-01-02', '2021-01-01')).toThrow();
  });
  it('formats names and splits exact parts, preserving multiline and empty content', async () => {
    expect(fileName(config.targetUserId, '2019-12-09', '2021-03-10', 1)).toBe('discord_from-503801259925700610_2019-12-09_2021-03-10_part-001.txt');
    async function* pages() { yield [{ id: '3', content: 'third' }, { id: '2', content: '' }, { id: '1', content: 'first\nline' }]; }
    const parts = []; for await (const part of makeParts(pages(), 2, true)) parts.push(part);
    expect(parts.map(p => p.content)).toEqual(['first\nline\n\n', 'third']);
    expect(parts.map(p => p.messages)).toEqual([2, 1]);
  });
});

describe('page processing', () => {
  it('includes both boundary timestamps, handles empty and foreign messages and stops below the window', () => {
    const page = [msg(config.dateTo), msg(config.dateTo - 1, ' '), msg(config.dateFrom + 1, 'other', '42'), msg(config.dateFrom), msg(config.dateFrom - 1)];
    const result = preparePage(config, initial(), page);
    expect(result.messages.map(m => m.content)).toEqual(['text', 'text']);
    expect(result.checkpoint).toMatchObject({ scanned: 5, fetched: 3, buffered: 2, requests: 1, done: true, pageCursor: page[4].id });
    expect(preparePage({ ...config, skipEmpty: false }, initial(), page).messages).toHaveLength(3);
  });
  it('rejects malformed, duplicate or unordered pages without advancing', () => {
    const a = msg(config.dateFrom + 2), b = msg(config.dateFrom + 1);
    expect(() => preparePage(config, initial(), [b, a])).toThrow();
    expect(() => preparePage(config, initial(), [a, a])).toThrow();
    expect(() => preparePage(config, initial(), [{ ...a, timestamp: 'broken' }])).toThrow();
    expect(() => preparePage(config, initial(), Array(101).fill(a))).toThrow();
  });
  it('does not advance on request or commit failure, and detects stale updates', async () => {
    const store = new MemoryStore(); const page = [msg(config.dateFrom + 1)];
    await expect(scanPage(config, store, async () => { throw new Error('network'); })).rejects.toThrow();
    store.fail = true; await expect(scanPage(config, store, async () => page)).rejects.toThrow(); store.fail = false;
    expect(store.checkpoint).toEqual(initial());
    const p1 = preparePage(config, initial(), page);
    expect(await store.commitPage(0, p1)).toBe(true);
    expect(await store.commitPage(0, p1)).toBe(false);
    expect(store.pages).toHaveLength(1);
  });
  it('resumes a 2019–2022 mock Discord channel and assembles 1832 messages chronologically', async () => {
    const wanted = 1832;
    const data: DiscordMessage[] = [];
    // Includes 2019–2021, with an unrelated 2022 message before the initial cursor.
    for (let i = 0; i < wanted * 3; i++) {
      const ms = config.dateFrom + 1000 + i * 2000;
      data.push(msg(ms, `message-${i}`, i % 3 === 0 ? config.targetUserId : '123456'));
    }
    data.push(msg(config.dateFrom - 1000, 'out-of-range'));
    data.push(msg(Date.parse('2022-01-01T00:00:00Z'), 'out-of-range'));
    data.sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1);
    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname !== '/channels/123/messages' || url.searchParams.get('limit') !== '100') { res.writeHead(400).end(); return; }
      const before = BigInt(url.searchParams.get('before')!);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data.filter(m => BigInt(m.id) < before).slice(0, 100)));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const fetchPage = async (channel: string, cursor: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/channels/${channel}/messages?limit=100&before=${cursor}`);
      if (!response.ok) throw new Error('Discord error');
      return await response.json() as DiscordMessage[];
    };
    const store = new MemoryStore();
    for (let i = 0; i < 5; i++) await scanPage(config, store, fetchPage);
    // Simulated consumer restart: only durable checkpoint/pages are reused.
    while (!store.checkpoint.done) await scanPage(config, store, fetchPage);
    const parts = await allParts(store, 300);
    const lines = parts.flatMap(p => p.content.split('\n'));
    expect(lines).toEqual(Array.from({ length: wanted }, (_, i) => `message-${i * 3}`));
    expect(new Set(lines).size).toBe(wanted);
    expect(parts.map(p => p.messages)).toEqual([300, 300, 300, 300, 300, 300, 32]);
    expect(store.checkpoint.fetched).toBe(wanted);
  });
});
