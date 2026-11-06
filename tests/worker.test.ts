import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const SECRET = 'a-long-session-secret-with-at-least-32-characters';
function environment() {
  let owner: string | null = null;
  let until = 0;
  let count = 0, multiplier = 1;
  const db = {
    prepare(sql: string) {
      return { async first() { return { locked_until: until, next_at: 0 }; }, bind(...args: (string | number)[]) { return {
        async run() {
          if (sql.includes('SET owner=?, locked_until=?')) {
            if (until > Number(args[2])) return { meta: { changes: 0 } };
            owner = String(args[0]); until = Number(args[1]);
            return { meta: { changes: 1 } };
          }
          if (sql.includes('SET owner=NULL') && owner === args[3]) { owner = null; until = 0; count = Number(args[1]); multiplier = Number(args[2]); return { meta: { changes: 1 } }; }
          return { meta: { changes: 0 } };
        },
        async first() {
          if (sql.includes('request_count,multiplier')) return { request_count: count, multiplier };
          return { locked_until: until, next_at: 0 };
        },
      }; } };
    },
  };
  return { PANEL_PASSWORD: 'correct-password', SESSION_SECRET: SECRET, DISCORD_TOKEN: 'test-secret-token', DISCORD_COOKIES: 'private=cookie', DB: db, ASSETS: { fetch: async () => new Response('static') } } as unknown as Parameters<typeof worker.fetch>[1];
}
async function req(env: ReturnType<typeof environment>, path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`https://test.example${path}`, init) as unknown as Parameters<typeof worker.fetch>[0], env) as unknown as Promise<globalThis.Response>;
}
async function login(env: ReturnType<typeof environment>) {
  const response = await req(env, '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://test.example' }, body: JSON.stringify({ password: 'correct-password' }) });
  const setCookies = response.headers.getSetCookie();
  const session = setCookies.find(c => c.startsWith('__Host-akira_session='))!;
  const csrf = setCookies.find(c => c.startsWith('__Host-akira_csrf='))!;
  return { response, session, csrf, cookie: [session.split(';')[0], csrf.split(';')[0]].join('; '), token: csrf.split(';')[0].split('=')[1] };
}
afterEach(() => vi.unstubAllGlobals());
describe('stage 1 worker', () => {
  it('serves assets with security headers and denies unauthenticated health', async () => {
    const env = environment();
    const page = await req(env, '/');
    expect(await page.text()).toBe('static');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    expect((await req(env, '/api/health')).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects wrong password, cross-origin login, and unconfigured secrets', async () => {
    const env = environment();
    const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) };
    expect((await req(env, '/api/login', options)).status).toBe(401);
    expect((await req(env, '/api/login', { ...options, headers: { ...options.headers, origin: 'https://evil.example' } })).status).toBe(403);
    expect((await req({ ...env, SESSION_SECRET: 'short' }, '/api/login', options)).status).toBe(503);
  });
  it('uses signed, secure cookies and rejects tampering', async () => {
    const env = environment(); const auth = await login(env);
    expect(auth.response.status).toBe(200);
    expect(auth.session).toContain('HttpOnly'); expect(auth.session).toContain('Secure'); expect(auth.session).toContain('SameSite=Lax');
    expect(auth.csrf).not.toContain('HttpOnly');
    expect((await req(env, '/api/session', { headers: { cookie: auth.cookie } })).status).toBe(200);
    expect((await req(env, '/api/session', { headers: { cookie: auth.cookie.replace('__Host-akira_session=', '__Host-akira_session=x') } })).status).toBe(401);
    expect((await req(env, '/api/session', { headers: { cookie: auth.cookie + '; ' + auth.session.split(';')[0] } })).status).toBe(401);
  });
  it('requires the session-bound double-submit token and correct origin on logout', async () => {
    const env = environment(); const auth = await login(env);
    const call = (headers: Record<string, string>) => req(env, '/api/logout', { method: 'POST', headers: { cookie: auth.cookie, ...headers } });
    expect((await call({})).status).toBe(403);
    expect((await call({ 'x-csrf-token': 'wrong' })).status).toBe(403);
    expect((await call({ 'x-csrf-token': auth.token, origin: 'https://evil.example' })).status).toBe(403);
    const response = await call({ 'x-csrf-token': auth.token, origin: 'https://test.example' });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().every(c => c.includes('Max-Age=0'))).toBe(true);
  });
  it('reports Discord health without leaking secrets and sends cookies only to Discord', async () => {
    const env = environment(); const auth = await login(env);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 })); vi.stubGlobal('fetch', fetchMock);
    const response = await req(env, '/api/health', { headers: { cookie: auth.cookie } });
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ ok: true, token_valid: true, last_error: null });
    expect(body).not.toContain('test-secret-token'); expect(body).not.toContain('private=cookie');
    expect(fetchMock.mock.calls[0][0]).toBe('https://discord.com/api/v9/users/@me');
    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get('authorization')).toBe('test-secret-token');
    expect(headers.get('cookie')).toBe('private=cookie');
    expect((await req(env, '/api/health', { headers: { cookie: auth.cookie, 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
  });
  it('reports 401 and network errors without leaking the response', async () => {
    const env = environment(); const auth = await login(env);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('test-secret-token', { status: 401 })).mockRejectedValueOnce(new Error('test-secret-token'));
    vi.stubGlobal('fetch', fetchMock);
    const first = await (await req(env, '/api/health', { headers: { cookie: auth.cookie } })).json();
    expect(first).toMatchObject({ ok: false, token_valid: false });
    const second = await (await req(env, '/api/health', { headers: { cookie: auth.cookie } })).text();
    expect(second).not.toContain('test-secret-token'); expect(JSON.parse(second).token_valid).toBeNull();
  });
  it('serializes simultaneous health requests via D1 lock', async () => {
    const env = environment(); const auth = await login(env);
    let finish!: (r: Response) => void;
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal('fetch', fetchMock);
    const first = req(env, '/api/health', { headers: { cookie: auth.cookie } });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const second = await req(env, '/api/health', { headers: { cookie: auth.cookie } });
    expect(second.status).toBe(503); expect(fetchMock).toHaveBeenCalledOnce();
    finish(new Response('{}')); expect((await first).status).toBe(200);
  });
});
