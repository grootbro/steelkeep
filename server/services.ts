import { randomUUID } from 'node:crypto'
import pg from 'pg'
import {realpath,stat} from 'node:fs/promises'
import {isAbsolute,relative} from 'node:path'
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3'
import { CronExpressionParser } from 'cron-parser'
import { sql, type Kysely, type Selectable } from 'kysely'
import type { Schema } from './db'
import type { ConnectionInput, PlanInput, PlanUpdateInput } from './contracts'
import { allowedHost, identifier, seal, unseal, AppError, safeFailure } from './security'
import {config} from './config'
import {resourceKey} from './resources'
import {AgentServices,audit} from './agents'
import {authenticateRequest} from './auth'
export {authenticateRequest,authorize,validateScopedTokens,type Principal,type Scope} from './auth'

export {engineProfiles} from '../shared/engines'
export type DatabaseConfig={engine?:'postgres'|'mysql'|'mariadb'|'mongodb'|'clickhouse'|'mssql';host:string;port:number;database:string;user:string;tls:boolean;restoreTarget:boolean;authDatabase?:string;allowGlobalReadLock?:boolean;backupDisk?:string;sharedBackupRoot?:string;quiescentSource?:boolean}
export type RedisConfig={engine:'redis';host:string;port:number;database:string;dbIndex:number;user:string;tls:boolean;restoreTarget:boolean;allowGlobalReadLock:boolean}
export type SQLiteConfig={engine:'sqlite';path:string;database:string;restoreTarget:boolean}
export type SourceConfig=DatabaseConfig|RedisConfig|SQLiteConfig
export type StorageConfig={endpoint:string;region:string;bucket:string;prefix:string}
export type DbSecret={password:string}
export type S3Secret={accessKey:string;secretKey:string}
export function databaseClient(c:DatabaseConfig,s:DbSecret){
  allowedHost(c.host)
  return new pg.Client({host:c.host,port:c.port,database:c.database,user:c.user,password:s.password,ssl:c.tls?{rejectUnauthorized:true}:false,connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12500})
}
export function storageClient(c:StorageConfig,s:S3Secret){
  allowedHost(new URL(c.endpoint).hostname)
  return new S3Client({endpoint:c.endpoint,region:c.region,forcePathStyle:true,credentials:{accessKeyId:s.accessKey,secretAccessKey:s.secretKey},maxAttempts:2})
}
export function nextOccurrence(cron:string,timezone:string,after=new Date()):Date{
  try{
   const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})
   const localKey=(date:Date)=>formatter.format(date)
   const offset=(date:Date)=>{
    const parts=Object.fromEntries(formatter.formatToParts(date).map(part=>[part.type,part.value]))
    return Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second))-Math.floor(date.getTime()/1000)*1000
   }
   const expression=CronExpressionParser.parse(cron,{tz:timezone,currentDate:after})
   for(let i=0;i<10000;i++){
    const candidate=expression.next().toDate()
    // cron-parser can shift a nonexistent wall time forward; our policy skips it.
    if(!expression.includesDate(candidate))continue
    const currentOffset=offset(candidate)
    let earlier:Date|undefined
    // Recover the earlier copy even when a fresh parser starts inside a DST fold.
    for(const hours of [3,6,12,24,48]){
     const delta=offset(new Date(candidate.getTime()-hours*3600000))-currentOffset
     if(delta<=0)continue
     const alternative=new Date(candidate.getTime()-delta)
     if(localKey(alternative)===localKey(candidate)&&expression.includesDate(alternative)&&(!earlier||alternative<earlier))earlier=alternative
    }
    if(earlier){if(earlier>after)return earlier;continue}
    return candidate
   }
   throw new Error('Schedule search exhausted')
  }catch{throw new AppError('INVALID_SCHEDULE','Check the cron expression and IANA timezone.')}
}
export function upcomingOccurrences(cron:string|null,timezone:string,after=new Date()):string[]{
  if(!cron)return [];const result:string[]=[];let date=after
  for(let i=0;i<3;i++){date=nextOccurrence(cron,timezone,date);result.push(date.toISOString())}return result
}
export function safeRun(run:Selectable<Schema['runs']>){const {execution_token:_,review_fingerprint:__,...safe}=run;return safe}
export function validId(id:string){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw new AppError('INVALID_ID','Use a valid UUID.');return id}
function requestKey(key:string){if(key.length<16||key.length>160||/[\r\n\0]/.test(key))throw new AppError('INVALID_REQUEST_KEY','Use a request key of 16 to 160 characters.');return key}

