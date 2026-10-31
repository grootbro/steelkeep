import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import mysql from 'mysql2/promise'
import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'
import {connectDb} from '../server/db'
import {createNativeAdapter} from '../server/engines/native'
import {manifestComparison,assertProtectedDatabase} from '../server/engines/database'

if(process.platform!=='linux'||process.env.STEELKEEP_RUNTIME_CORE!=='synthetic-server'||process.env.DEBUG||process.env.NODE_DEBUG||process.env.PWDEBUG)throw new Error('Use only the isolated non-debug Linux core stand.')
const engine=process.argv[2]??'',phase=process.argv[3]??''
if(engine!=='mysql'&&engine!=='mariadb'||!['direct','mcp'].includes(phase))throw new Error('Choose mysql/mariadb and direct/mcp explicitly.')
const nonce='14bafed8114d2c726a31e7040b155f28',bucket='steelkeep-core-'+nonce.slice(0,12)
if(process.env.STEELKEEP_RUNTIME_PROOF_NONCE!==nonce||process.env.STEELKEEP_RUNTIME_PROOF_BUCKET!==bucket)throw new Error('Wrong stand identity.')
const metadata=new URL(process.env.DATABASE_URL??'')
if(metadata.hostname!=='database'||metadata.pathname!=='/steelkeep_runtime_core'||metadata.username!=='steelkeep')throw new Error('Wrong metadata database.')
const {db}=connectDb()
try{
 const identity=await db.selectFrom('runtime_proof_identity' as never).selectAll().executeTakeFirst() as {nonce:string}|undefined
 if(identity?.nonce!==nonce||await db.selectFrom('owner_account').select('id').executeTakeFirst())throw new Error('Metadata guard failed; owner data cannot be used.')
}finally{await db.destroy()}
const assert=(condition:unknown,message:string)=>{if(!condition){summary.failureCheck=message;throw new Error(message)}}
const prefix='/opt/steelkeep-sqlclients',host=engine==='mysql'?'sqlclients-mysql8':'sqlclients-mariadb11'
const sourceDb=engine==='mysql'?'source_mysql8':'source_mysql',directDb=engine==='mysql'?'restore_mysql8':'restore_mysql',targetDb=engine==='mysql'?'restore_mysql8_mcp':'restore_mariadb11_mcp'
const readerPassword=engine==='mysql'?'local-mysql8-reader-only':'local-mysql-reader-only',directPassword=engine==='mysql'?'local-mysql8-writer-only':'local-mysql-writer-only',targetPassword=engine==='mysql'?'synthetic-mysql8-mcp-writer':'synthetic-mariadb11-mcp-writer'
const summary:Record<string,unknown>={engine,phase,nonce,sourceSnapshot:'ef8bae643ac1f87a2b19193db74ca9a91ddb112401872670905b23f7d7ad7cb8',runtimeImage:'cf3d84df5261',nativePrefix:prefix,stage:'guarded',passed:false}
const output=`/tmp/runtime-sqlclients-${engine}-${phase}-proof.json`
async function save(){await writeFile(output,JSON.stringify(summary,null,2),{mode:0o600})}
const config=(database:string,user:string)=>({engine,host,port:3306,database,user,tls:false,restoreTarget:user!=='backup_reader',allowGlobalReadLock:user==='backup_reader'})
async function independent(database:string,user:string,password:string){
 const connection=await mysql.createConnection({host,port:3306,database,user,password,connectTimeout:5000,supportBigNumbers:true,bigNumberStrings:true,dateStrings:true,multipleStatements:false,charset:'utf8mb4'})
 try{
  if(engine==='mysql')await connection.query('SET SESSION information_schema_stats_expiry=0')
  const [version]=await connection.query('SELECT VERSION() AS version')
  const [projects]=await connection.query('SELECT * FROM projects ORDER BY id'),[entries]=await connection.query('SELECT * FROM entries ORDER BY id')
  const [sequence]=await connection.query("SELECT CAST(auto_increment AS CHAR) AS next_value FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='projects'")
  return {version,projects,entries,sequence}
 }finally{await connection.end()}
}
let client:Client|undefined,s3:S3Client|undefined
try{
 const before=await independent(sourceDb,'backup_reader',readerPassword)
 summary.serverVersion=(before.version as {version:string}[])[0].version
 assert(engine==='mysql'?/^8\.0\.46(?:\D|$)/.test(String(summary.serverVersion))&&!/mariadb/i.test(String(summary.serverVersion)):/^11\.4\.13.*mariadb/i.test(String(summary.serverVersion)),'Wrong vendor/version fixture')
 const sourceRows=JSON.stringify({projects:before.projects,entries:before.entries,sequence:before.sequence})
 summary.sourceRowsSha256=createHash('sha256').update(sourceRows).digest('hex')
 if(phase==='direct'){
  const signal=AbortSignal.timeout(120000),source=createNativeAdapter(engine,{config:config(sourceDb,'backup_reader'),secret:{password:readerPassword},signal}),target=createNativeAdapter(engine,{config:config(directDb,'restore_writer'),secret:{password:directPassword},signal}),directory=await mkdtemp('/tmp/sqlclients-direct-')
  try{
   summary.stage='native-adapter';assertProtectedDatabase(sourceDb);assertProtectedDatabase(directDb)
   await source.connect();await target.connect();await target.restrictedRestoreRole();assert(await target.empty(),'Direct target is not empty; nothing was reset')
   const file=directory+'/archive.sql',phases:string[]=[];await mkdir(directory+'/capture');await mkdir(directory+'/restore')
   const captured=await source.backup(file,directory+'/capture',signal,async phase=>{phases.push(phase)})
   const restored=await target.restore(file,directory+'/restore',signal),validation=manifestComparison(captured.manifest,await target.manifest())
   assert(validation.passed,'Native manifest validation failed');const after=await independent(directDb,'restore_writer',directPassword),sourceAfter=await independent(sourceDb,'backup_reader',readerPassword)
   assert(JSON.stringify({projects:after.projects,entries:after.entries,sequence:after.sequence})===sourceRows,'Independent direct restore rows differ')
   assert(JSON.stringify({projects:sourceAfter.projects,entries:sourceAfter.entries,sequence:sourceAfter.sequence})===sourceRows,'Source changed')
   const bytes=await readFile(file);assert(bytes.length>0,'Native dump is empty');Object.assign(summary,{toolVersion:captured.toolVersion,restoreToolVersion:restored.toolVersion,validation,archiveBytes:bytes.length,archiveSha256:createHash('sha256').update(bytes).digest('hex'),phases,independentRowsVerified:true,sourceUnchanged:true,passed:true})
  }finally{await target.close();await source.close();await rm(directory,{recursive:true,force:true})}
 }else{
  const token=(await readFile('/run/secrets/token','utf8')).trim(),base='http://core-api:4311'
  client=new Client({name:'steelkeep-native-sqlclients-proof',version:'0.1.0'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}}))
  async function tool<T>(name:string,args:Record<string,unknown>={}):Promise<T>{const value=await client!.callTool({name,arguments:args});assert(!value.isError,'MCP '+name+' refused; do not replace uncertain requests');const item=value.content?.find(x=>x.type==='text');assert(item?.type==='text','Missing MCP JSON');return JSON.parse(item!.type==='text'?item!.text:'') as T}
  async function rest<T>(path:string,body:unknown):Promise<T>{const response=await fetch(base+'/api/v1'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});assert(response.ok,'API operation refused ('+response.status+')');return response.json() as Promise<T>}
  type Connection={id:string;name:string;kind:string;config:Record<string,unknown>};type Job={id:string;status:string;artifact_id:string|null;error_code:string|null;validation:Record<string,unknown>|null};type Artifact={id:string;object_key:string;size:string;sha256:string;engine:string;tool_version:string}
  async function completed(id:string){for(let i=0;i<180;i++){const job=await tool<Job>('get_job',{id});if(['succeeded','failed','interrupted','cancelled'].includes(job.status)){assert(job.status==='succeeded','Job '+id+' ended '+job.status+' / '+job.error_code);return job}await Bun.sleep(1000)}throw new Error('Job deadline; no automatic resubmission')}
  const connections=await tool<Connection[]>('list_connections'),storage=connections.find(c=>c.name==='Runtime private storage'&&c.kind==='s3')
  assert(storage,'Synthetic private storage missing');assert(!connections.some(c=>c.name==='Runtime '+engine+' source'),'Previous proof exists; inspect its saved commands instead of repeating writes')
  summary.stage='create-connections';await save()
  const source=await rest<{id:string}>('/connections',{name:'Runtime '+engine+' source',kind:engine,host,port:3306,database:sourceDb,user:'backup_reader',password:readerPassword,tls:false,allowGlobalReadLock:true}),target=await rest<{id:string}>('/connections',{name:'Runtime '+engine+' target',kind:engine,host,port:3306,database:targetDb,user:'mcp_restore',password:targetPassword,tls:false,restoreTarget:true})
  for(const item of [source,target,storage!])assert((await tool<{status:string}>('test_connection',{id:item.id})).status==='available','Fixture connection check failed')
  const plan=await rest<{id:string}>('/plans',{name:'Runtime '+engine+' proof',sourceId:source.id,storageId:storage!.id,timezone:'UTC'}),backupKey=randomUUID();Object.assign(summary,{sourceId:source.id,targetId:target.id,planId:plan.id,backupKey,stage:'backup-command'});await save()
  const accepted=await tool<Job>('run_backup',{planId:plan.id,idempotencyKey:backupKey});summary.backupRun=accepted.id;await save();assert((await tool<Job>('run_backup',{planId:plan.id,idempotencyKey:backupKey})).id===accepted.id,'Backup replay changed job')
  const done=await completed(accepted.id),artifact=(await tool<Artifact[]>('list_backups')).find(a=>a.id===done.artifact_id);assert(artifact?.engine===engine,'Published native artifact missing');Object.assign(summary,{artifactId:artifact!.id,toolVersion:artifact!.tool_version,stage:'independent-s3'});await save()
  s3=new S3Client({endpoint:'http://s3:9000',region:'us-east-1',forcePathStyle:true,maxAttempts:1,credentials:{accessKeyId:(await readFile('/run/secrets/s3-access-key','utf8')).trim(),secretAccessKey:(await readFile('/run/secrets/s3-secret-key','utf8')).trim()}})
  const object=await s3.send(new GetObjectCommand({Bucket:bucket,Key:artifact!.object_key}));assert(object.Body,'S3 body missing');const bytes=await object.Body!.transformToByteArray();assert(bytes.length===Number(artifact!.size)&&createHash('sha256').update(bytes).digest('hex')===artifact!.sha256,'Independent S3 bytes/SHA mismatch');Object.assign(summary,{archiveBytes:bytes.length,actualS3Sha256:true,stage:'restore-review'});await save()
  const review=await tool<{intentId:string;review:{checks:Record<string,boolean>}}>('prepare_restore',{artifactId:artifact!.id,targetId:target.id});assert(Object.values(review.review.checks).every(Boolean),'Restore review failed');const restoreKey=randomUUID();Object.assign(summary,{intentId:review.intentId,restoreKey,stage:'restore-command'});await save()
  const started=await tool<Job>('start_restore',{intentId:review.intentId,idempotencyKey:restoreKey});summary.restoreRun=started.id;await save();assert((await tool<Job>('start_restore',{intentId:review.intentId,idempotencyKey:restoreKey})).id===started.id,'Restore replay changed job')
  const restored=await completed(started.id);assert(restored.validation?.status==='passed'&&restored.validation.integrity==='sha256-matched','Worker restore validation not passed')
  const after=await independent(targetDb,'mcp_restore',targetPassword),sourceAfter=await independent(sourceDb,'backup_reader',readerPassword)
  assert(JSON.stringify({projects:after.projects,entries:after.entries,sequence:after.sequence})===sourceRows,'Independent MCP restore rows differ');assert(JSON.stringify({projects:sourceAfter.projects,entries:sourceAfter.entries,sequence:sourceAfter.sequence})===sourceRows,'Source changed')
  Object.assign(summary,{independentRowsVerified:true,sourceUnchanged:true,validation:restored.validation,backupKeyReplay:true,restoreKeyReplay:true,passed:true})
 }
 summary.stage='complete';await save();console.log(JSON.stringify(summary))
}catch(error){summary.failureStage=summary.stage;summary.stage='failed';summary.errorCode=error&&typeof error==='object'&&'code'in error?String(error.code):'CHECK_FAILED';await save();throw new Error('Synthetic SQL proof failed at '+summary.failureStage+' ('+summary.errorCode+'); inspect its private journal, no replacement command sent')}
finally{s3?.destroy();await client?.close()}
