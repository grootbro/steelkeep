import {randomUUID} from 'node:crypto'
import {DeleteObjectCommand,HeadObjectCommand,type HeadObjectOutput} from '@aws-sdk/client-s3'
import {sql,type Kysely,type Selectable} from 'kysely'
import type {Schema} from './db'
import {AppError,safeFailure,unseal} from './security'
import {storageClient,type StorageConfig,type S3Secret} from './services'
import {audit} from './agents'
import {RetentionServices,retentionSelection} from './retention'
import {deletionPublication,deletionProtection} from './artifact-deletions'

const extensions:Record<string,string>={postgres:'.dump',mysql:'.sql',mariadb:'.sql',mongodb:'.archive.gz',sqlite:'.sqlite',redis:'.redis.ndjson',clickhouse:'.zip',mssql:'.bacpac'}
function missing(error:unknown){const e=error as {name?:string;$metadata?:{httpStatusCode?:number}};return e?.$metadata?.httpStatusCode===404||e?.name==='NoSuchKey'||e?.name==='NoSuchVersion'||e?.name==='NotFound'}
function deletionFailure(error:unknown){
 if(error instanceof AppError)return {failure:safeFailure(error),retry:false}
 const e=error as {name?:string;$metadata?:{httpStatusCode?:number}},status=e?.$metadata?.httpStatusCode
 if(status===412)return {failure:{code:'RETENTION_OBJECT_CHANGED',message:'The conditional object identity changed. No unconditional delete will be attempted.'},retry:false}
 if(status===401||status===403)return {failure:{code:'RETENTION_STORAGE_DENIED',message:'Storage refused cleanup. Check the dedicated deletion permissions.'},retry:false}
 if(status===400||status===405||status===501)return {failure:{code:'RETENTION_CONDITIONAL_UNSUPPORTED',message:'Storage did not accept the required conditional delete. No unconditional fallback is allowed.'},retry:false}
 return {failure:{code:'RETENTION_STORAGE_UNCERTAIN',message:'Object deletion or its final absence could not be confirmed. This backup stays reserved.'},retry:true}
}
async function owner(db:Kysely<Schema>,epoch:string){
 const row=await db.selectFrom('worker_state').select('epoch').where('singleton','=',true).forShare().executeTakeFirst()
 if(row?.epoch!==epoch)throw new AppError('RETENTION_WORKER_FENCED','This cleanup worker no longer owns execution.',409)
}
async function lockedContext(db:Kysely<Schema>,id:string){
 const known=await db.selectFrom('retention_jobs').select(['plan_id','artifact_id','kind']).where('id','=',id).executeTakeFirstOrThrow()
 const plan=known.kind==='policy'&&known.plan_id?await db.selectFrom('plans').selectAll().where('id','=',known.plan_id).forUpdate().executeTakeFirstOrThrow():null
 const artifact=await db.selectFrom('artifacts').selectAll().where('id','=',known.artifact_id).forUpdate().executeTakeFirstOrThrow()
 const job=await db.selectFrom('retention_jobs').selectAll().where('id','=',id).forUpdate().executeTakeFirstOrThrow()
 return {plan,artifact,job}
}
async function eligible(db:Kysely<Schema>,context:Awaited<ReturnType<typeof lockedContext>>){
 const {plan,artifact,job}=context
 if(job.kind==='manual'){
  if(!['queued','deleting','held'].includes(artifact.deletion_state))throw new AppError('DELETION_REVIEW_CHANGED','The snapshot deletion reservation changed.',409)
  const source=await db.selectFrom('connections').selectAll().where('id','=',artifact.source_id).executeTakeFirstOrThrow()
  const reason=await deletionProtection(db,artifact,source,true)
  if(reason)throw new AppError('DELETION_PROTECTED','This snapshot became protected after deletion was reviewed. Its object was not deleted.',409)
 }else{
  if(!plan||!plan.retention_enabled||plan.retention_policy.mode==='keep_all'||plan.retention_revision!==job.policy_revision)throw new AppError('RETENTION_POLICY_CHANGED','Cleanup authorization changed. Review this reserved job before retrying.',409)
  const selected=await retentionSelection(db,plan,undefined,artifact.id)
  if(artifact.retention_locked||!selected.candidates.some(row=>row.id===artifact.id))throw new AppError('RETENTION_NOT_ELIGIBLE','This backup is kept by policy or protected by a lock or restore.',409)
 }
 const storage=await db.selectFrom('connections').selectAll().where('id','=',artifact.storage_id).forUpdate().executeTakeFirstOrThrow()
 if(storage.kind!=='s3'||storage.revision!==job.storage_revision)throw new AppError('RETENTION_STORAGE_CHANGED','Storage settings changed. Review cleanup authorization before retrying.',409)
 const run=await db.selectFrom('runs').selectAll().where('id','=',artifact.run_id).executeTakeFirstOrThrow(),settings=storage.config as StorageConfig
 if(job.kind==='manual'){
  const source=await db.selectFrom('connections').selectAll().where('id','=',artifact.source_id).executeTakeFirstOrThrow(),publication=deletionPublication(artifact,run,source,storage)
  if(!publication.valid||publication.fingerprint!==job.manual_fingerprint)throw new AppError('DELETION_REVIEW_CHANGED','The immutable publication or connection revision changed after deletion was reviewed.',409)
  return {storage,settings}
 }
 const extension=extensions[artifact.engine],expected=[settings.prefix,run.id,run.execution_token,artifact.id+extension].filter(Boolean).join('/')
 if(!plan||!extension||!run.execution_token||run.type!=='backup'||run.status!=='succeeded'||run.artifact_id!==artifact.id||run.plan_id!==plan.id||run.source_id!==artifact.source_id||run.storage_id!==artifact.storage_id||artifact.object_key!==expected||!Number.isSafeInteger(Number(artifact.size))||Number(artifact.size)<=0||!/^[a-f0-9]{64}$/.test(artifact.sha256))throw new AppError('RETENTION_OWNERSHIP_UNCERTAIN','The stored object is not a verified immutable publication owned by this backup plan.',409)
 return {storage,settings}
}
function verifyHead(head:HeadObjectOutput,artifact:Selectable<Schema['artifacts']>,etag?:string|null){
 if(head.ContentLength!==Number(artifact.size)||head.Metadata?.sha256!==artifact.sha256||head.Metadata?.engine!==artifact.engine||typeof head.ETag!=='string'||!head.ETag||head.ETag==='*'||head.ETag.length>1024||/[\r\n\0]/.test(head.ETag)||etag&&head.ETag!==etag)throw new AppError('RETENTION_OBJECT_CHANGED','Stored object size, checksum metadata or conditional identity differs from the published backup. It was not deleted.',409)
}
async function finish(db:Kysely<Schema>,context:Awaited<ReturnType<typeof lockedContext>>,deleted=false){
 await db.updateTable('artifacts').set({deletion_state:'deleted',deleted_at:sql`clock_timestamp()`,availability:'missing',checked_at:sql`clock_timestamp()`}).where('id','=',context.artifact.id).execute()
 await db.updateTable('retention_jobs').set({status:'succeeded',finished_at:sql`clock_timestamp()`,next_attempt_at:null,error_code:null,error_message:null}).where('id','=',context.job.id).execute()
 await audit(db,context.job.actor,deleted?'backup.object.deleted':'backup.object.absence.confirmed',context.artifact.id)
}
export async function recoverRetentionClaims(db:Kysely<Schema>,epoch:string){
 const interrupted=await db.selectFrom('retention_jobs').selectAll().where('status','=','deleting').where(eb=>eb.or([eb('worker_epoch','!=',epoch),eb('worker_epoch','is',null)])).orderBy('artifact_id').execute()
 for(const job of interrupted){
  await db.selectFrom('artifacts').select('id').where('id','=',job.artifact_id).forUpdate().execute()
  const retry=job.kind==='policy'&&job.attempt<job.max_attempts
  await db.updateTable('retention_jobs').set({status:retry?'retry_wait':'held',next_attempt_at:retry?sql`clock_timestamp()`:null,execution_token:null,worker_epoch:null,error_code:'RETENTION_WORKER_INTERRUPTED',error_message:'The previous cleanup result is uncertain. The exact object identity and deletion reservation are retained.'}).where('id','=',job.id).execute()
  await db.updateTable('artifacts').set({deletion_state:'held'}).where('id','=',job.artifact_id).where('deletion_state','!=','deleted').execute()
 }
}
export async function evaluateRetention(db:Kysely<Schema>){
 const plan=await db.selectFrom('plans').select('id').where('retention_enabled','=',true).where(eb=>eb.or([eb('retention_checked_at','is',null),eb('retention_checked_at','<',sql<Date>`clock_timestamp()-interval '60 seconds'`)])).orderBy('retention_checked_at','asc').limit(1).executeTakeFirst()
 if(!plan)return
 try{await db.transaction().execute(trx=>new RetentionServices(trx).queueInTransaction(trx,plan.id,'retention-worker'))}
 catch(error){const failure=safeFailure(error);await db.transaction().execute(async trx=>{await trx.updateTable('plans').set({retention_checked_at:sql`clock_timestamp()`,retention_error_code:failure.code,retention_error_message:failure.message}).where('id','=',plan.id).execute();await audit(trx,'retention-worker','retention.evaluation.failed',plan.id)})}
}
export async function processRetentionJob(db:Kysely<Schema>,epoch:string,externalSignal:AbortSignal){
 if(externalSignal.aborted)return false
 const pending=await db.selectFrom('retention_jobs').select('id').where('status','in',['queued','retry_wait']).where('next_attempt_at','<=',sql<Date>`clock_timestamp()`).orderBy('created_at','asc').limit(1).executeTakeFirst()
 if(!pending)return false
 const token=randomUUID(),signal=AbortSignal.any([externalSignal,AbortSignal.timeout(20000)])
 const claimed=await db.transaction().execute(async trx=>{
  await owner(trx,epoch);const context=await lockedContext(trx,pending.id),{job,artifact}=context
  if(!['queued','retry_wait'].includes(job.status))return false
  try{await eligible(trx,context)}catch(error){
   const failure=safeFailure(error),unstarted=job.attempt===0
   await trx.updateTable('retention_jobs').set({status:unstarted?'cancelled':'held',next_attempt_at:null,finished_at:unstarted?sql`clock_timestamp()`:null,error_code:failure.code,error_message:failure.message}).where('id','=',job.id).execute()
   await trx.updateTable('artifacts').set({deletion_state:unstarted?'active':'held'}).where('id','=',artifact.id).execute();await audit(trx,job.actor,unstarted?'retention.deletion.cancelled':'retention.deletion.held',job.id);return false
  }
  if(job.attempt>=job.max_attempts)return false
  await trx.updateTable('retention_jobs').set({status:'deleting',attempt:job.attempt+1,execution_token:token,worker_epoch:epoch,next_attempt_at:null,error_code:null,error_message:null}).where('id','=',job.id).execute()
  await trx.updateTable('artifacts').set({deletion_state:'deleting'}).where('id','=',artifact.id).execute();return true
 })
 if(!claimed)return false
 try{
  // Commit an immutable object identity before issuing DeleteObject. A restart
  // must never probe a newly revealed version and delete somebody else's data.
  await db.transaction().execute(async trx=>{
   await owner(trx,epoch);const context=await lockedContext(trx,pending.id),{job,artifact}=context
   if(job.execution_token!==token||job.status!=='deleting')throw new AppError('RETENTION_WORKER_FENCED','Cleanup ownership changed.',409)
   const {storage,settings}=await eligible(trx,context)
   if(job.object_etag)return
   const client=storageClient(settings,unseal<S3Secret>(storage.secret),job.kind==='manual'?1:2)
   try{
    let head:HeadObjectOutput
    try{head=await client.send(new HeadObjectCommand({Bucket:settings.bucket,Key:artifact.object_key}),{abortSignal:signal})}catch(error){if(missing(error)){await finish(trx,context);return}throw error}
    verifyHead(head,artifact)
    await trx.updateTable('retention_jobs').set({object_etag:head.ETag!,object_version_id:head.VersionId??null}).where('id','=',job.id).execute()
   }finally{client.destroy()}
  })
  await db.transaction().execute(async trx=>{
   await owner(trx,epoch);const context=await lockedContext(trx,pending.id),{job,artifact}=context
   if(job.status==='succeeded')return
   if(job.execution_token!==token||job.status!=='deleting'||!job.object_etag)throw new AppError('RETENTION_WORKER_FENCED','Cleanup ownership or object identity changed.',409)
   const {storage,settings}=await eligible(trx,context),client=storageClient(settings,unseal<S3Secret>(storage.secret),job.kind==='manual'?1:2)
   const object={Bucket:settings.bucket,Key:artifact.object_key,...(job.object_version_id?{VersionId:job.object_version_id}:{})}
   try{
    let head:HeadObjectOutput
    try{head=await client.send(new HeadObjectCommand(object),{abortSignal:signal})}catch(error){if(missing(error)){await finish(trx,context);return}throw error}
    verifyHead(head,artifact,job.object_etag)
    await client.send(new DeleteObjectCommand({...object,IfMatch:job.object_etag}),{abortSignal:signal})
    try{await client.send(new HeadObjectCommand(object),{abortSignal:signal});throw new AppError('RETENTION_DELETE_UNCONFIRMED','Storage still reports the selected object after deletion. The backup remains reserved.',409)}catch(error){if(!missing(error))throw error}
    await finish(trx,context,true)
   }finally{client.destroy()}
  })
 }catch(error){
  const {failure,retry}=deletionFailure(error)
  await db.transaction().execute(async trx=>{
   const context=await lockedContext(trx,pending.id),{job,artifact}=context
   if(job.execution_token!==token||job.worker_epoch!==epoch||job.status!=='deleting')return
   const again=job.kind==='policy'&&retry&&job.attempt<job.max_attempts
   await trx.updateTable('retention_jobs').set({status:again?'retry_wait':'held',next_attempt_at:again?sql`clock_timestamp()+make_interval(secs=>${10*2**(job.attempt-1)})`:null,error_code:failure.code,error_message:failure.message}).where('id','=',job.id).execute()
   await trx.updateTable('artifacts').set({deletion_state:'held'}).where('id','=',artifact.id).execute();await audit(trx,job.actor,'retention.deletion.held',job.id)
  })
 }
 return true
}
