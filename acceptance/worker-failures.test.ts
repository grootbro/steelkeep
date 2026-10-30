import {test,expect} from 'bun:test'
import {randomBytes,randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {readFile,realpath,lstat} from 'node:fs/promises'
import {basename,dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import pg from 'pg'

// Deliberately excluded from the default suite. Never accept a user-supplied URL/DSN.
const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-local-failures'?test:test.skip
const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const base='http://127.0.0.1:4311/api/v1'
const terminal=new Set(['succeeded','failed','cancelled','interrupted'])
type Job={id:string;type:string;status:string;phase:string;attempt:number;artifact_id:string|null;validation:Record<string,unknown>|null;error_code:string|null;events:Array<{phase:string}>}
type Connection={id:string;name:string;kind:string;config:Record<string,unknown>;blocked:boolean}
type Target={database:string;user:string;password:string;connectionId:string}
type Gate={client:pg.Client;pid:number;database:string;released:boolean}
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))

async function until<T>(label:string,read:()=>Promise<T>,accepted:(value:T)=>boolean,timeoutMs=45000):Promise<T>{
  const deadline=Date.now()+timeoutMs
  while(Date.now()<deadline){const value=await read();if(accepted(value))return value;await delay(150)}
  throw new Error(`Worker failure acceptance timed out: ${label}. No data or history was reset.`)
}

// Suppress raw driver errors: PostgreSQL errors can contain SQL/credential context.
async function query<T extends pg.QueryResultRow=pg.QueryResultRow>(client:pg.Client,text:string,values:unknown[]=[]):Promise<T[]>{
  try{return (await client.query<T>(text,values)).rows}
  catch{throw new Error('A fixed local fixture query failed; SQL and credentials are omitted.')}
}
async function connect(database:string,kind:'metadata'|'fixture',user?:string,password?:string){
  const client=new pg.Client({host:'127.0.0.1',port:kind==='metadata'?54371:54372,database,
    user:user??(kind==='metadata'?'steelkeep':'fixture_admin'),password:password??(kind==='metadata'?'local-metadata-only':'local-fixture-only'),
    connectionTimeoutMillis:5000,statement_timeout:15000,query_timeout:20000,application_name:'steelkeep-worker-failure-acceptance'})
  client.on('error',()=>{})
  try{await client.connect();return client}catch{await client.end().catch(()=>{});throw new Error('The exact loopback PostgreSQL fixture is unavailable; connection credentials are omitted.')}
}

