import {test,expect} from 'bun:test'
import {randomBytes,randomUUID,createHash} from 'node:crypto'
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import pg from 'pg'
import {Kysely,PostgresDialect,sql} from 'kysely'
import {S3Client,CreateBucketCommand,HeadBucketCommand,PutObjectCommand,HeadObjectCommand,DeleteObjectCommand,ListObjectsV2Command,DeleteBucketCommand,GetObjectCommand} from '@aws-sdk/client-s3'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'
import type {Schema} from '../server/db'
import {Services} from '../server/services'
import {createApp} from '../server/app'
import {allScopes,validateScopedTokens,type Principal} from '../server/auth'
import {processRetentionJob,recoverRetentionClaims} from '../server/retention-worker'

const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-local-retention'?test:test.skip
acceptance('isolated retention: real conditional S3 deletion, restore pins, scopes, durable retry and tombstones',async()=>{
 if(await realpath(process.cwd())!=='/Users/dobrota/dev/steelkeep')throw new Error('Use the fixed Steelkeep checkout.')
 const target=new URL(process.env.DATABASE_URL??''),database='steelkeep_retention_test'
 if(target.hostname!=='127.0.0.1'||target.port!=='54371'||target.pathname!==`/${database}`||target.username!=='steelkeep'||target.search||target.hash)throw new Error('Require the new dedicated loopback steelkeep_retention_test database.')
 const accessKey=process.env.STEELKEEP_RETENTION_TEST_S3_ACCESS_KEY,secretKey=process.env.STEELKEEP_RETENTION_TEST_S3_SECRET_KEY
 if(!accessKey||!secretKey)throw new Error('Provide only the explicit local synthetic RustFS fixture credentials.')
 const saved=Object.fromEntries(['STEELKEEP_KEY_FILE','STEELKEEP_TOKEN_FILE','STEELKEEP_ALLOWED_HOSTS','STEELKEEP_ALLOWED_ORIGINS','STEELKEEP_SCOPED_TOKENS_FILE'].map(key=>[key,process.env[key]]))
 const directory=await mkdtemp(join(tmpdir(),'steelkeep-retention-')),nonce=randomBytes(10).toString('hex'),bucket='steelkeep-retention-proof-'+nonce,prefix='retention-proof/'+nonce,token=randomBytes(32).toString('hex')
 const application='steelkeep-retention-'+nonce.slice(0,12),epoch=randomUUID(),nextEpoch=randomUUID()
 const adminUrl=new URL(target);adminUrl.pathname='/postgres'
 const admin=new pg.Client({connectionString:adminUrl.toString(),connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000}),holder=new pg.Client({connectionString:target.toString(),connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000})
 const pool=new pg.Pool({connectionString:target.toString(),max:4,application_name:application,connectionTimeoutMillis:5000,statement_timeout:30000,query_timeout:35000}),db=new Kysely<Schema>({dialect:new PostgresDialect({pool})}),service=new Services(db)
 const s3=new S3Client({endpoint:'http://127.0.0.1:54373',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:accessKey,secretAccessKey:secretKey},maxAttempts:1})
 const owner:Principal={actor:'installation-owner',scopes:allScopes},connections=new Set<string>(),plans=new Set<string>(),runs=new Set<string>(),artifacts=new Set<string>(),intents=new Set<string>(),agents=new Set<string>(),keys=new Set<string>()
 let created=false,createdOid:number|undefined,holderConnected=false,bucketCreated=false,held=false,pending:Promise<unknown>|undefined,faults:ReturnType<typeof Bun.serve>|undefined
 let sourceId='',storageId='',planId=''
 const emptyPublicTables=async()=>{
  const tables=await holder.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'steelkeep_migrations'")
  for(const {tablename}of tables.rows){if(!/^[a-z_]+$/.test(tablename))throw new Error('Unexpected dedicated schema name.');const row=await holder.query<{n:number}>(`SELECT count(*)::int AS n FROM "${tablename}"`);if(row.rows[0].n!==0)throw new Error('Unexpected retained application data in the dedicated retention database.')}
 }
 async function waitFor(read:()=>Promise<boolean>){const deadline=Date.now()+5000;while(Date.now()<deadline){if(await read())return;await Bun.sleep(5)}throw new Error('Expected dedicated metadata lock barrier was not observed.')}
 const addConnection=async(input:Parameters<Services['createConnection']>[0])=>{const result=await service.createConnection(input);connections.add(result.id);return result.id}
 async function published(label:string,storage=storageId,plan=planId,object=true){
  const id=randomUUID(),runId=randomUUID(),execution=randomUUID(),body=Buffer.from('Synthetic retention proof '+nonce+' '+label),sha256=createHash('sha256').update(body).digest('hex'),key=prefix+'/'+runId+'/'+execution+'/'+id+'.dump',born=new Date(Date.now()-40*86400000)
  artifacts.add(id);runs.add(runId)
  await db.insertInto('runs').values({id:runId,plan_id:plan,type:'backup',status:'succeeded',phase:'completed',idempotency_key:randomUUID(),source_id:sourceId,storage_id:storage,target_id:null,artifact_id:id,created_at:born,started_at:born,finished_at:born,heartbeat_at:null,error_code:null,error_message:null,validation:null,cancel_requested:false,attempt:1,execution_token:execution,review_fingerprint:null}).execute()
  if(object){await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:body,ContentLength:body.length,IfNoneMatch:'*',Metadata:{sha256,engine:'postgres'}}));keys.add(key)}
  await db.insertInto('artifacts').values({id,run_id:runId,source_id:sourceId,storage_id:storage,object_key:key,size:String(body.length),sha256,engine:'postgres',server_version:'synthetic',tool_version:'synthetic-no-native-tools',created_at:born,availability:'present',checked_at:born,manifest:{format:1,engine:'postgres',database:'synthetic_retention_source',serverVersion:'synthetic',objects:{},data:{},sequences:{}}}).execute()
  return {id,key,body,sha256}
 }
 async function review(artifactId:string,targetId:string,executor?:pg.Client){
  const id=randomUUID();intents.add(id)
  const query=`INSERT INTO restore_intents(id,actor,artifact_id,target_id,review,fingerprint,expires_at,consumed_run_id,idempotency_key) VALUES($1,'synthetic-retention-proof',$2,$3,'{}','synthetic-review',clock_timestamp()+interval '1 hour',NULL,NULL)`
  if(executor)await executor.query(query,[id,artifactId,targetId]);else await holder.query(query,[id,artifactId,targetId]);return id
 }
 async function restorePin(artifactId:string,status:string,validation:Record<string,unknown>|null,reserved:boolean,targetId:string){
  const id=randomUUID();runs.add(id)
  await db.insertInto('runs').values({id,plan_id:null,type:'restore',status,phase:status,idempotency_key:randomUUID(),source_id:sourceId,storage_id:storageId,target_id:targetId,artifact_id:artifactId,started_at:null,finished_at:status==='running'?null:new Date(),heartbeat_at:null,error_code:null,error_message:null,validation,cancel_requested:false,attempt:1,execution_token:randomUUID(),review_fingerprint:'synthetic'}).execute()
  if(reserved)await db.insertInto('target_blocks').values({target_id:targetId,resource_key:'postgres:target_'+targetId,run_id:id,reason:'Synthetic retention pin proof'}).execute()
  return id
 }
 try{
  await writeFile(join(directory,'key'),randomBytes(32),{mode:0o600});await writeFile(join(directory,'token'),token,{mode:0o600})
  process.env.STEELKEEP_KEY_FILE=join(directory,'key');process.env.STEELKEEP_TOKEN_FILE=join(directory,'token');process.env.STEELKEEP_ALLOWED_HOSTS='127.0.0.1';process.env.STEELKEEP_ALLOWED_ORIGINS='http://localhost';delete process.env.STEELKEEP_SCOPED_TOKENS_FILE
  await admin.connect()
  if((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount)throw new Error('Dedicated retention database already exists; preserve it for explicit inspection.')
  await admin.query('CREATE DATABASE steelkeep_retention_test');created=true;createdOid=(await admin.query<{oid:number}>('SELECT oid FROM pg_database WHERE datname=$1',[database])).rows[0].oid
  const migration=Bun.spawn([process.execPath,'server/migrate.ts'],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:target.toString(),STEELKEEP_DATABASE_PASSWORD_FILE:''},stdout:'ignore',stderr:'ignore',timeout:15000});if(await migration.exited!==0)throw new Error('Dedicated retention migration failed; diagnostics withheld.')
  await holder.connect();holderConnected=true;await emptyPublicTables()
  expect((await holder.query<{v:number}>('SELECT max(version)::int AS v FROM steelkeep_migrations')).rows[0].v).toBe(8)
  try{await s3.send(new HeadBucketCommand({Bucket:bucket}));throw new Error('Unexpected existing nonce bucket.')}catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==404)throw new Error('The new nonce bucket absence guard failed.')}
  await s3.send(new CreateBucketCommand({Bucket:bucket}));bucketCreated=true
  const canary=prefix+'/conditional-canary';await s3.send(new PutObjectCommand({Bucket:bucket,Key:canary,Body:'synthetic conditional canary',IfNoneMatch:'*'}));keys.add(canary)
  let mismatch=0;try{await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:canary,IfMatch:'"mismatch-'+nonce+'"'}))}catch(error){mismatch=(error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode??0}
  expect(mismatch).toBe(412);expect((await s3.send(new HeadObjectCommand({Bucket:bucket,Key:canary}))).ContentLength).toBeGreaterThan(0)
  sourceId=await addConnection({name:'Retention proof source '+nonce,kind:'postgres',host:'127.0.0.1',port:1,database:'synthetic_retention_source',user:'synthetic_reader',password:'synthetic-not-used',tls:false})
  storageId=await addConnection({name:'Retention proof storage '+nonce,kind:'s3',endpoint:'http://127.0.0.1:54373',bucket,region:'us-east-1',prefix,accessKey,secretKey})
  planId=(await service.createPlan({name:'Retention proof plan '+nonce,sourceId,storageId,timezone:'UTC'})).id;plans.add(planId)
  await db.insertInto('worker_state').values({singleton:true,epoch}).execute()
  const plain=await published('delete'),locked=await published('locked'),reviewed=await published('reviewed'),active=await published('active'),uncertain=await published('uncertain'),validated=await published('validated'),changed=await published('changed')
  await service.retention.lock(owner,locked.id,true)
  const makeTarget=()=>addConnection({name:'Retention proof target '+nonce,kind:'postgres',host:'127.0.0.1',port:1,database:'target_'+randomBytes(6).toString('hex'),user:'synthetic_writer',password:'synthetic-not-used',restoreTarget:true,tls:false})
  const reviewTarget=await makeTarget();await review(reviewed.id,reviewTarget)
  await restorePin(active.id,'running',null,false,await makeTarget());await restorePin(uncertain.id,'interrupted',null,true,await makeTarget());const validatedTarget=await makeTarget();await restorePin(validated.id,'succeeded',{status:'passed',passed:true},true,validatedTarget)
  const initial=(await service.plans())[0].retention;expect(initial.policy).toEqual({mode:'keep_all'});expect(initial.enabled).toBe(false)
  expect((await service.retention.preview(planId)).candidateCount).toBe(0);expect(await processRetentionJob(db,epoch,new AbortController().signal)).toBe(false)
  const policy={mode:'days' as const,days:14},preview=await service.retention.preview(planId,policy)
  expect(preview.candidateCount).toBe(3);expect(preview.protectedCount).toBe(4);expect(preview.candidates.map(row=>row.id).sort()).toEqual([plain.id,validated.id,changed.id].sort())
  expect(preview.protected.map(row=>String(row.reason)).sort()).toEqual(['locked','restore_review','restore_active','restore_uncertain'].sort())
  const agent=await service.agents.create(owner,{name:'Retention proof delegated '+nonce});agents.add(agent.id)
  const configure=await service.agents.issue(owner,agent.id,{name:'configure only',scopes:['read','configure']}),delegated=await service.agents.issue(owner,agent.id,{name:'explicit cleanup delegation',scopes:['read','configure','backup:delete']})
  const app=createApp(service),request=(path:string,body:unknown,method='POST',bearer=delegated.token)=>app.handle(new Request('http://localhost/api/v1'+path,{method,headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},body:JSON.stringify(body)}))
  expect((await request(`/plans/${planId}/retention`,{policy,enabled:true,revision:1,confirmDeletion:true},'PATCH',configure.token)).status).toBe(403)
  expect((await request(`/plans/${planId}/retention`,{policy,enabled:true,revision:1},'PATCH')).status).toBe(409)
  const enabled=await request(`/plans/${planId}/retention`,{policy,enabled:true,revision:1,confirmDeletion:true},'PATCH');expect(enabled.status).toBe(200);expect((await enabled.json()).revision).toBe(2)
  expect((await service.authenticate(new Request('http://localhost',{headers:{authorization:'Bearer '+configure.token}}))).scopes).toEqual(['read','configure'])
  const queueKey=randomUUID(),queueBody={revision:2,idempotencyKey:queueKey},queued=await request(`/plans/${planId}/retention/run`,queueBody);expect(queued.status).toBe(202);const accepted=await queued.json();expect(accepted.queued).toBe(3)
  const replay=await request(`/plans/${planId}/retention/run`,queueBody);expect(await replay.json()).toEqual(accepted)
  await expect(service.prepareRestore(plain.id,reviewTarget)).rejects.toMatchObject({code:'ARTIFACT_DELETION_RESERVED'})
  const changedBody=Buffer.from('Changed owned test object '+nonce),changedSha=createHash('sha256').update(changedBody).digest('hex')
  await s3.send(new PutObjectCommand({Bucket:bucket,Key:changed.key,Body:changedBody,ContentLength:changedBody.length,Metadata:{sha256:changedSha,engine:'postgres'}}))
  for(let i=0;i<3;i++)expect(await processRetentionJob(db,epoch,new AbortController().signal)).toBe(true)
  for(const candidate of [plain,validated]){
   const row=await db.selectFrom('artifacts').selectAll().where('id','=',candidate.id).executeTakeFirstOrThrow();expect(row.deletion_state).toBe('deleted');expect(row.deleted_at).not.toBeNull();expect(row.object_key).toBe(candidate.key)
   let status=0;try{await s3.send(new HeadObjectCommand({Bucket:bucket,Key:candidate.key}))}catch(error){status=(error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode??0}expect(status).toBe(404)
  }
  for(const candidate of [locked,reviewed,active,uncertain])expect((await s3.send(new HeadObjectCommand({Bucket:bucket,Key:candidate.key}))).Metadata?.sha256).toBe(candidate.sha256)
  expect((await db.selectFrom('target_blocks').select('run_id').where('target_id','=',validatedTarget).executeTakeFirst())).toBeDefined()
  const changedJob=await db.selectFrom('retention_jobs').selectAll().where('artifact_id','=',changed.id).executeTakeFirstOrThrow();expect(changedJob.status).toBe('held');expect(changedJob.error_code).toBe('RETENTION_OBJECT_CHANGED')
  expect(createHash('sha256').update(await (await s3.send(new GetObjectCommand({Bucket:bucket,Key:changed.key}))).Body!.transformToByteArray()).digest('hex')).toBe(changedSha)
  const mcp=new Client({name:'synthetic-retention-proof',version:'0.1.0'})
  try{
   await mcp.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),{requestInit:{headers:{authorization:'Bearer '+delegated.token}},fetch:async(input,init)=>app.handle(new Request(input,init))}))
   const tools=await mcp.listTools();expect(tools.tools.some(tool=>tool.name==='queue_retention_cleanup'&&tool.annotations?.destructiveHint===true)).toBe(true)
   const listed=await mcp.callTool({name:'list_retention_jobs',arguments:{}});expect(listed.isError).not.toBe(true)
   expect((listed.structuredContent as {data:unknown[]}).data.length).toBe(3)
   const overview=await mcp.callTool({name:'get_overview',arguments:{}});expect(overview.isError).not.toBe(true)
   const publicData=(overview.structuredContent as {data:{plans:Array<{retention:{revision:number}}> ;backups:Array<{deletion_state:string;retention_locked:boolean}>}}).data
   expect(publicData.plans[0].retention.revision).toBe(2)
   expect(publicData.backups.filter(backup=>backup.deletion_state==='deleted').length).toBe(2)
   expect(publicData.backups.some(backup=>backup.retention_locked)).toBe(true)
  }finally{await mcp.close()}
  await s3.send(new PutObjectCommand({Bucket:bucket,Key:changed.key,Body:changed.body,ContentLength:changed.body.length,Metadata:{sha256:changed.sha256,engine:'postgres'}}))
  const delegatedPrincipal=await service.authenticate(new Request('http://localhost',{headers:{authorization:'Bearer '+delegated.token}})),retryKey=randomUUID(),retry=await service.retention.retry(delegatedPrincipal,changedJob.id,retryKey)
  expect(retry.maxAttempts).toBe(changedJob.attempt+3);expect(await service.retention.retry(delegatedPrincipal,changedJob.id,retryKey)).toEqual(JSON.parse(JSON.stringify(retry)))
  expect(await processRetentionJob(db,epoch,new AbortController().signal)).toBe(true);expect((await db.selectFrom('artifacts').select('deletion_state').where('id','=',changed.id).executeTakeFirstOrThrow()).deletion_state).toBe('deleted')
  const raced=await published('review-race')
  await holder.query('BEGIN');held=true;await holder.query('SELECT id FROM artifacts WHERE id=$1 FOR UPDATE',[raced.id]);const holderPid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid
  pending=service.retention.queue(planId,2,randomUUID(),owner)
  await waitFor(async()=>{const row=await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND wait_event_type=$3 AND $4::int=ANY(pg_blocking_pids(pid))',[database,application,'Lock',holderPid]);return !!row.rowCount})
  await review(raced.id,reviewTarget,holder);await holder.query('COMMIT');held=false
  expect((await pending as {queued:number}).queued).toBe(0)
  const unstarted=await published('cancel-unstarted'),cancel=await service.retention.queue(planId,2,randomUUID(),owner);expect(cancel.queued).toBe(1)
  await service.retention.lock(owner,unstarted.id,true);expect((await db.selectFrom('retention_jobs').select('status').where('artifact_id','=',unstarted.id).executeTakeFirstOrThrow()).status).toBe('cancelled');expect((await db.selectFrom('artifacts').select('deletion_state').where('id','=',unstarted.id).executeTakeFirstOrThrow()).deletion_state).toBe('active')
  await service.retention.update(owner,planId,{policy,enabled:false,revision:2})
  let faultRequests=0
  faults=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>{faultRequests++;return new Response(request.method==='HEAD'?null:'untrusted upstream diagnostics',{status:503})}})
  const faultStorage=await addConnection({name:'Retention proof faults '+nonce,kind:'s3',endpoint:`http://127.0.0.1:${faults.port}`,bucket:'synthetic-fault-'+nonce,prefix,accessKey:'synthetic',secretKey:'synthetic'})
  const faultPlan=(await service.createPlan({name:'Retention proof fault plan '+nonce,sourceId,storageId:faultStorage,timezone:'UTC'})).id;plans.add(faultPlan)
  const faultArtifact=await published('fault',faultStorage,faultPlan,false)
  await service.retention.update(owner,faultPlan,{policy,enabled:true,revision:1,confirmDeletion:true});await service.retention.queue(faultPlan,2,randomUUID(),owner)
  for(let i=0;i<3;i++){await db.updateTable('retention_jobs').set({next_attempt_at:sql`clock_timestamp()`}).where('artifact_id','=',faultArtifact.id).execute();expect(await processRetentionJob(db,epoch,new AbortController().signal)).toBe(true)}
  const exhausted=await db.selectFrom('retention_jobs').selectAll().where('artifact_id','=',faultArtifact.id).executeTakeFirstOrThrow();expect(exhausted.status).toBe('held');expect(exhausted.attempt).toBe(3);expect(exhausted.error_message).not.toContain('untrusted upstream');expect(faultRequests).toBeGreaterThanOrEqual(3)
  await db.updateTable('retention_jobs').set({status:'deleting',attempt:1,execution_token:randomUUID(),worker_epoch:epoch,object_etag:'"synthetic-retained-etag"',object_version_id:'synthetic-retained-version'}).where('id','=',exhausted.id).execute()
  await db.transaction().execute(async trx=>{await trx.updateTable('worker_state').set({epoch:nextEpoch}).where('singleton','=',true).execute();await recoverRetentionClaims(trx,nextEpoch)})
  const recovered=await db.selectFrom('retention_jobs').selectAll().where('id','=',exhausted.id).executeTakeFirstOrThrow();expect(recovered.status).toBe('retry_wait');expect(recovered.execution_token).toBeNull();expect(recovered.object_etag).toBe('"synthetic-retained-etag"');expect(recovered.object_version_id).toBe('synthetic-retained-version')
  await expect(processRetentionJob(db,epoch,new AbortController().signal)).rejects.toMatchObject({code:'RETENTION_WORKER_FENCED'})
  const legacy=join(directory,'legacy.json');await writeFile(legacy,JSON.stringify([{token:randomBytes(32).toString('hex'),actor:'synthetic',scopes:['backup:delete']}]),{mode:0o600});process.env.STEELKEEP_SCOPED_TOKENS_FILE=legacy;expect(()=>validateScopedTokens()).toThrow();delete process.env.STEELKEEP_SCOPED_TOKENS_FILE
  console.info(JSON.stringify({proof:'retention',schema:8,conditionalMismatch:412,actualOwnedDeletes:3,protectedObjects:4,changedObject:'held-before-explicit-retry',reviewRace:'pinned-before-queue',validatedRestore:'does-not-pin-forever',tombstones:true,delegatedScopes:true,mcp:true,boundedRetryAttempts:3,epochRecovery:'metadata-fence-tested',nativeDatabaseContacts:0}))
 }finally{
  if(held){await holder.query('ROLLBACK');held=false}await pending;await faults?.stop(true)
  try{
   if(created&&holderConnected){
    for(const [table,ids]of [['connections',connections],['plans',plans],['runs',runs],['artifacts',artifacts],['restore_intents',intents],['agents',agents]] as const){const rows=await db.selectFrom(table).select('id').execute();if(rows.some(row=>!ids.has(row.id)))throw new Error('Unexpected dedicated fixture identity; preserve retention proof data.')}
    for(const table of ['retention_requests','retention_jobs','restore_intents','target_blocks','source_blocks','schedule_occurrences','events','outbox','artifacts','runs','plans','connections','agent_tokens','agents','audit_events','worker_state'] as const)await db.deleteFrom(table).execute()
    await emptyPublicTables()
   }
  }finally{await db.destroy();if(holderConnected)await holder.end()}
  try{if(created){const row=(await admin.query<{oid:number;clients:number}>('SELECT d.oid,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=d.datname) AS clients FROM pg_database d WHERE d.datname=$1',[database])).rows[0];if(!holderConnected||row.oid!==createdOid||row.clients!==0)throw new Error('Dedicated retention DB cleanup identity/client guard failed.');await admin.query('DROP DATABASE steelkeep_retention_test');expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount).toBe(0)}}finally{await admin.end()}
  try{if(bucketCreated){const contents=await s3.send(new ListObjectsV2Command({Bucket:bucket}));if(contents.IsTruncated||contents.Contents?.some(object=>!object.Key||!object.Key.startsWith(prefix+'/')||!keys.has(object.Key)))throw new Error('Foreign object in nonce proof bucket; preserve it.');for(const object of contents.Contents??[]){const head=await s3.send(new HeadObjectCommand({Bucket:bucket,Key:object.Key!}));await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:object.Key!,IfMatch:head.ETag}))}await s3.send(new DeleteBucketCommand({Bucket:bucket}))}}finally{s3.destroy();for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value}await rm(directory,{recursive:true,force:true})}
 }
},120000)
