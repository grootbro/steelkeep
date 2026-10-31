import {test,expect} from 'bun:test'
import {createServer,request as httpRequest,type Server,type IncomingMessage,type ClientRequest} from 'node:http'
import {Readable} from 'node:stream'
import {randomUUID,randomBytes,createHash} from 'node:crypto'
import {mkdtemp,chmod,writeFile,readFile,lstat,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import pg from 'pg'
import {Kysely,PostgresDialect,sql} from 'kysely'
import type {Schema} from '../server/db'
import {Services} from '../server/services'
import {createApp} from '../server/app'
import {allScopes,type Principal} from '../server/auth'

type Opened={id:string;body:Readable;closed:boolean;abortObserved:boolean;readableClosed:boolean}
class LifecycleDownloads extends Services{
 readonly opened:Opened[]=[]
 constructor(db:Kysely<Schema>){super(db);const open=this.openArtifactDownload;this.openArtifactDownload=async(artifact,signal)=>{
  const source=await open(artifact,signal)
  if(!(source.body instanceof Readable)){source.close();throw new Error('Expected the pinned SDK Node readable.')}
  const entry:Opened={id:artifact.id,body:source.body,closed:false,abortObserved:signal.aborted,readableClosed:false};this.opened.push(entry)
  signal.addEventListener('abort',()=>{entry.abortObserved=true},{once:true});source.body.once('close',()=>{entry.readableClosed=true})
  return {...source,close:()=>{entry.closed=true;source.close()}}
 }}
}
type Transfer={request:ClientRequest;response?:IncomingMessage;status:number;bytes:number;ended:boolean;closed:boolean;failed:boolean;destroy:()=>void}
type Upstream={key:string;bytes:number;closed:boolean;ended:boolean}
async function waitFor(predicate:()=>boolean|Promise<boolean>,label:string){const until=Date.now()+5000;do{if(await predicate())return;await Bun.sleep(10)}while(Date.now()<until);throw new Error('Download lifecycle deadline: '+label)}
const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-server-download-lifecycle'?test:test.skip

acceptance('real HTTP disconnect and token expiry close throttled SDK streams and release download slots',async()=>{
 if(process.platform!=='linux'||process.env.STEELKEEP_SERVER_PROOF_ROOT!=='/work'||await realpath(process.cwd())!=='/work')throw new Error('Requires the authorized isolated Linux proof stand at /work.')
 async function privateFile(path:string){const file=await lstat(path);if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1||(file.mode&0o777)!==0o600||file.uid!==process.getuid?.()||file.size>4096||await realpath(path)!==path)throw new Error('Invalid private proof capability.');return (await readFile(path,'utf8')).trim()}
 const nonce=await privateFile('/run/steelkeep/proof-nonce'),password=await privateFile('/run/steelkeep/metadata-password')
 if(!/^[a-f0-9]{64}$/.test(nonce)||!password)throw new Error('Missing explicit control capabilities.')
 const database='steelkeep_download_lifecycle_test',control=new URL('postgresql://steelkeep@metadata:5432/steelkeep_platform_proof');control.password=password;const destination=new URL(control);destination.pathname='/'+database
 const options={connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000},admin=new pg.Client({connectionString:control.toString(),...options}),db=new Kysely<Schema>({dialect:new PostgresDialect({pool:new pg.Pool({connectionString:destination.toString(),max:4,...options})})}),services=new LifecycleDownloads(db)
 const ids={source:randomUUID(),storage:randomUUID()},artifactIds=new Set<string>(),runIds=new Set<string>(),agentIds=new Set<string>(),tokenIds=new Set<string>(),keys=new Set<string>(),clients=new Set<Transfer>(),upstreams:Upstream[]=[],timers=new Set<ReturnType<typeof setTimeout>>()
 const saved=Object.fromEntries(['STEELKEEP_KEY_FILE','STEELKEEP_TOKEN_FILE','STEELKEEP_ALLOWED_HOSTS','STEELKEEP_ALLOWED_ORIGINS','STEELKEEP_SCOPED_TOKENS_FILE'].map(key=>[key,process.env[key]]))
 const owner:Principal={actor:'installation-owner',scopes:allScopes},bucket='synthetic-lifecycle-'+randomBytes(8).toString('hex'),accessKey='SYNTHETIC'+randomBytes(12).toString('hex'),secretKey=randomBytes(32).toString('hex')
 const chunk=Buffer.alloc(32768);for(let i=0;i<chunk.length;i++)chunk[i]=i%251
 const parts=256,totalBytes=chunk.length*parts,digest=createHash('sha256');for(let i=0;i<parts;i++)digest.update(chunk);const sha256=digest.digest('hex')
 let created=false,dbClosed=false,oid:number|undefined,directory:string|undefined,http:ReturnType<typeof Bun.serve>|undefined,upstream:Server|undefined,fixtureFailure=false
 function transfer(origin:string,id:string,token:string):Transfer{
  const entry:Transfer={request:undefined as unknown as ClientRequest,status:0,bytes:0,ended:false,closed:false,failed:false,destroy:()=>{entry.response?.destroy();entry.request.destroy()}}
  const request=httpRequest(origin+'/api/v1/backups/'+id+'/download',{headers:{authorization:'Bearer '+token,connection:'close'}},response=>{
   entry.response=response;entry.status=response.statusCode??0
   response.on('data',(data:Buffer)=>{entry.bytes+=data.length});response.on('end',()=>{entry.ended=true});response.on('error',()=>{entry.failed=true});response.on('close',()=>{entry.closed=true})
  });entry.request=request;request.on('error',()=>{entry.failed=true;entry.closed=true});request.end();clients.add(entry);return entry
 }
 try{
  await admin.connect();const identity=(await admin.query('SELECT current_database() AS database,current_user AS actor')).rows[0],marker=(await admin.query('SELECT singleton,nonce FROM steelkeep_platform_proof_identity')).rows
  if(identity.database!=='steelkeep_platform_proof'||identity.actor!=='steelkeep'||marker.length!==1||marker[0].singleton!==true||marker[0].nonce!==nonce)throw new Error('Control database identity mismatch.')
  if((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount)throw new Error('Lifecycle database exists; preserve it.')
  await admin.query('CREATE DATABASE steelkeep_download_lifecycle_test');created=true;oid=(await admin.query('SELECT oid FROM pg_database WHERE datname=$1',[database])).rows[0].oid
  directory=await mkdtemp(join(tmpdir(),'steelkeep-download-lifecycle-'));await chmod(directory,0o700);await writeFile(join(directory,'key'),randomBytes(32),{mode:0o600});await writeFile(join(directory,'token'),randomBytes(32).toString('hex'),{mode:0o600})
  process.env.STEELKEEP_KEY_FILE=join(directory,'key');process.env.STEELKEEP_TOKEN_FILE=join(directory,'token');process.env.STEELKEEP_ALLOWED_HOSTS='metadata,127.0.0.1,localhost';process.env.STEELKEEP_ALLOWED_ORIGINS='http://localhost';delete process.env.STEELKEEP_SCOPED_TOKENS_FILE
  const migration=Bun.spawn([process.execPath,'server/migrate.ts'],{cwd:'/work',env:{...process.env,DATABASE_URL:destination.toString(),STEELKEEP_DATABASE_PASSWORD_FILE:''},stdout:'ignore',stderr:'ignore',timeout:15000});if(await migration.exited!==0)throw new Error('Dedicated lifecycle migration failed; diagnostics withheld.')
  // This speaks the tiny GetObject protocol surface only; it is not an S3 implementation or native backup.
  upstream=createServer((request,response)=>{
   const key=(request.url??'').split('?')[0],authorization=request.headers.authorization??''
   if(request.method!=='GET'||!keys.has(key)||!authorization.startsWith('AWS4-HMAC-SHA256 ')||!authorization.includes('Credential='+accessKey+'/')){fixtureFailure=true;response.writeHead(403);response.end();return}
   const entry:Upstream={key,bytes:0,closed:false,ended:false};upstreams.push(entry)
   response.writeHead(200,{'content-type':'application/octet-stream','content-length':String(totalBytes),'accept-ranges':'bytes'})
   let timer:ReturnType<typeof setTimeout>|undefined
   const send=()=>{
    if(entry.closed)return
    entry.bytes+=chunk.length
    if(!response.write(chunk)){response.once('drain',schedule);return}
    schedule()
   }
   const schedule=()=>{
    if(entry.closed)return
    if(entry.bytes===totalBytes){entry.ended=true;response.end();return}
    timer=setTimeout(()=>{if(timer)timers.delete(timer);send()},80);timers.add(timer)
   }
   response.once('close',()=>{entry.closed=true;if(timer){clearTimeout(timer);timers.delete(timer)}});send()
  });await new Promise<void>((resolve,reject)=>{upstream!.once('error',reject);upstream!.listen(0,'127.0.0.1',resolve)})
  const address=upstream.address();if(!address||typeof address==='string')throw new Error('Loopback fixture port missing.')
  await db.insertInto('connections').values([{id:ids.source,name:'Synthetic lifecycle source',kind:'postgres',config:{database:'synthetic_lifecycle_source',restoreTarget:false},secret:'SYNTHETIC_NEVER_DECRYPTED',check_status:'untested',checked_at:null},{id:ids.storage,name:'Synthetic throttled GetObject protocol fixture',kind:'s3',config:{endpoint:'http://127.0.0.1:'+address.port,region:'us-east-1',bucket,prefix:'fixture/'},secret:(await import('../server/security')).seal({accessKey,secretKey}),check_status:'untested',checked_at:null}]).execute()
  async function artifact(label:string){
   const id=randomUUID(),run=randomUUID(),key='fixture/'+label+'-'+id+'.dump';artifactIds.add(id);runIds.add(run);keys.add('/'+bucket+'/'+key)
   await db.insertInto('runs').values({id:run,plan_id:null,type:'backup',status:'succeeded',phase:'completed',idempotency_key:randomUUID(),source_id:ids.source,storage_id:ids.storage,target_id:null,artifact_id:id,started_at:null,finished_at:null,heartbeat_at:null,error_code:null,error_message:null,validation:null,cancel_requested:false,attempt:1,execution_token:null,review_fingerprint:null}).execute()
   await db.insertInto('artifacts').values({id,run_id:run,source_id:ids.source,storage_id:ids.storage,object_key:key,size:String(totalBytes),sha256,engine:'postgres',server_version:'synthetic',tool_version:'synthetic-protocol-byte-fixture-not-a-native-backup',availability:'present',checked_at:null,deletion_state:'active',deleted_at:null}).execute();return {id,path:'/'+bucket+'/'+key}
  }
  const agent=await services.agents.create(owner,{name:'Synthetic HTTP lifecycle agent'});agentIds.add(agent.id)
  const persistent=await services.agents.issue(owner,agent.id,{name:'download lifecycle',scopes:['backup:download'],expiresInHours:1}),expiring=await services.agents.issue(owner,agent.id,{name:'expires while streaming',scopes:['backup:download'],expiresInHours:1})
  tokenIds.add(persistent.id);tokenIds.add(expiring.id)
  const app=createApp(services);http=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>app.handle(request)});const origin='http://127.0.0.1:'+http.port
  const results:Array<Record<string,unknown>>=[]
  for(const mode of ['disconnect','credential-expiry'] as const){
   const primary=await artifact(mode),sibling=await artifact(mode+'-sibling'),replacement=await artifact(mode+'-replacement')
   if(mode==='credential-expiry')await db.updateTable('agent_tokens').set({expires_at:new Date(Date.now()+5000)}).where('id','=',expiring.id).execute()
   const first=transfer(origin,primary.id,mode==='disconnect'?persistent.token:expiring.token),second=transfer(origin,sibling.id,persistent.token)
   await waitFor(()=>first.status===200&&second.status===200&&first.bytes>0&&second.bytes>0,'both real HTTP streams started')
   const denied=transfer(origin,replacement.id,persistent.token);await waitFor(()=>denied.closed,'third HTTP response');expect(denied.status).toBe(429)
   const source=services.opened.find(entry=>entry.id===primary.id)!,upstreamSource=upstreams.find(entry=>entry.key===primary.path)!,siblingSource=services.opened.find(entry=>entry.id===sibling.id)!,siblingBytes=second.bytes
   expect(source).toBeDefined();expect(upstreamSource.closed).toBe(false);expect(upstreamSource.bytes).toBeLessThan(totalBytes)
   if(mode==='disconnect')first.destroy()
   await waitFor(()=>source.closed&&source.readableClosed&&source.body.destroyed&&upstreamSource.closed,'SDK readable and upstream socket close')
   await waitFor(()=>first.closed,'downstream interrupted socket close')
   expect(first.ended).toBe(false);expect(first.bytes).toBeLessThan(totalBytes);expect(upstreamSource.ended).toBe(false);expect(upstreamSource.bytes).toBeLessThan(totalBytes);expect(source.abortObserved).toBe(true)
   expect(siblingSource.closed).toBe(false);expect(siblingSource.body.destroyed).toBe(false)
   const admitted=transfer(origin,replacement.id,persistent.token);await waitFor(()=>admitted.status===200&&admitted.bytes>0&&second.bytes>siblingBytes,'released slot accepts HTTP stream while sibling continues')
   if(mode==='credential-expiry'){const expired=transfer(origin,primary.id,expiring.token);await waitFor(()=>expired.closed,'expired credential response');expect(expired.status).toBe(401)}
   second.destroy();admitted.destroy();await waitFor(()=>services.opened.every(entry=>entry.closed&&entry.body.destroyed)&&upstreams.every(entry=>entry.closed),'all case transports close')
   expect((await db.selectFrom('audit_events').select('id').where('action','=','backup.download.verified').where('subject_id','=',primary.id).execute()).length).toBe(0)
   results.push({mode,realHttpClientDestroyed:mode==='disconnect',expiredWithoutClientCancel:mode==='credential-expiry',sourceAbortObserved:source.abortObserved,sdkReadableDestroyed:source.body.destroyed,upstreamClosedIncomplete:upstreamSource.closed&&!upstreamSource.ended,downstreamBytes:first.bytes,upstreamBytes:upstreamSource.bytes,publishedBytes:totalBytes,thirdDownload429:true,releasedSlotAdmits200:true,siblingContinued:true,verifiedAuditAbsent:true})
  }
  expect(fixtureFailure).toBe(false);expect((await db.selectFrom('outbox').select('run_id').execute()).length).toBe(0)
  console.info(JSON.stringify({proof:'artifact-download-http-lifecycle',upstream:'controlled-loopback-S3-GetObject-protocol-fixture',realSdkNodeReadable:true,results,nativeBackups:0,realS3Implementation:false,allSourcesClosed:services.opened.every(entry=>entry.closed&&entry.body.destroyed)}))
 }finally{
  for(const client of clients)client.destroy();http?.stop(true);upstream?.closeAllConnections();if(upstream)await new Promise<void>(resolve=>upstream!.close(()=>resolve()));for(const timer of timers)clearTimeout(timer)
  try{
   if(created){
    if((await admin.query('SELECT oid FROM pg_database WHERE datname=$1',[database])).rows[0]?.oid!==oid)throw new Error('Lifecycle database OID changed; preserve it.')
    for(const [table,allowed]of [['connections',new Set<string>([ids.source,ids.storage])],['runs',runIds],['artifacts',artifactIds],['agents',agentIds]]as const)if((await db.selectFrom(table).select('id').execute()).some(row=>!allowed.has(row.id)))throw new Error('Foreign lifecycle rows; preserve the database.')
    if((await db.selectFrom('agent_tokens').select('id').execute()).some(row=>!tokenIds.has(row.id)))throw new Error('Foreign lifecycle credentials; preserve the database.')
    const subjects=new Set([...agentIds,...tokenIds,...artifactIds]);if((await db.selectFrom('audit_events').select(['actor','subject_id']).execute()).some(row=>row.subject_id===null||!subjects.has(row.subject_id)||![owner.actor,...[...agentIds].map(id=>'agent:'+id)].includes(row.actor)))throw new Error('Foreign lifecycle audit rows; preserve the database.')
    for(const table of ['artifacts','runs','connections','agent_tokens','agents','audit_events']as const)await db.deleteFrom(table).execute()
    const tables=await sql<{tablename:string}>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'steelkeep_migrations'`.execute(db)
    for(const {tablename}of tables.rows){if(!/^[a-z_]+$/.test(tablename)||(await sql<{n:number}>`SELECT count(*)::int AS n FROM ${sql.table(tablename)}`.execute(db)).rows[0].n!==0)throw new Error('Lifecycle rows remain; preserve the database.')}
    await db.destroy();dbClosed=true;const current=(await admin.query('SELECT d.oid,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=d.datname) AS clients FROM pg_database d WHERE d.datname=$1',[database])).rows[0]
    if(!current||current.oid!==oid||current.clients!==0)throw new Error('Lifecycle OID/client guard failed; preserve the database.')
    await admin.query('DROP DATABASE steelkeep_download_lifecycle_test')
   }
  }finally{if(!dbClosed)await db.destroy();await admin.end();for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value}if(directory)await rm(directory,{recursive:true,force:true})}
 }
},45000)
