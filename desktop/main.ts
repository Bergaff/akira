import { app, BrowserWindow, ipcMain, safeStorage, dialog, shell, session } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { LocalBucket, LocalD1, LocalQueue, atomicWrite } from './adapters';
import { jobsApi } from '../src/jobs-api';
import type { Env } from '../src/env';

const SMOKE = process.env.AKIRA_DESKTOP_SMOKE === '1' && !app.isPackaged;
const SETTINGS = ['DISCORD_TOKEN','DISCORD_COOKIES','NOTIFY_WEBHOOK','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','GOOGLE_DRIVE_CLIENT_ID','GOOGLE_DRIVE_CLIENT_SECRET','GOOGLE_DRIVE_REFRESH_TOKEN','GOOGLE_DRIVE_FOLDER_ID','OUTBOUND_PROXY','OUTBOUND_PROXY_SECRET'] as const;
type Key = typeof SETTINGS[number];
type Settings = Partial<Record<Key,string>>;
let window: BrowserWindow | null = null;
let db: LocalD1;
let bucket: LocalBucket;
let queue: LocalQueue;
let env: Env;
let secretFile: string;
let settings: Settings = {};
let watchdog: ReturnType<typeof setInterval> | undefined;

async function loadSecrets(): Promise<Settings> {
  try {
    const ciphertext = await fs.readFile(secretFile);
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Системное шифрование Windows недоступно');
    const parsed: unknown = JSON.parse(safeStorage.decryptString(ciphertext));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Некорректный файл настроек');
    const result: Settings = {};
    for (const key of SETTINGS) if (typeof (parsed as Record<string,unknown>)[key] === 'string') result[key] = (parsed as Record<string,string>)[key];
    return result;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}
async function storeSecrets(values: unknown) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Некорректные настройки');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Системное шифрование Windows недоступно: секреты не сохранены');
  const next: Settings = {...settings};
  for (const key of SETTINGS) {
    const value = (values as Record<string,unknown>)[key];
    if (typeof value === 'string' && value.trim()) {
      if (value.length > 8192 || /[\r\n]/.test(value)) throw new Error('Слишком длинное или некорректное значение');
      next[key] = value.trim();
    }
  }
  await atomicWrite(secretFile,safeStorage.encryptString(JSON.stringify(next)));
  settings = next;
  for (const key of SETTINGS) env[key] = settings[key];
}
function senderCheck(event: Electron.IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(path.join(app.getAppPath(),'desktop','ui','index.html')).href) throw new Error('Запрос отклонён');
}
async function callApi(method: 'GET'|'POST'|'DELETE', route: string, body?: unknown) {
  const request = new Request(`https://desktop.invalid${route}`, { method, ...(body === undefined ? {} : {headers:{'content-type':'application/json'},body:JSON.stringify(body)}) });
  const response = await jobsApi(request as unknown as Parameters<typeof jobsApi>[0],env);
  if (!response) throw new Error('Действие не найдено');
  const result = await response.json() as {error?:string};
  if (!response.ok) throw new Error(result.error || 'Ошибка операции');
  return result;
}
function checkedId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Неверный ID задания');
  return id;
}
async function saveParts(id: number) {
  if (!window) throw new Error('Окно закрыто');
  const selected = await dialog.showOpenDialog(window,{title:'Выберите папку для сохранения файлов',properties:['openDirectory','createDirectory']});
  if (selected.canceled || !selected.filePaths[0]) return {cancelled:true};
  const parts = await db.prepare('SELECT file_name,r2_key FROM job_parts WHERE job_id=? ORDER BY part_index').bind(id).all<{file_name:string;r2_key:string}>();
  if (!parts.results.length) throw new Error('Пока нет готовых частей');
  // A fresh directory avoids silently overwriting older exports.
  const folder = await fs.mkdtemp(path.join(selected.filePaths[0],`Akira-job-${id}-`));
  for (const part of parts.results) {
    if (!/^discord_from-\d+_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}_part-\d+\.txt$/.test(part.file_name)) throw new Error('Некорректное имя файла');
    await fs.copyFile(bucket.localPath(part.r2_key),path.join(folder,part.file_name));
  }
  await shell.openPath(folder);
  return {cancelled:false,folder,count:parts.results.length};
}
function registerIpc() {
  ipcMain.handle('akira:settings-status', async event => { senderCheck(event); return Object.fromEntries(SETTINGS.map(key => [key,!!settings[key]])); });
  ipcMain.handle('akira:settings-save', async (event,values) => { senderCheck(event); await storeSecrets(values); return {ok:true}; });
  ipcMain.handle('akira:settings-clear', async event => {
    senderCheck(event); settings = {}; for (const key of SETTINGS) delete env[key]; await fs.rm(secretFile,{force:true}); return {ok:true};
  });
  ipcMain.handle('akira:jobs', async event => { senderCheck(event); return callApi('GET','/api/jobs'); });
  ipcMain.handle('akira:job', async (event,id) => { senderCheck(event); return callApi('GET',`/api/jobs/${checkedId(id)}`); });
  ipcMain.handle('akira:parts', async (event,id) => { senderCheck(event); return callApi('GET',`/api/jobs/${checkedId(id)}/parts`); });
  ipcMain.handle('akira:create', async (event,data) => { senderCheck(event); return callApi('POST','/api/jobs',data); });
  ipcMain.handle('akira:control', async (event,id,action) => {
    senderCheck(event);
    if (!['start','pause','resume','restart','cancel'].includes(action)) throw new Error('Неизвестное действие');
    return callApi('POST',`/api/jobs/${checkedId(id)}/${action}`);
  });
  ipcMain.handle('akira:delete', async (event,id) => { senderCheck(event); return callApi('DELETE',`/api/jobs/${checkedId(id)}`); });
  ipcMain.handle('akira:save-parts', async (event,id) => { senderCheck(event); return saveParts(checkedId(id)); });
}
async function start() {
  const root = path.join(app.getPath('userData'),'export-data');
  await fs.mkdir(root,{recursive:true});
  db = new LocalD1(path.join(root,'jobs.sqlite'));
  const migrationsDir = path.join(app.getAppPath(),'migrations');
  const names = (await fs.readdir(migrationsDir)).filter(x=>/^\d+_.+\.sql$/.test(x)).sort();
  db.migrate(await Promise.all(names.map(async name=>({name,sql:await fs.readFile(path.join(migrationsDir,name),'utf8')}))));
  bucket = new LocalBucket(path.join(root,'objects'));
  secretFile = path.join(root,'secrets.bin');
  try { settings = await loadSecrets(); }
  catch { await dialog.showMessageBox({type:'warning',title:'Настройки Akira',message:'Не удалось расшифровать сохранённые настройки Windows. Введите секреты заново в приложении.'}); settings = {}; }
  queue = new LocalQueue(() => env);
  env = {DB:db as unknown as D1Database,BUCKET:bucket as unknown as R2Bucket,QUEUE:queue as unknown as Queue,ASSETS:{} as Fetcher,...settings};
  registerIpc();
  await queue.recover(db);
  // Recover a task whose timer was interrupted or whose attempt failed unexpectedly.
  watchdog = setInterval(async () => {
    try {
      const stale = await db.prepare("SELECT id,scan_generation,phase FROM jobs WHERE (status IN ('running','rate_limited') OR phase='cleanup') AND updated_at<? AND lease_until<? LIMIT 100").bind(Date.now()-180000,Date.now()).all<{id:number;scan_generation:number;phase:string}>();
      for (const job of stale.results) await queue.send({jobId:job.id,generation:job.scan_generation,...(job.phase==='cleanup'?{kind:'cleanup' as const}:{})});
    } catch { /* next watchdog pass retries */ }
  },60_000);
  session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  window = new BrowserWindow({width:1180,height:850,minWidth:750,minHeight:600,show:false,webPreferences:{preload:path.join(app.getAppPath(),'desktop','dist','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.once('ready-to-show',()=>window?.show());
  window.on('closed',()=>{ window=null; });
  await window.loadFile(path.join(app.getAppPath(),'desktop','ui','index.html'));
  if (SMOKE) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows safeStorage is unavailable');
    const secret = 'akira-smoke-test';
    if (safeStorage.decryptString(safeStorage.encryptString(secret)) !== secret) throw new Error('Windows safeStorage roundtrip failed');
    const result = await window.webContents.executeJavaScript(`Promise.all([window.akira.settingsStatus(), window.akira.jobs()]).then(([settings, jobs]) => ({settings, jobs}))`);
    if (!result || !Array.isArray(result.jobs?.jobs) || typeof result.settings?.DISCORD_TOKEN !== 'boolean') throw new Error('IPC bridge smoke test failed');
    console.log('Desktop smoke test passed: SQLite, window, IPC and Windows secret storage');
    app.exit(0);
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',()=>{ if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(start).catch(async (error: unknown) => { if (SMOKE) { console.error('Desktop smoke test failed',error); app.exit(1); return; } await dialog.showMessageBox({type:'error',title:'Akira',message:'Не удалось запустить приложение или открыть локальные данные.'}); app.quit(); });
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',()=>{ if (watchdog) clearInterval(watchdog); queue?.close(); });
}
