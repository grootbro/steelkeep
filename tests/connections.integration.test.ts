// Source only: execution is deferred until the owner authorizes running checks.
import {test,expect,afterAll} from 'bun:test'
import {randomUUID} from 'node:crypto'
import {sql} from 'kysely'
import {connectDb} from '../server/db'
import {Services,type ConnectionRow} from '../server/services'
import {seal,unseal} from '../server/security'
import {allScopes} from '../server/auth'
import {createApp} from '../server/app'
import {config} from '../server/config'
import {scheduleDue} from '../server/scheduler'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'

// This suite inserts and removes metadata. Never follow an operator's production URL.
if(process.env.STEELKEEP_ACCEPTANCE!=='synthetic-local')throw new Error('Integration tests require explicit STEELKEEP_ACCEPTANCE=synthetic-local fixture mode.')
const metadataUrl=new URL(config.databaseUrl())
if(!['127.0.0.1','localhost'].includes(metadataUrl.hostname)||metadataUrl.port!=='54371'||metadataUrl.pathname!=='/steelkeep'||metadataUrl.username!=='steelkeep')throw new Error('Integration tests require the isolated loopback Steelkeep metadata fixture on port 54371.')
const {db}=connectDb(),service=new Services(db),app=createApp(service)
afterAll(()=>db.destroy())
const source=()=>service.createConnection({kind:'postgres',name:'Synthetic editable '+randomUUID(),host:'127.0.0.1',port:54372,database:'source',user:'backup_reader',password:'synthetic-original-password',tls:false})
const storage=()=>service.createConnection({kind:'s3',name:'Synthetic storage '+randomUUID(),endpoint:'http://127.0.0.1:54373',bucket:'steelkeep-test',accessKey:'synthetic-original-key',secretKey:'synthetic-original-secret'})
async function cleanup(ids:string[]){
 const runs=await db.selectFrom('runs').select('id').where(eb=>eb.or([eb('source_id','in',ids),eb('storage_id','in',ids),eb('target_id','in',ids)])).execute(),runIds=runs.map(r=>r.id)
 if(runIds.length){
  await db.deleteFrom('source_blocks').where('run_id','in',runIds).execute();await db.deleteFrom('target_blocks').where('run_id','in',runIds).execute()
  await db.deleteFrom('restore_intents').where('consumed_run_id','in',runIds).execute()
  await db.deleteFrom('events').where('run_id','in',runIds).execute();await db.deleteFrom('outbox').where('run_id','in',runIds).execute()
  await db.deleteFrom('schedule_occurrences').where('run_id','in',runIds).execute();await db.deleteFrom('runs').where('id','in',runIds).execute()
 }
 const plans=await db.selectFrom('plans').select('id').where(eb=>eb.or([eb('source_id','in',ids),eb('storage_id','in',ids)])).execute()
 if(plans.length){await db.deleteFrom('schedule_occurrences').where('plan_id','in',plans.map(p=>p.id)).execute();await db.deleteFrom('plans').where('id','in',plans.map(p=>p.id)).execute()}
 await db.deleteFrom('connections').where('id','in',ids).execute()
}

