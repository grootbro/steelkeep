import {randomUUID} from 'node:crypto'
import {PgBoss} from 'pg-boss'
import {fromKysely} from 'pg-boss/dist/adapters/kysely.js'
import {sql} from 'kysely'
import pino from 'pino'
import {connectDb} from './db'
import {Services} from './services'
import {scheduleDue} from './scheduler'
import {config} from './config'
import {executeBackup,isRetryableBackupError} from './backup'
import {executeRestore} from './restore'
import {AppError,safeFailure} from './security'
import {evaluateRetention,processRetentionJob,recoverRetentionClaims} from './retention-worker'
import {processNotification,recoverNotificationClaims} from './notifications-worker'

const log=pino({name:'steelkeep-worker'}),{db,pool}=connectDb(),services=new Services(db)
const boss=new PgBoss(config.databaseUrl())
boss.on('error',()=>log.error('Queue connection failed; durable dispatch state is retained'))
const lock=await pool.connect()
const held=await lock.query<{held:boolean}>('SELECT pg_try_advisory_lock(4356543) AS held')
if(!held.rows[0].held){lock.release();await db.destroy();throw new Error('Another Steelkeep worker owns the installation lock')}

let closing=false,ownershipLost=false,active:AbortController|undefined,stopping:Promise<void>|undefined
let activeDone:Promise<void>|undefined,releaseActive:(()=>void)|undefined
let dispatching=false
const epoch=randomUUID()
let dispatchTimer:ReturnType<typeof setInterval>|undefined
let retentionTimer:ReturnType<typeof setInterval>|undefined,retentionDone:Promise<void>|undefined
const retentionAbort=new AbortController()
let notificationTimer:ReturnType<typeof setInterval>|undefined,notificationDone:Promise<void>|undefined
const notificationAbort=new AbortController()
lock.on('error',()=>{
  ownershipLost=true;active?.abort();retentionAbort.abort();notificationAbort.abort()
  log.error('Execution ownership connection lost; stopping native processes')
  void stop()
})

await boss.start()
// Queue retries recover undelivered work. Domain CAS prevents replaying an interrupted restore.
await boss.createQueue('operations',{retryLimit:2,retryDelay:10,retryBackoff:true,expireInSeconds:7500})

// An old subprocess may have written before losing its connection. Quarantine, never replay.
await db.transaction().execute(async trx=>{
  // Claims hold a shared lock on this row. A new epoch waits for every old claim to commit,
  // then quarantines it; an old callback can never claim after this ownership transfer.
  await trx.insertInto('worker_state').values({singleton:true,epoch}).onConflict(c=>c.column('singleton').doUpdateSet({epoch,started_at:sql`now()`})).execute()
  await recoverRetentionClaims(trx,epoch)
  await recoverNotificationClaims(trx,epoch)
  const interrupted=await trx.updateTable('runs').set({status:'interrupted',phase:'interrupted',error_code:'WORKER_INTERRUPTED',error_message:'The previous worker stopped before confirming completion. Review the operation; restore targets remain reserved.',finished_at:sql`now()`}).where('status','in',['running','cancelling']).returning('id').execute()
  for(const run of interrupted)await trx.insertInto('events').values({run_id:run.id,phase:'interrupted',message:'Worker restart detected an unknown execution outcome. Automatic replay is blocked.'}).execute()
  const pending=await trx.selectFrom('runs').innerJoin('outbox','outbox.run_id','runs.id').select('runs.id').where('runs.status','=','queued').where('runs.cancel_requested','=',false).where('outbox.dispatched_at','is not',null).execute()
  const queueDb={db:fromKysely(trx)}
  for(const run of pending){
    const delivery=await boss.getJobById('operations',run.id,queueDb)
    if(!delivery){await trx.updateTable('outbox').set({dispatched_at:null}).where('run_id','=',run.id).execute();continue}
    if(delivery.state==='active'){
      // The durable run is still unclaimed, so no native effect was authorized. Old epoch is fenced.
      await boss.cancel('operations',run.id,queueDb);await boss.resume('operations',run.id,queueDb)
      await trx.insertInto('events').values({run_id:run.id,phase:'queued',message:'Recovered a queue delivery interrupted before execution claim.'}).execute()
    }else if(delivery.state==='cancelled')await boss.resume('operations',run.id,queueDb)
    else if(delivery.state==='failed')await boss.retry('operations',run.id,queueDb)
    else if(delivery.state==='completed'){
      await trx.updateTable('runs').set({status:'interrupted',phase:'interrupted',error_code:'DELIVERY_STATE_CONFLICT',error_message:'Queue delivery ended without a confirmed operation claim. Review before starting a new operation.',finished_at:sql`now()`}).where('id','=',run.id).execute()
      await trx.insertInto('events').values({run_id:run.id,phase:'interrupted',message:'Conflicting durable delivery state retained for explicit review.'}).execute()
    }
  }
})

