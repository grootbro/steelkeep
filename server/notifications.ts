import {randomUUID} from 'node:crypto'
import {sql,type Kysely,type Selectable} from 'kysely'
import type {Schema,NotificationChannel,NotificationDelivery} from './db'
import {AppError,seal,unseal} from './security'
import {authorize,type Principal} from './auth'
import {audit} from './agents'
import {notificationKinds,validateNotification,notificationDestination,invalidNotification,type NotificationKind,type NotificationConfig,type NotificationEvents,type NotificationSecrets} from './notifications-config'

export type ChannelInput={name:string;kind:NotificationKind;enabled:boolean;events:NotificationEvents;config:NotificationConfig;secrets:NotificationSecrets}
export type ChannelUpdate=Omit<ChannelInput,'kind'|'secrets'>&{revision:number;secrets?:NotificationSecrets}
export function notificationDeliveryDto(row:Selectable<NotificationDelivery>){return {id:row.id,channelId:row.channel_id,channelName:row.channel_name,kind:row.kind,runId:row.run_id,event:row.event,status:row.status,attempt:row.attempt,maxAttempts:row.max_attempts,nextAttemptAt:row.next_attempt_at,errorCode:row.error_code,errorMessage:row.error_message,createdAt:row.created_at,finishedAt:row.finished_at}}
function channelDto(row:Selectable<NotificationChannel>){const secrets=unseal<NotificationSecrets>(row.secret);return {id:row.id,name:row.name,kind:row.kind,enabled:row.enabled,revision:row.revision,events:row.events,config:row.config,secretFields:Object.keys(secrets).filter(key=>!!secrets[key]),destination:notificationDestination(row.kind,row.config,secrets),createdAt:row.created_at,updatedAt:row.updated_at}}
function id(value:string){if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new AppError('INVALID_ID','Use a valid notification identifier.');return value}
function key(value:string){if(typeof value!=='string'||value.length<16||value.length>160||/[\r\n\0]/.test(value))throw new AppError('INVALID_REQUEST_KEY','Use a request key of16–160 characters.');return value}
function fields(input:Omit<ChannelInput,'kind'|'secrets'>){if(typeof input.name!=='string'||!input.name.trim()||input.name.length>80||typeof input.enabled!=='boolean'||!input.events||typeof input.events.success!=='boolean'||typeof input.events.failure!=='boolean'||Object.keys(input.events).some(key=>!['success','failure'].includes(key)))throw invalidNotification()}
export class NotificationServices{
 constructor(readonly db:Kysely<Schema>){}
 async list(){return (await this.db.selectFrom('notification_channels').selectAll().where('deleted_at','is',null).orderBy('created_at','desc').limit(100).execute()).map(channelDto)}
 async create(principal:Principal,input:ChannelInput){
  authorize(principal,'configure');fields(input);if(!notificationKinds.includes(input.kind))throw invalidNotification()
  const checked=validateNotification(input.kind,input.config,input.secrets)
  return this.db.transaction().execute(async trx=>{
   await sql`SELECT pg_advisory_xact_lock(4356542,9)`.execute(trx)
   const count=await trx.selectFrom('notification_channels').select(eb=>eb.fn.countAll<string>().as('n')).where('deleted_at','is',null).executeTakeFirstOrThrow();if(Number(count.n)>=100)throw new AppError('NOTIFICATION_CHANNEL_LIMIT','This installation supports at most100 active channels.',409)
   const row=await trx.insertInto('notification_channels').values({id:randomUUID(),name:input.name.trim(),kind:input.kind,enabled:input.enabled,events:input.events,config:checked.config,secret:seal(checked.secrets),deleted_at:null}).returningAll().executeTakeFirstOrThrow()
   await audit(trx,principal.actor,'notification.channel.created',row.id);return channelDto(row)
  })
 }
 async update(principal:Principal,channelId:string,input:ChannelUpdate){
  authorize(principal,'configure');id(channelId);fields(input)
  return this.db.transaction().execute(async trx=>{
   const previous=await trx.selectFrom('notification_channels').selectAll().where('id','=',channelId).where('deleted_at','is',null).forUpdate().executeTakeFirst()
   if(!previous)throw new AppError('NOTIFICATION_CHANNEL_NOT_FOUND','Notification channel not found.',404)
   if(input.revision!==previous.revision)throw new AppError('REVISION_CONFLICT','This channel changed. Reload its settings before saving.',409)
   const checked=validateNotification(previous.kind,input.config,input.secrets??{},unseal<NotificationSecrets>(previous.secret))
   const row=await trx.updateTable('notification_channels').set({name:input.name.trim(),enabled:input.enabled,events:input.events,config:checked.config,secret:seal(checked.secrets),revision:previous.revision+1,updated_at:sql`clock_timestamp()`}).where('id','=',channelId).returningAll().executeTakeFirstOrThrow()
   await this.cancelPending(trx,channelId);await audit(trx,principal.actor,'notification.channel.updated',channelId);return channelDto(row)
  })
 }
 private async cancelPending(db:Kysely<Schema>,channelId:string){await db.updateTable('notification_deliveries').set({status:'cancelled',next_attempt_at:null,finished_at:sql`clock_timestamp()`,error_code:'NOTIFICATION_CHANNEL_CHANGED',error_message:'Channel configuration changed before delivery. No send was made for this queued attempt.'}).where('channel_id','=',channelId).where('status','in',['queued','retry_wait']).execute()}
 async remove(principal:Principal,channelId:string,revision:number){
  authorize(principal,'configure');id(channelId)
  return this.db.transaction().execute(async trx=>{const channel=await trx.selectFrom('notification_channels').selectAll().where('id','=',channelId).where('deleted_at','is',null).forUpdate().executeTakeFirst();if(!channel)throw new AppError('NOTIFICATION_CHANNEL_NOT_FOUND','Notification channel not found.',404);if(channel.revision!==revision)throw new AppError('REVISION_CONFLICT','This channel changed. Reload before removing it.',409);await trx.updateTable('notification_channels').set({enabled:false,deleted_at:sql`clock_timestamp()`,updated_at:sql`clock_timestamp()`,revision:channel.revision+1}).where('id','=',channelId).execute();await this.cancelPending(trx,channelId);await audit(trx,principal.actor,'notification.channel.removed',channelId);return {id:channelId,deleted:true as const}})
 }
 async deliveries(){return (await this.db.selectFrom('notification_deliveries').selectAll().orderBy('created_at','desc').orderBy('id','desc').limit(100).execute()).map(notificationDeliveryDto)}
 async delivery(deliveryId:string){
  id(deliveryId);const row=await this.db.selectFrom('notification_deliveries').selectAll().where('id','=',deliveryId).executeTakeFirst();if(!row)throw new AppError('NOT_FOUND','Notification delivery not found.',404)
  const attempts=await this.db.selectFrom('notification_attempts').selectAll().where('delivery_id','=',deliveryId).orderBy('attempt','desc').limit(100).execute()
  return {delivery:notificationDeliveryDto(row),attempts:attempts.map(attempt=>({attempt:attempt.attempt,status:attempt.status,startedAt:attempt.started_at,finishedAt:attempt.finished_at,errorCode:attempt.error_code,errorMessage:attempt.error_message}))}
 }
 async test(principal:Principal,channelId:string,revision:number,requestKey:string){
  authorize(principal,'configure');id(channelId);key(requestKey)
  return this.db.transaction().execute(async trx=>{
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${requestKey},9))`.execute(trx)
   const existing=await trx.selectFrom('notification_requests').selectAll().where('key','=',requestKey).executeTakeFirst()
   if(existing){if(existing.actor!==principal.actor||existing.kind!=='test'||existing.resource_id!==channelId||existing.revision!==revision)throw new AppError('IDEMPOTENCY_CONFLICT','This key belongs to another notification request.',409);return existing.response as unknown as ReturnType<typeof notificationDeliveryDto>}
   const channel=await trx.selectFrom('notification_channels').selectAll().where('id','=',channelId).where('deleted_at','is',null).forUpdate().executeTakeFirst()
   if(!channel)throw new AppError('NOTIFICATION_CHANNEL_NOT_FOUND','Notification channel not found.',404)
   if(channel.revision!==revision)throw new AppError('REVISION_CONFLICT','Reload the channel before creating a new test.',409)
   const row=await trx.insertInto('notification_deliveries').values({id:randomUUID(),channel_id:channelId,channel_revision:revision,channel_name:channel.name,kind:channel.kind,run_id:null,event:'test',payload:{title:'steelkeep notification test',text:'A test delivery from your Steelkeep installation.',runId:null,timestamp:new Date().toISOString()},status:'queued',execution_token:null,worker_epoch:null,next_attempt_at:sql`clock_timestamp()`,error_code:null,error_message:null,finished_at:null}).returningAll().executeTakeFirstOrThrow(),response=notificationDeliveryDto(row)
   await trx.insertInto('notification_requests').values({key:requestKey,actor:principal.actor,kind:'test',resource_id:channelId,revision,confirm_duplicate:false,response}).execute();await audit(trx,principal.actor,'notification.test.queued',row.id);return response
  })
 }
 async retry(principal:Principal,deliveryId:string,requestKey:string,confirmDuplicateRisk=false){
  authorize(principal,'configure');id(deliveryId);key(requestKey)
  return this.db.transaction().execute(async trx=>{
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${requestKey},9))`.execute(trx)
   const existing=await trx.selectFrom('notification_requests').selectAll().where('key','=',requestKey).executeTakeFirst()
   if(existing){if(existing.actor!==principal.actor||existing.kind!=='retry'||existing.resource_id!==deliveryId||existing.confirm_duplicate!==confirmDuplicateRisk)throw new AppError('IDEMPOTENCY_CONFLICT','This key belongs to another notification request.',409);return existing.response as unknown as ReturnType<typeof notificationDeliveryDto>}
   const known=await trx.selectFrom('notification_deliveries').select('channel_id').where('id','=',deliveryId).executeTakeFirst();if(!known)throw new AppError('NOT_FOUND','Notification delivery not found.',404)
   const channel=await trx.selectFrom('notification_channels').selectAll().where('id','=',known.channel_id).where('deleted_at','is',null).forUpdate().executeTakeFirst();if(!channel)throw new AppError('NOTIFICATION_CHANNEL_NOT_FOUND','Notification channel not found.',404)
   const delivery=await trx.selectFrom('notification_deliveries').selectAll().where('id','=',deliveryId).forUpdate().executeTakeFirstOrThrow()
   if(!['failed','uncertain'].includes(delivery.status))throw new AppError('NOTIFICATION_RETRY_NOT_READY','Only failed or uncertain deliveries can be retried explicitly.',409)
   if(delivery.status==='uncertain'&&!confirmDuplicateRisk)throw new AppError('NOTIFICATION_DUPLICATE_CONFIRMATION_REQUIRED','The previous message may have been accepted. Confirm the duplicate risk before retrying.',409)
   if(delivery.channel_revision!==channel.revision)throw new AppError('REVISION_CONFLICT','The channel changed. Create a new test instead of redirecting this old delivery.',409)
   if(delivery.event!=='test'&&!channel.enabled)throw new AppError('NOTIFICATION_CHANNEL_DISABLED','The channel is disabled.',409)
   const row=await trx.updateTable('notification_deliveries').set({status:'retry_wait',max_attempts:delivery.attempt+3,next_attempt_at:sql`clock_timestamp()`,execution_token:null,worker_epoch:null,error_code:null,error_message:null,finished_at:null}).where('id','=',deliveryId).returningAll().executeTakeFirstOrThrow(),response=notificationDeliveryDto(row)
   await trx.insertInto('notification_requests').values({key:requestKey,actor:principal.actor,kind:'retry',resource_id:deliveryId,revision:channel.revision,confirm_duplicate:confirmDuplicateRisk,response}).execute();await audit(trx,principal.actor,'notification.delivery.retry.authorized',deliveryId);return response
  })
 }
}