test('rename preserves sealed credentials and checked state; rotation resets only connection check',async()=>{
 const {id}=await source()
 try{
  await db.updateTable('connections').set({check_status:'available',checked_at:new Date()}).where('id','=',id).execute()
  const before=await service.connection(id),renamed=await service.updateConnection(id,{revision:before.revision,name:'Renamed fixture'})
  const kept=await service.connection(id)
  expect(kept.secret).toBe(before.secret);expect(kept.check_status).toBe('available');expect(kept.checked_at).toEqual(before.checked_at);expect(renamed.revision).toBe(before.revision+1)
  const updated=await service.updateConnection(id,{revision:renamed.revision,name:renamed.name,password:'synthetic-rotated-password'})
  const rotated=await service.connection(id)
  expect(rotated.secret).not.toBe(before.secret);expect(unseal<{password:string}>(rotated.secret).password).toBe('synthetic-rotated-password')
  expect(updated.check_status).toBe('untested');expect(updated.checked_at).toBeNull()
  expect(JSON.stringify(updated)).not.toContain('synthetic-rotated-password');expect(JSON.stringify(updated)).not.toContain('"secret"')
 }finally{await cleanup([id])}
})
test('S3 key rotation preserves an omitted companion secret and never returns either credential',async()=>{
 const {id}=await storage()
 try{
  const row=await service.connection(id),updated=await service.updateConnection(id,{revision:row.revision,name:row.name,accessKey:'synthetic-new-key'})
  const credentials=unseal<{accessKey:string;secretKey:string}>((await service.connection(id)).secret)
  expect(credentials).toEqual({accessKey:'synthetic-new-key',secretKey:'synthetic-original-secret'})
  expect(JSON.stringify(updated)).not.toContain(credentials.accessKey);expect(JSON.stringify(updated)).not.toContain(credentials.secretKey)
  await expect(service.updateConnection(id,{revision:updated.revision,name:updated.name,user:'wrong-kind'})).rejects.toMatchObject({code:'INAPPLICABLE_FIELD'})
 }finally{await cleanup([id])}
})
test('only one concurrent edit of the same revision succeeds; immutable and inapplicable fields fail closed',async()=>{
 const {id}=await source()
 try{
  const row=await service.connection(id),results=await Promise.allSettled([service.updateConnection(id,{revision:row.revision,name:'First edit'}),service.updateConnection(id,{revision:row.revision,name:'Second edit'})])
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
  const rejected=results.find(r=>r.status==='rejected');expect(rejected?.status==='rejected'?(rejected.reason as {code:string}).code:'').toBe('REVISION_CONFLICT')
  const latest=await service.connection(id)
  await expect(service.updateConnection(id,{revision:latest.revision,name:latest.name,host:'other.invalid'} as never)).rejects.toMatchObject({code:'IMMUTABLE_CONNECTION'})
  await expect(service.updateConnection(id,{revision:latest.revision,name:latest.name,password:''})).rejects.toMatchObject({code:'INVALID_CONNECTION_UPDATE'})
  await expect(service.updateConnection(id,{revision:latest.revision,name:latest.name,quiescentSource:true})).rejects.toMatchObject({code:'INAPPLICABLE_FIELD'})
  const response=await app.handle(new Request('http://localhost/api/v1/connections/'+id,{method:'PATCH',headers:{authorization:'Bearer '+config.token(),'content-type':'application/json'},body:JSON.stringify({revision:latest.revision,name:latest.name,restoreTarget:true})}))
  expect(response.status).toBe(422)
 }finally{await cleanup([id])}
})
test('queued source and storage credentials are frozen while rename remains available',async()=>{
 const a=await source(),b=await storage()
 try{
  const plan=await service.createPlan({name:'Synthetic busy plan',sourceId:a.id,storageId:b.id,timezone:'UTC'}),run=await service.runBackup(plan.id,randomUUID())
  const row=await service.connection(a.id)
  await expect(service.updateConnection(a.id,{revision:row.revision,name:row.name,password:'new-while-busy'})).rejects.toMatchObject({code:'CONNECTION_BUSY'})
  const renamed=await service.updateConnection(a.id,{revision:row.revision,name:'Renamed while queued'})
  expect(renamed.revision).toBe(row.revision+1)
  const store=await service.connection(b.id)
  await expect(service.updateConnection(b.id,{revision:store.revision,name:store.name,secretKey:'new-while-busy'})).rejects.toMatchObject({code:'CONNECTION_BUSY'})
  await service.cancel(run.id)
  const edited=await service.updateConnection(a.id,{revision:renamed.revision,name:renamed.name,password:'new-after-cancel'})
  expect(edited.check_status).toBe('untested')
 }finally{await cleanup([a.id,b.id])}
})
test('an uncertain source journal freezes credentials even after its run is interrupted',async()=>{
 const a=await source(),b=await storage()
 try{
  const plan=await service.createPlan({name:'Synthetic journal plan',sourceId:a.id,storageId:b.id,timezone:'UTC'}),run=await service.runBackup(plan.id,randomUUID())
  await db.updateTable('runs').set({status:'interrupted'}).where('id','=',run.id).execute()
  await db.insertInto('source_blocks').values({resource_key:'postgres:source',server_identity:'synthetic:'+randomUUID(),run_id:run.id,execution_token:randomUUID(),owner_token:randomUUID(),state:'uncertain',reason_code:'SYNTHETIC_UNKNOWN'}).execute()
  const row=await service.connection(a.id)
  await expect(service.updateConnection(a.id,{revision:row.revision,name:row.name,user:'another_reader'})).rejects.toMatchObject({code:'CONNECTION_BUSY'})
  expect((await service.updateConnection(a.id,{revision:row.revision,name:'Journal source renamed'})).name).toBe('Journal source renamed')
 }finally{await cleanup([a.id,b.id])}
})
test('late connection checks cannot overwrite a new credential revision',async()=>{
 const {id}=await source();let release!:()=>void,started!:()=>void
 const wait=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{started=resolve})
 class DelayedProbe extends Services {protected override async probeConnection(_row:ConnectionRow){started();await wait}}
 try{
  const checker=new DelayedProbe(db),pending=checker.testConnection(id);await entered
  const row=await service.connection(id)
  await service.updateConnection(id,{revision:row.revision,name:row.name,password:'synthetic-new-during-check'})
  release();expect((await pending).status).toBe('stale')
  const latest=await service.connection(id);expect(latest.check_status).toBe('untested');expect(latest.checked_at).toBeNull()
 }finally{release();await cleanup([id])}
})
test('unused metadata deletion succeeds, but cancelled run and plan history remain protected',async()=>{
 const unused=await source();expect((await service.deleteUnusedConnection(unused.id)).deleted).toBe(true)
 await expect(service.connection(unused.id)).rejects.toMatchObject({code:'NOT_FOUND'})
 const a=await source(),b=await storage()
 try{
  const plan=await service.createPlan({name:'Synthetic retained plan',sourceId:a.id,storageId:b.id,timezone:'UTC'}),run=await service.runBackup(plan.id,randomUUID())
  await service.cancel(run.id)
  await expect(service.deleteUnusedConnection(a.id)).rejects.toMatchObject({code:'CONNECTION_IN_USE'})
  await db.updateTable('runs').set({plan_id:null}).where('id','=',run.id).execute();await db.deleteFrom('plans').where('id','=',plan.id).execute()
  await expect(service.deleteUnusedConnection(a.id)).rejects.toMatchObject({code:'CONNECTION_IN_USE'})
  await expect(service.deleteUnusedConnection(b.id)).rejects.toMatchObject({code:'CONNECTION_IN_USE'})
 }finally{await cleanup([a.id,b.id])}
})
test('manual and scheduled admission cannot race a credential edit into a queued run',async()=>{
 const a=await source(),b=await storage()
 try{
  const plan=await service.createPlan({name:'Synthetic admission race',sourceId:a.id,storageId:b.id,timezone:'UTC'}),row=await service.connection(a.id)
  const [queued,edited]=await Promise.allSettled([service.runBackup(plan.id,randomUUID()),service.updateConnection(a.id,{revision:row.revision,name:row.name,password:'racing-synthetic-password'})])
  expect(queued.status).toBe('fulfilled')
  if(edited.status==='rejected')expect((edited.reason as {code:string}).code).toBe('CONNECTION_BUSY')
  if(queued.status==='fulfilled')await service.cancel(queued.value.id)
  await db.updateTable('plans').set({cron:'* * * * *',next_due:sql`now()`}).where('id','=',plan.id).execute()
  const current=await service.connection(a.id)
  const [scheduled,rotation]=await Promise.allSettled([scheduleDue(service),service.updateConnection(a.id,{revision:current.revision,name:current.name,password:'scheduled-synthetic-password'})])
  expect(scheduled.status).toBe('fulfilled')
  if(rotation.status==='rejected')expect((rotation.reason as {code:string}).code).toBe('CONNECTION_BUSY')
 }finally{await cleanup([a.id,b.id])}
})