await boss.work<{runId:string}>('operations',{batchSize:1,pollingIntervalSeconds:1},async jobs=>{
  for(const job of jobs){
    if(closing)throw new Error('Worker stopping before claim')
    const id=job.data.runId,token=randomUUID(),controller=new AbortController()
    const claimed=await db.transaction().execute(async trx=>{
      const owner=await trx.selectFrom('worker_state').select('epoch').where('singleton','=',true).forShare().executeTakeFirstOrThrow()
      if(owner.epoch!==epoch||closing||ownershipLost)throw new Error('Worker epoch no longer owns execution')
      return trx.updateTable('runs').set({status:'running',phase:'preflight',started_at:sql`now()`,heartbeat_at:sql`now()`,finished_at:null,error_code:null,error_message:null,execution_token:token,attempt:sql`attempt + 1`}).where('id','=',id).where('status','=','queued').where('cancel_requested','=',false).returningAll().executeTakeFirst()
    })
    if(!claimed)continue
    active=controller;activeDone=new Promise<void>(resolve=>{releaseActive=resolve})
    if(closing||ownershipLost)controller.abort()
    let ticking=false,userCancelled=false,heartbeatLost=false,heartbeatDone:Promise<void>|undefined
    async function heartbeat(){
      if(ticking)return;ticking=true
      try{
        const row=await db.selectFrom('runs').select(['execution_token','cancel_requested','status']).where('id','=',id).executeTakeFirst()
        if(row?.cancel_requested){userCancelled=true;controller.abort();return}
        if(!row||row.execution_token!==token||!['running','cancelling'].includes(row.status)||closing){heartbeatLost=true;controller.abort();return}
        await db.updateTable('runs').set({heartbeat_at:sql`now()`}).where('id','=',id).where('execution_token','=',token).execute()
      }catch{heartbeatLost=true;controller.abort()}finally{ticking=false}
    }
    const timer=setInterval(()=>{heartbeatDone=heartbeat()},1000)
    try{
      if(claimed.type==='backup')await executeBackup(services,id,token,controller.signal)
      else await executeRestore(services,id,token,controller.signal)
    }catch(error){
      const failure=safeFailure(error)
      await db.transaction().execute(async trx=>{
        const current=await trx.selectFrom('runs').selectAll().where('id','=',id).where('execution_token','=',token).forUpdate().executeTakeFirst()
        if(!current||!['running','cancelling'].includes(current.status))return
        const nativeUncertain=error instanceof AppError&&['NATIVE_OPERATION_UNCERTAIN','SOURCE_LOCK_UNCERTAIN'].includes(error.code)
        const interrupted=ownershipLost||heartbeatLost||closing||nativeUncertain
        const restoreMayHaveWritten=claimed.type==='restore'&&['restoring','validating-data'].includes(current.phase)
        const cancelled=userCancelled||current.cancel_requested
        const retry=claimed.type==='backup'&&!cancelled&&!interrupted&&claimed.attempt<3&&isRetryableBackupError(error)
        const knownValidationFailure=error instanceof AppError&&error.code==='VALIDATION_FAILED'
        const status=retry?'queued':interrupted||(restoreMayHaveWritten&&!knownValidationFailure)?'interrupted':cancelled?'cancelled':'failed'
        const message=retry?'Temporary storage failure. A new immutable backup attempt will retry after backoff.':status==='interrupted'?(nativeUncertain?failure.message:'Operation interrupted before a safe final result was confirmed. Review source and target reservations before a new operation; it will not be retried automatically.'):failure.message
        await trx.updateTable('runs').set({status,phase:retry?'retry_wait':status,error_code:failure.code,error_message:message,finished_at:retry?null:sql`now()`,execution_token:retry?null:token}).where('id','=',id).where('execution_token','=',token).execute()
        await trx.insertInto('events').values({run_id:id,phase:retry?'retry_wait':status,message}).execute()
      })
      const current=await db.selectFrom('runs').select('status').where('id','=',id).executeTakeFirst()
      log.warn({runId:id,code:failure.code,status:current?.status},'Operation did not complete')
      if(current?.status==='queued')throw new Error('Retryable backup storage failure')
    }finally{
      clearInterval(timer);await heartbeatDone
      active=undefined;releaseActive?.();releaseActive=undefined;activeDone=undefined
    }
  }
})

