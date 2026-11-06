import { log, type Env } from './env';
/** Best effort: notification failure is visible in the job log and never rolls
 * back an export. No remote response bodies or secrets are written to logs. */
export async function notify(env: Env, message: string, jobId?: number): Promise<void> {
  const requests: Promise<unknown>[] = [];
  let invalid = false;
  const send = async (url: string, body: unknown) => {
    const response = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(10_000), redirect:'manual' });
    if (!response.ok) throw new Error('Notification failed');
  };
  if (env.NOTIFY_WEBHOOK) {
    try {
      const url = new URL(env.NOTIFY_WEBHOOK);
      if (url.protocol === 'https:' && url.hostname === 'discord.com' && /^\/api(?:\/v\d+)?\/webhooks\//.test(url.pathname)) requests.push(send(url.toString(), {content:message}));
      else invalid = true;
    } catch { invalid = true; }
  }
  if (env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_CHAT_ID) {
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && /^\d+:[A-Za-z0-9_-]+$/.test(env.TELEGRAM_BOT_TOKEN) && /^-?\d+$/.test(env.TELEGRAM_CHAT_ID)) {
      requests.push(send(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {chat_id:env.TELEGRAM_CHAT_ID,text:message}));
    } else invalid = true;
  }
  const results = await Promise.allSettled(requests);
  if (jobId && (invalid || results.some(r => r.status === 'rejected'))) {
    try { await log(env, jobId, 'warn', 'Не удалось доставить уведомление; проверьте настройки и доступ к Telegram / Discord webhook'); } catch { /* best effort */ }
  }
}
