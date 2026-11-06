import type { Env } from './env';
import { DiscordError } from './discord';

export class DiscordBusy extends Error {
  constructor(public waitMs: number) { super('Discord is busy'); }
}
/** All authenticated Discord calls must go through the same global lease. */
export async function limitedDiscord<T>(env: Env, min: number, max: number, run: (send: typeof fetch) => Promise<T>): Promise<T> {
  const now = Date.now(), owner = crypto.randomUUID();
  const result = await env.DB.prepare('UPDATE ratelimit_lock SET owner=?, locked_until=? WHERE id=1 AND locked_until<=? AND next_at<=?')
    .bind(owner, now + 30_000, now, now).run();
  if (result.meta.changes !== 1) {
    const state = await env.DB.prepare('SELECT locked_until,next_at FROM ratelimit_lock WHERE id=1').first<{locked_until: number; next_at: number}>();
    throw new DiscordBusy(Math.max(1000, (Math.max(state?.locked_until ?? 0, state?.next_at ?? 0) - now)));
  }
  let response: Response | undefined;
  let thrown: unknown;
  const send: typeof fetch = async (input, init) => {
    let target: RequestInfo | URL = input;
    let options = init;
    if (env.OUTBOUND_PROXY || env.OUTBOUND_PROXY_SECRET) {
      if (!env.OUTBOUND_PROXY || !env.OUTBOUND_PROXY_SECRET || typeof input !== 'string') throw new Error('Proxy is not configured');
      const discord = new URL(input), proxy = new URL(env.OUTBOUND_PROXY);
      if (discord.protocol !== 'https:' || discord.hostname !== 'discord.com' || proxy.protocol !== 'https:' || proxy.username || proxy.password || proxy.search || proxy.hash) throw new Error('Invalid proxy URL');
      proxy.pathname = proxy.pathname.replace(/\/$/, '') + discord.pathname;
      proxy.search = discord.search;
      const headers = new Headers(init?.headers);
      headers.set('X-Akira-Relay-Secret', env.OUTBOUND_PROXY_SECRET);
      target = proxy.toString(); options = { ...init, headers, redirect: 'manual' };
    }
    const r = await fetch(target, options); response = r; return r;
  };
  try { return await run(send); }
  catch (e) { thrown = e; throw e; }
  finally {
    const state = await env.DB.prepare('SELECT request_count,multiplier FROM ratelimit_lock WHERE id=1 AND owner=?').bind(owner).first<{request_count: number; multiplier: number}>();
    if (state) {
      const nextCount = state.request_count + 1;
      const multiplier = thrown instanceof DiscordError && thrown.status === 429 ? Math.min(state.multiplier * 1.2, 8) : state.multiplier;
      const base = Math.min(10_000, (min + Math.random() * Math.max(0, max - min)) * multiplier);
      let delay = Math.max(1500, base); // global cap: at most 40 requests/minute
      if (nextCount % 12 === 0) delay += 3000 + Math.random() * 4000;
      const remaining = response?.headers.get('x-ratelimit-remaining');
      const reset = Number(response?.headers.get('x-ratelimit-reset-after'));
      if (remaining === '0' && Number.isFinite(reset)) delay = Math.max(delay, reset * 1000 + 250);
      if (thrown instanceof DiscordError && thrown.status === 429) delay = Math.max(delay, (thrown.retryAfterMs ?? 5000) + 250 + Math.random() * 1000);
      await env.DB.prepare('UPDATE ratelimit_lock SET owner=NULL,locked_until=0,next_at=?,request_count=?,multiplier=? WHERE id=1 AND owner=?')
        .bind(Date.now() + Math.ceil(delay), nextCount, multiplier, owner).run();
    }
  }
}
