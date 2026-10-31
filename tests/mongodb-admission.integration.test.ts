import {test,expect} from 'bun:test'
import {randomUUID} from 'node:crypto'
import {sql} from 'kysely'
import {connectDb} from '../server/db'
import {config} from '../server/config'
import {Services} from '../server/services'
import {scheduleDue} from '../server/scheduler'

const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-mongo-admission'?test:test.skip
acceptance('Mongo admission refuses cross-database aliases before queueing and reports retained journals consistently',async()=>{
 const url=new URL(config.databaseUrl())
 if(url.hostname!=='127.0.0.1'||url.port!=='54371'||url.pathname!=='/steelkeep_mongo_admission_test'||url.username!=='steelkeep')throw new Error('Use only the dedicated loopback Mongo admission metadata fixture.')
 const {db}=connectDb(),services=new Services(db),ids:string[]=[]
 try{
  for(const table of ['connections','runs','artifacts','owner_account'] as const){const count=await db.selectFrom(table).select(eb=>eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();if(count.count!=='0')throw new Error('The dedicated metadata fixture must be empty.')}
  const source=await services.createConnection({kind:'mongodb',name:'Synthetic Mongo admission primary',host:'127.0.0.1',port:27017,database:'orders',user:'synthetic_reader',password:'synthetic-only',tls:false,allowGlobalReadLock:true});ids.push(source.id)
  const alias=await services.createConnection({kind:'mongodb',name:'Synthetic Mongo admission alias',host:'localhost',port:27018,database:'billing',user:'synthetic_reader',password:'synthetic-only',tls:false,allowGlobalReadLock:true});ids.push(alias.id)
  const other=await services.createConnection({kind:'postgres',name:'Synthetic unrelated SQL source',host:'127.0.0.1',port:54372,database:'orders',user:'synthetic_reader',password:'synthetic-only',tls:false});ids.push(other.id)
  const storage=await services.createConnection({kind:'s3',name:'Synthetic Mongo admission storage',endpoint:'http://127.0.0.1:54373',bucket:'synthetic-admission',accessKey:'synthetic-only',secretKey:'synthetic-only'});ids.push(storage.id)
  const plan=await services.createPlan({name:'Synthetic primary plan',sourceId:source.id,storageId:storage.id,timezone:'UTC'}),aliasPlan=await services.createPlan({name:'Synthetic alias plan',sourceId:alias.id,storageId:storage.id,timezone:'UTC'}),otherPlan=await services.createPlan({name:'Synthetic SQL plan',sourceId:other.id,storageId:storage.id,timezone:'UTC'})
  const keys=[randomUUID(),randomUUID()],raced=await Promise.allSettled([services.runBackup(plan.id,keys[0]),services.runBackup(aliasPlan.id,keys[1])])
  expect(raced.filter(result=>result.status==='fulfilled')).toHaveLength(1)
  const denied=raced.find(result=>result.status==='rejected');expect(denied?.status==='rejected'?(denied.reason as {code:string}).code:null).toBe('SOURCE_BUSY')
  const winner=raced.findIndex(result=>result.status==='fulfilled'),accepted=raced[winner]
  if(accepted.status!=='fulfilled')throw new Error('A concurrent backup must be admitted.')
  const first=accepted.value,firstKey=keys[winner],firstPlanId=winner===0?plan.id:aliasPlan.id
  await expect(services.runBackup(aliasPlan.id,randomUUID())).rejects.toMatchObject({code:'SOURCE_BUSY'})
  expect(await db.selectFrom('runs').select('id').execute()).toHaveLength(1)
  expect(await db.selectFrom('outbox').select('run_id').execute()).toHaveLength(1)
  await db.updateTable('plans').set({cron:'* * * * *',next_due:sql`clock_timestamp()-interval '1 second'`}).where('id','=',aliasPlan.id).execute()
  expect(await scheduleDue(services)).toEqual({queued:0,processed:1})
  expect((await db.selectFrom('schedule_occurrences').select('outcome').where('plan_id','=',aliasPlan.id).executeTakeFirstOrThrow()).outcome).toBe('skipped_overlap')
  await db.updateTable('plans').set({cron:null,next_due:null}).where('id','=',aliasPlan.id).execute()
  await services.cancel(first.id)
  const second=await services.runBackup(aliasPlan.id,randomUUID());expect(second.source_id).toBe(alias.id);await services.cancel(second.id)
  const interrupted=await services.runBackup(plan.id,randomUUID())
  await db.updateTable('runs').set({status:'interrupted',phase:'source-lock',finished_at:new Date()}).where('id','=',interrupted.id).execute()
  const journal={resource_key:'mongodb:127.0.0.1:27017',server_identity:'synthetic-mongo-process:'+randomUUID(),run_id:interrupted.id,execution_token:randomUUID(),owner_token:randomUUID(),state:'uncertain' as const,reason_code:'SYNTHETIC_UNKNOWN'}
  await db.insertInto('source_blocks').values(journal).execute()
  const before=await db.selectFrom('runs').select('id').execute(),outboxBefore=await db.selectFrom('outbox').select('run_id').execute()
  await expect(services.runBackup(aliasPlan.id,randomUUID())).rejects.toMatchObject({code:'SOURCE_BLOCKED'})
  expect(await db.selectFrom('runs').select('id').execute()).toHaveLength(before.length)
  expect(await db.selectFrom('outbox').select('run_id').execute()).toHaveLength(outboxBefore.length)
  const connections=await services.connections()
  expect(connections.find(row=>row.id===source.id)?.blocked).toBe(true)
  expect(connections.find(row=>row.id===alias.id)?.blocked).toBe(true)
  expect(connections.find(row=>row.id===other.id)?.blocked).toBe(false)
  expect(connections.find(row=>row.id===storage.id)?.blocked).toBe(false)
  const row=await services.connection(alias.id)
  await expect(services.updateConnection(alias.id,{revision:row.revision,name:row.name,password:'synthetic-new'})).rejects.toMatchObject({code:'CONNECTION_BUSY'})
  const renamed=await services.updateConnection(alias.id,{revision:row.revision,name:'Synthetic blocked alias renamed'})
  expect(renamed.blocked).toBe(true)
  await db.updateTable('plans').set({cron:'* * * * *',next_due:sql`clock_timestamp()-interval '1 second'`}).where('id','=',aliasPlan.id).execute()
  expect(await scheduleDue(services)).toEqual({queued:0,processed:1})
  const occurrence=await db.selectFrom('schedule_occurrences').selectAll().where('plan_id','=',aliasPlan.id).orderBy('due_at','desc').executeTakeFirstOrThrow()
  expect(occurrence.outcome).toBe('skipped_source_blocked');expect(occurrence.run_id).toBeNull()
  expect(await db.selectFrom('runs').select('id').execute()).toHaveLength(before.length)
  expect(await db.selectFrom('outbox').select('run_id').execute()).toHaveLength(outboxBefore.length)
  expect((await db.selectFrom('plans').select('next_due').where('id','=',aliasPlan.id).executeTakeFirstOrThrow()).next_due!.getTime()).toBeGreaterThan(Date.now())
  const independent=await services.runBackup(otherPlan.id,randomUUID());expect(independent.status).toBe('queued');await services.cancel(independent.id)
  expect((await services.runBackup(firstPlanId,firstKey)).id).toBe(first.id)
  const retained=await db.selectFrom('source_blocks').selectAll().executeTakeFirstOrThrow()
  expect(retained.resource_key).toBe(journal.resource_key);expect(retained.state).toBe('uncertain');expect(retained.owner_token).toBe(journal.owner_token)
 }finally{
  if(ids.length){
   const runs=await db.selectFrom('runs').select('id').where('source_id','in',ids).execute(),runIds=runs.map(run=>run.id)
   if(runIds.length){await db.deleteFrom('source_blocks').where('run_id','in',runIds).execute();await db.deleteFrom('events').where('run_id','in',runIds).execute();await db.deleteFrom('outbox').where('run_id','in',runIds).execute();await db.deleteFrom('runs').where('id','in',runIds).execute()}
   const plans=await db.selectFrom('plans').select('id').where('source_id','in',ids).execute()
   if(plans.length){await db.deleteFrom('schedule_occurrences').where('plan_id','in',plans.map(plan=>plan.id)).execute();await db.deleteFrom('plans').where('id','in',plans.map(plan=>plan.id)).execute()}
   await db.deleteFrom('connections').where('id','in',ids).execute()
  }
  await db.destroy()
 }
},30000)
