import type { Env } from './env';
import { jobsApi } from './jobs-api';
import { runStep } from './runner';
import { cleanupStep } from './cleanup';
import { limitedDiscord, DiscordBusy } from './limits';
import { DiscordError } from './discord';


const SESSION_SECONDS = 12 * 60 * 60;
const COOKIE_SESSION = '__Host-akira_session';
const COOKIE_CSRF = '__Host-akira_csrf';
const encoder = new TextEncoder();

type Session = { exp: number; csrf: string };

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set('content-type', 'application/json; charset=utf-8');
  h.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers: h });
}

function securityHeaders(response: Response): Response {
  const h = new Headers(response.headers);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unbase64url(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('Invalid encoding');
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4);
  const decoded = atob(padded);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}
async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signedSession(secret: string, session: Session): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(session)));
  const signature = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}
function cookies(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i >= 0) {
      const name = part.slice(0, i).trim();
      // Reject duplicate cookie names rather than accepting an attacker-controlled ambiguity.
      if (result.has(name)) result.set(name, '');
      else result.set(name, part.slice(i + 1).trim());
    }
  }
  return result;
}
async function getSession(request: Request, secret: string): Promise<Session | null> {
  try {
    const value = cookies(request).get(COOKIE_SESSION) ?? '';
    const [payload, sig, extra] = value.split('.');
    if (!payload || !sig || extra || value.length > 2048) return null;
    if (!await crypto.subtle.verify('HMAC', await key(secret), unbase64url(sig), encoder.encode(payload))) return null;
    const session: unknown = JSON.parse(new TextDecoder().decode(unbase64url(payload)));
    if (typeof session !== 'object' || session === null || !('exp' in session) || !('csrf' in session)) return null;
    const { exp, csrf } = session as Session;
    if (!Number.isSafeInteger(exp) || exp <= Math.floor(Date.now() / 1000) || typeof csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrf)) return null;
    return { exp, csrf };
  } catch { return null; }
}
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([crypto.subtle.digest('SHA-256', encoder.encode(a)), crypto.subtle.digest('SHA-256', encoder.encode(b))]);
  const l = new Uint8Array(left), r = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < l.length; i++) difference |= l[i] ^ r[i];
  return difference === 0;
}
function cookie(name: string, value: string, maxAge: number, httpOnly: boolean): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax${httpOnly ? '; HttpOnly' : ''}`;
}
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  // Browser POSTs include Origin; reject it if it doesn't match. CSRF tokens are
  // also required on every authenticated state-changing request.
  return !origin || origin === new URL(request.url).origin;
}
async function health(env: Env): Promise<Response> {
  if (!env.DISCORD_TOKEN) return json({ ok: false, token_valid: false, last_error: 'DISCORD_TOKEN не настроен' });
  try {
    return await limitedDiscord(env, 1200, 2800, async send => {
      const headers = new Headers({ Authorization: env.DISCORD_TOKEN! });
      if (env.DISCORD_COOKIES) headers.set('Cookie', env.DISCORD_COOKIES);
      const response = await send('https://discord.com/api/v9/users/@me', { headers, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
      if (response.status === 429) throw new DiscordError(429, Number(response.headers.get('retry-after')) * 1000 || 5000, 'Discord HTTP 429');
      if (response.ok) return json({ ok: true, token_valid: true, last_error: null });
      if (response.status === 401) return json({ ok: false, token_valid: false, last_error: 'Токен Discord недействителен' });
      return json({ ok: false, token_valid: null, last_error: `Discord ответил HTTP ${response.status}; проверьте доступ и cookies` });
    });
  } catch (e) {
    if (e instanceof DiscordBusy) return json({ ok: false, token_valid: null, last_error: 'Discord занят, попробуйте позже' }, 503);
    return json({ ok: false, token_valid: null, last_error: e instanceof DiscordError && e.status === 429 ? 'Discord ограничил запросы; попробуйте позже' : 'Не удалось связаться с Discord' });
  }
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/files/')) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Метод не поддерживается' }, 405);
    return env.ASSETS.fetch(request);
  }
  if (!env.PANEL_PASSWORD || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    return json({ error: 'Панель не настроена: задайте PANEL_PASSWORD и SESSION_SECRET (не менее 32 символов)' }, 503);
  }
  if (request.method === 'POST' && !sameOrigin(request)) return json({ error: 'Недопустимый источник запроса' }, 403);
  if (url.pathname === '/api/login' && request.method === 'POST') {
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'Нужен JSON' }, 415);
    let body: unknown;
    try {
      // Avoid buffering arbitrarily large unauthenticated requests.
      const reader = request.body?.getReader();
      if (!reader) return json({ error: 'Неверный запрос' }, 400);
      let size = 0; const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4096) { await reader.cancel(); return json({ error: 'Слишком большой запрос' }, 413); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch { return json({ error: 'Неверный запрос' }, 400); }
    const password = typeof body === 'object' && body !== null && 'password' in body ? body.password : null;
    if (typeof password !== 'string' || !await sameSecret(password, env.PANEL_PASSWORD)) return json({ error: 'Неверный пароль' }, 401);
    const csrf = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const session = await signedSession(env.SESSION_SECRET, { exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS, csrf });
    const headers = new Headers();
    headers.append('Set-Cookie', cookie(COOKIE_SESSION, session, SESSION_SECONDS, true));
    headers.append('Set-Cookie', cookie(COOKIE_CSRF, csrf, SESSION_SECONDS, false));
    return json({ ok: true }, 200, headers);
  }
  const session = await getSession(request, env.SESSION_SECRET);
  if (!session) return json({ error: 'Требуется вход' }, 401);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const csrfCookie = cookies(request).get(COOKIE_CSRF) ?? '';
    const csrfHeader = request.headers.get('x-csrf-token') ?? '';
    if (!csrfCookie || !csrfHeader || !await sameSecret(csrfCookie, session.csrf) || !await sameSecret(csrfHeader, session.csrf)) return json({ error: 'Ошибка CSRF' }, 403);
  }
  if (url.pathname === '/api/session' && request.method === 'GET') return json({ ok: true });
  if (url.pathname === '/api/logout' && request.method === 'POST') {
    const headers = new Headers();
    headers.append('Set-Cookie', cookie(COOKIE_SESSION, '', 0, true));
    headers.append('Set-Cookie', cookie(COOKIE_CSRF, '', 0, false));
    return json({ ok: true }, 200, headers);
  }
  if (url.pathname === '/api/health' && request.method === 'GET') {
    if (!sameOrigin(request) || request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: 'Недопустимый источник запроса' }, 403);
    return health(env);
  }
  const jobResponse = await jobsApi(request, env);
  if (jobResponse) return jobResponse;
  return json({ error: 'Маршрут не найден' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return securityHeaders(await handle(request, env)); }
    catch { return securityHeaders(json({ error: 'Внутренняя ошибка сервиса' }, 500)); }
  },
  async queue(batch: MessageBatch<import('./env').JobMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try { if (message.body.kind === 'cleanup') await cleanupStep(env, message.body); else await runStep(env, message.body); message.ack(); }
      catch { message.retry(); }
    }
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const stale = await env.DB.prepare("SELECT id,scan_generation,phase FROM jobs WHERE (status IN ('running','rate_limited') OR phase='cleanup') AND updated_at<? AND lease_until<? LIMIT 100")
      .bind(Date.now() - 180_000, Date.now()).all<{id: number; scan_generation: number; phase: string}>();
    for (const job of stale.results) await env.QUEUE.send({ jobId: job.id, generation: job.scan_generation, ...(job.phase === 'cleanup' ? {kind:'cleanup' as const} : {}) });
  },
};
