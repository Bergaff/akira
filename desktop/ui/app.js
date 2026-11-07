const $ = id => document.getElementById(id);
const api = window.akira;
let selected = null;
const statuses = { queued:'Ожидает', running:'Работает', paused:'Пауза', rate_limited:'Лимит Discord', completed:'Готово', completed_with_errors:'Готово с ошибками', failed:'Ошибка', cancelled:'Отменено' };
const settingsFields = { DISCORD_TOKEN:'discord-token', DISCORD_COOKIES:'discord-cookies', NOTIFY_WEBHOOK:'notify-webhook', TELEGRAM_BOT_TOKEN:'telegram-token', TELEGRAM_CHAT_ID:'telegram-chat', GOOGLE_DRIVE_CLIENT_ID:'google-client', GOOGLE_DRIVE_CLIENT_SECRET:'google-secret', GOOGLE_DRIVE_REFRESH_TOKEN:'google-refresh', GOOGLE_DRIVE_FOLDER_ID:'google-folder', OUTBOUND_PROXY:'proxy-url', OUTBOUND_PROXY_SECRET:'proxy-secret' };
function el(tag, cls, text) { const node = document.createElement(tag); if (cls) node.className=cls; if (text !== undefined) node.textContent=text; return node; }
function errorText(e) { return (e && e.message || 'Неизвестная ошибка').replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
async function settingsStatus() {
  try { const status = await api.settingsStatus(); $('settings-status').textContent = `Discord: ${status.DISCORD_TOKEN ? 'токен сохранён' : 'токен не задан'} · Telegram: ${status.TELEGRAM_BOT_TOKEN && status.TELEGRAM_CHAT_ID ? 'настроен' : 'не настроен'} · Google Диск: ${status.GOOGLE_DRIVE_CLIENT_ID && status.GOOGLE_DRIVE_CLIENT_SECRET && status.GOOGLE_DRIVE_REFRESH_TOKEN && status.GOOGLE_DRIVE_FOLDER_ID ? 'настроен' : 'не настроен'}`; }
  catch(e) { $('settings-message').textContent=errorText(e); }
}
$('settings-form').addEventListener('submit',async event=>{
  event.preventDefault(); $('settings-message').textContent='';
  const values={}; for (const [key,id] of Object.entries(settingsFields)) values[key]=$(id).value;
  try { await api.saveSettings(values); for (const id of Object.values(settingsFields)) $(id).value=''; $('settings-message').textContent='Настройки сохранены.'; await settingsStatus(); }
  catch(e) { $('settings-message').textContent=errorText(e); }
});
$('clear-settings').addEventListener('click',async()=>{
  if (!confirm('Удалить все сохранённые секреты? Для продолжения работы их потребуется ввести заново.')) return;
  try { await api.clearSettings(); await settingsStatus(); $('settings-message').textContent='Секреты удалены.'; }
  catch(e) { $('settings-message').textContent=errorText(e); }
});
$('job-form').addEventListener('submit',async event=>{
  event.preventDefault(); $('job-error').textContent=''; const button=event.currentTarget.querySelector('button'); button.disabled=true;
  try {
    const type=$('source-type').value;
    const data={source_type:type,source_id:$('source').value,target_user_id:$('author').value,date_from:$('from').value,date_to:$('to').value,mode:type==='guild'?'guild':'scan',part_size:Number($('size').value),delay_min:Number($('delay-min').value),delay_max:Number($('delay-max').value),blank_line_between:$('blank').checked,skip_empty:$('skip').checked,dry_run:$('dry').checked};
    const result=await api.create(data); selected=result.job.id; await api.control(selected,'start'); await refresh();
  } catch(e) { $('job-error').textContent=errorText(e); } finally { button.disabled=false; }
});
function progress(job) {
  if (['completed','completed_with_errors'].includes(job.status)) return 100;
  if (job.phase==='drive') return 99;
  if (job.source_type==='guild') return 0;
  if (job.phase==='assembly') return job.fetched ? Math.min(99,90+9*job.written/job.fetched) : 99;
  if (!job.page_cursor) return 0;
  try { const ms=Number((BigInt(job.page_cursor)>>22n)+1420070400000n); return Math.max(0,Math.min(90,90*(job.date_to-ms)/(job.date_to-job.date_from+1))); } catch { return 0; }
}
function button(label,fn) { const b=el('button','',label); b.type='button'; b.addEventListener('click',async()=>{b.disabled=true;try{await fn();await refresh();}catch(e){alert(errorText(e));}finally{b.disabled=false;}});return b; }
function renderJobs(jobs) {
  const list=$('jobs'); list.replaceChildren();
  if (!jobs.length) {list.append(el('p','muted','Заданий пока нет. Укажите токен и создайте первое задание.'));return;}
  for (const job of jobs) {
    const box=el('div','job'),head=el('div','job-head');
    head.append(el('span','job-title',`#${job.id} · ${job.source_type==='guild'?'сервер':'канал'} ${job.source_id}`),el('span','job-status',job.phase==='cleanup'?'Удаление':(statuses[job.status]||job.status)));box.append(head);
    const percent=progress(job),bar=el('div','bar'),fill=el('span');fill.style.width=`${percent}%`;bar.append(fill);
    box.append(el('p','job-meta',`${job.dry_run?'Пробный проход · ':''}${new Date(job.date_from).toISOString().slice(0,10)} — ${new Date(job.date_to).toISOString().slice(0,10)} UTC\nПросмотрено: ${job.scanned} · найдено: ${job.fetched} · записано: ${job.written}\nЧастей: ${job.part_index} · запросов: ${job.requests} · обновлено: ${new Date(job.updated_at).toLocaleString()}\n${job.phase==='drive'?'Копирование на Google Диск':job.phase==='assembly'?'Сборка файлов':job.source_type==='guild'?'Обход каналов':'Оценка по времени: '+percent.toFixed(1)+'%'}${job.eta_seconds!=null?' · примерно осталось '+Math.ceil(job.eta_seconds/60)+' мин':''}${job.last_error?' · '+job.last_error:''}`),bar);
    const controls=el('div','actions');
    if(job.status==='queued')controls.append(button('Старт',()=>api.control(job.id,'start')));
    if(['running','rate_limited'].includes(job.status))controls.append(button('Пауза',()=>api.control(job.id,'pause')));
    if(['paused','failed'].includes(job.status))controls.append(button('Продолжить',()=>api.control(job.id,'resume')));
    if(!['completed','completed_with_errors','cancelled'].includes(job.status))controls.append(button('Отменить',async()=>{if(confirm('Отменить задание?'))await api.control(job.id,'cancel');}));
    if(job.phase!=='cleanup')controls.append(button('Начать заново',async()=>{if(confirm('Начать заново? Старые части останутся в локальном хранилище до удаления задания.'))await api.control(job.id,'restart');}));
    if(job.part_index>0)controls.append(button('Сохранить файлы…',()=>api.saveParts(job.id)));
    if(!['running','rate_limited','queued'].includes(job.status)&&job.phase!=='cleanup')controls.append(button('Удалить',async()=>{if(confirm('Удалить задание и его локальные данные? Сохранённые в выбранную папку файлы и копии на Google Диске останутся.'))await api.remove(job.id);}));
    controls.append(button('Лог',async()=>{selected=job.id;await refreshDetails();}));box.append(controls);list.append(box);
  }
}
async function refreshDetails() {
  if (!selected) return; const id=selected;
  try {
    const [detail,parts]=await Promise.all([api.job(id),api.parts(id)]);if(selected!==id)return;
    $('log-title').textContent=`Задание #${id} · ${parts.parts.length} частей`; const view=$('logs');view.replaceChildren();
    for(const channel of detail.channels||[])view.append(el('div','',`Канал ${channel.name||channel.channel_id}: ${channel.status} · просмотрено ${channel.scanned} · найдено ${channel.fetched} · записано ${channel.written}`));
    for(const part of parts.parts)view.append(el('div','',`${part.file_name} · ${part.messages} сообщений${part.drive_status==='done'?' · Google Диск':''}`));
    if(!detail.logs.length)view.append(el('div','','Нет записей'));
    for(const entry of detail.logs){const row=el('div');row.append(el('span','log-time',new Date(entry.ts).toLocaleString()),document.createTextNode(`${entry.level}: ${entry.message}`));view.append(row);}
  } catch(e){$('logs').textContent=errorText(e);}
}
async function refresh(){try{const data=await api.jobs();renderJobs(data.jobs);if(!selected&&data.jobs.length)selected=data.jobs[0].id;await refreshDetails();}catch(e){$('jobs').textContent=errorText(e);}}
settingsStatus();refresh();setInterval(refresh,4000);
