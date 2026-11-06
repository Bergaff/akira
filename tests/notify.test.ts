import { afterEach, expect, it, vi } from 'vitest';
import { notify } from '../src/notify';
import type { Env } from '../src/env';
afterEach(() => vi.unstubAllGlobals());
it('sends result notifications to Telegram and Discord without exposing tokens in the content', async () => {
  const send = vi.fn().mockResolvedValue(new Response('{}')); vi.stubGlobal('fetch',send);
  const env = { NOTIFY_WEBHOOK:'https://discord.com/api/webhooks/123/secret', TELEGRAM_BOT_TOKEN:'123456:botsecret', TELEGRAM_CHAT_ID:'-123456' } as Env;
  await notify(env, 'Выгрузка #42 завершена: 5 сообщений, 1 частей.');
  expect(send).toHaveBeenCalledTimes(2);
  const discord = send.mock.calls.find(c => String(c[0]).includes('discord.com'))!;
  const telegram = send.mock.calls.find(c => String(c[0]).includes('telegram.org'))!;
  expect(JSON.parse(discord[1].body).content).toContain('завершена');
  const body = JSON.parse(telegram[1].body);
  expect(body).toEqual({chat_id:'-123456',text:'Выгрузка #42 завершена: 5 сообщений, 1 частей.'});
  expect(telegram[1].body).not.toContain('botsecret');
});
