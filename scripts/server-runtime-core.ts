import {readFile,writeFile} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {Database} from 'bun:sqlite'
import {createClient,RESP_TYPES} from 'redis'
import {S3Client,CreateBucketCommand,HeadBucketCommand,GetObjectCommand} from '@aws-sdk/client-s3'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'
import {connectDb} from '../server/db'
import {sql} from 'kysely'

// Explicit Linux server proof only; never imports into the application startup.
if(process.platform!=='linux'||process.env.STEELKEEP_RUNTIME_CORE!=='synthetic-server')throw new Error('Requires the isolated server runtime stand.')
const engine=process.argv[2]
if(!['redis','sqlite','clickhouse'].includes(engine))throw new Error('Choose one explicit core engine.')
const nonce=process.env.STEELKEEP_RUNTIME_PROOF_NONCE!,bucket=process.env.STEELKEEP_RUNTIME_PROOF_BUCKET!
if(!/^[a-f0-9]{32}$/.test(nonce)||bucket!=='steelkeep-core-'+nonce.slice(0,12))throw new Error('Invalid proof identity.')
const token=(await readFile('/run/secrets/token','utf8')).trim(),base='http://core-api:4311'
const {db}=connectDb()
const identity=(await sql<{nonce:string}>`SELECT nonce FROM runtime_proof_identity`.execute(db)).rows[0]
await db.destroy()
if(identity?.nonce!==nonce)throw new Error('Metadata proof ownership could not be verified.')
type Connection={id:string;name:string;kind:string;config:Record<string,unknown>}
type Job={id:string;status:string;artifact_id:string|null;error_code:string|null;validation:Record<string,unknown>|null}
type Artifact={id:string;object_key:string;size:string;sha256:string;engine:string;tool_version:string}
const assert=(condition:unknown,message:string)=>{if(!condition)throw new Error(message)}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
const client=new Client({name:'steelkeep-server-runtime-proof',version:'0.1.0'})
await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}}))
const summary:Record<string,unknown>={engine,nonce,sourceSnapshot:'ef8bae643ac1',independentDataVerified:false}
async function tool<T>(name:string,args:Record<string,unknown>={}):Promise<T>{
  const result=await client.callTool({name,arguments:args})
  assert(!result.isError,'MCP '+name+' refused the operation; inspect durable metadata, never repeat uncertain writes.')
  const text=result.content?.find(x=>x.type==='text')
  assert(text?.type==='text','Missing MCP JSON')
  return JSON.parse(text!.type==='text'?text!.text:'') as T
}
async function rest<T>(path:string,body:unknown):Promise<T>{
  const response=await fetch(base+'/api/v1'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)})
  assert(response.ok,'API '+path+' refused the operation ('+response.status+').')
  return response.json() as Promise<T>
}
async function completed(id:string){
  for(let i=0;i<180;i++){
    const job=await tool<Job>('get_job',{id})
    if(['succeeded','failed','interrupted','cancelled'].includes(job.status)){
      assert(job.status==='succeeded','Job '+id+' ended '+job.status+' / '+job.error_code)
      return job
    }
    await pause(1000)
  }
  throw new Error('Job deadline exceeded; execution was not resubmitted.')
}
const s3=new S3Client({endpoint:'http://s3:9000',region:'us-east-1',forcePathStyle:true,maxAttempts:1,credentials:{accessKeyId:(await readFile('/run/secrets/s3-access-key','utf8')).trim(),secretAccessKey:(await readFile('/run/secrets/s3-secret-key','utf8')).trim()}})
let redis:ReturnType<typeof createClient>|undefined,redisTarget:ReturnType<typeof createClient>|undefined
try{
  try{await s3.send(new HeadBucketCommand({Bucket:bucket}))}catch(e){if((e as {$metadata?:{httpStatusCode:number}}).$metadata?.httpStatusCode!==404)throw e;await s3.send(new CreateBucketCommand({Bucket:bucket}))}
  const existing=await tool<Connection[]>('list_connections')
  assert(!existing.some(x=>x.name==='Runtime '+engine+' source'),'A previous proof already exists; preserve it and use a new stand.')
  let storage=existing.find(x=>x.name==='Runtime private storage')
  storage??={...(await rest<{id:string}>('/connections',{kind:'s3',name:'Runtime private storage',endpoint:'http://s3:9000',bucket,region:'us-east-1',prefix:nonce,accessKey:(await readFile('/run/secrets/s3-access-key','utf8')).trim(),secretKey:(await readFile('/run/secrets/s3-secret-key','utf8')).trim()})),name:'Runtime private storage',kind:'s3',config:{}}
  let sourceInput:Record<string,unknown>,targetInput:Record<string,unknown>
  let verify:()=>Promise<void>
  if(engine==='redis'){
    redis=createClient({socket:{host:'redis-fixture',port:6379,reconnectStrategy:false},username:'fixture_admin',password:'local-redis-admin-only',database:0});redis.on('error',()=>{});await redis.connect()
    redisTarget=createClient({socket:{host:'redis-fixture',port:6379,reconnectStrategy:false},username:'fixture_admin',password:'local-redis-admin-only',database:1});redisTarget.on('error',()=>{});await redisTarget.connect()
    assert(await redis.dbSize()===0&&await redisTarget.dbSize()===0,'Redis fixture indexes are not empty; nothing was flushed.')
    const payload=Buffer.from([0,255,65,0,127]);await redis.set('binary',payload);await redis.hSet('hash',{name:'synthetic'});await redis.rPush('list',['alpha','beta']);await redis.sAdd('set',['one','two']);await redis.zAdd('sorted',[{score:1.25,value:'one'}]);await redis.xAdd('stream','*',{message:'synthetic'});await redis.set('live','ttl',{PX:600000});const expiry=await redis.pExpireTime('live')
    sourceInput={kind:'redis',host:'redis-fixture',port:6379,dbIndex:0,user:'backup_reader',password:'local-redis-reader-only',tls:false,allowGlobalReadLock:true}
    targetInput={kind:'redis',host:'redis-fixture',port:6379,dbIndex:1,user:'restore_writer',password:'local-redis-writer-only',tls:false,restoreTarget:true}
    verify=async()=>{
      const got=await redisTarget!.sendCommand(['GET','binary'],{typeMapping:{[RESP_TYPES.BLOB_STRING]:Buffer}});assert(Buffer.isBuffer(got)&&got.equals(payload),'Redis binary payload differs')
      assert(await redisTarget!.pExpireTime('live')===expiry,'Redis absolute expiry differs');assert(await redisTarget!.hGet('hash','name')==='synthetic','Redis hash differs');assert(JSON.stringify(await redisTarget!.lRange('list',0,-1))==='["alpha","beta"]','Redis list differs');assert((await redisTarget!.sMembers('set')).sort().join(',')==='one,two','Redis set differs');assert(await redisTarget!.zScore('sorted','one')===1.25,'Redis sorted set differs');assert(await redisTarget!.xLen('stream')===1,'Redis stream differs');assert(await redis!.dbSize()===7,'Redis source changed');summary.absoluteTTLVerified=true;summary.binaryAndSixTypesVerified=true
    }
  }else if(engine==='sqlite'){
    const source='/steelkeep/sqlite/source/source.sqlite',target='/steelkeep/sqlite/target/target.sqlite'
    const input=new Database(source,{readonly:true,create:false}),output=new Database(target,{readonly:true,create:false})
    const before=input.query('SELECT id,body,hex(payload) AS payload FROM entries ORDER BY id').all();input.close();assert(output.query('SELECT count(*) AS n FROM sqlite_schema').get()&&((output.query('SELECT count(*) AS n FROM sqlite_schema').get() as {n:number}).n===0),'SQLite target is not empty');output.close()
    sourceInput={kind:'sqlite',path:source};targetInput={kind:'sqlite',path:target,restoreTarget:true}
    verify=async()=>{const result=new Database(target,{readonly:true,create:false}),original=new Database(source,{readonly:true,create:false});try{assert(JSON.stringify(result.query('SELECT id,body,hex(payload) AS payload FROM entries ORDER BY id').all())===JSON.stringify(before),'SQLite rows differ');assert(JSON.stringify(original.query('SELECT id,body,hex(payload) AS payload FROM entries ORDER BY id').all())===JSON.stringify(before),'SQLite source changed');assert((result.query('PRAGMA integrity_check').get() as {integrity_check:string}).integrity_check==='ok','SQLite integrity failed');assert(result.query('PRAGMA foreign_key_check').all().length===0,'SQLite foreign keys failed');assert((result.query('SELECT seq FROM sqlite_sequence WHERE name=\'entries\'').get() as {seq:number}).seq===10,'SQLite sequence differs');summary.integrityAndSequencesVerified=true}finally{result.close();original.close()}}
  }else{
    sourceInput={kind:'clickhouse',host:'clickhouse-fixture',port:8123,database:'fixture_ch_source',user:'backup_reader',password:'local-clickhouse-reader-only',tls:false,backupDisk:'steelkeep_backup',sharedBackupRoot:'/steelkeep/clickhouse',quiescentSource:true}
    targetInput={kind:'clickhouse',host:'clickhouse-fixture',port:8123,database:'fixture_ch_target',user:'restore_writer',password:'local-clickhouse-writer-only',tls:false,backupDisk:'steelkeep_backup',sharedBackupRoot:'/steelkeep/clickhouse',restoreTarget:true}
    const query=async(sql:string)=>{const r=await fetch('http://clickhouse-fixture:8123/',{method:'POST',headers:{authorization:'Basic '+Buffer.from('fixture_owner:local-clickhouse-owner-only').toString('base64')},body:sql,signal:AbortSignal.timeout(30000)});assert(r.ok&&!Number(r.headers.get('X-ClickHouse-Exception-Code')),'Independent ClickHouse query failed');return r}
    const before=new Uint8Array(await(await query('SELECT * FROM fixture_ch_source.entries ORDER BY id SETTINGS max_threads=1 FORMAT Native')).arrayBuffer())
    verify=async()=>{const after=new Uint8Array(await(await query('SELECT * FROM fixture_ch_target.entries ORDER BY id SETTINGS max_threads=1 FORMAT Native')).arrayBuffer());assert(createHash('sha256').update(after).digest('hex')===createHash('sha256').update(before).digest('hex'),'ClickHouse lossless Native bytes differ');const rows=await(await query('SELECT toString(id) AS id,label,toString(amount) AS amount,tags,toString(occurred) AS occurred,hex(fixed) AS fixed FROM fixture_ch_target.entries ORDER BY id FORMAT JSON')).json() as {data:unknown[]};assert(rows.data.length===3,'ClickHouse recovered row count differs');summary.losslessNativeBytesVerified=true;summary.rows=rows.data}
  }
  const source=await rest<{id:string}>('/connections',{name:'Runtime '+engine+' source',...sourceInput}),target=await rest<{id:string}>('/connections',{name:'Runtime '+engine+' target',...targetInput})
  for(const row of [source,target,storage])assert((await tool<{status:string}>('test_connection',{id:row.id})).status==='available','Connection failed')
  const plan=await rest<{id:string}>('/plans',{name:'Runtime '+engine+' proof',sourceId:source.id,storageId:storage.id,timezone:'UTC'})
  const key=randomUUID(),accepted=await tool<Job>('run_backup',{planId:plan.id,idempotencyKey:key});assert((await tool<Job>('run_backup',{planId:plan.id,idempotencyKey:key})).id===accepted.id,'Backup key replay differs');summary.backupRun=accepted.id
  const backup=await completed(accepted.id),artifact=(await tool<Artifact[]>('list_backups')).find(x=>x.id===backup.artifact_id);assert(artifact&&artifact.engine===engine,'Missing published artifact');summary.toolVersion=artifact!.tool_version;summary.artifactId=artifact!.id
  const object=await s3.send(new GetObjectCommand({Bucket:bucket,Key:artifact!.object_key}));assert(object.Body,'No object body');const bytes=await object.Body!.transformToByteArray();assert(bytes.length===Number(artifact!.size)&&createHash('sha256').update(bytes).digest('hex')===artifact!.sha256,'Independent S3 bytes/SHA differ');summary.archiveBytes=bytes.length;summary.actualS3SHA256=true
  const review=await tool<{intentId:string;review:{checks:Record<string,boolean>}}>('prepare_restore',{artifactId:artifact!.id,targetId:target.id});assert(Object.values(review.review.checks).every(Boolean),'Restore review failed')
  const restoreKey=randomUUID(),started=await tool<Job>('start_restore',{intentId:review.intentId,idempotencyKey:restoreKey});assert((await tool<Job>('start_restore',{intentId:review.intentId,idempotencyKey:restoreKey})).id===started.id,'Restore key replay differs');summary.restoreRun=started.id
  const done=await completed(started.id);assert(done.validation?.status==='passed'&&done.validation.integrity==='sha256-matched','Restore was not validated');await verify();summary.independentDataVerified=true
  await writeFile('/tmp/runtime-'+engine+'-proof.json',JSON.stringify(summary,null,2),{mode:0o600});console.log(JSON.stringify(summary))
}finally{await redisTarget?.close().catch(()=>{});await redis?.close().catch(()=>{});s3.destroy();await client.close()}
