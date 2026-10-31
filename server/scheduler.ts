import {randomUUID} from 'node:crypto'
import {sql} from 'kysely'
import type {Services} from './services'
import {nextOccurrence,lockConnections} from './services'
import {resourceKey} from './resources'
import {audit} from './agents'

// The worker calls this tick. PostgreSQL time and row locks make replicas safe.
// Missed slots over 60 seconds old are recorded and skipped; no catch-up flood.
export async function scheduleDue(services:Services){
 return services.db.transaction().execute(async trx=>{
  const clock=await sql<{now:Date}>`SELECT clock_timestamp() AS now`.execute(trx)
  const plans=await trx.selectFrom('plans').selectAll().where('enabled','=',true).where('cron','is not',null).where('next_due','<=',clock.rows[0].now).orderBy('next_due').forUpdate().skipLocked().limit(50).execute()
  if(!plans.length)return {queued:0,processed:0}
  // Retain one global row order across the entire batch, not just each plan.
  const connections=await lockConnections(trx,plans.flatMap(plan=>[plan.source_id,plan.storage_id]))
  const sourceKeys=[...new Set(plans.map(plan=>resourceKey(connections.get(plan.source_id)!)))].sort()
  for(const key of sourceKeys)await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},1))`.execute(trx)
  let queued=0
  for(const plan of plans){
   if(!plan.cron||!plan.next_due)continue
   // Lock waits must not preserve a stale transaction-start scheduling window.
   const clock=await sql<{now:Date}>`SELECT clock_timestamp() AS now`.execute(trx),now=clock.rows[0].now
   const due=new Date(plan.next_due),next=nextOccurrence(plan.cron,plan.timezone,now)
   const occurrence=await trx.selectFrom('schedule_occurrences').select('plan_id').where('plan_id','=',plan.id).where('due_at','=',due).executeTakeFirst()
   if(occurrence){await trx.updateTable('plans').set({next_due:next}).where('id','=',plan.id).execute();continue}
   const source=connections.get(plan.source_id)!,sourceKey=resourceKey(source)
   const active=await trx.selectFrom('runs').innerJoin('connections','connections.id','runs.source_id').select(['connections.kind','connections.config']).where('runs.status','in',['queued','running','cancelling']).execute()
   const blocked=await trx.selectFrom('source_blocks').select('run_id').where('resource_key','=',sourceKey).executeTakeFirst()
   let outcome=now.getTime()-due.getTime()>60000?'skipped_missed':blocked?'skipped_source_blocked':active.some(row=>resourceKey(row)===sourceKey)?'skipped_overlap':'queued',id:string|null=null
   if(outcome==='queued'){
    id=randomUUID()
    await trx.insertInto('runs').values({id,plan_id:plan.id,type:'backup',status:'queued',phase:'queued',idempotency_key:`schedule:${plan.id}:${due.toISOString()}`,source_id:plan.source_id,storage_id:plan.storage_id,target_id:null,artifact_id:null,started_at:null,finished_at:null,heartbeat_at:null,error_code:null,error_message:null,validation:null,cancel_requested:false,attempt:0,execution_token:null,review_fingerprint:null}).execute()
    await trx.insertInto('outbox').values({run_id:id,dispatched_at:null}).execute()
    await trx.insertInto('events').values({run_id:id,phase:'queued',message:'Scheduled backup accepted and waiting for a worker.'}).execute();await audit(trx,'scheduler','backup.queued',id);queued++
   }
   await trx.insertInto('schedule_occurrences').values({plan_id:plan.id,due_at:due,outcome,run_id:id}).execute()
   await trx.updateTable('plans').set({next_due:next}).where('id','=',plan.id).execute()
  }
  return {queued,processed:plans.length}
 })
}