test('a queued restore freezes its target credentials while a target rename stays safe',async()=>{
 const a=await source(),b=await storage(),target=await service.createConnection({kind:'postgres',name:'Synthetic target',host:'127.0.0.1',port:54372,database:'restore_target',user:'restore_writer',password:'synthetic-target-password',tls:false,restoreTarget:true}),id=randomUUID()
 try{
  await db.insertInto('runs').values({id,plan_id:null,type:'restore',status:'queued',phase:'queued',idempotency_key:randomUUID(),source_id:a.id,storage_id:b.id,target_id:target.id,artifact_id:null,started_at:null,finished_at:null,heartbeat_at:null,error_code:null,error_message:null,validation:null,cancel_requested:false,attempt:0,execution_token:null,review_fingerprint:null}).execute()
  const row=await service.connection(target.id)
  await expect(service.updateConnection(target.id,{revision:row.revision,name:row.name,tls:true})).rejects.toMatchObject({code:'CONNECTION_BUSY'})
  await expect(service.updateConnection(target.id,{revision:row.revision,name:row.name,allowGlobalReadLock:true})).rejects.toMatchObject({code:'INAPPLICABLE_FIELD'})
  const renamed=await service.updateConnection(target.id,{revision:row.revision,name:'Target renamed'})
  expect(renamed.name).toBe('Target renamed');expect((await service.connection(target.id)).secret).toBe(row.secret)
 }finally{await cleanup([a.id,b.id,target.id])}
})
test('unused deletion and plan admission serialize rather than producing a dangling reference',async()=>{
 const a=await source(),b=await storage()
 try{
  const [plan,deleted]=await Promise.allSettled([service.createPlan({name:'Synthetic deletion race',sourceId:a.id,storageId:b.id,timezone:'UTC'}),service.deleteUnusedConnection(a.id)])
  expect(plan.status==='fulfilled'||deleted.status==='fulfilled').toBe(true)
  if(plan.status==='fulfilled'){expect(deleted.status).toBe('rejected');if(deleted.status==='rejected')expect((deleted.reason as {code:string}).code).toBe('CONNECTION_IN_USE')}
  else{expect(deleted.status).toBe('fulfilled');expect((plan.reason as {code:string}).code).toBe('NOT_FOUND')}
 }finally{await cleanup([a.id,b.id])}
})
test('MCP edit/delete expose typed safe results and reject identity changes without normalizing them away',async()=>{
 const {id}=await source(),client=new Client({name:'steelkeep-connection-management',version:'0.1.0'})
 const transport=new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),{requestInit:{headers:{authorization:'Bearer '+config.token()}},fetch:async(input,init)=>app.handle(new Request(input,init))})
 try{
  await client.connect(transport)
  const tools=(await client.listTools()).tools
  expect(tools.find(tool=>tool.name==='update_connection')?.outputSchema).toBeDefined();expect(tools.find(tool=>tool.name==='delete_unused_connection')?.outputSchema).toBeDefined()
  const row=await service.connection(id),updated=await client.callTool({name:'update_connection',arguments:{id,revision:row.revision,name:'MCP renamed',password:'synthetic-mcp-rotated'}})
  expect(updated.isError).not.toBe(true)
  const safe=(updated.structuredContent as {data:{revision:number;name:string}}).data
  expect(safe.name).toBe('MCP renamed');expect(safe.revision).toBe(row.revision+1);expect(JSON.stringify(updated)).not.toContain('synthetic-mcp-rotated')
  let refused=false
  try{refused=(await client.callTool({name:'update_connection',arguments:{id,revision:safe.revision,name:safe.name,host:'forbidden.invalid'}})).isError===true}catch{refused=true}
  expect(refused).toBe(true);expect((await service.connection(id)).revision).toBe(safe.revision)
  const removed=await client.callTool({name:'delete_unused_connection',arguments:{id}})
  expect(removed.isError).not.toBe(true);expect((removed.structuredContent as {data:{deleted:boolean}}).data.deleted).toBe(true)
 }finally{await client.close();await cleanup([id])}
})