async function command(args:string[],timeoutMs=30000){
  return new Promise<string>((resolve,reject)=>{
    // No shell, credential-bearing arguments, container logs, or inherited Compose files.
    const child=spawn('docker',args,{cwd:workspace,env:{PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','ignore']})
    let output='',settled=false
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(false)},timeoutMs)
    function finish(ok:boolean){if(settled)return;settled=true;clearTimeout(timer);ok?resolve(output.trim()):reject(new Error('A scoped local worker Docker command failed; raw command output is omitted.'))}
    child.stdout.on('data',(chunk:Buffer)=>{if(output.length+chunk.length>128*1024){child.kill('SIGKILL');finish(false)}else output+=chunk.toString('utf8')})
    child.once('error',()=>finish(false));child.once('close',code=>finish(code===0))
  })
}

acceptance('fixed local worker: queued/running cancellation, native dump/restore SIGKILL, restart quarantine and idempotency',async()=>{
  let metadata:pg.Client|undefined,admin:pg.Client|undefined,sourceClient:pg.Client|undefined,token='',dockerHost='',workerManaged=false,harnessLock=false
  const gates:Gate[]=[],ownedJobs:string[]=[],evidence:Array<{check:string;jobId:string;status:string;attempt:number}>=[]
  const suffix=randomBytes(6).toString('hex'),sourceDatabase='wf_src_'+suffix,sourceUser='wf_read_'+suffix,sourcePassword=randomBytes(24).toString('hex')
  const docker=(...args:string[])=>command(['--host',dockerHost,...args])
  const compose=(...args:string[])=>docker('compose','--file',join(workspace,'compose.yaml'),'--project-name','steelkeep','--profile','application',...args)
  async function rest<T>(path:string,body?:unknown,expected=200):Promise<T>{
    let response:Response
    try{response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20000)})}
    catch{throw new Error('The fixed loopback acceptance API is unavailable; request details are omitted.')}
    if(response.status!==expected)throw new Error(`Local worker acceptance API returned ${response.status}; expected ${expected}. No response body was printed.`)
    const value=await response.json() as T
    if(token&&JSON.stringify(value).includes(token))throw new Error('An API response exposed the installation credential.')
    return value
  }
  const job=(id:string)=>rest<Job>('/jobs/'+id)
  async function finished(id:string){return until('durable terminal outcome',()=>job(id),row=>terminal.has(row.status),90000)}
  async function workerId(){
    const id=await compose('ps','--all','--quiet','worker')
    if(!/^[a-f0-9]{12,64}$/.test(id))throw new Error('Expected exactly one existing steelkeep worker container.')
    const labels=JSON.parse(await docker('inspect','--format','{{json .Config.Labels}}',id)) as Record<string,string>
    if(labels['com.docker.compose.project']!=='steelkeep'||labels['com.docker.compose.service']!=='worker'||await realpath(labels['com.docker.compose.project.working_dir']??'/')!==await realpath(workspace))throw new Error('Worker container ownership does not match this exact local checkout.')
    // A merged/custom Compose stack could target other hosts; only this fixture file is accepted.
    if(labels['com.docker.compose.project.config_files']!==join(workspace,'compose.yaml'))throw new Error('Use the unmerged local fixture compose.yaml for worker failure acceptance.')
    return id
  }
  async function workerRunning(){return (await docker('inspect','--format','{{.State.Running}}',await workerId()))==='true'}
  async function epoch(){return (await query<{epoch:string}>(metadata!,'SELECT epoch FROM worker_state WHERE singleton=true'))[0]?.epoch}
  async function restart(){
    const previous=await epoch()
    await compose('up','-d','--no-deps','--no-build','--pull','never','worker')
    await until('worker running',workerRunning,Boolean)
    await until('new worker ownership epoch',epoch,value=>Boolean(value&&value!==previous))
  }
  async function stopWorker(){
    await workerId()
    await compose('stop','--timeout','20','worker')
    await until('only worker stopped',workerRunning,running=>!running)
  }
  async function killWorker(){
    await workerId()
    await compose('kill','--signal','SIGKILL','worker')
    await until('SIGKILL stopped worker',workerRunning,running=>!running)
  }
  async function reserveGate(database:string,catalog:'pg_description'|'pg_class'){
    if(database!==sourceDatabase&&!database.startsWith('wf_target_'+suffix+'_'))throw new Error('Catalog gates are restricted to databases generated by this run.')
    const client=await connect(database,'fixture'),gate:Gate={client,pid:0,database,released:false};gates.push(gate)
    gate.pid=Number((await query<{pid:number}>(client,'SELECT pg_backend_pid() AS pid'))[0].pid)
    await query(client,"SET idle_in_transaction_session_timeout='120s'")
    await query(client,'BEGIN')
    // Database-local catalogs only. Reads pass the restore gate; pg_dump's comment read waits.
    await query(client,catalog==='pg_description'?'LOCK TABLE pg_catalog.pg_description IN ACCESS EXCLUSIVE MODE':'LOCK TABLE pg_catalog.pg_class IN SHARE MODE')
    return gate
  }
  async function release(gate:Gate){
    if(gate.released)return;gate.released=true
    try{await query(gate.client,'ROLLBACK')}finally{await gate.client.end().catch(()=>{})}
  }
  async function nativeBlocked(gate:Gate,application:'pg_dump'|'pg_restore',user:string){
    const rows=await query<{n:number}>(admin!,`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND application_name=$3 AND wait_event_type='Lock' AND $4::int=ANY(pg_blocking_pids(pid))`,[gate.database,user,application,gate.pid])
    return rows[0].n===1
  }
  async function waitNative(id:string,gate:Gate,application:'pg_dump'|'pg_restore',user:string,phase:string){
    await until('actual native backend blocked by owned catalog gate',async()=>{
      const current=await job(id)
      if(terminal.has(current.status))throw new Error('The native operation ended before fault injection; no kill evidence was established.')
      return current.status==='running'&&current.phase===phase&&await nativeBlocked(gate,application,user)
    },Boolean)
  }
  async function nativeCount(database:string,user:string){return Number((await query<{n:number}>(admin!,"SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND application_name IN ('pg_dump','pg_restore')",[database,user]))[0].n)}
  async function noNative(database:string,user:string){await until('native database sessions ended',()=>nativeCount(database,user),n=>n===0,15000)}
  async function noPublishedArtifact(id:string){
    expect(Number((await query<{n:number}>(metadata!,'SELECT count(*)::int AS n FROM artifacts WHERE run_id=$1',[id]))[0].n)).toBe(0)
    expect((await job(id)).artifact_id).toBeNull()
  }
  async function remember(check:string,id:string,status:string,attempt:number){
    const row=await job(id);expect(row.status).toBe(status);expect(row.attempt).toBe(attempt)
    expect(row.events.some(event=>event.phase==='completed')).toBe(false)
    evidence.push({check,jobId:id,status:row.status,attempt:row.attempt})
  }
  async function run(planId:string,key=randomUUID()){
    const result=await rest<Job>('/plans/'+planId+'/run',{idempotencyKey:key},202);ownedJobs.push(result.id)
    return {result,key}
  }
  async function newTarget(index:number):Promise<Target>{
    const database='wf_target_'+suffix+'_'+index,user='wf_write_'+suffix+'_'+index,password=randomBytes(24).toString('hex')
    // Every interpolated identifier and password is generated locally from fixed prefixes/hex.
    await query(admin!,`CREATE ROLE ${user} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`)
    await query(admin!,`CREATE DATABASE ${database} OWNER ${user}`)
    const connection=await rest<{id:string}>('/connections',{name:'Worker failure target '+suffix+' '+index,kind:'postgres',host:'fixture',port:5432,database,user,password,tls:false,restoreTarget:true})
    return {database,user,password,connectionId:connection.id}
  }
  try{
    if(await realpath(workspace)!=='/Users/dobrota/dev/steelkeep')throw new Error('This destructive-to-worker acceptance is restricted to the exact Steelkeep checkout.')
    // Ambient DOCKER_HOST/DOCKER_CONTEXT cannot silently select a remote daemon.
    if(process.env.DOCKER_HOST||process.env.DOCKER_CONTEXT)throw new Error('Unset DOCKER_HOST and DOCKER_CONTEXT; only a verified local Unix-socket context is allowed.')
    const context=JSON.parse(await command(['context','inspect','--format','{{json .Endpoints.docker.Host}}'])) as unknown
    if(typeof context!=='string'||!context.startsWith('unix:///'))throw new Error('Worker failure acceptance requires a local Docker Unix socket.')
    // Bun on macOS cannot realpath a socket; resolve its parent and require a socket leaf.
    const requestedSocket=context.slice('unix://'.length)
    const socketPath=join(await realpath(dirname(requestedSocket)),basename(requestedSocket))
    if(!(await lstat(socketPath)).isSocket())throw new Error('The Docker endpoint is not a local Unix socket.')
    dockerHost='unix://'+socketPath
    if(!await workerRunning())throw new Error('Start the local worker first; this suite restores only an initially running worker.')
    token=(await readFile(join(workspace,'.steelkeep','token'),'utf8')).trim()
    if(token.length<32)throw new Error('Prepare the isolated fixture installation token before acceptance.')
    const me=await rest<{actor:string}>('/me')
    if(me.actor!=='installation-owner')throw new Error('Use the local fixture owner token; a delegated agent cannot operate the worker harness.')
    metadata=await connect('steelkeep','metadata');admin=await connect('source','fixture')
    const identity=(await query<{name:string;version:number}>(admin,"SELECT current_database() AS name,current_setting('server_version_num')::int AS version"))[0]
    if(identity.name!=='source'||identity.version<170000||identity.version>=180000)throw new Error('The fixed source fixture must be PostgreSQL 17.')
    const fixture=(await query<{n:number;total:string}>(admin,'SELECT count(*)::int AS n,sum(amount)::text AS total FROM public.entries'))[0]
    if(fixture.n!==1000||fixture.total!=='625625.00')throw new Error('The fixed PG fixture marker does not match; no worker control is allowed.')
    harnessLock=(await query<{held:boolean}>(metadata,'SELECT pg_try_advisory_lock(4356544) AS held'))[0].held
    if(!harnessLock)throw new Error('Another worker-failure harness is active.')
    if(Number((await query<{n:number}>(metadata,"SELECT count(*)::int AS n FROM runs WHERE status IN ('queued','running','cancelling')"))[0].n)!==0)throw new Error('Finish all existing jobs before interrupting the shared local worker.')
    if(Number((await query<{n:number}>(metadata,'SELECT count(*)::int AS n FROM plans WHERE enabled=true AND cron IS NOT NULL'))[0].n)!==0)throw new Error('This isolated harness requires no enabled scheduled plans; it does not disable them automatically.')
    const connections=await rest<Connection[]>('/connections')
    const storage=connections.find(connection=>connection.name==='Local S3 · RustFS'&&connection.kind==='s3'&&connection.config.endpoint==='http://s3:9000'&&connection.config.bucket==='steelkeep-fixture'&&connection.config.prefix==='steelkeep'&&connection.config.region==='us-east-1')
    if(!storage)throw new Error('Seed the exact local RustFS fixture; arbitrary storage connections are forbidden.')
    workerManaged=true
    await query(admin,`CREATE ROLE ${sourceUser} LOGIN PASSWORD '${sourcePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`)
    await query(admin,`CREATE DATABASE ${sourceDatabase} OWNER ${sourceUser}`)
    sourceClient=await connect(sourceDatabase,'fixture',sourceUser,sourcePassword)
    await query(sourceClient,'CREATE TABLE public.entries(id integer PRIMARY KEY,body text NOT NULL)')
    await query(sourceClient,"INSERT INTO public.entries SELECT n, 'Worker failure synthetic row '||n FROM generate_series(1,1000) n")
    const source=await rest<{id:string}>('/connections',{name:'Worker failure source '+suffix,kind:'postgres',host:'fixture',port:5432,database:sourceDatabase,user:sourceUser,password:sourcePassword,tls:false,restoreTarget:false})
    const plan=await rest<{id:string}>('/plans',{name:'Worker failure plan '+suffix,sourceId:source.id,storageId:storage.id,cron:null,timezone:'UTC'})

    // Cancellation before native execution: both concurrent admissions must name one durable run.
    await stopWorker()
    const queuedKey=randomUUID(),queued=await run(plan.id,queuedKey)
    const duplicates=await Promise.all([rest<Job>('/plans/'+plan.id+'/run',{idempotencyKey:queuedKey},202),rest<Job>('/plans/'+plan.id+'/run',{idempotencyKey:queuedKey},202)])
    for(const duplicate of duplicates)expect(duplicate.id).toBe(queued.result.id)
    expect(queued.result.status).toBe('queued');expect(queued.result.attempt).toBe(0)
    expect((await rest<Job>('/jobs/'+queued.result.id+'/cancel',{})).status).toBe('cancelled')
    await restart()
    await remember('queued cancellation survives restart',queued.result.id,'cancelled',0)
    await noPublishedArtifact(queued.result.id)

    // Real artifact for the restore fault. This executes the normal native/S3 pipeline.
    const successful=await run(plan.id),artifactRun=await finished(successful.result.id)
    expect(artifactRun.status).toBe('succeeded')
    if(!artifactRun.artifact_id)throw new Error('A real native fixture artifact is required before restore fault injection.')

    // pg_description is not read by Steelkeep's manifest, but pg_dump must read comments.
    const cancellationGate=await reserveGate(sourceDatabase,'pg_description')
    const running=await run(plan.id)
    await waitNative(running.result.id,cancellationGate,'pg_dump',sourceUser,'dumping')
    const cancellation=await rest<Job>('/jobs/'+running.result.id+'/cancel',{})
    expect(['cancelling','cancelled']).toContain(cancellation.status)
    expect((await finished(running.result.id)).status).toBe('cancelled')
    await release(cancellationGate);await noNative(sourceDatabase,sourceUser)
    await remember('running native dump cancelled',running.result.id,'cancelled',1)
    await noPublishedArtifact(running.result.id)

    const dumpGate=await reserveGate(sourceDatabase,'pg_description'),killed=await run(plan.id)
    await waitNative(killed.result.id,dumpGate,'pg_dump',sourceUser,'dumping')
    await killWorker()
    // Release only this run's gate; a disconnected backend can then observe connection closure.
    await release(dumpGate);await noNative(sourceDatabase,sourceUser)
    await restart()
    expect((await finished(killed.result.id)).error_code).toBe('WORKER_INTERRUPTED')
    await remember('SIGKILL native dump quarantined',killed.result.id,'interrupted',1)
    await noPublishedArtifact(killed.result.id)
    expect((await rest<Job>('/plans/'+plan.id+'/run',{idempotencyKey:killed.key},202)).id).toBe(killed.result.id)

    // SHARE on target-local pg_class allows preflight SELECTs, blocks native CREATE TABLE.
    const target=await newTarget(1),restoreGate=await reserveGate(target.database,'pg_class')
    const review=await rest<{intentId:string}>('/restores/prepare',{artifactId:artifactRun.artifact_id,targetId:target.connectionId})
    const restoreKey=randomUUID(),restoring=await rest<Job>('/restores/start',{intentId:review.intentId,idempotencyKey:restoreKey},202);ownedJobs.push(restoring.id)
    expect((await rest<Job>('/restores/start',{intentId:review.intentId,idempotencyKey:restoreKey},202)).id).toBe(restoring.id)
    await waitNative(restoring.id,restoreGate,'pg_restore',target.user,'restoring')
    await killWorker();await release(restoreGate);await noNative(target.database,target.user)
    await restart()
    expect((await finished(restoring.id)).error_code).toBe('WORKER_INTERRUPTED')
    await remember('SIGKILL native restore quarantined',restoring.id,'interrupted',1)
    expect((await job(restoring.id)).validation?.status).not.toBe('passed')
    expect((await rest<Job>('/restores/start',{intentId:review.intentId,idempotencyKey:restoreKey},202)).id).toBe(restoring.id)
    const denied=await rest<{error:{code:string}}>('/restores/prepare',{artifactId:artifactRun.artifact_id,targetId:target.connectionId},409)
    expect(denied.error.code).toBe('TARGET_BLOCKED')
    expect((await rest<Connection[]>('/connections')).find(row=>row.id===target.connectionId)?.blocked).toBe(true)
    expect((await query<{run_id:string}>(metadata,'SELECT run_id FROM target_blocks WHERE target_id=$1',[target.connectionId]))[0]?.run_id).toBe(restoring.id)

    // Another ownership transfer plus > the initial 10s retry delay, without editing queue rows.
    await stopWorker();await restart()
    const observationDeadline=Date.now()+12000
    while(Date.now()<observationDeadline){
      const current=await job(restoring.id),dump=await job(killed.result.id),cancelled=await job(queued.result.id)
      expect(current.status).toBe('interrupted');expect(current.attempt).toBe(1)
      expect(dump.status).toBe('interrupted');expect(dump.attempt).toBe(1)
      expect(cancelled.status).toBe('cancelled');expect(cancelled.attempt).toBe(0)
      expect(await nativeCount(target.database,target.user)).toBe(0)
      expect(await nativeCount(sourceDatabase,sourceUser)).toBe(0)
      await delay(250)
    }
    for(const id of [queued.result.id,running.result.id,killed.result.id,restoring.id]){
      expect(Number((await query<{n:number}>(metadata,'SELECT count(*)::int AS n FROM runs WHERE idempotency_key=(SELECT idempotency_key FROM runs WHERE id=$1)',[id]))[0].n)).toBe(1)
    }
    await noPublishedArtifact(killed.result.id)
    expect(Number((await query<{n:number}>(sourceClient,'SELECT count(*)::int AS n FROM public.entries'))[0].n)).toBe(1000)
    const targetClient=await connect(target.database,'fixture',target.user,target.password)
    try{expect(Number((await query<{n:number}>(targetClient,"SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m')"))[0].n)).toBe(0)}finally{await targetClient.end()}
    console.info(JSON.stringify({suite:'synthetic-local-worker-failures',sourceDatabase,targetDatabase:target.database,artifactRunId:artifactRun.id,checks:evidence,observationSeconds:12,retained:'All databases, roles, artifacts and operation history are retained.'}))
  }finally{
    // Best-effort cancellation affects only jobs this invocation created. Never alter queue rows.
    if(token)for(const id of ownedJobs){try{const current=await job(id);if(['queued','running','cancelling'].includes(current.status))await rest('/jobs/'+id+'/cancel',{})}catch{}}
    for(const gate of gates)await release(gate).catch(()=>{})
    let cleanupFailed=false
    if(workerManaged){
      try{if(!await workerRunning())await restart()}
      catch{cleanupFailed=true}
    }
    await sourceClient?.end().catch(()=>{});await admin?.end().catch(()=>{})
    if(harnessLock&&metadata)await query(metadata,'SELECT pg_advisory_unlock(4356544)').catch(()=>{})
    await metadata?.end().catch(()=>{})
    if(cleanupFailed)throw new Error('Acceptance cleanup could not restore the initially running local worker. Start only the steelkeep worker; all fixture data and history remain retained.')
  }
},360000)
