import {test,expect} from 'bun:test'
import {createHash,randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import pg from 'pg'
import {S3Client,HeadBucketCommand,GetObjectCommand} from '@aws-sdk/client-s3'

const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-local-schedule'?test:test.skip
const metadataUrl='postgres://steelkeep:local-metadata-only@127.0.0.1:54371/steelkeep',workspace=resolve(import.meta.dir,'..')
type Connection={id:string;name:string;kind:string;config:Record<string,unknown>}
type Plan={id:string;name:string;source_id:string;storage_id:string;cron:string|null;timezone:string;enabled:boolean;next_due:string|null}
type Occurrence={plan_id:string;due_at:string;outcome:string;run_id:string|null}
type Job={id:string;plan_id:string;source_id:string;storage_id:string;idempotency_key:string;type:string;status:string;attempt:number;artifact_id:string|null;events?:Array<{phase:string;message:string}>}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))

// Only real API plan writes and scheduler execution. No clock manipulation,
// synthetic occurrence rows, direct metadata mutation, manual run or cleanup.
acceptance('minute cron creates one native PostgreSQL backup with a unique scheduler occurrence',async()=>{
  if(process.env.DATABASE_URL!==metadataUrl||process.env.STEELKEEP_DATABASE_PASSWORD_FILE)throw new Error('Schedule acceptance requires the exact isolated metadata URL.')
  let token='',planId='',sourceId='',storageId='',creationMayHaveHappened=false
  const name='Scheduled native acceptance '+randomUUID(),cron='* * * * *',timezone='Asia/Bangkok'
  const metadata=new pg.Client({connectionString:metadataUrl,connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000,options:'-c default_transaction_read_only=on'})
  metadata.on('error',()=>{})
  const s3=new S3Client({endpoint:'http://127.0.0.1:54373',region:'us-east-1',forcePathStyle:true,maxAttempts:1,credentials:{accessKeyId:'steelkeep-local',secretAccessKey:'local-s3-fixture-only'}})
  async function api<T>(path:string,body?:unknown,method?:string):Promise<T>{
    try{
      const response=await fetch('http://127.0.0.1:4311/api/v1'+path,{method:method??(body===undefined?'GET':'POST'),headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)})
      if(!response.ok)throw new Error()
      const result=await response.json(),serialized=JSON.stringify(result)
      if([token,'local-reader-only','local-s3-fixture-only'].some(secret=>secret&&serialized.includes(secret)))throw new Error()
      return result as T
    }catch{throw new Error('The isolated schedule API request failed; credential and response details withheld.')}
  }
  async function disable(){
    // A timed-out create may still have committed. Recover only this random,
    // previously absent plan name with the exact guarded source/storage pair.
    if(!planId&&creationMayHaveHappened){
      const rows=(await metadata.query('SELECT id,source_id,storage_id FROM plans WHERE name=$1',[name])).rows
      if(rows.length>1||rows.some(row=>row.source_id!==sourceId||row.storage_id!==storageId))throw new Error('Own schedule creation is uncertain; operator review required.')
      if(!rows.length)throw new Error('The schedule creation outcome remains unknown; do not assume it cannot commit later.')
      planId=rows[0].id
    }
    if(!planId)return
    const disabled=await api<Plan>(`/plans/${planId}`,{name,cron,timezone,enabled:false},'PATCH')
    if(disabled.id!==planId||disabled.name!==name||disabled.source_id!==sourceId||disabled.storage_id!==storageId||disabled.enabled||disabled.next_due!==null)throw new Error('The dedicated acceptance schedule was not safely disabled.')
  }
  async function totals(){
    const source=new pg.Client({host:'127.0.0.1',port:54372,database:'source',user:'backup_reader',password:'local-reader-only',connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000,options:'-c default_transaction_read_only=on'})
    source.on('error',()=>{})
    try{await source.connect();const row=(await source.query('SELECT count(*)::text AS count,sum(amount)::text AS total FROM entries')).rows[0];expect(row).toEqual({count:'1000',total:'625625.00'});return row}
    catch{throw new Error('The synthetic source data evidence failed; credentials withheld.')}
    finally{await source.end().catch(()=>{})}
  }
  try{
    await metadata.connect()
    const identity=(await metadata.query("SELECT current_database() AS name,current_user AS actor,current_setting('server_version_num')::int AS version")).rows[0]
    if(identity.name!=='steelkeep'||identity.actor!=='steelkeep'||Math.floor(Number(identity.version)/10000)!==17)throw new Error('Unexpected metadata identity.')
    token=(await readFile(resolve(workspace,'.steelkeep/token'),'utf8')).trim();if(token.length<32)throw new Error('Missing isolated installation token.')
    const connections=await api<Connection[]>('/connections'),hosts=new Set(['fixture','mysql-fixture','mysql8-fixture','mongodb-fixture','redis-fixture','clickhouse-fixture','mssql-fixture'])
    for(const {kind,config:c} of connections)if(kind==='s3'?c.endpoint!=='http://s3:9000':kind==='sqlite'?!String(c.path).startsWith('/var/lib/steelkeep-fixtures/sqlite/'):!hosts.has(String(c.host)))throw new Error('Foreign saved profiles prohibit native schedule acceptance.')
    const sources=connections.filter(c=>c.name==='Application · fixture'&&c.kind==='postgres'&&c.config.host==='fixture'&&c.config.port===5432&&c.config.database==='source'&&c.config.user==='backup_reader'&&c.config.tls===false&&c.config.restoreTarget===false)
    const storages=connections.filter(c=>c.name==='Local S3 · RustFS'&&c.kind==='s3'&&c.config.endpoint==='http://s3:9000'&&c.config.bucket==='steelkeep-fixture'&&c.config.region==='us-east-1'&&c.config.prefix==='steelkeep')
    if(sources.length!==1||storages.length!==1)throw new Error('Exact public PostgreSQL and S3 fixture profiles are required.')
    sourceId=sources[0].id;storageId=storages[0].id
    const saved=(await metadata.query('SELECT id,name FROM connections WHERE id=ANY($1::uuid[])',[ [sourceId,storageId] ])).rows
    if(saved.length!==2||!saved.some(row=>row.id===sourceId&&row.name===sources[0].name)||!saved.some(row=>row.id===storageId&&row.name===storages[0].name))throw new Error('The API does not match the guarded metadata installation.')
    const idle=(await metadata.query("SELECT (SELECT count(*) FROM runs WHERE status IN ('queued','running','cancelling'))::int AS active,(SELECT count(*) FROM plans WHERE enabled AND cron IS NOT NULL)::int AS scheduled,(SELECT count(*) FROM plans WHERE name=$1)::int AS existing",[name])).rows[0]
    if(idle.active||idle.scheduled||idle.existing)throw new Error('Require an idle fixture installation without other enabled schedules.')
    await s3.send(new HeadBucketCommand({Bucket:'steelkeep-fixture'}),{abortSignal:AbortSignal.timeout(5000)})
    const before=await totals(),started=Date.now(),deadline=started+100000
    creationMayHaveHappened=true
    const created=await api<{id:string;nextDue:string}>('/plans',{name,sourceId,storageId,cron,timezone});planId=created.id
    console.info(JSON.stringify({suite:'scheduled-native',planId,name,timezone,state:'created'}))
    const plan=(await api<Plan[]>('/plans')).find(row=>row.id===planId)
    if(!plan||plan.name!==name||plan.source_id!==sourceId||plan.storage_id!==storageId||plan.cron!==cron||plan.timezone!==timezone||!plan.enabled||plan.next_due!==created.nextDue)throw new Error('The dedicated schedule was not persisted as requested.')
    const due=new Date(created.nextDue)
    expect(Number.isFinite(due.getTime())).toBe(true);expect(due.getUTCSeconds()).toBe(0);expect(due.getUTCMilliseconds()).toBe(0)
    const serverNow=Date.parse(String((await metadata.query('SELECT now() AS now')).rows[0].now))
    expect(due.getTime()-serverNow).toBeGreaterThan(-2000);expect(due.getTime()-serverNow).toBeLessThanOrEqual(60000)
    let occurrence:Occurrence|undefined
    while(Date.now()<deadline){
      const rows=await api<Occurrence[]>(`/plans/${planId}/occurrences`)
      if(rows.length){await disable();expect(rows.length).toBe(1);occurrence=rows[0];break}
      await pause(250)
    }
    if(!occurrence)throw new Error('No actual scheduler occurrence within the 100-second observation bound.')
    expect(occurrence.plan_id).toBe(planId);expect(occurrence.outcome).toBe('queued');expect(occurrence.due_at).toBe(created.nextDue)
    if(!occurrence.run_id)throw new Error('The actual scheduler did not enqueue a job; skipped outcomes are retained.')
    const runId=occurrence.run_id,key=`schedule:${planId}:${due.toISOString()}`
    let completed:Job|undefined
    while(Date.now()<deadline){
      const job=await api<Job>(`/jobs/${runId}`)
      expect(job.plan_id).toBe(planId);expect(job.source_id).toBe(sourceId);expect(job.storage_id).toBe(storageId);expect(job.type).toBe('backup');expect(job.idempotency_key).toBe(key)
      if(['succeeded','failed','interrupted','cancelled'].includes(job.status)){completed=job;break}
      await pause(300)
    }
    if(!completed)throw new Error('The scheduled backup did not complete within 100 seconds; history is retained.')
    expect(completed.status).toBe('succeeded');expect(completed.attempt).toBe(1)
    for(const phase of ['queued','dumping','uploading','publishing','completed'])expect(completed.events?.some(event=>event.phase===phase)).toBe(true)
    expect(completed.events?.some(event=>event.message==='Scheduled backup accepted and waiting for a worker.')).toBe(true)
    const occurrences=await api<Occurrence[]>(`/plans/${planId}/occurrences`);expect(occurrences.length).toBe(1)
    const counts=(await metadata.query("SELECT (SELECT count(*) FROM schedule_occurrences WHERE plan_id=$1 AND due_at=$2 AND run_id=$3 AND outcome='queued')::int AS occurrences,(SELECT count(*) FROM runs WHERE plan_id=$1)::int AS runs,(SELECT count(*) FROM runs WHERE idempotency_key=$4)::int AS keys,(SELECT count(*) FROM outbox WHERE run_id=$3)::int AS deliveries,(SELECT count(*) FROM audit_events WHERE subject_id=$3 AND actor='scheduler' AND action='backup.queued')::int AS audit",[planId,due,runId,key])).rows[0]
    expect(counts).toEqual({occurrences:1,runs:1,keys:1,deliveries:1,audit:1})
    const artifacts=(await metadata.query('SELECT id,object_key,size::text,sha256 FROM artifacts WHERE run_id=$1',[runId])).rows
    expect(artifacts.length).toBe(1);expect(artifacts[0].id).toBe(completed.artifact_id)
    const artifact=artifacts[0],size=Number(artifact.size);if(size<=0||size>16*1024*1024)throw new Error('Unexpected synthetic archive size.')
    const object=await s3.send(new GetObjectCommand({Bucket:'steelkeep-fixture',Key:artifact.object_key}),{abortSignal:AbortSignal.timeout(10000)})
    if(!object.Body)throw new Error('The scheduled backup archive is missing.')
    expect(object.ContentLength).toBe(size)
    const bytes=await object.Body.transformToByteArray();expect(bytes.length).toBe(size);expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);expect(Buffer.from(bytes.subarray(0,5)).toString()).toBe('PGDMP')
    expect(await totals()).toEqual(before)
    console.log(JSON.stringify({planId,runId,dueAt:due.toISOString(),timezone,schedulerOccurrence:'queued',uniqueJob:true,sha256Verified:true,elapsedMs:Date.now()-started}))
  }finally{
    try{
      let disabled=false
      for(let attempt=0;attempt<3&&!disabled;attempt++)try{await disable();disabled=true}catch{if(attempt===2)throw new Error('Could not confirm the dedicated plan is disabled. Operator review required; no other plan was changed.');await pause(500)}
    }finally{token='';s3.destroy();await metadata.end().catch(()=>{})}
  }
  // Preserve the paused plan, occurrence, scheduler audit, run and S3 object.
},145000)
