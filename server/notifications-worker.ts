import {randomUUID} from 'node:crypto'
import {sql,type Kysely} from 'kysely'
import type {Schema} from './db'
import {AppError,unseal,safeFailure} from './security'
import {audit} from './agents'
import {sendNotification,NotificationSendError} from './notifications-send'
import type {NotificationSecrets} from './notifications-config'

export async function recoverNotificationClaims(db:Kysely<Schema>,epoch:string){
 await db.updateTable('notification_attempts').set({status:'uncertain',finished_at:sql`clock_timestamp()`,error_code:'NOTIFICATION_WORKER_INTERRUPTED',error_message:'The previous worker stopped before recording provider acknowledgement; automatic replay is stopped.'}).where('status','=','sending').where('delivery_id','in',db.selectFrom('notification_deliveries').select('id').where('status','=','sending').where(eb=>eb.or([eb('worker_epoch','!=',epoch),eb('worker_epoch','is',null)]))).execute()

 await db.updateTable('notification_deliveries').set({status:'uncertain',execution_token:null,worker_epoch:null,next_attempt_at:null,finished_at:sql`clock_timestamp()`,error_code:'NOTIFICATION_WORKER_INTERRUPTED',error_message:'The previous worker stopped before recording provider acknowledgement. The message may have been accepted; automatic replay is stopped.'}).where('status','=','sending').where(eb=>eb.or([eb('worker_epoch','!=',epoch),eb('worker_epoch','is',null)])).execute()
}
async function owner(db:Kysely<Schema>,epoch:string){const state=await db.selectFrom('worker_state').select('epoch').where('singleton','=',true).forShare().executeTakeFirst();if(state?.epoch!==epoch)throw new AppError('NOTIFICATION_WORKER_FENCED','Notification worker ownership changed.',409)}
export async function processNotification(db:Kysely<Schema>,epoch:string,externalSignal:AbortSignal){
 if(externalSignal.aborted)return false
 const next=await db.selectFrom('notification_deliveries').select(['id','channel_id']).where('status','in',['queued','retry_wait']).where('next_attempt_at','<=',sql<Date>`clock_timestamp()`).orderBy('created_at','asc').limit(1).executeTakeFirst()
 if(!next)return false
 const token=randomUUID(),signal=AbortSignal.any([externalSignal,AbortSignal.timeout(12000)])
 const claimed=await db.transaction().execute(async trx=>{
  await owner(trx,epoch)
  const channel=await trx.selectFrom('notification_channels').selectAll().where('id','=',next.channel_id).forUpdate().executeTakeFirstOrThrow(),delivery=await trx.selectFrom('notification_deliveries').selectAll().where('id','=',next.id).forUpdate().executeTakeFirstOrThrow()
  if(!['queued','retry_wait'].includes(delivery.status))return false
  if(channel.deleted_at||channel.revision!==delivery.channel_revision||delivery.event!=='test'&&!channel.enabled){await trx.updateTable('notification_deliveries').set({status:'cancelled',finished_at:sql`clock_timestamp()`,next_attempt_at:null,error_code:'NOTIFICATION_CHANNEL_CHANGED',error_message:'The channel changed or was disabled before this delivery.'}).where('id','=',delivery.id).execute();return false}
  if(delivery.attempt>=delivery.max_attempts)return false
  await trx.updateTable('notification_deliveries').set({status:'sending',attempt:delivery.attempt+1,execution_token:token,worker_epoch:epoch,next_attempt_at:null,error_code:null,error_message:null}).where('id','=',delivery.id).execute();await trx.insertInto('notification_attempts').values({delivery_id:delivery.id,attempt:delivery.attempt+1,status:'sending',finished_at:null,error_code:null,error_message:null}).execute();return true
 })
 if(!claimed)return false
 try{
  await db.transaction().execute(async trx=>{
   await owner(trx,epoch)
   const channel=await trx.selectFrom('notification_channels').selectAll().where('id','=',next.channel_id).forUpdate().executeTakeFirstOrThrow(),delivery=await trx.selectFrom('notification_deliveries').selectAll().where('id','=',next.id).forUpdate().executeTakeFirstOrThrow()
   if(delivery.execution_token!==token||delivery.worker_epoch!==epoch||delivery.status!=='sending')throw new AppError('NOTIFICATION_WORKER_FENCED','Notification delivery ownership changed.',409)
   if(channel.deleted_at||channel.revision!==delivery.channel_revision||delivery.event!=='test'&&!channel.enabled){await trx.updateTable('notification_deliveries').set({status:'cancelled',finished_at:sql`clock_timestamp()`,error_code:'NOTIFICATION_CHANNEL_CHANGED',error_message:'The channel changed before sending.'}).where('id','=',delivery.id).execute();await trx.updateTable('notification_attempts').set({status:'cancelled',finished_at:sql`clock_timestamp()`,error_code:'NOTIFICATION_CHANNEL_CHANGED',error_message:'The channel changed before sending.'}).where('delivery_id','=',delivery.id).where('attempt','=',delivery.attempt).execute();return}
   await sendNotification(channel.kind,channel.config,unseal<NotificationSecrets>(channel.secret),delivery.payload,delivery.id,signal)
   await trx.updateTable('notification_deliveries').set({status:'succeeded',finished_at:sql`clock_timestamp()`,error_code:null,error_message:null}).where('id','=',delivery.id).execute();await audit(trx,'notification-worker','notification.provider.accepted',delivery.id);await trx.updateTable('notification_attempts').set({status:'succeeded',finished_at:sql`clock_timestamp()`}).where('delivery_id','=',delivery.id).where('attempt','=',delivery.attempt).execute()
  })
 }catch(error){
  const failure=error instanceof NotificationSendError?{code:error.code,message:error.message}:safeFailure(error),outcome=error instanceof NotificationSendError?error.outcome:error instanceof AppError?'failed':'uncertain'
  await db.transaction().execute(async trx=>{
   const row=await trx.selectFrom('notification_deliveries').selectAll().where('id','=',next.id).forUpdate().executeTakeFirstOrThrow()
   if(row.execution_token!==token||row.worker_epoch!==epoch||row.status!=='sending')return
   const retry=outcome==='retry'&&row.attempt<row.max_attempts,status=retry?'retry_wait':outcome==='uncertain'?'uncertain':'failed',message=outcome==='retry'&&!retry?failure.message+' The automatic attempt budget is exhausted.':failure.message
   await trx.updateTable('notification_deliveries').set({status,next_attempt_at:retry?sql`clock_timestamp()+make_interval(secs=>${Math.min(300,10*2**Math.min(row.attempt-1,5))})`:null,finished_at:retry?null:sql`clock_timestamp()`,error_code:failure.code,error_message:message}).where('id','=',row.id).execute();await audit(trx,'notification-worker','notification.delivery.'+status,row.id);await trx.updateTable('notification_attempts').set({status,finished_at:sql`clock_timestamp()`,error_code:failure.code,error_message:message}).where('delivery_id','=',row.id).where('attempt','=',row.attempt).execute()
  })
 }
 return true
}
