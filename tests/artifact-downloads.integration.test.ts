import {test,expect} from 'bun:test'
import {randomUUID,randomBytes,createHash} from 'node:crypto'
import {Readable} from 'node:stream'
import {mkdtemp,chmod,writeFile,readFile,lstat,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import pg from 'pg'
import {Kysely,PostgresDialect,sql} from 'kysely'
import {S3Client,CreateBucketCommand,HeadBucketCommand,PutObjectCommand,HeadObjectCommand,ListObjectsV2Command,DeleteObjectCommand,DeleteBucketCommand,GetBucketVersioningCommand} from '@aws-sdk/client-s3'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'
import type {Schema} from '../server/db'
import {Services} from '../server/services'
import {createApp} from '../server/app'
import {allScopes,type Principal} from '../server/auth'

class ObservedDownloads extends Services{
 opened:Array<{id:string;body:Readable;closed:boolean}>=[]
 constructor(db:Kysely<Schema>){super(db);const open=this.openArtifactDownload;this.openArtifactDownload=async(artifact,signal)=>{
  const source=await open(artifact,signal)
  if(!(source.body instanceof Readable)){source.close();throw new Error('Pinned SDK did not return the expected Node readable; preserve this transport difference.')}
  const entry={id:artifact.id,body:source.body,closed:false};this.opened.push(entry)
  return {...source,close:()=>{entry.closed=true;source.close()}}
 }}
}
const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-server-downloads'?test:test.skip
acceptance('real S3 GetObject archive download: HTTP bytes/SHA, scopes, incomplete corruption and cancellation cleanup',async()=>{
 if(process.platform!=='linux'||process.env.STEELKEEP_SERVER_PROOF_ROOT!=='/work'||await realpath(process.cwd())!=='/work')throw new Error('Download proof requires the authorized isolated Linux stand at /work.')
 async function privateFile(path:string){const file=await lstat(path);if(!file.isFile()||(file.mode&0o777)!==0o600||file.uid!==process.getuid?.())throw new Error('Invalid private proof capability file.');return readFile(path,'utf8')}
 const controlNonce=(await privateFile('/run/steelkeep/proof-nonce')).trim(),password=(await privateFile('/run/steelkeep/metadata-password')).trim(),accessKeyId=(await privateFile('/run/steelkeep/download-s3-access-key')).trim(),secretAccessKey=(await privateFile('/run/steelkeep/download-s3-secret-key')).trim()
 if(!/^[a-f0-9]{64}$/.test(controlNonce)||!password||accessKeyId.length<16||secretAccessKey.length<32)throw new Error('Invalid explicit download fixture capabilities.')
 const database='steelkeep_downloads_test',controlUrl=new URL('postgresql://steelkeep@metadata:5432/steelkeep_platform_proof');controlUrl.password=password;const target=new URL(controlUrl);target.pathname='/'+database
 const options={connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000},admin=new pg.Client({connectionString:controlUrl.toString(),...options}),db=new Kysely<Schema>({dialect:new PostgresDialect({pool:new pg.Pool({connectionString:target.toString(),max:4,...options})})}),services=new ObservedDownloads(db)
 const s3=new S3Client({endpoint:'http://s3:9000',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId,secretAccessKey},maxAttempts:1}),objectNonce=randomBytes(12).toString('hex'),bucket='steelkeep-download-'+objectNonce,prefix='download-proof/'+objectNonce+'/',objects=new Map<string,{size:number;sha256:string}>()
 const source=randomUUID(),storage=randomUUID(),connections=new Set<string>([source,storage]),runs=new Set<string>(),artifacts=new Set<string>(),agents=new Set<string>(),readers=new Set<ReadableStreamDefaultReader<Uint8Array>>(),saved=Object.fromEntries(['STEELKEEP_KEY_FILE','STEELKEEP_TOKEN_FILE','STEELKEEP_ALLOWED_HOSTS','STEELKEEP_ALLOWED_ORIGINS','STEELKEEP_SCOPED_TOKENS_FILE'].map(key=>[key,process.env[key]]))
 const owner:Principal={actor:'installation-owner',scopes:allScopes}
 let created=false,oid:number|undefined,bucketCreated=false,versioningConfirmed=false,metadataOwnershipVerified=false,emptyVerified=false,directory:string|undefined,http:ReturnType<typeof Bun.serve>|undefined
 const body=Buffer.alloc(3*1024*1024+117);for(let i=0;i<body.length;i++)body[i]=i%251;Buffer.from('SYNTHETIC-DOWNLOAD-'+objectNonce).copy(body)
 const sha256=createHash('sha256').update(body).digest('hex')
 async function waitFor(predicate:()=>boolean|Promise<boolean>){const deadline=Date.now()+5000;do{if(await predicate())return;await Bun.sleep(5)}while(Date.now()<deadline);throw new Error('Expected download cleanup did not finish within its deadline.')}
 async function snapshot(label:string,state:'active'|'queued'|'deleting'|'held'|'deleted'='active',wrongHash=false,wrongSize=false,upload=true){
  const id=randomUUID(),run=randomUUID(),key=prefix+label+'-'+id+'.dump';runs.add(run);artifacts.add(id)
  if(upload){await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:body,ContentLength:body.length,IfNoneMatch:'*',Metadata:{sha256,'steelkeep-proof':objectNonce}}));objects.set(key,{size:body.length,sha256})}
  await db.insertInto('runs').values({id:run,plan_id:null,type:'backup',status:'succeeded',phase:'completed',idempotency_key:randomUUID(),source_id:source,storage_id:storage,target_id:null,artifact_id:id,started_at:null,finished_at:null,heartbeat_at:null,error_code:null,error_message:null,validation:null,cancel_requested:false,attempt:1,execution_token:null,review_fingerprint:null}).execute()
  await db.insertInto('artifacts').values({id,run_id:run,source_id:source,storage_id:storage,object_key:key,size:String(body.length+(wrongSize?1:0)),sha256:wrongHash?'b'.repeat(64):sha256,engine:'postgres',server_version:'synthetic',tool_version:'synthetic-byte-fixture-not-a-native-backup',availability:upload?'present':'unknown',checked_at:null,deletion_state:state,deleted_at:state==='deleted'?new Date():null}).execute();return {id,key}
 }
 try{
  await admin.connect();const identity=(await admin.query<{database:string;role:string}>('SELECT current_database() AS database,current_user AS role')).rows[0],marker=await admin.query<{singleton:boolean;nonce:string}>('SELECT singleton,nonce FROM steelkeep_platform_proof_identity')
  if(identity.database!=='steelkeep_platform_proof'||identity.role!=='steelkeep'||marker.rowCount!==1||marker.rows[0].singleton!==true||marker.rows[0].nonce!==controlNonce)throw new Error('Proof control identity mismatch.')
  if((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount)throw new Error('Dedicated downloads database exists; preserve for inspection.')
  // Only a genuinely absent nonce bucket may be created; denied/ambiguous HEAD never grants ownership.
  try{await s3.send(new HeadBucketCommand({Bucket:bucket}));throw new Error('Nonce download bucket already exists; preserve it.')}catch(error){if((error as{$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==404)throw error}
  await s3.send(new CreateBucketCommand({Bucket:bucket}));bucketCreated=true
  const versioning=await s3.send(new GetBucketVersioningCommand({Bucket:bucket}));if(versioning.Status)throw new Error('The fresh fixture bucket unexpectedly has versioning; preserve it.');versioningConfirmed=true
  await admin.query('CREATE DATABASE steelkeep_downloads_test');created=true;oid=(await admin.query<{oid:number}>('SELECT oid FROM pg_database WHERE datname=$1',[database])).rows[0].oid
  directory=await mkdtemp(join(tmpdir(),'steelkeep-downloads-'));await chmod(directory,0o700);await writeFile(join(directory,'key'),randomBytes(32),{mode:0o600});await writeFile(join(directory,'token'),randomBytes(32).toString('hex'),{mode:0o600})
  process.env.STEELKEEP_KEY_FILE=join(directory,'key');process.env.STEELKEEP_TOKEN_FILE=join(directory,'token');process.env.STEELKEEP_ALLOWED_HOSTS='metadata,s3,127.0.0.1,localhost';process.env.STEELKEEP_ALLOWED_ORIGINS='http://localhost';delete process.env.STEELKEEP_SCOPED_TOKENS_FILE
  const migration=Bun.spawn([process.execPath,'server/migrate.ts'],{cwd:'/work',env:{...process.env,DATABASE_URL:target.toString(),STEELKEEP_DATABASE_PASSWORD_FILE:''},stdout:'ignore',stderr:'ignore',timeout:15000});if(await migration.exited!==0)throw new Error('Dedicated downloads migration failed; diagnostics withheld.')
  await db.insertInto('connections').values([{id:source,name:'Synthetic download source',kind:'postgres',config:{database:'synthetic_source',restoreTarget:false},secret:'SYNTHETIC_NEVER_DECRYPTED',check_status:'untested',checked_at:null},{id:storage,name:'Synthetic download storage',kind:'s3',config:{endpoint:'http://s3:9000',region:'us-east-1',bucket,prefix},secret:(await import('../server/security')).seal({accessKey:accessKeyId,secretKey:secretAccessKey}),check_status:'untested',checked_at:null}]).execute()
  const good=await snapshot('valid'),badHash=await snapshot('bad-hash','active',true),badSize=await snapshot('bad-size','active',false,true),refused=[]
  for(const state of ['queued','deleting','held','deleted']as const)refused.push({state,...await snapshot(state,state,false,false,false)})
  const agent=await services.agents.create(owner,{name:'Synthetic download agent',description:'Fresh private bucket and metadata fixture only'});agents.add(agent.id);const downloader=await services.agents.issue(owner,agent.id,{name:'download only',scopes:['backup:download'],expiresInHours:1}),reader=await services.agents.issue(owner,agent.id,{name:'read only',scopes:['read'],expiresInHours:1}),app=createApp(services)
  http=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>app.handle(request)});const origin='http://127.0.0.1:'+http.port
  const request=(path:string,token=downloader.token,extra:Record<string,string>={})=>fetch(origin+'/api/v1'+path,{headers:{authorization:'Bearer '+token,...extra}})
  const descriptor=await request('/backups/'+good.id+'/download-info');expect(descriptor.status).toBe(200);const description=await descriptor.json()as{id:string;path:string;size:string;sha256:string;filename:string};expect(description).toMatchObject({id:good.id,path:'/api/v1/backups/'+good.id+'/download',size:String(body.length),sha256,filename:'steelkeep-'+good.id+'.dump'})
  for(const hidden of [accessKeyId,secretAccessKey,bucket,good.key,'http://s3:9000','X-Amz-Signature'])expect(JSON.stringify(description).includes(hidden)).toBe(false)
  const received=await request('/backups/'+good.id+'/download');expect(received.status).toBe(200);const transferLength=received.headers.get('content-length');if(transferLength===null)expect(received.headers.get('transfer-encoding')).toBe('chunked');else expect(transferLength).toBe(description.size);expect(received.headers.get('accept-ranges')).toBe('none');expect(received.headers.get('x-steelkeep-recorded-sha256')).toBe(sha256)
  const bytes=Buffer.from(await received.arrayBuffer());expect(bytes.equals(body)).toBe(true);expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256)
  const headers=JSON.stringify([...received.headers]);for(const hidden of [accessKeyId,secretAccessKey,bucket,good.key,'s3:9000','X-Amz-Signature'])expect(headers.includes(hidden)).toBe(false)
  await waitFor(()=>services.opened.every(entry=>entry.closed));expect(services.opened[0].body.destroyed).toBe(true)
  expect((await db.selectFrom('audit_events').selectAll().where('action','=','backup.download.verified').where('subject_id','=',good.id).execute()).length).toBe(1)
  const beforeDenied=services.opened.length;expect((await request('/backups/'+good.id+'/download-info',reader.token)).status).toBe(403);expect((await request('/backups/'+good.id+'/download',reader.token)).status).toBe(403);expect(services.opened.length).toBe(beforeDenied)
  expect((await request('/backups/'+good.id+'/download',downloader.token,{range:'bytes=0-10'})).status).toBe(416)
  for(const item of refused){const before=services.opened.length;expect((await request('/backups/'+item.id+'/download')).status).toBe(item.state==='deleted'?404:409);expect(services.opened.length).toBe(before)}
  const invalidSize=await request('/backups/'+badSize.id+'/download');expect(invalidSize.status).toBe(409);expect(await invalidSize.json()).toMatchObject({error:{code:'ARTIFACT_SIZE_MISMATCH'}})
  const corrupt=await request('/backups/'+badHash.id+'/download');expect(corrupt.status).toBe(200);await expect(corrupt.arrayBuffer()).rejects.toBeDefined();await waitFor(()=>services.opened.every(entry=>entry.closed))
  expect((await db.selectFrom('audit_events').selectAll().where('action','=','backup.download.verified').where('subject_id','=',badHash.id).execute()).length).toBe(0)
  // Direct route responses retain deterministic backpressure while still opening real SDK GetObject bodies.
  const direct=()=>app.handle(new Request('http://localhost/api/v1/backups/'+good.id+'/download',{headers:{authorization:'Bearer '+downloader.token}}))
  const first=await direct(),second=await direct();expect(first.status).toBe(200);expect(second.status).toBe(200);expect((await direct()).status).toBe(429)
  const firstReader=first.body!.getReader(),secondReader=second.body!.getReader();readers.add(firstReader);readers.add(secondReader);await firstReader.read();const firstEntry=services.opened.at(-2)!
  await firstReader.cancel();readers.delete(firstReader);await waitFor(()=>firstEntry.closed);expect(firstEntry.body.destroyed).toBe(true)
  const afterCancel=await direct();expect(afterCancel.status).toBe(200);expect(Buffer.from(await afterCancel.arrayBuffer()).equals(body)).toBe(true);await secondReader.cancel();readers.delete(secondReader);await waitFor(()=>services.opened.every(entry=>entry.closed))
  const transport=new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+downloader.token}}}),mcp=new Client({name:'download-proof',version:'1'});await mcp.connect(transport)
  try{const result=await mcp.callTool({name:'get_backup_download',arguments:{id:good.id}});expect(result.isError).not.toBe(true);expect((result.structuredContent as{data:{path:string;sha256:string}}).data).toMatchObject({path:'/api/v1/backups/'+good.id+'/download',sha256});expect(JSON.stringify(result.structuredContent).includes(secretAccessKey)).toBe(false)}finally{await mcp.close()}
  await services.agents.revokeToken(owner,downloader.id);const beforeRevoke=services.opened.length;expect((await request('/backups/'+good.id+'/download-info')).status).toBe(401);expect((await request('/backups/'+good.id+'/download')).status).toBe(401);expect(services.opened.length).toBe(beforeRevoke)
  expect((await db.selectFrom('outbox').selectAll().execute()).length).toBe(0)
  console.info(JSON.stringify({proof:'artifact-download',actualSdkGetObjects:services.opened.length,httpBytes:body.length,sha256Matched:true,corruption:'incomplete-http-stream',scopedDownloadOnly:true,readDenied:true,revocation:true,cancelledSocketDestroyed:true,slotsReleased:true,allSourcesClosed:services.opened.every(entry=>entry.closed),nativeBackups:0,existingObjectsTouched:0}))
 }finally{
  for(const reader of readers)await reader.cancel().catch(()=>{});http?.stop(true)
  try{
   try{if(created){for(const [table,ids]of [['connections',connections],['runs',runs],['artifacts',artifacts],['agents',agents]]as const){if((await db.selectFrom(table).select('id').execute()).some(row=>!ids.has(row.id)))throw new Error('Foreign rows in dedicated downloads DB; preserve all fixtures.')}metadataOwnershipVerified=true;for(const table of ['artifacts','runs','connections','agent_tokens','agents','audit_events']as const)await db.deleteFrom(table).execute();const tables=await sql<{tablename:string}>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'steelkeep_migrations'`.execute(db);for(const {tablename}of tables.rows){if(!/^[a-z_]+$/.test(tablename))throw new Error('Unexpected dedicated table.');if((await sql<{n:number}>`SELECT count(*)::int AS n FROM ${sql.table(tablename)}`.execute(db)).rows[0].n!==0)throw new Error('Dedicated downloads DB retains application data; preserve.')}emptyVerified=true}}finally{await db.destroy()}
   if(created){const identity=(await admin.query<{oid:number;clients:number}>('SELECT d.oid,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=d.datname) AS clients FROM pg_database d WHERE d.datname=$1',[database])).rows[0];if(!emptyVerified||!identity||identity.oid!==oid||identity.clients!==0)throw new Error('Dedicated downloads DB identity/empty/client guard failed; preserve.');await admin.query('DROP DATABASE steelkeep_downloads_test');expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount).toBe(0)}
   if(bucketCreated){if(!versioningConfirmed||created&&!metadataOwnershipVerified)throw new Error('Fixture ownership was not established; preserve the bucket.');const contents=await s3.send(new ListObjectsV2Command({Bucket:bucket}));if(contents.IsTruncated||contents.Contents?.some(object=>!object.Key||!object.Key.startsWith(prefix)||!objects.has(object.Key)))throw new Error('Foreign objects in nonce bucket; preserve it.');for(const object of contents.Contents??[]){const expected=objects.get(object.Key!)!,head=await s3.send(new HeadObjectCommand({Bucket:bucket,Key:object.Key!}));if(head.Metadata?.['steelkeep-proof']!==objectNonce||head.Metadata?.sha256!==expected.sha256||head.ContentLength!==expected.size||!head.ETag)throw new Error('Owned object changed; preserve it.');await s3.send(new DeleteObjectCommand({Bucket:bucket,Key:object.Key!,IfMatch:head.ETag}))}const empty=await s3.send(new ListObjectsV2Command({Bucket:bucket}));if(empty.IsTruncated||empty.Contents?.length)throw new Error('Nonce bucket is not empty; preserve.');await s3.send(new DeleteBucketCommand({Bucket:bucket}))}
  }finally{await admin.end();s3.destroy();for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value}if(directory)await rm(directory,{recursive:true,force:true})}
 }
},90000)
