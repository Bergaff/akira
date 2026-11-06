import { describe, expect, it, vi } from 'vitest';
import { discordFetchPage, DiscordError } from '../src/discord';

describe('Discord page client', () => {
  it('uses before, limit 100 and unprefixed auth, without following redirects', async () => {
    const send = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    const get = discordFetchPage('secret', 'private=cookie', send as unknown as typeof fetch);
    expect(await get('123', '456')).toEqual([]);
    expect(send.mock.calls[0][0]).toBe('https://discord.com/api/v9/channels/123/messages?limit=100&before=456');
    expect(send.mock.calls[0][1].headers.get('Authorization')).toBe('secret');
    expect(send.mock.calls[0][1].headers.get('Cookie')).toBe('private=cookie');
    expect(send.mock.calls[0][1].redirect).toBe('manual');
  });
  it('classifies 429/401 and never includes secret response bodies', async () => {
    const send = vi.fn().mockResolvedValueOnce(new Response('{"retry_after":3,"secret":"secret"}', { status: 429, headers: { 'retry-after': '2.5' } })).mockResolvedValueOnce(new Response('secret', { status: 401 }));
    const get = discordFetchPage('secret', undefined, send as unknown as typeof fetch);
    const first = await get('123', '456').catch(e => e);
    expect(first).toBeInstanceOf(DiscordError); expect(first.status).toBe(429); expect(first.retryAfterMs).toBe(3000); expect(first.message).not.toContain('secret');
    const second = await get('123', '456').catch(e => e);
    expect(second.status).toBe(401); expect(second.message).not.toContain('secret');
  });
  it('sanitizes network errors', async () => {
    const send = vi.fn().mockRejectedValue(new Error('secret'));
    const get = discordFetchPage('secret', undefined, send as unknown as typeof fetch);
    const error = await get('123', '456').catch(e => e);
    expect(error).toMatchObject({ status: null, message: 'Discord network error' });
  });
});

it('paginates archived threads using Discord archive timestamps', async () => {
  const { discordFetchThreads } = await import('../src/discord');
  const send = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ threads:[{id:'123456', name:'thread', type:11, thread_metadata:{archive_timestamp:'2020-01-01T00:00:00Z'}}], has_more:true })));
  const result = await discordFetchThreads({parent_id:'555555',kind:'public',cursor:null},'secret',undefined,send as unknown as typeof fetch);
  expect(result).toEqual({ threads:[{id:'123456',name:'thread'}], next:'2020-01-01T00:00:00Z', done:false });
  expect(send.mock.calls[0][0]).toContain('/channels/555555/threads/archived/public?limit=100');
});
