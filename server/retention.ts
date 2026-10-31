import {randomUUID} from 'node:crypto'
import {sql,type Kysely,type Selectable} from 'kysely'
import type {Schema,RetentionJob} from './db'
import {AppError} from './security'
import {authorize,type Principal} from './auth'
import {audit} from './agents'
import {retentionPolicy,selectRetention,retentionScanLimit,retentionBatchLimit,type RetentionPolicy,type RetentionRow} from './retention-policy'

export function planRetention(plan:Selectable<Schema['plans']>){return {policy:plan.retention_policy,enabled:plan.retention_enabled,revision:plan.retention_revision,timezone:plan.timezone,lastEvaluatedAt:plan.retention_checked_at,lastErrorCode:plan.retention_error_code,lastErrorMessage:plan.retention_error_message}}
export function retainedPlanDto(plan:Selectable<Schema['plans']>){const {retention_policy:_,retention_enabled:__,retention_revision:___,retention_checked_at:____,retention_error_code:_____,retention_error_message:______,...rest}=plan;return {...rest,retention:planRetention(plan)}}
export function retentionJobDto(job:Selectable<RetentionJob>){return {id:job.id,planId:job.plan_id,artifactId:job.artifact_id,status:job.status,attempt:job.attempt,maxAttempts:job.max_attempts,nextAttemptAt:job.next_attempt_at,errorCode:job.error_code,errorMessage:job.error_message,createdAt:job.created_at,finishedAt:job.finished_at}}
function uuid(value:string){if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw new AppError('INVALID_ID','Use a valid resource identifier.');return value}
function requestKey(value:string){if(typeof value!=='string'||value.length<16||value.length>160||/[\r\n\0]/.test(value))throw new AppError('INVALID_REQUEST_KEY','Use a request key of 16 to 160 characters.');return value}

