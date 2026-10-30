// Metadata/probe contract fixtures only: these do not prove a real backup or restore.
import {test,expect,afterAll} from 'bun:test'
import {randomUUID} from 'node:crypto'
import {connectDb} from '../server/db'
import {config} from '../server/config'
import {Services} from '../server/services'
import {createApp} from '../server/app'
import {allScopes} from '../server/auth'
import {probeArtifactAvailability,type AvailabilityObservation,type HeadResponse} from '../server/artifact-availability'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'

// This suite inserts and removes metadata. Never follow an operator's production URL.
if(process.env.STEELKEEP_ACCEPTANCE!=='synthetic-local')throw new Error('Integration tests require explicit STEELKEEP_ACCEPTANCE=synthetic-local fixture mode.')
const metadataUrl=new URL(config.databaseUrl())
if(!['127.0.0.1','localhost'].includes(metadataUrl.hostname)||metadataUrl.port!=='54371'||metadataUrl.pathname!=='/steelkeep'||metadataUrl.username!=='steelkeep')throw new Error('Integration tests require the isolated loopback Steelkeep metadata fixture on port 54371.')
const {db}=connectDb(),service=new Services(db)
afterAll(()=>db.destroy())
const expected={size:'100',sha256:'a'.repeat(64)}
function observe(head:()=>Promise<HeadResponse>){return probeArtifactAvailability({head,destroy(){}},expected)}
const present=()=>observe(async()=>({ContentLength:100,Metadata:{sha256:expected.sha256}}))
const missing=()=>observe(async()=>{throw {$metadata:{httpStatusCode:404},message:'Never return this private provider message'}})

test('HEAD agreement is reported as object metadata only and destroys the client',async()=>{
 let destroyed=false
 const result=await probeArtifactAvailability({head:async()=>({ContentLength:100,Metadata:{sha256:expected.sha256}}),destroy(){destroyed=true}},expected)
 expect(result.availability).toBe('present');expect(result.verification).toBe('object-head-only')
 expect(result.checks).toEqual({objectExists:true,sizeMatches:true,metadataSha256Matches:true});expect(destroyed).toBe(true)
})
test('size differences block availability while metadata digest differences alone keep restore eligible',async()=>{
 const changed=await observe(async()=>({ContentLength:101,Metadata:{sha256:expected.sha256}}))
 expect(changed.availability).toBe('changed');expect(changed.checks.sizeMatches).toBe(false)
 for(const Metadata of [undefined,{sha256:'b'.repeat(64)}]){
  const result=await observe(async()=>({ContentLength:100,Metadata}))
  expect(result.availability).toBe('present');expect(result.checks.metadataSha256Matches).toBe(false);expect(result.reason).toBe('metadata_sha256_mismatch')
 }
})
test('only an authoritative 404 is missing; denied and failing requests stay unknown without provider secrets',async()=>{
 for(const status of [401,403,404,429,500]){
  const secret='synthetic-provider-secret-'+status
  const result=await observe(async()=>{throw {name:'NoSuchKey',$metadata:{httpStatusCode:status},message:secret,credentials:{secretAccessKey:secret}}})
  expect(result.availability).toBe(status===404?'missing':'unknown')
  expect(result.checks.objectExists).toBe(status===404?false:null)
  expect(JSON.stringify(result)).not.toContain(secret)
 }
})
test('unusable size stays unknown despite an existing object and matching metadata digest',async()=>{
 const result=await observe(async()=>({Metadata:{sha256:expected.sha256}}))
 expect(result.availability).toBe('unknown');expect(result.checks.objectExists).toBe(true);expect(result.checks.sizeMatches).toBeNull()
})
test('a nonsettling provider is bounded by the deadline and destroyed',async()=>{
 let aborted:AbortSignal|undefined,destroyed=false
 const result=await probeArtifactAvailability({head:signal=>{aborted=signal;return new Promise<HeadResponse>(()=>{})},destroy(){destroyed=true}},expected,5)
 expect(result.availability).toBe('unknown');expect(result.reason).toBe('check_timeout');expect(aborted?.aborted).toBe(true);expect(destroyed).toBe(true)
})

