import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalD1, LocalBucket, LocalQueue } from '../desktop/adapters';
import { jobsApi } from '../src/jobs-api';
import { runStep } from '../src/runner';
import { idFromMs } from '../src/scan';
import type { Env, JobMessage } from '../src/env';

const roots: string[] = [];
afterEach(async()=>{vi.unstubAllGlobals();vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'akira-local-test-'));roots.push(root);
  const db=new LocalD1(join(root,'jobs.sqlite'));
  const names=(await readdir('migrations')).filter(n=>/^\d+_.+\.sql$/.test(n)).sort();
  const migrations=await Promise.all(names.map(async name=>({name,sql:await readFile(join('migrations',name),'utf8')})));
  db.migrate(migrations); db.migrate(migrations);
  const bucket=new LocalBucket(join(root,'objects')); const messages:JobMessage[]=[];
  const env={DB:db,BUCKET:bucket,QUEUE:{send:async(m:JobMessage)=>{messages.push(m);}},DISCORD_TOKEN:'secret'} as unknown as Env;
  const call=(path:string,method='GET',body?:unknown)=>jobsApi(new Request(`https://desktop.invalid${path}`,{method,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})}) as unknown as Parameters<typeof jobsApi>[0],env);
  return {root,db,bucket,env,messages,call};
}
const input={source_type:'channel',source_id:'123456',target_user_id:'456789',date_from:'2020-01-01',date_to:'2020-01-01',mode:'scan',part_size:10};
function discord() {
  const base=Date.parse('2020-01-01T00:00:00Z');
  const items=Array.from({length:180},(_,i)=>({id:idFromMs(base+i*1000),timestamp:new Date(base+i*1000).toISOString(),author:{id:i%3?'999999':'456789'},content:`text-${i}`})).reverse();
  return async(url:string)=>{const before=BigInt(new URL(url).searchParams.get('before')!);return new Response(JSON.stringify(items.filter(m=>BigInt(m.id)<before).slice(0,100)));};
}
describe('Windows local storage adapters',()=>{
  it('migrates a real SQLite database and rolls back failed batches',async()=>{
    const f=await fixture();
    await expect(f.db.batch([f.db.prepare("UPDATE ratelimit_lock SET request_count=42"),f.db.prepare('INSERT INTO table_that_does_not_exist VALUES(1)')])).rejects.toThrow();
    expect(f.db.sqlite.prepare('SELECT request_count FROM ratelimit_lock').get()).toMatchObject({request_count:0});
    expect(f.db.sqlite.prepare('SELECT count(*) AS n FROM d1_migrations').get()).toMatchObject({n:7});
    f.db.close();
  });
  it('keeps objects on disk and rejects paths outside the data directory',async()=>{
    const f=await fixture();await f.bucket.put('staging/1/0/page.json','[{"content":"test"}]');
    expect(await (await f.bucket.get('staging/1/0/page.json'))!.json()).toEqual([{content:'test'}]);
    expect((await f.bucket.list({prefix:'staging/1/',limit:10})).objects).toHaveLength(1);
    expect(()=>f.bucket.localPath('../secrets')).toThrow();
    await f.bucket.delete('staging/1/0/page.json');expect(await f.bucket.get('staging/1/0/page.json')).toBeNull();f.db.close();
  });
  it('resumes an interrupted local export with a fresh SQLite connection, without duplicates',async()=>{
    const f=await fixture();vi.stubGlobal('fetch',discord());
    expect((await f.call('/api/jobs','POST',input))!.status).toBe(200);await f.call('/api/jobs/1/start','POST');
    await runStep(f.env,f.messages.shift()!);
    const checkpoint=f.db.sqlite.prepare('SELECT page_cursor,scanned FROM jobs WHERE id=1').get();expect(checkpoint).toMatchObject({scanned:100});
    f.db.close();
    // Simulates application termination: queued timers disappear, but SQLite and page files survive.
    f.messages.length=0;
    const reopened=new LocalD1(join(f.root,'jobs.sqlite'));(f.env as unknown as {DB:LocalD1}).DB=reopened;
    reopened.sqlite.exec('UPDATE jobs SET lease_owner=NULL,lease_until=0; UPDATE ratelimit_lock SET owner=NULL,locked_until=0,next_at=0;');
    f.messages.push({jobId:1,generation:0});
    for(let i=0;f.messages.length&&i<100;i++){reopened.sqlite.exec('UPDATE ratelimit_lock SET next_at=0');await runStep(f.env,f.messages.shift()!);}
    expect(f.messages).toHaveLength(0);
    expect(reopened.sqlite.prepare('SELECT status,written FROM jobs WHERE id=1').get()).toMatchObject({status:'completed',written:60});
    const parts=reopened.sqlite.prepare('SELECT r2_key FROM job_parts ORDER BY part_index').all() as {r2_key:string}[];
    const texts=[];for(const p of parts) texts.push(...(await readFile(f.bucket.localPath(p.r2_key),'utf8')).split('\n\n'));
    expect(texts).toEqual(Array.from({length:60},(_,i)=>`text-${i*3}`));expect(new Set(texts).size).toBe(60);reopened.close();
  });
  it('recovers running jobs and clears stale leases when the application starts',async()=>{
    vi.useFakeTimers();
    try {
      const f=await fixture();await f.call('/api/jobs','POST',input);
      f.db.sqlite.exec("UPDATE jobs SET status='running',lease_owner='old',lease_until=9999999999999; UPDATE ratelimit_lock SET owner='old',locked_until=9999999999999");
      const queue=new LocalQueue(()=>f.env); const spy=vi.spyOn(queue,'send');await queue.recover(f.db);
      expect(spy).toHaveBeenCalledWith({jobId:1,generation:0});
      expect(f.db.sqlite.prepare('SELECT lease_owner,lease_until FROM jobs').get()).toMatchObject({lease_owner:null,lease_until:0});
      queue.close();f.db.close();
    } finally {vi.useRealTimers();}
  });
});
