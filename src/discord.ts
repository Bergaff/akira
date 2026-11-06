import type { DiscordMessage, FetchPage } from './scan';
import { msFromId } from './scan';

export class DiscordError extends Error {
  constructor(public readonly status: number | null, public readonly retryAfterMs: number | null, message: string) { super(message); this.name = 'DiscordError'; }
}

/** Network client only; callers MUST acquire the account-wide lock and enforce
 * pauses, rate-limit headers and retries before using this function. */
export function discordFetchPage(token: string, cookies?: string, send: typeof fetch = fetch): FetchPage {
  if (!token) throw new Error('Discord token is not configured');
  return async (channelId, before): Promise<DiscordMessage[]> => {
    if (!/^\d{1,20}$/.test(channelId)) throw new Error('Invalid channel ID');
    msFromId(before);
    const headers = new Headers({ Authorization: token });
    if (cookies) headers.set('Cookie', cookies);
    let response: Response;
    try {
      response = await send(`https://discord.com/api/v9/channels/${channelId}/messages?limit=100&before=${before}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    } catch { throw new DiscordError(null, null, 'Discord network error'); }
    if (!response.ok) {
      // Do not include response bodies or request headers in errors/logs.
      let retry = Number(response.headers.get('retry-after'));
      if (response.status === 429) {
        try {
          const body: unknown = await response.json();
          const bodyRetry = typeof body === 'object' && body !== null && 'retry_after' in body ? Number(body.retry_after) : 0;
          if (Number.isFinite(bodyRetry) && bodyRetry > retry) retry = bodyRetry;
        } catch { /* Some rate-limit responses do not contain JSON. */ }
      }
      const retryMs = response.status === 429 && Number.isFinite(retry) && retry > 0 ? Math.ceil(retry * 1000) : null;
      throw new DiscordError(response.status, retryMs, `Discord HTTP ${response.status}`);
    }
    try {
      const page: unknown = await response.json();
      if (!Array.isArray(page)) throw new Error('Not an array');
      return page as DiscordMessage[];
    } catch { throw new DiscordError(response.status, null, 'Invalid Discord response'); }
  };
}

export async function discordFetchChannels(guildId: string, token: string, cookies: string | undefined, send: typeof fetch): Promise<{id: string; name: string; type: number}[]> {
  if (!/^\d{1,20}$/.test(guildId)) throw new Error('Invalid guild ID');
  const headers = new Headers({ Authorization: token });
  if (cookies) headers.set('Cookie', cookies);
  let response: Response;
  try { response = await send(`https://discord.com/api/v9/guilds/${guildId}/channels`, { headers, signal: AbortSignal.timeout(10_000), redirect: 'manual' }); }
  catch { throw new DiscordError(null, null, 'Discord network error'); }
  if (!response.ok) {
    let retry = Number(response.headers.get('retry-after'));
    if (response.status === 429) try {
      const body = await response.json() as { retry_after?: number };
      if (Number.isFinite(body.retry_after) && body.retry_after! > retry) retry = body.retry_after!;
    } catch {}
    throw new DiscordError(response.status, response.status === 429 && retry > 0 ? Math.ceil(retry * 1000) : null, `Discord HTTP ${response.status}`);
  }
  let channels: unknown;
  try { channels = await response.json(); } catch { throw new DiscordError(response.status, null, 'Invalid Discord response'); }
  if (!Array.isArray(channels)) throw new DiscordError(response.status, null, 'Invalid Discord response');
  return channels.filter(c => c && typeof c.id === 'string' && /^\d{1,20}$/.test(c.id) && typeof c.name === 'string' && [0,5,10,11,12,15,16].includes(c.type)).map(c => ({ id: c.id, name: c.name.slice(0, 100), type: c.type }));
}

export type ThreadCursor = { parent_id: string; kind: 'active'|'public'|'private'|'joined'; cursor: string | null };
export async function discordFetchThreads(cursor: ThreadCursor, token: string, cookies: string | undefined, send: typeof fetch): Promise<{threads: {id:string; name:string}[]; next: string | null; done: boolean}> {
  if (!/^\d{1,20}$/.test(cursor.parent_id)) throw new Error('Invalid parent ID');
  let path: string;
  if (cursor.kind === 'active') path = `/guilds/${cursor.parent_id}/threads/active`;
  else path = `/channels/${cursor.parent_id}/${cursor.kind === 'joined' ? 'users/@me/threads/archived/private' : `threads/archived/${cursor.kind}`}`;
  const url = new URL(`https://discord.com/api/v9${path}`);
  if (cursor.kind !== 'active') {
    url.searchParams.set('limit', '100');
    if (cursor.cursor) url.searchParams.set('before', cursor.cursor);
  }
  const headers = new Headers({Authorization: token}); if (cookies) headers.set('Cookie', cookies);
  let response: Response;
  try { response = await send(url.toString(), {headers,redirect:'manual',signal:AbortSignal.timeout(10_000)}); }
  catch { throw new DiscordError(null,null,'Discord network error'); }
  if (!response.ok) {
    let retry = Number(response.headers.get('retry-after'));
    if (response.status === 429) try { const body = await response.json() as {retry_after?:number}; if (Number.isFinite(body.retry_after) && body.retry_after! > retry) retry = body.retry_after!; } catch {}
    throw new DiscordError(response.status,response.status === 429 && retry > 0 ? Math.ceil(retry*1000) : null,`Discord HTTP ${response.status}`);
  }
  let body: {threads?:unknown;has_more?:unknown};
  try { body = await response.json() as typeof body; } catch { throw new DiscordError(response.status,null,'Invalid Discord response'); }
  if (!body || !Array.isArray(body.threads) || (cursor.kind !== 'active' && typeof body.has_more !== 'boolean')) throw new DiscordError(response.status,null,'Invalid thread list');
  const raw = body.threads;
  const threads = raw.filter(t => t && typeof t.id === 'string' && /^\d{1,20}$/.test(t.id) && typeof t.name === 'string' && [10,11,12].includes(t.type)).map(t => ({id:t.id, name:t.name.slice(0,100)}));
  const more = cursor.kind !== 'active' && body.has_more === true;
  let next: string | null = null;
  if (more) {
    const last = raw[raw.length-1];
    next = cursor.kind === 'joined' ? last?.id : last?.thread_metadata?.archive_timestamp;
    if (typeof next !== 'string' || !next || (cursor.kind === 'joined' ? !/^\d{1,20}$/.test(next) : !Number.isFinite(Date.parse(next))) || next === cursor.cursor) throw new DiscordError(response.status,null,'Invalid thread cursor');
  }
  return {threads,next,done:!more};
}
