import {test,expect} from 'bun:test'
import {spawn} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {readFile,realpath,stat} from 'node:fs/promises'
import {resolve} from 'node:path'
import pg from 'pg'
import {S3Client,HeadBucketCommand,GetObjectCommand} from '@aws-sdk/client-s3'

// Explicit outage acceptance. No container creation/removal, restart of other
// services, bucket cleanup, metadata writes or uncertainty reconciliation.
const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-local-storage-retry'?test:test.skip
const workspace=resolve(import.meta.dir,'..'),metadataUrl='postgres://steelkeep:local-metadata-only@127.0.0.1:54371/steelkeep'
type Connection={id:string;name:string;kind:string;config:Record<string,unknown>}
type Job={id:string;status:string;phase:string;attempt:number;artifact_id:string|null;error_code:string|null;events?:Array<{phase:string}>}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))

acceptance('native S3 outage retries the same PostgreSQL job and publishes one verified artifact',async()=>{
  if(process.env.DATABASE_URL!==metadataUrl||process.env.STEELKEEP_DATABASE_PASSWORD_FILE||process.env.DOCKER_HOST||process.env.DOCKER_CONTEXT)throw new Error('Use the exact isolated metadata URL and unmodified local Unix Docker context.')
  let dockerContext='',containerId='',restoreRunning=false
  // Detached groups bound Docker CLI children as well as their parent. No shell.
  async function docker(args:string[],timeout=20000):Promise<string>{
    return new Promise((resolve,reject)=>{
      const child=spawn('docker',[...(dockerContext?['--context',dockerContext]:[]),...args],{cwd:workspace,detached:true,stdio:['ignore','pipe','pipe']})
      let output='',settled=false
      const kill=(signal:NodeJS.Signals)=>{if(child.pid)try{process.kill(-child.pid,signal)}catch{}}
      let hard:ReturnType<typeof setTimeout>|undefined
      const deadline=setTimeout(()=>{kill('SIGTERM');hard=setTimeout(()=>{kill('SIGKILL');finish(false)},1000)},timeout)
      function finish(ok:boolean){if(settled)return;settled=true;clearTimeout(deadline);clearTimeout(hard);kill('SIGKILL');ok?resolve(output.trim()):reject(new Error('The bounded fixture Docker command failed; CLI diagnostics withheld.'))}
      child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>256*1024){kill('SIGTERM');finish(false)}})
      child.stderr.on('data',()=>{}) // Never persist raw CLI environment diagnostics.
      child.on('error',()=>finish(false));child.on('close',code=>finish(code===0))
    })
  }
  const metadata=new pg.Client({connectionString:metadataUrl,connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000,options:'-c default_transaction_read_only=on'})
  metadata.on('error',()=>{})
  const s3=new S3Client({endpoint:'http://127.0.0.1:54373',region:'us-east-1',forcePathStyle:true,maxAttempts:1,credentials:{accessKeyId:'steelkeep-local',secretAccessKey:'local-s3-fixture-only'}})
  let token=''
  async function api<T>(path:string,body?:unknown):Promise<T>{
    try{
      const response=await fetch('http://127.0.0.1:4311/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)})
      if(!response.ok)throw new Error()
      const value=await response.json()
      if([token,'local-reader-only','local-s3-fixture-only'].some(secret=>secret&&JSON.stringify(value).includes(secret)))throw new Error()
      return value as T
    }catch{throw new Error('The fixed local acceptance API call failed or exposed a credential; response withheld.')}
  }
  const expectedImage=(await readFile(resolve(workspace,'compose.yaml'),'utf8')).match(/^  s3:\n    image: (rustfs\/rustfs:1\.0\.1@sha256:[a-f0-9]{64})$/m)?.[1]
  if(!expectedImage)throw new Error('The exact digest-pinned fixture RustFS image was not established.')
  async function inspect(){
    const rows=JSON.parse(await docker(['container','inspect',containerId])) as Array<{Id:string;Config:{Image:string;Labels:Record<string,string>};State:{Running:boolean};HostConfig:{PortBindings:Record<string,Array<{HostIp:string;HostPort:string}>>}}>
    const row=rows[0],labels=row?.Config.Labels
    if(rows.length!==1||row.Id!==containerId||row.Config.Image!==expectedImage||labels?.['com.docker.compose.project']!=='steelkeep'||labels['com.docker.compose.service']!=='s3'||await realpath(labels['com.docker.compose.project.working_dir']??'')!==await realpath(workspace))throw new Error('Refusing to control an unverified fixture S3 container.')
    const ports=row.HostConfig.PortBindings['9000/tcp']
    if(ports?.length!==1||ports[0].HostIp!=='127.0.0.1'||ports[0].HostPort!=='54373')throw new Error('The fixture S3 binding is not the dedicated loopback port.')
    return row
  }
  async function ready(){try{await s3.send(new HeadBucketCommand({Bucket:'steelkeep-fixture'}),{abortSignal:AbortSignal.timeout(2000)});return true}catch{return false}}
  async function totals(){
    const source=new pg.Client({host:'127.0.0.1',port:54372,database:'source',user:'backup_reader',password:'local-reader-only',connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000,options:'-c default_transaction_read_only=on'})
    source.on('error',()=>{})
    try{await source.connect();const row=(await source.query('SELECT count(*)::text AS count,sum(amount)::text AS total FROM entries')).rows[0];expect(row).toEqual({count:'1000',total:'625625.00'});return row}
    catch{throw new Error('The isolated source data evidence failed; credentials withheld.')}
    finally{await source.end().catch(()=>{})}
  }
  try{
    dockerContext=await docker(['context','show'])
    if(!/^[a-zA-Z0-9_.-]+$/.test(dockerContext))throw new Error('Invalid local Docker context.')
    const contexts=JSON.parse(await docker(['context','inspect',dockerContext])) as Array<{Endpoints:{docker:{Host:string}}}>
    const host=contexts[0]?.Endpoints.docker.Host
    // Bun on macOS cannot realpath a Unix socket; stat its absolute endpoint.
    if(contexts.length!==1||!host?.startsWith('unix:///')||!(await stat(host.slice(7))).isSocket())throw new Error('A local Unix Docker socket is required.')
    const ids=(await docker(['container','ls','--all','--filter','label=com.docker.compose.project=steelkeep','--filter','label=com.docker.compose.service=s3','--format','{{.ID}}','--no-trunc'])).split('\n').filter(Boolean)
    if(ids.length!==1||!/^[a-f0-9]{64}$/.test(ids[0]))throw new Error('Exactly one existing fixture S3 container is required.')
    containerId=ids[0];if(!(await inspect()).State.Running)throw new Error('The fixture S3 must initially be running.')
    await metadata.connect()
    const identity=(await metadata.query("SELECT current_database() AS name,current_user AS actor,current_setting('server_version_num')::int AS version")).rows[0]
    if(identity.name!=='steelkeep'||identity.actor!=='steelkeep'||Math.floor(Number(identity.version)/10000)!==17)throw new Error('Unexpected fixture metadata identity.')
    const idle=async()=>{const row=(await metadata.query("SELECT (SELECT count(*) FROM runs WHERE status IN ('queued','running','cancelling'))::int AS active,(SELECT count(*) FROM plans WHERE enabled AND cron IS NOT NULL)::int AS scheduled")).rows[0];if(row.active||row.scheduled)throw new Error('Outage acceptance requires no active jobs or enabled cron plans.')}
    await idle();token=(await readFile(resolve(workspace,'.steelkeep/token'),'utf8')).trim();if(token.length<32)throw new Error('Missing isolated installation token.')
    const connections=await api<Connection[]>('/connections'),hosts=new Set(['fixture','mysql-fixture','mysql8-fixture','mongodb-fixture','redis-fixture','clickhouse-fixture','mssql-fixture'])
    for(const {kind,config:c} of connections)if(kind==='s3'?c.endpoint!=='http://s3:9000':kind==='sqlite'?!String(c.path).startsWith('/var/lib/steelkeep-fixtures/sqlite/'):!hosts.has(String(c.host)))throw new Error('Foreign saved profiles prohibit a fixture outage.')
    const sources=connections.filter(c=>c.name==='Application · fixture'&&c.kind==='postgres'&&c.config.host==='fixture'&&c.config.port===5432&&c.config.database==='source'&&c.config.user==='backup_reader'&&c.config.tls===false&&c.config.restoreTarget===false)
    const storages=connections.filter(c=>c.name==='Local S3 · RustFS'&&c.kind==='s3'&&c.config.endpoint==='http://s3:9000'&&c.config.bucket==='steelkeep-fixture'&&c.config.region==='us-east-1'&&c.config.prefix==='steelkeep')
    const plans=(await api<Array<{id:string;name:string;source_id:string;storage_id:string;cron:string|null}>>('/plans')).filter(p=>p.name==='PostgreSQL fixture'&&p.source_id===sources[0]?.id&&p.storage_id===storages[0]?.id&&p.cron===null)
    if(sources.length!==1||storages.length!==1||plans.length!==1||!await ready())throw new Error('Exact public fixture source, storage, manual plan and healthy bucket are required.')
    const bound=(await metadata.query('SELECT source_id,storage_id FROM plans WHERE id=$1',[plans[0].id])).rows[0]
    if(bound?.source_id!==sources[0].id||bound.storage_id!==storages[0].id)throw new Error('The API does not match the guarded metadata installation.')
    const before=await totals(),key='storage-retry-'+randomUUID();await idle();await inspect()
    restoreRunning=true // Set before stop: timeout may mean its outcome is unknown.
    await docker(['container','stop','--time','5',containerId])
    if((await inspect()).State.Running||await ready())throw new Error('The scoped fixture S3 outage was not established.')
    const accepted=await api<Job>(`/plans/${plans[0].id}/run`,{idempotencyKey:key})
    let waiting:Job|undefined,deadline=Date.now()+60000
    while(Date.now()<deadline){const job=await api<Job>(`/jobs/${accepted.id}`);if(job.phase==='retry_wait'&&job.attempt===1){waiting=job;break}if(['failed','interrupted','cancelled','succeeded'].includes(job.status)||job.attempt>1)throw new Error('The first transient attempt did not expose its expected retry wait.');await pause(200)}
    if(!waiting)throw new Error('No bounded first-attempt retry observation; retained for inspection.')
    expect(waiting.status).toBe('queued');expect(waiting.error_code).toBe('STORAGE_UNAVAILABLE');expect(waiting.artifact_id).toBeNull()
    expect(waiting.events?.some(event=>event.phase==='dumping')).toBe(true);expect(waiting.events?.some(event=>event.phase==='uploading')).toBe(true)
    expect((await metadata.query('SELECT count(*)::int AS count FROM artifacts WHERE run_id=$1',[accepted.id])).rows[0].count).toBe(0)
    await inspect();await docker(['container','start',containerId]);deadline=Date.now()+25000
    while(!await ready()){if(Date.now()>deadline)throw new Error('The original S3 container did not become ready.');await pause(300)}
    let done:Job|undefined;deadline=Date.now()+90000
    while(Date.now()<deadline){const job=await api<Job>(`/jobs/${accepted.id}`);if(job.attempt>3)throw new Error('Backup exceeded the retry cap.');if(['succeeded','failed','interrupted','cancelled'].includes(job.status)){done=job;break}await pause(300)}
    if(!done)throw new Error('Retry did not finish within 90 seconds; no unknown state was cleared.')
    expect(done.status).toBe('succeeded');expect([2,3].includes(done.attempt)).toBe(true);expect(done.error_code).toBeNull()
    expect(done.events?.some(event=>event.phase==='retry_wait')).toBe(true)
    expect((await api<Job>(`/plans/${plans[0].id}/run`,{idempotencyKey:key})).id).toBe(accepted.id)
    const rows=(await metadata.query('SELECT id,object_key,size::text,sha256 FROM artifacts WHERE run_id=$1',[accepted.id])).rows
    expect(rows.length).toBe(1);expect(rows[0].id).toBe(done.artifact_id)
    const size=Number(rows[0].size);if(size<=0||size>16*1024*1024)throw new Error('Unexpected synthetic archive size.')
    const object=await s3.send(new GetObjectCommand({Bucket:'steelkeep-fixture',Key:rows[0].object_key}),{abortSignal:AbortSignal.timeout(15000)})
    if(!object.Body)throw new Error('The successful retry archive is missing.')
    expect(object.ContentLength).toBe(size)
    const bytes=await object.Body.transformToByteArray();expect(bytes.length).toBe(size);expect(createHash('sha256').update(bytes).digest('hex')).toBe(rows[0].sha256);expect(Buffer.from(bytes.subarray(0,5)).toString()).toBe('PGDMP')
    expect((await metadata.query('SELECT count(*)::int AS count FROM runs WHERE idempotency_key=$1',[key])).rows[0].count).toBe(1)
    expect(await totals()).toEqual(before)
    console.log(JSON.stringify({jobId:done.id,attempts:done.attempt,firstAttempt:'STORAGE_UNAVAILABLE/retry_wait',artifactId:done.artifact_id,archiveBytes:size,sha256Verified:true}))
  }finally{
    try{if(restoreRunning){await inspect();await docker(['container','start',containerId]);const until=Date.now()+25000;while(!await ready()){if(Date.now()>until)throw new Error('Fixture S3 recovery needs operator attention.');await pause(300)}}}
    finally{token='';s3.destroy();await metadata.end().catch(()=>{})}
  }
},240000)