export async function retentionSelection(db:Kysely<Schema>,plan:Selectable<Schema['plans']>,policy=plan.retention_policy,includeReservedId?:string){
 policy=retentionPolicy(policy)
 const clock=await sql<{now:Date;cutoff:Date}>`SELECT clock_timestamp() AS now,((clock_timestamp() AT TIME ZONE ${plan.timezone})-make_interval(days=>${policy.mode==='days'?policy.days:0})) AT TIME ZONE ${plan.timezone} AS cutoff`.execute(db)
 const rows=await sql<RetentionRow>`SELECT a.id,a.created_at,a.size::text,a.retention_locked,a.deletion_state,
 CASE WHEN EXISTS(SELECT 1 FROM restore_intents i WHERE i.artifact_id=a.id AND i.consumed_run_id IS NULL AND i.expires_at>clock_timestamp()) THEN 'restore_review'
 WHEN EXISTS(SELECT 1 FROM runs rr WHERE rr.artifact_id=a.id AND rr.type='restore' AND rr.status IN ('queued','running','cancelling')) THEN 'restore_active'
 WHEN EXISTS(SELECT 1 FROM target_blocks b JOIN runs rr ON rr.id=b.run_id WHERE rr.artifact_id=a.id AND NOT(rr.status='succeeded' AND coalesce(rr.validation->>'passed'='true',false) AND coalesce(rr.validation->>'status'='passed',false))) THEN 'restore_uncertain'
 ELSE NULL END AS pin
 FROM artifacts a JOIN runs r ON r.id=a.run_id
 WHERE r.plan_id=${plan.id} AND r.type='backup' AND r.status='succeeded' AND r.artifact_id=a.id AND a.source_id=${plan.source_id} AND a.storage_id=${plan.storage_id} AND a.deletion_state<>'deleted'
 ORDER BY a.created_at DESC,a.id DESC LIMIT ${retentionScanLimit+1}`.execute(db)
 if(rows.rows.length>retentionScanLimit)throw new AppError('RETENTION_SCAN_LIMIT','This plan exceeds the bounded retention evaluation limit. No cleanup was queued.',409)
 const selection=selectRetention(rows.rows,policy,clock.rows[0].now,plan.timezone,clock.rows[0].cutoff,includeReservedId)
 return {...selection,now:clock.rows[0].now,scanned:rows.rows.length,policy}
}
async function cancelUnstarted(db:Kysely<Schema>,artifactId:string,code:string){
 const jobs=await db.selectFrom('retention_jobs').selectAll().where('artifact_id','=',artifactId).where('status','=','queued').where('attempt','=',0).forUpdate().execute()
 for(const job of jobs)await db.updateTable('retention_jobs').set({status:'cancelled',finished_at:sql`clock_timestamp()`,error_code:code,error_message:'Cleanup cancelled before any object deletion attempt.'}).where('id','=',job.id).execute()
 if(jobs.length)await db.updateTable('artifacts').set({deletion_state:'active'}).where('id','=',artifactId).where('deletion_state','=','queued').execute()
}
export class RetentionServices{
 constructor(readonly db:Kysely<Schema>){}
 async preview(planId:string,policy?:RetentionPolicy){
  const plan=await this.db.selectFrom('plans').selectAll().where('id','=',uuid(planId)).executeTakeFirst()
  if(!plan)throw new AppError('NOT_FOUND','Backup plan not found.',404)
  const selected=await retentionSelection(this.db,plan,policy)
  return {planId,revision:plan.retention_revision,enabled:plan.retention_enabled,policy:selected.policy,timezone:plan.timezone,evaluatedAt:selected.now,scanned:selected.scanned,kept:selected.kept,candidateCount:selected.candidates.length,bytes:selected.bytes,candidates:selected.candidates.slice(0,100),protectedCount:selected.protectedRows.length,protected:selected.protectedRows.slice(0,100),limit:retentionScanLimit}
 }
 async update(principal:Principal,planId:string,input:{policy:RetentionPolicy;enabled:boolean;revision:number;confirmDeletion?:boolean}){
  authorize(principal,'configure');authorize(principal,'backup:delete');uuid(planId)
  if(typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.revision)||input.revision<1)throw new AppError('INVALID_RETENTION_POLICY','Supply an enabled boolean and a positive current policy revision.')
  const policy=retentionPolicy(input.policy)
  if(input.enabled&&policy.mode==='keep_all')throw new AppError('INVALID_RETENTION_POLICY','Keep all does not enable automatic cleanup.')
  return this.db.transaction().execute(async trx=>{
   const plan=await trx.selectFrom('plans').selectAll().where('id','=',planId).forUpdate().executeTakeFirst()
   if(!plan)throw new AppError('NOT_FOUND','Backup plan not found.',404)
   if(plan.retention_revision!==input.revision)throw new AppError('REVISION_CONFLICT','The cleanup policy changed. Reload and preview it again.',409)
   if(input.enabled&&(!plan.retention_enabled||JSON.stringify(plan.retention_policy)!==JSON.stringify(policy))&&input.confirmDeletion!==true)throw new AppError('RETENTION_CONFIRMATION_REQUIRED','Explicitly confirm permanent deletion before enabling or changing active cleanup.',409)
   const changed=await trx.updateTable('plans').set({retention_policy:policy,retention_enabled:input.enabled,retention_revision:plan.retention_revision+1,retention_checked_at:null,retention_error_code:null,retention_error_message:null}).where('id','=',planId).returningAll().executeTakeFirstOrThrow()
   const pending=await trx.selectFrom('retention_jobs').select('artifact_id').where('plan_id','=',planId).where('status','=','queued').where('attempt','=',0).execute()
   for(const row of pending){await trx.selectFrom('artifacts').select('id').where('id','=',row.artifact_id).forUpdate().execute();await cancelUnstarted(trx,row.artifact_id,'POLICY_CHANGED')}
   await audit(trx,principal.actor,input.enabled?'retention.policy.enabled':'retention.policy.saved',planId)
   return {planId,...planRetention(changed)}
  })
 }
 async queue(planId:string,revision:number,key:string,principal:Principal){
  authorize(principal,'backup:delete');uuid(planId);requestKey(key)
  if(!Number.isSafeInteger(revision)||revision<1)throw new AppError('INVALID_RETENTION_POLICY','Supply the positive current policy revision.')
  return this.db.transaction().execute(async trx=>{
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},7))`.execute(trx)
   const previous=await trx.selectFrom('retention_requests').selectAll().where('key','=',key).executeTakeFirst()
   if(previous){if(previous.kind!=='run'||previous.actor!==principal.actor||previous.plan_id!==planId||previous.revision!==revision)throw new AppError('IDEMPOTENCY_CONFLICT','This request key belongs to another cleanup operation.',409);return previous.response as unknown as {planId:string;revision:number;queued:number;skipped:number;jobIds:string[];idempotencyKey:string}}
   const response=await this.queueInTransaction(trx,planId,principal.actor,revision,key)
   await trx.insertInto('retention_requests').values({key,actor:principal.actor,plan_id:planId,job_id:null,kind:'run',revision,response}).execute()
   return response
  })
 }
 async queueInTransaction(trx:Kysely<Schema>,planId:string,actor:string,revision?:number,key='automatic'){
  const plan=await trx.selectFrom('plans').selectAll().where('id','=',planId).forUpdate().executeTakeFirst()
  if(!plan)throw new AppError('NOT_FOUND','Backup plan not found.',404)
  if(revision!==undefined&&revision!==plan.retention_revision)throw new AppError('REVISION_CONFLICT','The cleanup policy changed. Preview it again.',409)
  if(!plan.retention_enabled||plan.retention_policy.mode==='keep_all')throw new AppError('RETENTION_DISABLED','Cleanup is not enabled for this plan.',409)
  const selected=await retentionSelection(trx,plan),jobIds:string[]=[]
  for(const candidate of selected.candidates.slice(0,retentionBatchLimit)){
   const artifact=await trx.selectFrom('artifacts').selectAll().where('id','=',candidate.id).forUpdate().executeTakeFirstOrThrow()
   if(artifact.deletion_state!=='active'||artifact.retention_locked)continue
   const current=await retentionSelection(trx,plan)
   if(!current.candidates.some(row=>row.id===artifact.id))continue
   const storage=await trx.selectFrom('connections').select('revision').where('id','=',artifact.storage_id).executeTakeFirstOrThrow(),id=randomUUID()
   await trx.insertInto('retention_jobs').values({id,plan_id:planId,artifact_id:artifact.id,policy_revision:plan.retention_revision,storage_revision:storage.revision,status:'queued',next_attempt_at:sql`clock_timestamp()`,execution_token:null,worker_epoch:null,object_etag:null,object_version_id:null,error_code:null,error_message:null,actor,finished_at:null}).execute()
   await trx.updateTable('artifacts').set({deletion_state:'queued'}).where('id','=',artifact.id).execute()
   await audit(trx,actor,'retention.deletion.queued',artifact.id);jobIds.push(id)
  }
  await trx.updateTable('plans').set({retention_checked_at:sql`clock_timestamp()`,retention_error_code:null,retention_error_message:null}).where('id','=',planId).execute()
  return {planId,revision:plan.retention_revision,queued:jobIds.length,skipped:selected.candidates.length-jobIds.length,jobIds,idempotencyKey:key}
 }
 async jobs(){return (await this.db.selectFrom('retention_jobs').selectAll().orderBy('created_at','desc').limit(100).execute()).map(retentionJobDto)}
 async lock(principal:Principal,artifactId:string,locked:boolean){
  authorize(principal,'backup:delete');uuid(artifactId)
  if(typeof locked!=='boolean')throw new AppError('INVALID_RETENTION_LOCK','Supply an explicit retention lock boolean.')
  return this.db.transaction().execute(async trx=>{
   const artifact=await trx.selectFrom('artifacts').selectAll().where('id','=',artifactId).forUpdate().executeTakeFirst()
   if(!artifact)throw new AppError('NOT_FOUND','Backup not found.',404)
   if(artifact.deletion_state==='deleted')throw new AppError('ARTIFACT_DELETED','This backup object has already been deleted.',409)
   if(locked)await cancelUnstarted(trx,artifactId,'ARTIFACT_LOCKED')
   const row=await trx.updateTable('artifacts').set({retention_locked:locked}).where('id','=',artifactId).returning(['id','retention_locked','deletion_state','deleted_at']).executeTakeFirstOrThrow()
   await audit(trx,principal.actor,locked?'backup.retention.locked':'backup.retention.unlocked',artifactId);return row
  })
 }
 async retry(principal:Principal,jobId:string,key:string){
  authorize(principal,'backup:delete');uuid(jobId);requestKey(key)
  return this.db.transaction().execute(async trx=>{
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},7))`.execute(trx)
   const previous=await trx.selectFrom('retention_requests').selectAll().where('key','=',key).executeTakeFirst()
   if(previous){if(previous.kind!=='retry'||previous.actor!==principal.actor||previous.job_id!==jobId)throw new AppError('IDEMPOTENCY_CONFLICT','This request key belongs to another cleanup operation.',409);return previous.response as unknown as ReturnType<typeof retentionJobDto>}
   const known=await trx.selectFrom('retention_jobs').select(['plan_id','artifact_id']).where('id','=',jobId).executeTakeFirst()
   if(!known)throw new AppError('NOT_FOUND','Cleanup job not found.',404)
   const plan=await trx.selectFrom('plans').selectAll().where('id','=',known.plan_id).forUpdate().executeTakeFirstOrThrow()
   await trx.selectFrom('artifacts').select('id').where('id','=',known.artifact_id).forUpdate().execute()
   const job=await trx.selectFrom('retention_jobs').selectAll().where('id','=',jobId).forUpdate().executeTakeFirstOrThrow()
   if(job.status!=='held')throw new AppError('RETENTION_RETRY_NOT_READY','Only held cleanup jobs can receive an explicit new retry budget.',409)
   const selected=await retentionSelection(trx,plan,undefined,job.artifact_id)
   if(!plan.retention_enabled||!selected.candidates.some(row=>row.id===job.artifact_id))throw new AppError('RETENTION_NOT_ELIGIBLE','The backup is locked, pinned or kept by the current cleanup policy.',409)
   const storage=await trx.selectFrom('connections').select('revision').where('id','=',plan.storage_id).executeTakeFirstOrThrow()
   const updated=await trx.updateTable('retention_jobs').set({status:'retry_wait',max_attempts:job.attempt+3,next_attempt_at:sql`clock_timestamp()`,policy_revision:plan.retention_revision,storage_revision:storage.revision,error_code:null,error_message:null,execution_token:null,worker_epoch:null,finished_at:null}).where('id','=',jobId).returningAll().executeTakeFirstOrThrow()
   const response=retentionJobDto(updated)
   await trx.insertInto('retention_requests').values({key,actor:principal.actor,plan_id:plan.id,job_id:jobId,kind:'retry',revision:plan.retention_revision,response}).execute();await audit(trx,principal.actor,'retention.deletion.retry.authorized',jobId)
   return response
  })
 }
}
