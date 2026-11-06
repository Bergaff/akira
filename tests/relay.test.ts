import { afterEach, expect, it, vi } from 'vitest';
import relay from '../relay/index';
afterEach(() => vi.unstubAllGlobals());
it('relay accepts only authenticated allowlisted Discord GET paths', async () => {
  const env = { RELAY_SECRET: 'random-relay-secret-at-least-32-characters' };
  const call = (path: string, headers: Record<string,string> = {}, method = 'GET') => relay.fetch(new Request(`https://relay.example${path}`, {headers,method}) as unknown as Parameters<typeof relay.fetch>[0], env);
  expect((await call('/api/v9/users/@me')).status).toBe(403);
  const auth = { 'x-akira-relay-secret': env.RELAY_SECRET, authorization: 'secret' };
  expect((await call('/api/v9/users/@me',auth,'POST')).status).toBe(404);
  expect((await call('/api/v9/users/@me/other',auth)).status).toBe(404);
  const send = vi.fn().mockResolvedValue(new Response('[]',{status:200,headers:{'x-ratelimit-remaining':'1','set-cookie':'private=x'}})); vi.stubGlobal('fetch',send);
  const result = await call('/api/v9/channels/12345/messages?limit=100&before=123',auth);
  expect(result.status).toBe(200); expect(result.headers.get('set-cookie')).toBeNull();
  expect(send.mock.calls[0][0]).toBe('https://discord.com/api/v9/channels/12345/messages?limit=100&before=123');
  expect(send.mock.calls[0][1].headers.get('x-akira-relay-secret')).toBeNull();
});