async function fixture(){
 const source=await service.createConnection({kind:'postgres',name:'Synthetic HEAD source',host:'127.0.0.1',database:'source',user:'backup_reader',password:'synthetic-only',tls:false})
 const storage=await service.createConnection({kind:'s3',name:'Synthetic HEAD storage',endpoint:'http://127.0.0.1:54373',bucket:'steelkeep-test',accessKey:'synthetic-key',secretKey:'synthetic-secret'})
 const id=randomUUID(),runId=randomUUID()
 await db.insertInto('runs').values({id:runId,plan_id:null,type:'backup',status:'succeeded',phase:'completed',idempotency_key:randomUUID(),source_id:source.id,storage_id:storage.id,target_id:null,artifact_id:id,started_at:null,finished_at:new Date(),heartbeat_at:null,error_code:null,error_message:null,validation:null,cancel_requested:false,attempt:1,execution_token:null,review_fingerprint:null}).execute()
 await db.insertInto('artifacts').values({id,run_id:runId,source_id:source.id,storage_id:storage.id,object_key:'synthetic-no-network/'+id,size:expected.size,sha256:expected.sha256,engine:'postgres',server_version:'17',tool_version:'fixture-only-no-tools-run',availability:'present',checked_at:null,manifest:null}).execute()
 return {id,sourceId:source.id,storageId:storage.id,runId}
}
async function cleanup(item:Awaited<ReturnType<typeof fixture>>){
 await db.deleteFrom('artifacts').where('id','=',item.id).execute();await db.deleteFrom('runs').where('id','=',item.runId).execute()
 await db.deleteFrom('connections').where('id','in',[item.sourceId,item.storageId]).execute()
}
class StubProbe extends Services {
 constructor(public observation:()=>Promise<AvailabilityObservation>){super(db)}
 protected override probeArtifactObject(){return this.observation()}
}
test('explicit rechecks persist missing/unknown and recover present; metadata mismatch remains a warning',async()=>{
 const item=await fixture(),checker=new StubProbe(missing)
 try{
  expect((await checker.checkArtifactAvailability(item.id,'synthetic-reader')).availability).toBe('missing')
  expect((await db.selectFrom('artifacts').select('availability').where('id','=',item.id).executeTakeFirstOrThrow()).availability).toBe('missing')
  checker.observation=()=>observe(async()=>{throw {$metadata:{httpStatusCode:403}}})
  expect((await checker.checkArtifactAvailability(item.id)).availability).toBe('unknown')
  checker.observation=()=>observe(async()=>({ContentLength:100}))
  const result=await checker.checkArtifactAvailability(item.id)
  expect(result.availability).toBe('present');expect(result.checks.metadataSha256Matches).toBe(false);expect(result.verification).toBe('object-head-only')
  const stored=await db.selectFrom('artifacts').select(['availability','checked_at']).where('id','=',item.id).executeTakeFirstOrThrow()
  expect(stored.availability).toBe('present');expect(stored.checked_at).not.toBeNull()
  expect(await db.selectFrom('audit_events').select('id').where('subject_id','=',item.id).where('actor','=','synthetic-reader').executeTakeFirst()).toBeDefined()
 }finally{await cleanup(item)}
})
test('an older successful HEAD cannot overwrite a newer missing observation or return false success',async()=>{
 const item=await fixture();let entered!:()=>void,release!:()=>void,count=0
 const started=new Promise<void>(resolve=>{entered=resolve}),wait=new Promise<void>(resolve=>{release=resolve})
 const checker=new StubProbe(async()=>{if(++count===1){entered();await wait;return present()}return missing()})
 let older:ReturnType<Services['checkArtifactAvailability']>|undefined
 try{
  older=checker.checkArtifactAvailability(item.id);await started
  const newer=await checker.checkArtifactAvailability(item.id);expect(newer.availability).toBe('missing')
  release();const stale=await older
  expect(stale.stale).toBe(true);expect(stale.availability).toBe('missing');expect(stale.reason).toBe('stale_check');expect(stale.checks.objectExists).toBeNull()
  expect((await db.selectFrom('artifacts').select('availability').where('id','=',item.id).executeTakeFirstOrThrow()).availability).toBe('missing')
 }finally{release();await older?.catch(()=>{});await cleanup(item)}
})
test('read-scoped REST and native MCP share the safe observation service and typed output',async()=>{
 const item=await fixture(),checker=new StubProbe(present),app=createApp(checker),owner={actor:'installation-owner',scopes:allScopes},agent=await service.agents.create(owner,{name:'Synthetic HEAD reader'})
 const issued=await service.agents.issue(owner,agent.id,{name:'Read-only HEAD token'}),client=new Client({name:'steelkeep-head-contract',version:'0.1.0'})
 try{
  const response=await app.handle(new Request('http://localhost/api/v1/backups/'+item.id+'/check',{method:'POST',headers:{authorization:'Bearer '+issued.token}}))
  expect(response.status).toBe(200);const data=await response.json();expect(data.verification).toBe('object-head-only');expect(data.checks.sizeMatches).toBe(true)
  await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),{requestInit:{headers:{authorization:'Bearer '+issued.token}},fetch:async(input,init)=>app.handle(new Request(input,init))}))
  expect((await client.listTools()).tools.find(tool=>tool.name==='check_backup_availability')?.outputSchema).toBeDefined()
  const result=await client.callTool({name:'check_backup_availability',arguments:{id:item.id}})
  expect(result.isError).not.toBe(true);expect((result.structuredContent as {data:{verification:string}}).data.verification).toBe('object-head-only')
  expect(JSON.stringify(result)).not.toContain('synthetic-secret')
 }finally{await client.close();await db.deleteFrom('agent_tokens').where('agent_id','=',agent.id).execute();await db.deleteFrom('agents').where('id','=',agent.id).execute();await cleanup(item)}
})

test('storage credential rotation invalidates an in-flight observation without publishing an old denial',async()=>{
 const item=await fixture();let entered!:()=>void,release!:()=>void
 const started=new Promise<void>(resolve=>{entered=resolve}),wait=new Promise<void>(resolve=>{release=resolve})
 const checker=new StubProbe(async()=>{entered();await wait;return missing()})
 let pending:ReturnType<Services['checkArtifactAvailability']>|undefined
 try{
  pending=checker.checkArtifactAvailability(item.id);await started
  const storage=await service.connection(item.storageId)
  await service.updateConnection(storage.id,{revision:storage.revision,name:storage.name,secretKey:'synthetic-rotated-key'})
  release();const result=await pending
  expect(result.stale).toBe(true);expect(result.reason).toBe('storage_changed');expect(result.availability).toBe('present');expect(result.checks.objectExists).toBeNull()
  expect((await db.selectFrom('artifacts').select('checked_at').where('id','=',item.id).executeTakeFirstOrThrow()).checked_at).toBeNull()
 }finally{release();await pending?.catch(()=>{});await cleanup(item)}
})
