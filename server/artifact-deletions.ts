import {createHash,randomUUID} from 'node:crypto'
import {z} from 'zod'
import {sql,type Kysely,type Selectable} from 'kysely'
import type {Schema} from './db'
import {authorize,type Principal} from './auth'
import {audit} from './agents'
import {AppError} from './security'
import {resourceKey,sourceBlockMatches} from './resources'
import {maxArchiveBytes} from './process'

export const deletionReviewInput=z.strictObject({artifactIds:z.array(z.uuid()).min(1).max(100)})
export const deletionRequestInput=z.strictObject({reviewId:z.uuid(),idempotencyKey:z.string().min(16).max(160).regex(/^[^\r\n\0]+$/),confirmDeletion:z.literal(true)})
export const deletionConfirmation='permanently-delete-reviewed-snapshots' as const
export type DeletionReason='locked'|'restore_review'|'restore_active'|'restore_uncertain'|'source_uncertain'|'target_uncertain'|'deletion_reserved'|'deleted'|'ownership_uncertain'
export type DeletionItem={id:string;sourceName:string;storageName:string;size:string;createdAt:string;deletionState:string;eligible:boolean;reason:DeletionReason|null}
export type DeletionPreview={reviewId:string;expiresAt:string;artifactIds:string[];eligibleCount:number;blockedCount:number;bytes:string;items:DeletionItem[];confirmation:typeof deletionConfirmation}
export type DeletionAccepted={reviewId:string;idempotencyKey:string;queued:number;jobIds:string[];artifactIds:string[]}
const extensions={postgres:'.dump',mysql:'.sql',mariadb:'.sql',mongodb:'.archive.gz',sqlite:'.sqlite',redis:'.redis.ndjson',clickhouse:'.zip',mssql:'.bacpac'} as const
function identifier(id:string){if(!z.uuid().safeParse(id).success)throw new AppError('INVALID_ID','Use a valid deletion review identifier.',422);return id}
export function deletionIds(value:unknown){const parsed=deletionReviewInput.safeParse(value);if(!parsed.success||new Set(parsed.data.artifactIds.map(id=>id.toLowerCase())).size!==parsed.data.artifactIds.length)throw new AppError('INVALID_DELETION_SELECTION','Select between 1 and 100 distinct snapshot identifiers.',422);return parsed.data.artifactIds.map(id=>id.toLowerCase()).sort()}
type Artifact=Selectable<Schema['artifacts']>
type Run=Selectable<Schema['runs']>
type Connection=Selectable<Schema['connections']>
export function deletionPublication(artifact:Artifact,run:Run,source:Connection,storage:Connection){
 const extension=Object.hasOwn(extensions,artifact.engine)?extensions[artifact.engine as keyof typeof extensions]:undefined,prefix=storage.config.prefix
 const expected=[prefix,run.id,run.execution_token,artifact.id+extension].filter(Boolean).join('/')
 const valid=Boolean(extension)&&storage.kind==='s3'&&source.kind===artifact.engine&&run.type==='backup'&&run.status==='succeeded'&&run.artifact_id===artifact.id&&run.id===artifact.run_id&&run.source_id===artifact.source_id&&run.storage_id===artifact.storage_id&&source.id===artifact.source_id&&storage.id===artifact.storage_id&&Boolean(run.execution_token)&&artifact.object_key===expected&&/^\d+$/.test(artifact.size)&&BigInt(artifact.size)>0n&&BigInt(artifact.size)<=BigInt(maxArchiveBytes)&&/^[a-f0-9]{64}$/.test(artifact.sha256)
 // No key, endpoint, credential or fingerprint is returned in a public review.
 const fingerprint=createHash('sha256').update(JSON.stringify([artifact.id,artifact.run_id,artifact.source_id,artifact.storage_id,artifact.object_key,artifact.size,artifact.sha256,artifact.engine,artifact.server_version,artifact.tool_version,artifact.created_at.toISOString(),run.plan_id,run.execution_token,run.type,run.status,run.artifact_id,source.name,source.revision,storage.name,storage.revision])).digest('hex')
 return {valid,fingerprint}
}
export async function deletionProtection(db:Kysely<Schema>,artifact:Artifact,source:Connection,includeReserved=false):Promise<DeletionReason|null>{
 if(source.kind==='s3')return 'ownership_uncertain'
 if(artifact.deletion_state==='deleted')return 'deleted'
 if(artifact.retention_locked)return 'locked'
 if(!includeReserved&&artifact.deletion_state!=='active')return 'deletion_reserved'
 const pins=await sql<{review:boolean;active:boolean;uncertain:boolean}>`SELECT
 EXISTS(SELECT 1 FROM restore_intents WHERE artifact_id=${artifact.id}::uuid AND consumed_run_id IS NULL AND expires_at>clock_timestamp()) AS review,
 EXISTS(SELECT 1 FROM runs WHERE artifact_id=${artifact.id}::uuid AND type='restore' AND status IN ('queued','running','cancelling')) AS active,
 EXISTS(SELECT 1 FROM target_blocks b JOIN runs r ON r.id=b.run_id WHERE r.artifact_id=${artifact.id}::uuid AND NOT(r.status='succeeded' AND coalesce(r.validation->>'passed'='true',false) AND coalesce(r.validation->>'status'='passed',false))) AS uncertain`.execute(db)
 if(pins.rows[0].review)return 'restore_review'
 if(pins.rows[0].active)return 'restore_active'
 if(pins.rows[0].uncertain)return 'restore_uncertain'
 const sourceBlocks=await db.selectFrom('source_blocks').select('resource_key').execute()
 if(sourceBlocks.some(block=>sourceBlockMatches(source,block.resource_key)))return 'source_uncertain'
 const target=await db.selectFrom('target_blocks as b').innerJoin('runs as r','r.id','b.run_id').select('b.run_id').where('b.resource_key','=',resourceKey(source)).where(sql<boolean>`NOT(r.status='succeeded' AND coalesce(r.validation->>'passed'='true',false) AND coalesce(r.validation->>'status'='passed',false))`).executeTakeFirst()
 return target?'target_uncertain':null
}
async function candidate(db:Kysely<Schema>,id:string){
 const artifact=await db.selectFrom('artifacts').selectAll().where('id','=',id).executeTakeFirst()
 if(!artifact)throw new AppError('NOT_FOUND','A selected snapshot was not found.',404)
 const run=await db.selectFrom('runs').selectAll().where('id','=',artifact.run_id).executeTakeFirstOrThrow(),source=await db.selectFrom('connections').selectAll().where('id','=',artifact.source_id).executeTakeFirstOrThrow(),storage=await db.selectFrom('connections').selectAll().where('id','=',artifact.storage_id).executeTakeFirstOrThrow(),publication=deletionPublication(artifact,run,source,storage)
 const reason=await deletionProtection(db,artifact,source)??(publication.valid?null:'ownership_uncertain')
 const item:DeletionItem={id,sourceName:source.name,storageName:storage.name,size:artifact.size,createdAt:artifact.created_at.toISOString(),deletionState:artifact.deletion_state,eligible:reason===null,reason}
 return {artifact,run,source,storage,publication,item}
}
function selectionFingerprint(rows:Awaited<ReturnType<typeof candidate>>[]){return createHash('sha256').update(JSON.stringify(rows.map(row=>[row.artifact.id,row.publication.fingerprint,row.item.deletionState,row.artifact.retention_locked,row.item.reason]))).digest('hex')}
async function clock(db:Kysely<Schema>){return (await sql<{now:Date}>`SELECT clock_timestamp() AS now`.execute(db)).rows[0].now}
export class ArtifactDeletionServices{
 constructor(readonly db:Kysely<Schema>){}
 async prepare(principal:Principal,value:unknown){
  authorize(principal,'backup:delete');const ids=deletionIds(value)
  return this.db.transaction().setIsolationLevel('repeatable read').execute(async trx=>{
   const rows=[];for(const id of ids)rows.push(await candidate(trx,id))
   const id=randomUUID(),now=await clock(trx),expires=new Date(now.getTime()+600000),items=rows.map(row=>row.item),eligible=items.filter(row=>row.eligible)
   const preview:DeletionPreview={reviewId:id,expiresAt:expires.toISOString(),artifactIds:ids,eligibleCount:eligible.length,blockedCount:items.length-eligible.length,bytes:eligible.reduce((sum,row)=>sum+BigInt(row.size),0n).toString(),items,confirmation:deletionConfirmation}
   await trx.insertInto('artifact_deletion_reviews').values({id,actor:principal.actor,artifact_ids:ids,fingerprint:selectionFingerprint(rows),preview:preview as unknown as Record<string,unknown>,expires_at:expires,idempotency_key:null,response:null}).execute();await audit(trx,principal.actor,'backup.deletion.reviewed',id)
   return preview
  })
 }
 async get(principal:Principal,id:string){
  authorize(principal,'backup:delete');identifier(id)
  const review=await this.db.selectFrom('artifact_deletion_reviews').selectAll().where('id','=',id).where('actor','=',principal.actor).executeTakeFirst()
  if(!review)throw new AppError('NOT_FOUND','Deletion review not found.',404)
  return {review:review.preview as unknown as DeletionPreview,result:review.response as unknown as DeletionAccepted|null}
 }
 async queue(principal:Principal,value:unknown){
  authorize(principal,'backup:delete');const parsed=deletionRequestInput.safeParse(value)
  if(!parsed.success)throw new AppError('INVALID_DELETION_REQUEST','Use the reviewed selection, a stable request key and explicit permanent-deletion confirmation.',422)
  const input={...parsed.data,reviewId:parsed.data.reviewId.toLowerCase()}
  return this.db.transaction().execute(async trx=>{
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey},11))`.execute(trx)
   const used=await trx.selectFrom('artifact_deletion_reviews').selectAll().where('idempotency_key','=',input.idempotencyKey).executeTakeFirst()
   if(used){if(used.id!==input.reviewId||used.actor!==principal.actor)throw new AppError('IDEMPOTENCY_CONFLICT','This request key belongs to another deletion operation.',409);return used.response as unknown as DeletionAccepted}
   const review=await trx.selectFrom('artifact_deletion_reviews').selectAll().where('id','=',input.reviewId).where('actor','=',principal.actor).forUpdate().executeTakeFirst()
   if(!review)throw new AppError('DELETION_REVIEW_NOT_FOUND','Deletion review not found.',404)
   if(review.idempotency_key)throw new AppError('DELETION_REVIEW_CONSUMED','This deletion review was already accepted with another request key.',409)
   if(review.expires_at<=await clock(trx))throw new AppError('DELETION_REVIEW_EXPIRED','Review this snapshot selection again.',409)
   const ids=deletionIds({artifactIds:review.artifact_ids})
   // Restore admission takes the same artifact row first; reserve every selected row atomically.
   await trx.selectFrom('artifacts').select('id').where('id','in',ids).orderBy('id').forUpdate().execute()
   const connectionIds=(await trx.selectFrom('artifacts').select(['source_id','storage_id']).where('id','in',ids).execute()).flatMap(row=>[row.source_id,row.storage_id])
   await trx.selectFrom('connections').select('id').where('id','in',[...new Set(connectionIds)].sort()).orderBy('id').forUpdate().execute()
   const rows=[];for(const id of ids)rows.push(await candidate(trx,id))
   if(selectionFingerprint(rows)!==review.fingerprint)throw new AppError('DELETION_REVIEW_CHANGED','Snapshot metadata or its protections changed. Review the selection again.',409)
   if(rows.some(row=>!row.item.eligible))throw new AppError('DELETION_PROTECTED','The selection includes a protected or unavailable snapshot. No deletion was queued.',409)
   if(review.expires_at<=await clock(trx))throw new AppError('DELETION_REVIEW_EXPIRED','Review this snapshot selection again.',409)
   const jobIds:string[]=[]
   for(const row of rows){
    const id=randomUUID();await trx.insertInto('retention_jobs').values({id,kind:'manual',manual_review_id:review.id,manual_fingerprint:row.publication.fingerprint,plan_id:row.run.plan_id,artifact_id:row.artifact.id,policy_revision:0,storage_revision:row.storage.revision,status:'queued',max_attempts:1,next_attempt_at:sql`clock_timestamp()`,execution_token:null,worker_epoch:null,object_etag:null,object_version_id:null,error_code:null,error_message:null,actor:principal.actor,finished_at:null}).execute()
    await trx.updateTable('artifacts').set({deletion_state:'queued'}).where('id','=',row.artifact.id).execute();await audit(trx,principal.actor,'backup.deletion.queued',row.artifact.id);jobIds.push(id)
   }
   const result:DeletionAccepted={reviewId:review.id,idempotencyKey:input.idempotencyKey,queued:jobIds.length,jobIds,artifactIds:ids}
   await trx.updateTable('artifact_deletion_reviews').set({idempotency_key:input.idempotencyKey,response:result as unknown as Record<string,unknown>}).where('id','=',review.id).execute()
   return result
  })
 }
}