// Queue insertion and dispatched marker share one PostgreSQL transaction.
async function dispatch(){
  if(dispatching||closing)return;dispatching=true
  try{
    await scheduleDue(services)
    await db.transaction().execute(async trx=>{
      const rows=await trx.selectFrom('outbox').selectAll().where('dispatched_at','is',null).forUpdate().skipLocked().limit(20).execute()
      for(const row of rows){
        await boss.send('operations',{runId:row.run_id},{id:row.run_id,retryLimit:2,retryDelay:10,retryBackoff:true,expireInSeconds:7500,db:fromKysely(trx)})
        await trx.updateTable('outbox').set({dispatched_at:sql`now()`}).where('run_id','=',row.run_id).execute()
      }
    })
  }catch{log.error('Schedule/dispatch failed; durable intent retained for next tick')}
  finally{dispatching=false}
}
await dispatch()
dispatchTimer=setInterval(()=>void dispatch(),1000)
function retentionTick(){
  if(closing||ownershipLost||retentionDone)return
  retentionDone=(async()=>{await evaluateRetention(db);if(!closing&&!ownershipLost)await processRetentionJob(db,epoch,retentionAbort.signal)})().catch(()=>log.error('Cleanup tick failed; durable reservations retained')).finally(()=>{retentionDone=undefined})
}
retentionTick();retentionTimer=setInterval(retentionTick,1000)
function notificationTick(){
  if(closing||ownershipLost||notificationDone)return
  notificationDone=processNotification(db,epoch,notificationAbort.signal).then(()=>{}).catch(()=>log.error('Notification tick failed; durable delivery state retained')).finally(()=>{notificationDone=undefined})
}
notificationTick();notificationTimer=setInterval(notificationTick,1000)
log.info('Worker ready; one native operation per installation')

function stop(){
  return stopping??=(async()=>{
    closing=true;clearInterval(dispatchTimer);clearInterval(retentionTimer);clearInterval(notificationTimer);active?.abort();retentionAbort.abort();notificationAbort.abort()
    // Native tool runner resolves only after the process group exits. Do not transfer ownership early.
    await Promise.all([activeDone,retentionDone,notificationDone])
    await boss.stop({graceful:true,timeout:15000})
    if(!ownershipLost)await lock.query('SELECT pg_advisory_unlock(4356543)')
    lock.release();await db.destroy()
  })()
}
process.on('SIGTERM',()=>void stop())
process.on('SIGINT',()=>void stop())