export class Services {
 readonly agents:AgentServices
 constructor(public db:Kysely<Schema>){this.agents=new AgentServices(db)}
 authenticate(request:Request){return authenticateRequest(request,this.db)}
 sourceBlocks(){return this.db.selectFrom('source_blocks').select(['resource_key','server_identity','run_id','state','reason_code','created_at','updated_at']).orderBy('created_at','desc').limit(100).execute()}
 async reconcileNativeOperation(connectionId:string,operationId:string,actor='installation-owner'){
  validId(operationId)
  const connection=await this.connection(connectionId)
  if(connection.kind!=='clickhouse')throw new AppError('INVALID_ENGINE','Native operation observation is available for the ClickHouse shared-disk profile.')
  const {reconcileClickHouseOperation}=await import('./engines/clickhouse')
  const result=await reconcileClickHouseOperation({config:connection.config,secret:unseal<Record<string,unknown>>(connection.secret),signal:AbortSignal.timeout(30000)},operationId)
  await audit(this.db,actor,'native.operation.observed',operationId)
  return result
 }
 async connections(){
  const [rows,blocks]=await Promise.all([this.db.selectFrom('connections').select(['id','name','kind','config','check_status','checked_at','created_at']).orderBy('created_at','desc').execute(),this.db.selectFrom('target_blocks').select(['target_id','resource_key']).execute()])
  return rows.map(row=>({...row,blocked:row.kind!=='s3'&&blocks.some(b=>b.resource_key===resourceKey(row))}))
 }
 async connection(id:string){
  const row=await this.db.selectFrom('connections').selectAll().where('id','=',validId(id)).executeTakeFirst()
  if(!row)throw new AppError('NOT_FOUND','Connection not found.',404);return row
 }
 async createConnection(input:ConnectionInput,actor='installation-owner'){
  const id=randomUUID();let safe:SourceConfig|StorageConfig,secret:DbSecret|S3Secret|Record<string,never>
  if(!input.name.trim())throw new AppError('INVALID_CONNECTION','Enter a connection name.')
  if(input.kind==='sqlite'){
   const {sqliteIdentity}=await import('./engines/sqlite'),identity=await sqliteIdentity(input.path,input.restoreTarget??false)
   safe={engine:'sqlite',path:identity.path,database:identity.path,restoreTarget:input.restoreTarget??false};secret={}
  }else if(input.kind==='redis'){
   allowedHost(input.host)
   if(!Number.isInteger(input.dbIndex)||input.dbIndex<0||input.dbIndex>15)throw new AppError('INVALID_DATABASE','Choose a Redis database index from 0 through 15.')
   safe={engine:'redis',host:input.host,port:input.port??6379,database:'redis:'+input.dbIndex,dbIndex:input.dbIndex,user:input.user??'default',tls:input.tls??true,restoreTarget:input.restoreTarget??false,allowGlobalReadLock:input.allowGlobalReadLock??false};secret={password:input.password}
  }else if(input.kind!=='s3'){
   if(!input.host||!input.database||!input.user||!input.password)throw new AppError('INVALID_CONNECTION','Host, database, user and password are required.')
   allowedHost(input.host);identifier(input.database)
   if(input.port!==undefined&&(!Number.isInteger(input.port)||input.port<1||input.port>65535))throw new AppError('INVALID_PORT','Use a valid integer TCP port.')
   if(!/^[a-zA-Z_][a-zA-Z0-9_.@-]{0,79}$/.test(input.user))throw new AppError('INVALID_CONNECTION','Invalid database user.')
   const ports={postgres:5432,mysql:3306,mariadb:3306,mongodb:27017,mssql:1433,clickhouse:input.tls===false?8123:8443}
   safe={engine:input.kind,host:input.host,port:input.port??ports[input.kind],database:input.database,user:input.user,tls:input.tls??true,restoreTarget:input.restoreTarget??false}
   if(input.kind==='mongodb'){const authDatabase=input.authDatabase??'admin';identifier(authDatabase);safe.authDatabase=authDatabase;safe.allowGlobalReadLock=input.allowGlobalReadLock??false}
   if(input.kind==='mysql'||input.kind==='mariadb')safe.allowGlobalReadLock=input.allowGlobalReadLock??false
   if(input.kind==='clickhouse'){
    identifier(input.backupDisk)
    if(!isAbsolute(input.sharedBackupRoot))throw new AppError('INVALID_BACKUP_PATH','Choose an absolute shared ClickHouse backup directory.')
    let path:string;try{path=await realpath(input.sharedBackupRoot);if(!(await stat(path)).isDirectory())throw new Error('Not a directory')}catch{throw new AppError('INVALID_BACKUP_PATH','The shared ClickHouse backup directory must already exist.')}
    let permitted=false
    for(const entry of (process.env.STEELKEEP_CLICKHOUSE_BACKUP_ROOTS??'').split(',').map(v=>v.trim()).filter(Boolean)){
     if(!isAbsolute(entry))continue
     let root:string;try{root=await realpath(entry)}catch{continue}
     const child=relative(root,path);if(root!=='/'&&(child===''||child!=='..'&&!child.startsWith('../')&&!isAbsolute(child)))permitted=true
    }
    if(!permitted)throw new AppError('ENDPOINT_NOT_ALLOWED','Configure an allowlisted shared ClickHouse backup directory.',403)
    safe.backupDisk=input.backupDisk;safe.sharedBackupRoot=path;safe.quiescentSource=input.quiescentSource??false
   }
   secret={password:input.password}
  }else{
   if(!input.endpoint||!input.bucket||!input.accessKey||!input.secretKey)throw new AppError('INVALID_CONNECTION','Endpoint, bucket and credentials are required.')
   let url:URL;try{url=new URL(input.endpoint)}catch{throw new AppError('INVALID_ENDPOINT','Enter a valid S3 endpoint.')}
   allowedHost(url.hostname)
   if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new AppError('INVALID_ENDPOINT','Use an HTTP(S) origin without credentials or path.')
   if(url.protocol==='http:'&&!['127.0.0.1','localhost','s3'].includes(url.hostname))throw new AppError('TLS_REQUIRED','Remote storage requires HTTPS.')
   if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket))throw new AppError('INVALID_BUCKET','Enter a valid bucket name.')
   const prefix=input.prefix??'steelkeep';if(!/^[a-zA-Z0-9/_-]*$/.test(prefix)||prefix.includes('..'))throw new AppError('INVALID_PREFIX','Use letters, digits, slash, underscore or hyphen.')
   safe={endpoint:url.origin,region:input.region??'us-east-1',bucket:input.bucket,prefix};secret={accessKey:input.accessKey,secretKey:input.secretKey}
  }
  await this.db.transaction().execute(async trx=>{await trx.insertInto('connections').values({id,name:input.name.trim(),kind:input.kind,config:safe,secret:seal(secret),check_status:'untested',checked_at:null}).execute();await audit(trx,actor,'connection.created',id)});return {id}
 }
 async testConnection(id:string){
  const row=await this.connection(id)
  try{
   if(row.kind==='s3'){
    const client=storageClient(row.config as StorageConfig,unseal<S3Secret>(row.secret));try{await client.send(new HeadBucketCommand({Bucket:(row.config as StorageConfig).bucket}),{abortSignal:AbortSignal.timeout(10000)})}finally{client.destroy()}
   }else{
    const {createEngineAdapter}=await import('./engines/index')
    const client=createEngineAdapter(row.kind,{config:row.config,secret:unseal<Record<string,unknown>>(row.secret),signal:AbortSignal.timeout(30000)})
    try{await client.connect()}finally{await client.close()}
   }
   await this.db.updateTable('connections').set({check_status:'available',checked_at:new Date()}).where('id','=',id).execute();return {status:'available'}
  }catch(error){await this.db.updateTable('connections').set({check_status:'failed',checked_at:new Date()}).where('id','=',id).execute();return {status:'failed',error:safeFailure(error).message}}
 }
 async plans(){return (await this.db.selectFrom('plans').selectAll().orderBy('created_at','desc').execute()).map(row=>({...row,upcoming:row.enabled?upcomingOccurrences(row.cron,row.timezone):[],missed_policy:'skip' as const,overlap_policy:'skip' as const}))}
 async scheduleOccurrences(planId:string){
  validId(planId)
  const plan=await this.db.selectFrom('plans').select('id').where('id','=',planId).executeTakeFirst()
  if(!plan)throw new AppError('NOT_FOUND','Plan not found.',404)
  return this.db.selectFrom('schedule_occurrences').selectAll().where('plan_id','=',planId).orderBy('due_at','desc').limit(30).execute()
 }
 async createPlan(input:PlanInput,actor='installation-owner'){
  if(!input.name.trim())throw new AppError('INVALID_PLAN','Enter a plan name.')
  const source=await this.connection(input.sourceId),storage=await this.connection(input.storageId)
  if(source.kind==='s3'||storage.kind!=='s3'||source.config.restoreTarget)throw new AppError('INVALID_PLAN','Choose a source database and S3 storage.')
  try{new Intl.DateTimeFormat('en',{timeZone:input.timezone}).format()}catch{throw new AppError('INVALID_TIMEZONE','Choose an IANA timezone.')}
  const id=randomUUID(),cron=input.cron?.trim()||null,next=cron?nextOccurrence(cron,input.timezone):null
  await this.db.transaction().execute(async trx=>{await trx.insertInto('plans').values({id,name:input.name.trim(),source_id:source.id,storage_id:storage.id,cron,timezone:input.timezone,enabled:true,next_due:next}).execute();await audit(trx,actor,'plan.created',id)});return {id,nextDue:next}
 }
 async updatePlan(id:string,input:PlanUpdateInput,actor='installation-owner'){
  if(!input.name.trim())throw new AppError('INVALID_PLAN','Enter a plan name.')
  validId(id);try{new Intl.DateTimeFormat('en',{timeZone:input.timezone}).format()}catch{throw new AppError('INVALID_TIMEZONE','Choose an IANA timezone.')}
  const cron=input.cron?.trim()||null,next=input.enabled&&cron?nextOccurrence(cron,input.timezone):null
  const row=await this.db.transaction().execute(async trx=>{const row=await trx.updateTable('plans').set({name:input.name.trim(),cron,timezone:input.timezone,enabled:input.enabled,next_due:next}).where('id','=',id).returningAll().executeTakeFirst();if(row)await audit(trx,actor,input.enabled?'plan.updated':'plan.paused',id);return row})
  if(!row)throw new AppError('NOT_FOUND','Plan not found.',404)
  return {...row,upcoming:row.enabled?upcomingOccurrences(row.cron,row.timezone):[],missed_policy:'skip' as const,overlap_policy:'skip' as const}
 }
 async runBackup(planId:string,key:string,actor='installation-owner'){
  validId(planId);requestKey(key)
  return this.db.transaction().execute(async trx=>{
   // Request-key lock serializes conflicting retries even when no run exists yet.
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`.execute(trx)
   const existing=await trx.selectFrom('runs').selectAll().where('idempotency_key','=',key).executeTakeFirst()
   if(existing){if(existing.plan_id!==planId||existing.type!=='backup')throw new AppError('IDEMPOTENCY_CONFLICT','This request key belongs to a different operation.',409);return safeRun(existing)}
   const plan=await trx.selectFrom('plans').selectAll().where('id','=',planId).forUpdate().executeTakeFirst()
   if(!plan)throw new AppError('NOT_FOUND','Plan not found.',404)
   const source=await trx.selectFrom('connections').selectAll().where('id','=',plan.source_id).executeTakeFirstOrThrow(),sourceKey=resourceKey(source)
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${sourceKey},1))`.execute(trx)
   if(await trx.selectFrom('source_blocks').select('run_id').where('resource_key','=',sourceKey).executeTakeFirst())throw new AppError('SOURCE_BLOCKED','An uncertain source lock requires operator reconciliation before another backup.',409)
   const active=await trx.selectFrom('runs').innerJoin('connections','connections.id','runs.source_id').select(['connections.kind','connections.config']).where('runs.status','in',['queued','running','cancelling']).execute()
   if(active.some(row=>resourceKey(row)===sourceKey))throw new AppError('SOURCE_BUSY','An operation for this source is already active.',409)
   const id=randomUUID()
   await trx.insertInto('runs').values({id,plan_id:planId,type:'backup',status:'queued',phase:'queued',idempotency_key:key,source_id:plan.source_id,storage_id:plan.storage_id,target_id:null,artifact_id:null,started_at:null,finished_at:null,heartbeat_at:null,error_code:null,error_message:null,validation:null,cancel_requested:false,attempt:0,execution_token:null,review_fingerprint:null}).execute()
   await trx.insertInto('outbox').values({run_id:id,dispatched_at:null}).execute();await trx.insertInto('events').values({run_id:id,phase:'queued',message:'Backup accepted and waiting for a worker.'}).execute();await audit(trx,actor,'backup.queued',id)
   return safeRun(await trx.selectFrom('runs').selectAll().where('id','=',id).executeTakeFirstOrThrow())
  })
 }
 async prepareRestore(artifactId:string,targetId:string,actor='installation-owner'){
  validId(artifactId);validId(targetId)
  const {inspectRestore}=await import('./restore'),review=await inspectRestore(this,artifactId,targetId)
  const id=randomUUID()
  const intent=await this.db.insertInto('restore_intents').values({id,actor,artifact_id:artifactId,target_id:targetId,review:review as unknown as Record<string,unknown>,fingerprint:review.fingerprint,expires_at:sql<Date>`now()+interval '10 minutes'`,consumed_run_id:null,idempotency_key:null}).returning('expires_at').executeTakeFirstOrThrow()
  return {intentId:id,expiresAt:new Date(intent.expires_at).toISOString(),review}
 }
 async startRestore(intentId:string,key:string,actor='installation-owner'){
  validId(intentId);requestKey(key)
  return this.db.transaction().execute(async trx=>{
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`.execute(trx)
   const intent=await trx.selectFrom('restore_intents').selectAll().where('id','=',intentId).forUpdate().executeTakeFirst()
   if(!intent||intent.actor!==actor)throw new AppError('NOT_FOUND','Restore review not found.',404)
   if(intent.consumed_run_id){if(intent.idempotency_key!==key)throw new AppError('RESTORE_REVIEW_CONSUMED','This review has already been used with another request key.',409);return safeRun(await trx.selectFrom('runs').selectAll().where('id','=',intent.consumed_run_id).executeTakeFirstOrThrow())}
   const clock=await sql<{now:Date}>`SELECT now() AS now`.execute(trx)
   if(new Date(intent.expires_at)<=clock.rows[0].now)throw new AppError('RESTORE_REVIEW_EXPIRED','Prepare and review this restore again.',409)
   const reused=await trx.selectFrom('runs').select('id').where('idempotency_key','=',key).executeTakeFirst()
   if(reused)throw new AppError('IDEMPOTENCY_CONFLICT','This request key belongs to another operation.',409)
   const artifact=await trx.selectFrom('artifacts').selectAll().where('id','=',intent.artifact_id).executeTakeFirstOrThrow()
   const target=await trx.selectFrom('connections').selectAll().where('id','=',intent.target_id).executeTakeFirstOrThrow()
   const name=resourceKey(target)
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${name},2))`.execute(trx)
   const blocked=await trx.selectFrom('target_blocks').select('run_id').where('resource_key','=',name).executeTakeFirst()
   if(blocked)throw new AppError('TARGET_BLOCKED','This target is reserved or contains a previous restore. Prepare a new empty target.',409)
   const {inspectRestore}=await import('./restore'),review=await inspectRestore(new Services(trx),intent.artifact_id,intent.target_id)
   if(review.fingerprint!==intent.fingerprint)throw new AppError('RESTORE_REVIEW_CHANGED','The artifact or target changed. Prepare and review again.',409)
   const id=randomUUID()
   await trx.insertInto('runs').values({id,plan_id:null,type:'restore',status:'queued',phase:'queued',idempotency_key:key,source_id:artifact.source_id,storage_id:artifact.storage_id,target_id:target.id,artifact_id:artifact.id,started_at:null,finished_at:null,heartbeat_at:null,error_code:null,error_message:null,validation:null,cancel_requested:false,attempt:0,execution_token:null,review_fingerprint:intent.fingerprint}).execute()
   await trx.insertInto('target_blocks').values({target_id:target.id,resource_key:name,run_id:id,reason:'Restore reserved; target must not be reused automatically.'}).execute()
   await trx.updateTable('restore_intents').set({consumed_run_id:id,idempotency_key:key}).where('id','=',intentId).execute()
   await trx.insertInto('outbox').values({run_id:id,dispatched_at:null}).execute();await trx.insertInto('events').values({run_id:id,phase:'queued',message:'Reviewed restore accepted. Target reserved for this operation.'}).execute();await audit(trx,actor,'restore.queued',id)
   return safeRun(await trx.selectFrom('runs').selectAll().where('id','=',id).executeTakeFirstOrThrow())
  })
 }
 async jobs(){return (await this.db.selectFrom('runs').selectAll().orderBy('created_at','desc').limit(100).execute()).map(safeRun)}
 async job(id:string){const run=await this.db.selectFrom('runs').selectAll().where('id','=',validId(id)).executeTakeFirst();if(!run)throw new AppError('NOT_FOUND','Job not found.',404);return {...safeRun(run),events:await this.db.selectFrom('events').selectAll().where('run_id','=',id).orderBy('id','asc').limit(500).execute()}}
 async artifacts(){
  const rows=await this.db.selectFrom('artifacts').select(['id','run_id','source_id','storage_id','object_key','size','sha256','engine','server_version','tool_version','created_at','availability','checked_at']).orderBy('created_at','desc').limit(100).execute()
  return Promise.all(rows.map(async row=>({...row,last_restore:await this.db.selectFrom('runs').select(['status','validation','finished_at']).where('artifact_id','=',row.id).where('type','=','restore').orderBy('created_at','desc').executeTakeFirst()??null})))
 }
 async cancel(id:string,actor='installation-owner'){
  validId(id)
  await this.db.transaction().execute(async trx=>{
   const run=await trx.selectFrom('runs').selectAll().where('id','=',id).forUpdate().executeTakeFirst()
   if(!run)throw new AppError('NOT_FOUND','Job not found.',404)
   if(!['queued','running','cancelling'].includes(run.status))throw new AppError('JOB_FINISHED','This job has already finished.',409)
   await trx.updateTable('runs').set({cancel_requested:true,status:run.status==='queued'?'cancelled':'cancelling',finished_at:run.status==='queued'?new Date():null}).where('id','=',id).execute()
   if(run.status==='queued')await trx.deleteFrom('target_blocks').where('run_id','=',id).execute()
   await trx.insertInto('events').values({run_id:id,phase:run.status==='queued'?'cancelled':'cancelling',message:run.status==='queued'?'Queued operation cancelled before execution.':'Cancellation requested; waiting for confirmed process termination.'}).execute();await audit(trx,actor,'job.cancel.requested',id)
  });return this.job(id)
 }
 async overview(){
  const [jobs,backups,plans,connections,activityRows,summary,storage]=await Promise.all([this.jobs(),this.artifacts(),this.plans(),this.connections(),
   sql<{date:string;backup:number;restore:number;failed:number}>`SELECT to_char(d.day,'YYYY-MM-DD') AS date, count(r.id) FILTER(WHERE r.type='backup')::integer AS backup,count(r.id) FILTER(WHERE r.type='restore')::integer AS restore,count(r.id) FILTER(WHERE r.status='failed')::integer AS failed FROM generate_series((now() AT TIME ZONE 'UTC')::date-13,(now() AT TIME ZONE 'UTC')::date,interval '1 day') d(day) LEFT JOIN runs r ON (r.created_at AT TIME ZONE 'UTC')::date=d.day::date GROUP BY d.day ORDER BY d.day`.execute(this.db),
   sql<{total:number;succeeded:number;failed:number;cancelled:number;interrupted:number;active:number}>`SELECT count(*)::integer AS total,count(*) FILTER(WHERE status='succeeded')::integer AS succeeded,count(*) FILTER(WHERE status='failed')::integer AS failed,count(*) FILTER(WHERE status='cancelled')::integer AS cancelled,count(*) FILTER(WHERE status='interrupted')::integer AS interrupted,count(*) FILTER(WHERE status IN ('queued','running','cancelling'))::integer AS active FROM runs WHERE created_at>=now()-interval '30 days'`.execute(this.db),
   sql<{bytes:string;count:number}>`SELECT coalesce(sum(size),0)::text AS bytes,count(*)::integer AS count FROM artifacts`.execute(this.db)])
  const activity=activityRows.rows
  return {jobs,backups,plans,connections,serverTime:new Date().toISOString(),activity,activityWindow:{from:activity[0]?.date??'',to:activity.at(-1)?.date??'',timezone:'UTC' as const},jobSummary:{...summary.rows[0],windowDays:30,scope:'all installation jobs'},storageSummary:{...storage.rows[0],scope:'all artifacts'}}
 }
}
