import {test,expect,spyOn} from 'bun:test'
import {randomUUID} from 'node:crypto'
import {realpath} from 'node:fs/promises'
import pg from 'pg'
import {Kysely,PostgresDialect,sql} from 'kysely'
import type {Schema} from '../server/db'
import {Services} from '../server/services'
import {AppError} from '../server/security'

const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-local-restore-clock'?test:test.skip
const database='steelkeep_restore_clock_test'

acceptance('restore review expiry uses actual admission time after a lock wait and preserves consumed retries',async()=>{
 if(await realpath(process.cwd())!=='/Users/dobrota/dev/steelkeep')throw new Error('Use the fixed Steelkeep checkout.')
 const target=new URL(process.env.DATABASE_URL??'')
 if(target.hostname!=='127.0.0.1'||target.port!=='54371'||target.pathname!==`/${database}`||target.username!=='steelkeep'||target.search||target.hash)throw new Error('Require the dedicated loopback steelkeep_restore_clock_test URL; never the main metadata database.')
 const adminUrl=new URL(target);adminUrl.pathname='/postgres'
 const options={connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000}
 const admin=new pg.Client({connectionString:adminUrl.toString(),...options,application_name:'steelkeep-restore-clock-admin'})
 const holder=new pg.Client({connectionString:target.toString(),...options,application_name:'steelkeep-restore-clock-holder'})
 const application='steelkeep-restore-clock-'+randomUUID().slice(0,12),pool=new pg.Pool({connectionString:target.toString(),...options,max:1,application_name:application})
 const statements:string[]=[],db=new Kysely<Schema>({dialect:new PostgresDialect({pool}),log:event=>{if(event.level==='query')statements.push(event.query.sql)}})
 const service=new Services(db),actor='synthetic-restore-clock-proof',suffix=randomUUID()
 const sourceId=randomUUID(),storageId=randomUUID(),targetId=randomUUID(),artifactId=randomUUID(),backupId=randomUUID(),restoreId=randomUUID(),intentId=randomUUID(),consumedIntentId=randomUUID(),preflightIntentId=randomUUID(),key=randomUUID(),consumedKey=randomUUID(),preflightKey=randomUUID()
 const connections=[sourceId,storageId,targetId],runs=[backupId,restoreId],intents=[intentId,consumedIntentId,preflightIntentId]
 let created=false,holderConnected=false,locked=false,createdOid:number|undefined,pending:Promise<{code:string;id?:string}>|undefined,releasePreflight:(()=>void)|undefined
 async function waitFor<T>(read:()=>Promise<T|undefined>,message:string):Promise<T>{
  const deadline=Date.now()+5000
  do{const value=await read();if(value!==undefined)return value;await Bun.sleep(5)}while(Date.now()<deadline)
  throw new Error(message)
 }
 try{
  await admin.connect()
  if((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount)throw new Error('Dedicated clock database already exists; retain it and inspect explicitly before rerunning.')
  await admin.query('CREATE DATABASE steelkeep_restore_clock_test');created=true
  createdOid=(await admin.query<{oid:number}>('SELECT oid FROM pg_database WHERE datname=$1',[database])).rows[0].oid
  const migration=Bun.spawn([process.execPath,'server/migrate.ts'],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:target.toString(),STEELKEEP_DATABASE_PASSWORD_FILE:''},stdout:'ignore',stderr:'ignore',timeout:15000})
  if(await migration.exited!==0)throw new Error('Dedicated metadata migration failed; raw diagnostics withheld.')
  await holder.connect();holderConnected=true
  const identity=await holder.query<{database:string;role:string}>('SELECT current_database() AS database,current_user AS role')
  expect(identity.rows[0]).toEqual({database,role:'steelkeep'})
  const empty=await holder.query<{n:number}>('SELECT ((SELECT count(*) FROM connections)+(SELECT count(*) FROM runs)+(SELECT count(*) FROM artifacts)+(SELECT count(*) FROM owner_account))::int AS n')
  expect(empty.rows[0].n).toBe(0)
  await db.insertInto('connections').values([
   {id:sourceId,name:'Synthetic clock source '+suffix,kind:'postgres',config:{database:'synthetic_clock_source',host:'restore-clock.invalid',port:1,restoreTarget:false},secret:'synthetic-metadata-only-no-valid-ciphertext',check_status:'untested',checked_at:null},
   {id:storageId,name:'Synthetic clock storage '+suffix,kind:'s3',config:{endpoint:'https://restore-clock.invalid',bucket:'synthetic-never-uploaded'},secret:'synthetic-metadata-only-no-valid-ciphertext',check_status:'untested',checked_at:null},
   {id:targetId,name:'Synthetic clock target '+suffix,kind:'postgres',config:{database:'synthetic_clock_target',host:'restore-clock.invalid',port:1,restoreTarget:true},secret:'synthetic-metadata-only-no-valid-ciphertext',check_status:'untested',checked_at:null}
  ]).execute()
  const run={plan_id:null,source_id:sourceId,storage_id:storageId,started_at:null,finished_at:null,heartbeat_at:null,error_code:null,error_message:null,validation:null,cancel_requested:false,attempt:0,execution_token:null,review_fingerprint:null}
  await db.insertInto('runs').values([
   {...run,id:backupId,type:'backup',status:'succeeded',phase:'succeeded',idempotency_key:randomUUID(),target_id:null,artifact_id:artifactId},
   {...run,id:restoreId,type:'restore',status:'interrupted',phase:'interrupted',idempotency_key:consumedKey,target_id:targetId,artifact_id:artifactId}
  ]).execute()
  // No object exists. Even a regression reaching preflight must stop at availability,
  // before decrypting credentials, reaching a database or executing a native tool.
  await db.insertInto('artifacts').values({id:artifactId,run_id:backupId,source_id:sourceId,storage_id:storageId,object_key:'synthetic-clock/'+suffix,size:'0',sha256:'0'.repeat(64),engine:'postgres',server_version:'synthetic',tool_version:'synthetic-no-native-tool',availability:'unknown',checked_at:null,manifest:null}).execute()
  await db.insertInto('restore_intents').values([
   {id:intentId,actor,artifact_id:artifactId,target_id:targetId,review:{synthetic:suffix},fingerprint:'synthetic-clock-'+suffix,expires_at:sql<Date>`clock_timestamp()+interval '1 hour'`,consumed_run_id:null,idempotency_key:null},
   {id:consumedIntentId,actor,artifact_id:artifactId,target_id:targetId,review:{synthetic:suffix},fingerprint:'synthetic-clock-'+suffix,expires_at:sql<Date>`clock_timestamp()-interval '1 hour'`,consumed_run_id:restoreId,idempotency_key:consumedKey},
   {id:preflightIntentId,actor,artifact_id:artifactId,target_id:targetId,review:{synthetic:suffix},fingerprint:'synthetic-clock-'+suffix,expires_at:sql<Date>`clock_timestamp()+interval '1 hour'`,consumed_run_id:null,idempotency_key:null}
  ]).execute()
  await holder.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);locked=true
  const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid
  statements.length=0
  pending=service.startRestore(intentId,key,actor).then(run=>({code:'ACCEPTED',id:run.id}),error=>({code:error instanceof AppError?error.code:'UNEXPECTED_ERROR'}))
  const waiting=await waitFor(async()=>{
   const result=await admin.query<{pid:number;transaction_started:string;blocked:boolean}>(`SELECT pid,xact_start::text AS transaction_started,$3::int=ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'`,[database,application,pid])
   return result.rows.find(row=>row.blocked)
  },'Restore admission did not reach the observed advisory-lock barrier.')
  expect(waiting.blocked).toBe(true)
  await holder.query(`UPDATE restore_intents SET expires_at=(SELECT xact_start+interval '1 millisecond' FROM pg_stat_activity WHERE pid=$2) WHERE id=$1`,[intentId,waiting.pid])
  const boundary=await waitFor(async()=>{
   const result=await holder.query<{after_start:boolean;expired:boolean;still_blocked:boolean}>(`SELECT i.expires_at>s.xact_start AS after_start,i.expires_at<clock_timestamp() AS expired,$3::int=ANY(pg_blocking_pids(s.pid)) AS still_blocked FROM restore_intents i CROSS JOIN pg_stat_activity s WHERE i.id=$1 AND s.pid=$2`,[intentId,waiting.pid,pid])
   return result.rows.find(row=>row.expired)
  },'The actual database clock did not pass the review expiry while admission remained blocked.')
  expect(boundary).toEqual({after_start:true,expired:true,still_blocked:true})
  expect((await holder.query<{released:boolean}>('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS released',[key])).rows[0].released).toBe(true);locked=false
  expect(await pending).toEqual({code:'RESTORE_REVIEW_EXPIRED'})
  expect(statements.some(statement=>statement.includes('clock_timestamp() AS now'))).toBe(true)
  expect(statements.some(statement=>/from "artifacts"|from "connections"|insert into "outbox"|insert into "runs"/i.test(statement))).toBe(false)
  const before=await holder.query<{runs:number;outbox:number;blocks:number;events:number;audits:number}>(`SELECT (SELECT count(*) FROM runs)::int AS runs,(SELECT count(*) FROM outbox)::int AS outbox,(SELECT count(*) FROM target_blocks)::int AS blocks,(SELECT count(*) FROM events)::int AS events,(SELECT count(*) FROM audit_events)::int AS audits`)
  expect(before.rows[0]).toEqual({runs:2,outbox:0,blocks:0,events:0,audits:0})
  const consumed=await service.startRestore(consumedIntentId,consumedKey,actor)
  expect(consumed.id).toBe(restoreId);expect(consumed.status).toBe('interrupted')
  await expect(service.startRestore(consumedIntentId,randomUUID(),actor)).rejects.toMatchObject({code:'RESTORE_REVIEW_CONSUMED',status:409})
  expect((await holder.query<{n:number}>('SELECT count(*)::int AS n FROM outbox')).rows[0].n).toBe(0)
  // Only this second boundary uses a synthetic preflight: real admission SQL
  // must reject a review that expires while the preflight response is pending.
  const restoreModule=await import('../server/restore')
  let preflightEntered=false
  const heldPreflight=new Promise<void>(resolve=>{releasePreflight=resolve})
  const inspect=spyOn(restoreModule,'inspectRestore').mockImplementation(async(_service,requestedArtifact,requestedTarget)=>{
   expect(requestedArtifact).toBe(artifactId);expect(requestedTarget).toBe(targetId)
   preflightEntered=true;await heldPreflight
   return {artifactId,targetId,fingerprint:'synthetic-clock-'+suffix,engine:'postgres',sourceDatabase:'synthetic_clock_source',targetDatabase:'synthetic_clock_target',sourceVersion:'synthetic',targetVersion:'synthetic',archiveBytes:1,sha256:'0'.repeat(64),checks:{trustedArtifact:true,targetEmpty:true,targetAllowlisted:true,distinctDatabase:true},warnings:[]}
  })
  try{
   await holder.query("UPDATE restore_intents SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",[preflightIntentId])
   statements.length=0
   pending=service.startRestore(preflightIntentId,preflightKey,actor).then(run=>({code:'ACCEPTED',id:run.id}),error=>({code:error instanceof AppError?error.code:'UNEXPECTED_ERROR'}))
   await waitFor(async()=>preflightEntered?true:undefined,'Restore did not enter the gated synthetic preflight before its deadline.')
   await waitFor(async()=>{const result=await holder.query<{expired:boolean}>('SELECT expires_at<clock_timestamp() AS expired FROM restore_intents WHERE id=$1',[preflightIntentId]);return result.rows[0].expired?true:undefined},'Review did not expire during the synthetic preflight.')
   releasePreflight?.();releasePreflight=undefined
   expect(await pending).toEqual({code:'RESTORE_REVIEW_EXPIRED'})
   expect(inspect).toHaveBeenCalledTimes(1)
   expect(statements.filter(statement=>statement.includes('clock_timestamp() AS now')).length).toBe(2)
   expect(statements.some(statement=>/insert into "runs"|insert into "target_blocks"|insert into "outbox"/i.test(statement))).toBe(false)
   expect((await holder.query<{n:number}>('SELECT count(*)::int AS n FROM outbox')).rows[0].n).toBe(0)
  }finally{releasePreflight?.();releasePreflight=undefined;await pending;inspect.mockRestore()}
  console.info(JSON.stringify({proof:'restore-review-clock',observedAdvisoryWait:true,expiryAfterTransactionStart:true,expiredBeforeRelease:true,result:'RESTORE_REVIEW_EXPIRED',initialPreflightReads:0,outboxWrites:0,consumedSameKey:'original-run',consumedOtherKey:'refused',finalAdmission:'expired-during-gated-preflight-refused',nativePreflight:'mocked-only-for-final-boundary'}))
 }finally{
  let emptyVerified=false
  try{
   try{
    if(locked&&holderConnected){await holder.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);locked=false}
    releasePreflight?.();await pending
    if(created&&holderConnected){
     const foreign=await holder.query<{n:number}>(`SELECT ((SELECT count(*) FROM connections WHERE NOT(id=ANY($1::uuid[])))+(SELECT count(*) FROM runs WHERE NOT(id=ANY($2::uuid[])))+(SELECT count(*) FROM artifacts WHERE id<>$3)+(SELECT count(*) FROM restore_intents WHERE NOT(id=ANY($4::uuid[]))))::int AS n`,[connections,runs,artifactId,intents])
     if(foreign.rows[0].n!==0)throw new Error('Unexpected data in the dedicated clock fixture; preserve it for inspection.')
     await db.deleteFrom('restore_intents').where('id','in',intents).execute()
     await db.deleteFrom('artifacts').where('id','=',artifactId).execute()
     await db.deleteFrom('runs').where('id','in',runs).execute()
     await db.deleteFrom('connections').where('id','in',connections).execute()
     for(const table of ['connections','plans','runs','artifacts','events','outbox','restore_intents','schedule_occurrences','target_blocks','source_blocks','agents','agent_tokens','audit_events','owner_account','browser_sessions','worker_state'] as const){
      const result=await db.selectFrom(table).select(eb=>eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()
      if(Number(result.n)!==0)throw new Error('Dedicated clock fixture retains unexpected application data; preserve it for inspection.')
     }
     emptyVerified=true
    }
   }finally{await db.destroy();if(holderConnected)await holder.end()}
   if(created){
    if(!emptyVerified)throw new Error('Dedicated clock fixture cleanup was not verified; preserve the database for inspection.')
    const row=(await admin.query<{oid:number;clients:number}>('SELECT d.oid,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=d.datname) AS clients FROM pg_database d WHERE d.datname=$1',[database])).rows[0]
    if(!row||row.oid!==createdOid||row.clients!==0)throw new Error('Dedicated clock database identity or active-client guard failed; no drop performed.')
    await admin.query('DROP DATABASE steelkeep_restore_clock_test')
    expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount).toBe(0)
   }
  }finally{await admin.end()}
 }
},45000)
