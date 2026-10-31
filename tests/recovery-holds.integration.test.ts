import {test,expect} from 'bun:test'
import {randomBytes,randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'
import {connectDb} from '../server/db'
import {config} from '../server/config'
import {Services} from '../server/services'
import {createApp} from '../server/app'
import {seal} from '../server/security'

const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-recovery-holds'?test:test.skip
acceptance('recovery holds expose bounded safe projections through read-scoped REST and MCP without clearing reservations',async()=>{
 const url=new URL(config.databaseUrl())
 if(url.hostname!=='127.0.0.1'||url.port!=='54371'||url.pathname!=='/steelkeep_recovery_holds_test'||url.username!=='steelkeep')throw new Error('Use only dedicated loopback steelkeep_recovery_holds_test metadata.')
 const {db}=connectDb(),directory=await mkdtemp(join(tmpdir(),'steelkeep-recovery-holds-')),oldScopedFile=process.env.STEELKEEP_SCOPED_TOKENS_FILE
 const readToken=randomBytes(32).toString('hex'),configureToken=randomBytes(32).toString('hex'),privateMarker='synthetic-private-'+randomUUID(),executionToken=randomUUID(),ownerToken=randomUUID()
 const sourceId=randomUUID(),storageId=randomUUID(),backupId=randomUUID(),targets=Array.from({length:101},(_,index)=>({id:randomUUID(),runId:randomUUID(),index})),ids=[sourceId,storageId,...targets.map(target=>target.id)],runIds=[backupId,...targets.map(target=>target.runId)]
 const clients:Client[]=[]
 try{
  for(const table of ['owner_account','connections','runs','artifacts','source_blocks','target_blocks'] as const){if(await db.selectFrom(table).selectAll().executeTakeFirst())throw new Error('Dedicated recovery fixture must be empty.')}
  const file=join(directory,'tokens.json');await writeFile(file,JSON.stringify([{token:readToken,actor:'synthetic-recovery-reader',scopes:['read']},{token:configureToken,actor:'synthetic-configurer-without-read',scopes:['configure']}]),{mode:0o600});process.env.STEELKEEP_SCOPED_TOKENS_FILE=file
  const services=new Services(db),app=createApp(services),secret=seal({password:privateMarker}),baseDate=1700000000000
  await db.insertInto('connections').values([{id:sourceId,name:'Synthetic retained Mongo source',kind:'mongodb' as const,config:{host:'127.0.0.1',port:27017,database:'source',restoreTarget:false},secret,check_status:'untested',checked_at:null},{id:storageId,name:'Synthetic recovery storage',kind:'s3' as const,config:{endpoint:'http://127.0.0.1:54373',bucket:'synthetic-holds'},secret,check_status:'untested',checked_at:null},...targets.map(target=>({id:target.id,name:'Synthetic protected target '+target.index,kind:'mongodb' as const,config:{database:'recovery_'+target.index,restoreTarget:true},secret,check_status:'untested',checked_at:null}))]).execute()
  const run={plan_id:null,phase:'interrupted',idempotency_key:randomUUID(),source_id:sourceId,storage_id:storageId,artifact_id:null,started_at:null,finished_at:new Date(baseDate),heartbeat_at:null,error_code:'SYNTHETIC_INTERRUPTED',error_message:privateMarker,validation:null,cancel_requested:false,attempt:1,execution_token:executionToken,review_fingerprint:privateMarker}
  await db.insertInto('runs').values([{...run,id:backupId,type:'backup' as const,status:'interrupted',target_id:null,created_at:new Date(baseDate)},...targets.map(target=>({...run,id:target.runId,type:'restore' as const,status:target.index===100?'succeeded':'interrupted',phase:target.index===100?'completed':'interrupted',target_id:target.id,idempotency_key:randomUUID(),created_at:new Date(baseDate+1000+target.index),validation:target.index===100?{status:'passed',passed:true,privateData:privateMarker}:target.index===99?{status:'passed',privateData:privateMarker}:null}))]).execute()
  await db.insertInto('source_blocks').values({resource_key:'mongodb:127.0.0.1:27017',server_identity:'synthetic-process',run_id:backupId,execution_token:executionToken,owner_token:ownerToken,state:'acquiring',reason_code:null,created_at:new Date(baseDate),updated_at:new Date(baseDate)}).execute()
  await db.insertInto('target_blocks').values(targets.map(target=>({target_id:target.id,resource_key:'mongodb:recovery_'+target.index,run_id:target.runId,reason:'Synthetic reservation retained for review',created_at:new Date(baseDate+target.index)}))).execute()
  const sourceBefore=await db.selectFrom('source_blocks').selectAll().execute(),targetsBefore=await db.selectFrom('target_blocks').selectAll().orderBy('resource_key').execute()
  const request=(path:string,token?:string)=>app.handle(new Request('http://localhost/api/v1'+path,{headers:token?{authorization:'Bearer '+token}:{}}))
  for(const path of ['/source-blocks','/target-blocks']){
   expect((await request(path)).status).toBe(401);expect((await request(path,configureToken)).status).toBe(403)
  }
  const sourceResponse=await request('/source-blocks',readToken),targetResponse=await request('/target-blocks',readToken)
  expect(sourceResponse.status).toBe(200);expect(targetResponse.status).toBe(200);expect(sourceResponse.headers.get('cache-control')).toBe('no-store');expect(targetResponse.headers.get('cache-control')).toBe('no-store')
  const sources=await sourceResponse.json() as Array<Record<string,unknown>>,holds=await targetResponse.json() as Array<Record<string,unknown>>
  expect(sources).toHaveLength(1);expect(holds).toHaveLength(100)
  expect(sources[0]).toMatchObject({resource_key:'mongodb:127.0.0.1:27017',server_identity:'synthetic-process',run_id:backupId,state:'acquiring',reason_code:null,source_id:sourceId,source_name:'Synthetic retained Mongo source',source_kind:'mongodb',run_status:'interrupted',run_phase:'interrupted',run_error_code:'SYNTHETIC_INTERRUPTED'})
  expect(typeof sources[0].created_at).toBe('string');expect(typeof sources[0].updated_at).toBe('string');expect(typeof sources[0].run_finished_at).toBe('string')
  expect(holds[0]).toMatchObject({target_id:targets[100].id,target_name:'Synthetic protected target 100',target_kind:'mongodb',run_id:targets[100].runId,run_status:'succeeded',validation_status:'passed'})
  expect(holds[1].validation_status).toBeNull();expect(holds.some(hold=>hold.target_id===targets[0].id)).toBe(false)
  const exposed=JSON.stringify({sources,holds})
  for(const forbidden of [privateMarker,secret,executionToken,ownerToken,'execution_token','owner_token','review_fingerprint','error_message','privateData'])expect(exposed.includes(forbidden)).toBe(false)
  // A hold can point to a job older than the latest 100 and still expose its safe owning-job summary.
  const recent=await services.jobs();expect(recent).toHaveLength(100);expect(recent.some(run=>run.id===backupId)).toBe(false)
  expect((await request('/jobs/'+backupId,readToken)).status).toBe(200)
  async function clientFor(token:string){const client=new Client({name:'synthetic-recovery-holds',version:'0.1.0'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}},fetch:async(input,init)=>app.handle(new Request(input,init))}));return client}
  const reader=await clientFor(readToken),tools=(await reader.listTools()).tools
  expect(tools.find(tool=>tool.name==='list_target_blocks')?.annotations?.readOnlyHint).toBe(true)
  expect(tools.find(tool=>tool.name==='observe_native_operation')?.annotations?.readOnlyHint).toBe(false)
  expect(tools.find(tool=>tool.name==='observe_native_operation')?.annotations?.idempotentHint).toBe(false)
  for(const [name,expected]of [['list_source_blocks',sources],['list_target_blocks',holds]] as const){
   const result=await reader.callTool({name,arguments:{}});expect(result.isError).not.toBe(true);expect((result.structuredContent as {data:unknown}).data).toEqual(expected)
  }
  const forbiddenObservation=await reader.callTool({name:'observe_native_operation',arguments:{connectionId:sourceId,operationId:randomUUID()}});expect(forbiddenObservation.isError).toBe(true)
  const configurer=await clientFor(configureToken),denied=await configurer.callTool({name:'list_target_blocks',arguments:{}});expect(denied.isError).toBe(true);expect((denied.structuredContent as {data:{error:{code:string}}}).data.error.code).toBe('FORBIDDEN')
  expect(await db.selectFrom('source_blocks').selectAll().execute()).toEqual(sourceBefore)
  expect(await db.selectFrom('target_blocks').selectAll().orderBy('resource_key').execute()).toEqual(targetsBefore)
  expect(await db.selectFrom('outbox').selectAll().execute()).toHaveLength(0)
 }finally{
  for(const client of clients)await client.close().catch(()=>{})
  if(oldScopedFile===undefined)delete process.env.STEELKEEP_SCOPED_TOKENS_FILE;else process.env.STEELKEEP_SCOPED_TOKENS_FILE=oldScopedFile
  await db.deleteFrom('source_blocks').where('run_id','in',runIds).execute();await db.deleteFrom('target_blocks').where('run_id','in',runIds).execute();await db.deleteFrom('runs').where('id','in',runIds).execute();await db.deleteFrom('connections').where('id','in',ids).execute()
  await db.destroy();await rm(directory,{recursive:true,force:true})
 }
},30000)