test('SQLite has no editable credentials and source-only lock flags cannot be granted to targets',async()=>{
 const sqlite=randomUUID(),target=await service.createConnection({kind:'mongodb',name:'Synthetic immutable target',host:'127.0.0.1',database:'restore_target',user:'restore_writer',password:'synthetic-only',tls:false,restoreTarget:true})
 await db.insertInto('connections').values({id:sqlite,name:'Synthetic SQLite policy only',kind:'sqlite',config:{engine:'sqlite',path:'/synthetic-never-opened/target.db',database:'/synthetic-never-opened/target.db',restoreTarget:true},secret:seal({}),check_status:'untested',checked_at:null}).execute()
 try{
  const row=await service.connection(sqlite)
  for(const field of [{user:'forbidden'},{password:'forbidden'},{tls:false}])await expect(service.updateConnection(sqlite,{revision:row.revision,name:row.name,...field})).rejects.toMatchObject({code:'INAPPLICABLE_FIELD'})
  const mongo=await service.connection(target.id)
  await expect(service.updateConnection(target.id,{revision:mongo.revision,name:mongo.name,allowGlobalReadLock:true})).rejects.toMatchObject({code:'INAPPLICABLE_FIELD'})
 }finally{await cleanup([sqlite,target.id])}
})
test('read-only agent tokens cannot edit or delete connection metadata',async()=>{
 const {id}=await source(),owner={actor:'installation-owner',scopes:allScopes},agent=await service.agents.create(owner,{name:'Synthetic connection reader'})
 try{
  const token=await service.agents.issue(owner,agent.id,{name:'Read-only policy test'}),row=await service.connection(id)
  const headers={authorization:'Bearer '+token.token,'content-type':'application/json'}
  const edited=await app.handle(new Request('http://localhost/api/v1/connections/'+id,{method:'PATCH',headers,body:JSON.stringify({revision:row.revision,name:'Forbidden rename'})}))
  expect(edited.status).toBe(403)
  expect((await app.handle(new Request('http://localhost/api/v1/connections/'+id,{method:'DELETE',headers}))).status).toBe(403)
  expect((await service.connection(id)).revision).toBe(row.revision)
 }finally{await cleanup([id]);await db.deleteFrom('agent_tokens').where('agent_id','=',agent.id).execute();await db.deleteFrom('agents').where('id','=',agent.id).execute()}
})
