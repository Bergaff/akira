const $ = id => document.getElementById(id);
const login = $('login-panel'), dashboard = $('dashboard'), logout = $('logout');
let selected = null, poll = null;
function show(authenticated) {
  login.hidden = authenticated; dashboard.hidden = !authenticated; logout.hidden = !authenticated;
  if (poll) clearInterval(poll);
  if (authenticated) { refresh(); poll = setInterval(refresh, 4000); }
}
function csrf() {
  const pair = document.cookie.split('; ').find(item => item.startsWith('__Host-akira_csrf='));
  return pair ? pair.slice('__Host-akira_csrf='.length) : '';
}
async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.method && options.method !== 'GET') headers.set('x-csrf-token', csrf());
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('login-error').textContent = '';
  const button = event.currentTarget.querySelector('button'); button.disabled = true;
  try { await api('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('password').value }) }); $('password').value = ''; show(true); }
  catch (error) { $('login-error').textContent = error.message || 'Не удалось войти'; }
  finally { button.disabled = false; }
});
logout.addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); show(false); } catch (error) { alert(error.message || 'Не удалось выйти'); } });
$('check-health').addEventListener('click', async event => {
  event.currentTarget.disabled = true; $('health-status').textContent = 'Проверяем…'; $('health-dot').className = 'status-dot';
  try { const result = await api('/api/health'); $('health-status').textContent = result.ok ? 'Подключение работает' : result.last_error; $('health-dot').classList.add(result.ok ? 'good' : 'bad'); }
  catch (error) { $('health-status').textContent = error.message || 'Не удалось выполнить проверку'; $('health-dot').classList.add('bad'); }
  finally { event.currentTarget.disabled = false; }
});
$('job-form').addEventListener('submit', async event => {
  event.preventDefault(); $('job-error').textContent = '';
  const button = event.currentTarget.querySelector('button'); button.disabled = true;
  try {
    const sourceType = $('source-type').value;
    const data = { source_type: sourceType, source_id: $('source').value, target_user_id: $('author').value, date_from: $('from').value, date_to: $('to').value, mode: sourceType === 'guild' ? 'guild' : 'scan', part_size: Number($('size').value), delay_min: Number($('delay-min').value), delay_max: Number($('delay-max').value), blank_line_between: $('blank').checked, skip_empty: $('skip').checked, dry_run: $('dry').checked };
    const { job } = await api('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    selected = job.id;
    await api(`/api/jobs/${job.id}/start`, { method: 'POST' });
    await refresh();
  } catch (error) { $('job-error').textContent = error.message || 'Не удалось создать задание'; }
  finally { button.disabled = false; }
});
const statuses = { queued:'Ожидает', running:'Работает', paused:'Пауза', rate_limited:'Лимит Discord', completed:'Готово', completed_with_errors:'Готово с ошибками', failed:'Ошибка', cancelled:'Отменено' };
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function progress(job) {
  if (['completed','completed_with_errors'].includes(job.status)) return 100;
  if (job.phase === 'drive') return 99;
  if (job.source_type === 'guild') return 0;
  if (job.phase === 'assembly') return job.fetched ? Math.min(99, 90 + 9 * job.written / job.fetched) : 99;
  if (!job.page_cursor) return 0;
  try { const ms = Number((BigInt(job.page_cursor) >> 22n) + 1420070400000n); return Math.max(0, Math.min(90, 90 * (job.date_to - ms) / (job.date_to - job.date_from + 1))); } catch { return 0; }
}
function actionButton(job, label, action) {
  const button = el('button', '', label); button.type = 'button';
  button.addEventListener('click', async () => {
    if ((action === 'restart' || action === 'cancel') && !confirm(action === 'restart' ? 'Начать задание заново? Старые файлы сохранятся в R2.' : 'Отменить задание?')) return;
    button.disabled = true;
    try { selected = job.id; await api(`/api/jobs/${job.id}/${action}`, { method: 'POST' }); await refresh(); }
    catch (error) { alert(error.message); }
    finally { button.disabled = false; }
  }); return button;
}
function renderJobs(jobs) {
  const list = $('jobs'); list.replaceChildren();
  if (!jobs.length) { list.append(el('p', 'muted', 'Пока нет заданий. Создайте первое слева.')); return; }
  for (const job of jobs) {
    const box = el('div', 'job'), head = el('div', 'job-head');
    head.append(el('span', 'job-title', `#${job.id} · ${job.source_type === 'guild' ? 'сервер' : 'канал'} ${job.source_id}`), el('span', 'job-status', job.phase === 'cleanup' ? 'Удаление' : (statuses[job.status] || job.status))); box.append(head);
    const percent = progress(job);
    const bar = el('div', 'bar'), fill = el('span'); fill.style.width = `${percent}%`; bar.append(fill);
    box.append(el('p', 'job-meta', `${job.dry_run ? 'Пробный проход · ' : ''}${new Date(job.date_from).toISOString().slice(0,10)} — ${new Date(job.date_to).toISOString().slice(0,10)} UTC\nПросмотрено: ${job.scanned} · найдено: ${job.fetched} · записано: ${job.written}\nЧастей: ${job.part_index} · запросов: ${job.requests} · обновлено: ${new Date(job.updated_at).toLocaleString()}\n${job.phase === 'drive' ? 'Копирование на Google Диск' : job.phase === 'assembly' ? 'Сборка файлов: ' + percent.toFixed(1) + '%' : job.source_type === 'guild' ? 'Обход каналов; общий ETA недоступен' : 'Оценка по времени: ' + percent.toFixed(1) + '%'}${job.eta_seconds != null ? ' · примерно осталось: ' + Math.ceil(job.eta_seconds / 60) + ' мин' : ''}${job.last_error ? ' · ' + job.last_error : ''}`), bar);
    const controls = el('div', 'actions');
    if (['queued'].includes(job.status)) controls.append(actionButton(job, 'Старт', 'start'));
    if (['running','rate_limited'].includes(job.status)) controls.append(actionButton(job, 'Пауза', 'pause'));
    if (['paused','failed'].includes(job.status)) controls.append(actionButton(job, 'Продолжить', 'resume'));
    if (!['completed','completed_with_errors','cancelled'].includes(job.status)) controls.append(actionButton(job, 'Отменить', 'cancel'));
    if (job.phase !== 'cleanup') controls.append(actionButton(job, 'Начать заново', 'restart'));
    if (!['running','rate_limited','queued'].includes(job.status) && job.phase !== 'cleanup') {
      const remove = el('button', '', 'Удалить'); remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (!confirm('Удалить задание и его файлы в R2? Копии на Google Диске останутся.')) return;
        try { await api(`/api/jobs/${job.id}`, { method: 'DELETE' }); if (selected === job.id) selected = null; await refresh(); } catch (error) { alert(error.message); }
      }); controls.append(remove);
    }
    const logs = el('button', '', 'Лог и файлы'); logs.type = 'button'; logs.addEventListener('click', () => { selected = job.id; refreshDetails(); }); controls.append(logs);
    box.append(controls); list.append(box);
  }
}
async function refreshDetails() {
  if (!selected) return;
  const id = selected;
  try {
    const [detail, files] = await Promise.all([api(`/api/jobs/${id}`), api(`/api/jobs/${id}/parts`)]);
    if (selected !== id) return;
    $('log-title').textContent = `Задание #${id} · лог и файлы`;
    const view = $('logs'); view.replaceChildren();
    for (const file of files.parts) { const line = el('div'); const link = el('a', '', `↓ ${file.file_name} (${file.messages} сообщений)`); link.href = file.url; link.style.color = '#c4f578'; line.append(link); if (file.drive_url) { const drive = el('a', '', ' · Google Диск ↗'); drive.href = file.drive_url; drive.target = '_blank'; drive.rel = 'noopener noreferrer'; drive.style.color = '#c4f578'; line.append(drive); } view.append(line); }
    for (const channel of detail.channels || []) view.append(el('div', '', `Канал ${channel.name || channel.channel_id}: ${channel.status} · просмотрено ${channel.scanned} · найдено ${channel.fetched} · записано ${channel.written}`));
    if (!detail.logs.length) view.append(el('div', '', 'Нет записей'));
    for (const entry of detail.logs) { const row = el('div'); row.append(el('span', 'log-time', new Date(entry.ts).toLocaleString()), document.createTextNode(`${entry.level}: ${entry.message}`)); view.append(row); }
  } catch (error) { $('logs').textContent = error.message || 'Не удалось загрузить журнал'; }
}
async function refresh() {
  try { const data = await api('/api/jobs'); renderJobs(data.jobs); if (!selected && data.jobs.length) selected = data.jobs[0].id; await refreshDetails(); }
  catch (error) { $('jobs').textContent = error.message || 'Не удалось загрузить задания'; }
}
api('/api/session').then(() => show(true)).catch(() => show(false));
