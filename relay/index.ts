/** Optional relay. Deploy only to trusted infrastructure with a different
 * egress network. The caller and relay must share RELAY_SECRET. */
interface RelayEnv { RELAY_SECRET?: string }
async function equal(a: string, b: string): Promise<boolean> {
  const encode = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', encode.encode(a)), crypto.subtle.digest('SHA-256', encode.encode(b))]);
  const left = new Uint8Array(x), right = new Uint8Array(y); let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    if (!env.RELAY_SECRET || env.RELAY_SECRET.length < 32 || !await equal(request.headers.get('x-akira-relay-secret') ?? '', env.RELAY_SECRET)) return new Response('Forbidden', {status:403});
    const url = new URL(request.url);
    if (request.method !== 'GET' || !/^\/api\/v9\/(users\/@me|channels\/\d{1,20}\/(messages|threads\/archived\/(public|private)|users\/@me\/threads\/archived\/private)|guilds\/\d{1,20}\/(channels|threads\/active))$/.test(url.pathname)) return new Response('Not found', {status:404});
    const headers = new Headers();
    const authorization = request.headers.get('authorization'), cookie = request.headers.get('cookie');
    if (!authorization) return new Response('Unauthorized', {status:401});
    headers.set('Authorization', authorization);
    if (cookie) headers.set('Cookie', cookie);
    try {
      const response = await fetch(`https://discord.com${url.pathname}${url.search}`, { headers, redirect:'manual', signal:AbortSignal.timeout(10_000) });
      // Only relay what the exporter needs, never Set-Cookie or redirects.
      const out = new Headers();
      for (const name of ['content-type','retry-after','x-ratelimit-remaining','x-ratelimit-reset-after','x-ratelimit-bucket']) {
        const value = response.headers.get(name); if (value) out.set(name, value);
      }
      out.set('cache-control','no-store');
      return new Response(response.body, { status: response.status, headers: out });
    } catch { return new Response('Upstream unavailable', {status:502}); }
  },
};
