import {test,expect} from 'bun:test'
import {randomBytes,randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm,realpath,lstat,readFile,chmod} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import pg from 'pg'
import {Kysely,PostgresDialect,sql} from 'kysely'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'
import type {Schema} from '../server/db'
import {Services} from '../server/services'
import {HistoryServices} from '../server/history'
import {createApp} from '../server/app'
import {allScopes,type Principal} from '../server/auth'

const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-server-comments'?test:test.skip
acceptance('snapshot notes persist with CAS across REST/MCP/history while preserving tombstones and recovery state',async()=>{
 if(process.platform!=='linux'||process.env.STEELKEEP_SERVER_PROOF_ROOT!=='/work'||await realpath(process.cwd())!=='/work')throw new Error('Comments proof runs only in the explicitly authorized isolated Linux server stand at /work.')
 async function privateFile(path:string){const file=await lstat(path);if(!file.isFile()||(file.mode&0o777)!==0o600||file.uid!==process.getuid?.())throw new Error('Proof capability files must be regular0600 files owned by the current proof user.');return readFile(path,'utf8')}
 const nonce=(await privateFile('/run/steelkeep/proof-nonce')).trim(),password=(await privateFile('/run/steelkeep/metadata-password')).trim()
 if(!/^[a-f0-9]{64}$/.test(nonce)||!password)throw new Error('The server proof capability is invalid.')
 const database='steelkeep_comments_test',controlUrl=new URL('postgresql://steelkeep@metadata:5432/steelkeep_platform_proof');controlUrl.password=password
 const target=new URL(controlUrl);target.pathname='/'+database
 const options={connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000},admin=new pg.Client({connectionString:controlUrl.toString(),...options}),db=new Kysely<Schema>({dialect:new PostgresDialect({pool:new pg.Pool({connectionString:target.toString(),max:4,...options})})}),services=new Services(db)
 const saved=Object.fromEntries(['STEELKEEP_KEY_FILE','STEELKEEP_TOKEN_FILE','STEELKEEP_ALLOWED_HOSTS','STEELKEEP_ALLOWED_ORIGINS','STEELKEEP_SCOPED_TOKENS_FILE'].map(key=>[key,process.env[key]]))
 const owner:Principal={actor:'installation-owner',scopes:allScopes},connectionIds=new Set<string>(),runIds=new Set<string>(),artifactIds=new Set<string>(),agentIds=new Set<string>(),intentIds=new Set<string>()
 let created=false,oid:number|undefined,directory:string|undefined,emptyVerified=false
 async function artifact(source:string,storage:string,deletion:'active'|'deleted'='active',old=false){
  const id=randomUUID(),runId=randomUUID();artifactIds.add(id);runIds.add(runId)
  await db.insertInto('runs').values({id:runId,plan_id:null,type:'backup',status:'succeeded',phase:'completed',idempotency_key:randomUUID(),source_id:source,storage_id:storage,target_id:null,artifact_id:id,started_at:null,finished_at:null,heartbeat_at:null,error_code:null,error_message:null,validation:null,cancel_requested:false,attempt:1,execution_token:null,review_fingerprint:null}).execute()
  await db.insertInto('artifacts').values({id,run_id:runId,source_id:source,storage_id:storage,object_key:'synthetic-never-uploaded/'+nonce+'/'+id,size:'128',sha256:'a'.repeat(64),engine:'postgres',server_version:'synthetic',tool_version:'metadata-only',created_at:old?new Date('2020-01-01T00:00:00Z'):new Date(),availability:'unknown',checked_at:null,retention_locked:deletion==='active',deletion_state:deletion,deleted_at:deletion==='deleted'?new Date():null}).execute();return id
 }
 try{
  await admin.connect()
  const control=(await admin.query<{database:string;role:string}>('SELECT current_database() AS database,current_user AS role')).rows[0]
  if(control.database!=='steelkeep_platform_proof'||control.role!=='steelkeep')throw new Error('Unexpected proof control database identity.')
  const marker=await admin.query<{singleton:boolean;nonce:string}>('SELECT singleton,nonce FROM steelkeep_platform_proof_identity')
  if(marker.rowCount!==1||marker.rows[0].singleton!==true||marker.rows[0].nonce!==nonce)throw new Error('Control database capability marker does not match this private stand.')
  if((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount)throw new Error('Dedicated comments database already exists; retain it for explicit inspection.')
  await admin.query('CREATE DATABASE steelkeep_comments_test');created=true;oid=(await admin.query<{oid:number}>('SELECT oid FROM pg_database WHERE datname=$1',[database])).rows[0].oid
  directory=await mkdtemp(join(tmpdir(),'steelkeep-comments-'));await chmod(directory,0o700)
  await writeFile(join(directory,'key'),randomBytes(32),{mode:0o600});await writeFile(join(directory,'token'),randomBytes(32).toString('hex'),{mode:0o600})
  process.env.STEELKEEP_KEY_FILE=join(directory,'key');process.env.STEELKEEP_TOKEN_FILE=join(directory,'token');process.env.STEELKEEP_ALLOWED_HOSTS='metadata';process.env.STEELKEEP_ALLOWED_ORIGINS='http://localhost';delete process.env.STEELKEEP_SCOPED_TOKENS_FILE
  const migration=Bun.spawn([process.execPath,'server/migrate.ts'],{cwd:'/work',env:{...process.env,DATABASE_URL:target.toString(),STEELKEEP_DATABASE_PASSWORD_FILE:''},stdout:'ignore',stderr:'ignore',timeout:15000});if(await migration.exited!==0)throw new Error('Dedicated comments migration failed; raw diagnostics withheld.')
  expect((await sql<{version:number}>`SELECT version FROM steelkeep_migrations WHERE version=10`.execute(db)).rows).toEqual([{version:10}])
  const source=randomUUID(),storage=randomUUID(),targetId=randomUUID();for(const id of [source,storage,targetId])connectionIds.add(id)
  await db.insertInto('connections').values([{id:source,name:'Synthetic notes source',kind:'postgres',config:{database:'notes_source',restoreTarget:false},secret:'SYNTHETIC_NEVER_DECRYPTED_'+nonce,check_status:'untested',checked_at:null},{id:storage,name:'Synthetic notes storage',kind:'s3',config:{endpoint:'https://never-contact.invalid',bucket:'synthetic'},secret:'SYNTHETIC_NEVER_DECRYPTED_'+nonce,check_status:'untested',checked_at:null},{id:targetId,name:'Synthetic notes target',kind:'postgres',config:{database:'notes_target',restoreTarget:true},secret:'SYNTHETIC_NEVER_DECRYPTED_'+nonce,check_status:'untested',checked_at:null}]).execute()
  const active=await artifact(source,storage,'active',true),deleted=await artifact(source,storage,'deleted')
  for(let i=0;i<101;i++)await artifact(source,storage)
  const before=await db.selectFrom('artifacts').selectAll().where('id','=',active).executeTakeFirstOrThrow(),empty=await services.artifactComments.get(owner,active)
  expect(empty).toMatchObject({id:active,comment:null,comment_revision:1,commented_at:null})
  const body='Before upgrade\n<script>literal text</script>',savedNote=await services.artifactComments.update(owner,active,{revision:1,comment:'  '+body+'  '})
  expect(savedNote.comment).toBe(body);expect(savedNote.comment_revision).toBe(2);expect(savedNote.commented_at).toBeInstanceOf(Date)
  const unchanged=await services.artifactComments.update(owner,active,{revision:2,comment:body});expect(unchanged).toEqual(savedNote)
  await expect(services.artifactComments.update(owner,active,{revision:1,comment:'stale writer'})).rejects.toMatchObject({code:'REVISION_CONFLICT'})
  const auditRows=await db.selectFrom('audit_events').selectAll().where('action','=','backup.comment.updated').execute();expect(auditRows.length).toBe(1);expect(auditRows[0].actor).toBe(owner.actor);expect(auditRows[0].subject_id).toBe(active);expect(auditRows[0].created_at).toBeInstanceOf(Date);expect(JSON.stringify(auditRows)).not.toContain(body)
  const after=await db.selectFrom('artifacts').selectAll().where('id','=',active).executeTakeFirstOrThrow();const {comment:_,comment_revision:__,commented_at:___,...beforeState}=before,{comment:____,comment_revision:_____,commented_at:______,...afterState}=after;expect(afterState).toEqual(beforeState)
  const raced=await Promise.allSettled([services.artifactComments.update(owner,active,{revision:2,comment:'writer A'}),services.artifactComments.update(owner,active,{revision:2,comment:'writer B'})]);expect(raced.filter(result=>result.status==='fulfilled').length).toBe(1);expect(raced.filter(result=>result.status==='rejected').map(result=>result.reason.code)).toEqual(['REVISION_CONFLICT'])
  const tombstoneBefore=await db.selectFrom('artifacts').selectAll().where('id','=',deleted).executeTakeFirstOrThrow();expect((await services.artifactComments.update(owner,deleted,{revision:1,comment:'Object removed; recovery history retained'})).comment_revision).toBe(2);const tombstoneAfter=await db.selectFrom('artifacts').selectAll().where('id','=',deleted).executeTakeFirstOrThrow();expect(tombstoneAfter.deletion_state).toBe('deleted');expect(tombstoneAfter.deleted_at).toEqual(tombstoneBefore.deleted_at)
  const restore=randomUUID(),intent=randomUUID();runIds.add(restore);intentIds.add(intent)
  await db.insertInto('runs').values({id:restore,plan_id:null,type:'restore',status:'interrupted',phase:'interrupted',idempotency_key:randomUUID(),source_id:source,storage_id:storage,target_id:targetId,artifact_id:active,started_at:null,finished_at:null,heartbeat_at:null,error_code:'SYNTHETIC',error_message:'Metadata-only fixture',validation:null,cancel_requested:false,attempt:1,execution_token:null,review_fingerprint:'synthetic-preserved'}).execute()
  await db.insertInto('target_blocks').values({target_id:targetId,resource_key:'postgres:notes_target',run_id:restore,reason:'Synthetic unknown restore outcome'}).execute()
  await db.insertInto('restore_intents').values({id:intent,actor:owner.actor,artifact_id:active,target_id:targetId,review:{synthetic:true},fingerprint:'synthetic-preserved',expires_at:sql<Date>`clock_timestamp()+interval '1 hour'`,consumed_run_id:null,idempotency_key:null}).execute()
  const recoveryBefore={run:await db.selectFrom('runs').selectAll().where('id','=',restore).executeTakeFirstOrThrow(),target:await db.selectFrom('target_blocks').selectAll().where('target_id','=',targetId).executeTakeFirstOrThrow(),intent:await db.selectFrom('restore_intents').selectAll().where('id','=',intent).executeTakeFirstOrThrow()}
  const cleared=await services.artifactComments.update(owner,active,{revision:3,comment:' \n\t '});expect(cleared.comment).toBeNull();expect(cleared.comment_revision).toBe(4)
  expect({run:await db.selectFrom('runs').selectAll().where('id','=',restore).executeTakeFirstOrThrow(),target:await db.selectFrom('target_blocks').selectAll().where('target_id','=',targetId).executeTakeFirstOrThrow(),intent:await db.selectFrom('restore_intents').selectAll().where('id','=',intent).executeTakeFirstOrThrow()}).toEqual(recoveryBefore)
  const agent=await services.agents.create(owner,{name:'Synthetic notes agent',description:'Dedicated comments metadata proof'});agentIds.add(agent.id);const editor=await services.agents.issue(owner,agent.id,{name:'notes editor',scopes:['read','configure'],expiresInHours:1}),reader=await services.agents.issue(owner,agent.id,{name:'notes reader',scopes:['read'],expiresInHours:1}),app=createApp(services),history=new HistoryServices(db)
  const request=(path:string,method='GET',body?:unknown,token=editor.token)=>app.handle(new Request('http://localhost/api/v1'+path,{method,headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)}))
  // Compile the strict base DTOs first; history extends their public fields without allOf branches.
  expect((await request('/jobs/'+restore)).status).toBe(200)
  expect((await request('/history/jobs?sourceId='+source)).status).toBe(200)
  expect((await request('/connections')).status).toBe(200)
  expect((await request('/history/connections?role=target')).status).toBe(200)
  expect((await request('/backups/'+active+'/comment','PATCH',{revision:4,comment:'denied'},reader.token)).status).toBe(403)
  const patched=await request('/backups/'+active+'/comment','PATCH',{revision:4,comment:'Durable API note'});expect(patched.status).toBe(200);expect((await patched.json() as {comment_revision:number}).comment_revision).toBe(5)
  const direct=await request('/backups/'+active);expect(direct.status).toBe(200);expect(await direct.json()).toMatchObject({id:active,comment:'Durable API note',comment_revision:5})
  const recent=await services.artifacts();expect(recent.length).toBe(100);expect(recent.every(row=>Object.hasOwn(row,'comment')&&row.comment_revision>=1&&Object.hasOwn(row,'commented_at'))).toBe(true);expect(recent.some(row=>row.id===active)).toBe(false)
  const historical=await history.snapshots({id:active,limit:1});expect(historical.items[0]).toMatchObject({comment:'Durable API note',comment_revision:5});expect((await services.overview()).backups.every(row=>Object.hasOwn(row,'comment'))).toBe(true)
  expect((await request('/history/snapshots?id='+active)).status).toBe(200);expect((await request('/overview')).status).toBe(200);expect((await request('/backups/'+deleted+'/comment','GET',undefined,reader.token)).status).toBe(200)
  expect((await request('/backups/'+active+'/comment','PATCH',{revision:5,comment:'x'.repeat(2001)})).status).toBe(422)
  const transport=new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),{requestInit:{headers:{authorization:'Bearer '+editor.token}},fetch:async(input,init)=>app.handle(input instanceof Request?input:new Request(input,init))}),mcp=new Client({name:'snapshot-comment-proof',version:'1'});await mcp.connect(transport)
  try{const written=await mcp.callTool({name:'update_backup_comment',arguments:{id:active,revision:5,comment:'Durable MCP note'}});expect(written.isError).not.toBe(true);expect((written.structuredContent as {data:{comment_revision:number}}).data.comment_revision).toBe(6);for(const name of ['get_backup','get_backup_comment'] as const){const result=await mcp.callTool({name,arguments:{id:active}});expect(result.isError).not.toBe(true);expect((result.structuredContent as {data:{comment:string}}).data.comment).toBe('Durable MCP note')}const all=await mcp.callTool({name:'browse_snapshot_history',arguments:{id:active}});expect(all.isError).not.toBe(true);expect((all.structuredContent as {data:{items:Array<{comment_revision:number}>}}).data.items[0].comment_revision).toBe(6)}finally{await mcp.close()}
  await expect(services.artifactComments.get({actor:'setup-only',scopes:[]},active)).rejects.toMatchObject({code:'FORBIDDEN'});await expect(services.artifactComments.update(owner,randomUUID(),{revision:1,comment:'missing'})).rejects.toMatchObject({code:'NOT_FOUND'})
  expect((await db.selectFrom('notification_deliveries').selectAll().execute()).length).toBe(0)
  console.info(JSON.stringify({proof:'snapshot-comments',schema:10,records:103,casRace:'one-writer-only',tombstoneAnnotatable:true,recoveryStateUnchanged:true,auditBodyStored:false,restMcpHistoryParity:true,nativeOrS3Contacts:0}))
 }finally{
  try{
   try{if(created){for(const [table,ids]of [['connections',connectionIds],['runs',runIds],['artifacts',artifactIds],['agents',agentIds],['restore_intents',intentIds]] as const){const rows=await db.selectFrom(table).select('id').execute();if(rows.some(row=>!ids.has(row.id)))throw new Error('Foreign rows in dedicated comments DB; preserve fixture.')}for(const table of ['restore_intents','target_blocks','artifacts','runs','connections','agent_tokens','agents','audit_events'] as const)await db.deleteFrom(table).execute();const tables=await sql<{tablename:string}>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'steelkeep_migrations'`.execute(db);for(const {tablename}of tables.rows){if(!/^[a-z_]+$/.test(tablename))throw new Error('Unexpected dedicated table identity.');if((await sql<{n:number}>`SELECT count(*)::int AS n FROM ${sql.table(tablename)}`.execute(db)).rows[0].n!==0)throw new Error('Dedicated comments DB retains application data; no drop.')}emptyVerified=true}}finally{await db.destroy()}
   if(created){const identity=(await admin.query<{oid:number;clients:number}>('SELECT d.oid,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=d.datname) AS clients FROM pg_database d WHERE d.datname=$1',[database])).rows[0];if(!emptyVerified||!identity||identity.oid!==oid||identity.clients!==0)throw new Error('Dedicated comments DB identity/empty/client guard failed; preserve.');await admin.query('DROP DATABASE steelkeep_comments_test');expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount).toBe(0)}
  }finally{await admin.end();for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value}if(directory)await rm(directory,{recursive:true,force:true})}
 }
},90000)
