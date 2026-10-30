import {test,expect,afterAll} from 'bun:test'
import {randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createApp} from '../server/app'
import {Services} from '../server/services'
import {connectDb} from '../server/db'
import {config} from '../server/config'
import {allScopes,tokenHash} from '../server/auth'
import {createSourceLockHooks} from '../server/source-locks'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'

// This suite inserts and removes metadata. Never follow an operator's production URL.
if(process.env.STEELKEEP_ACCEPTANCE!=='synthetic-local')throw new Error('Integration tests require explicit STEELKEEP_ACCEPTANCE=synthetic-local fixture mode.')
const metadataUrl=new URL(config.databaseUrl())
if(!['127.0.0.1','localhost'].includes(metadataUrl.hostname)||metadataUrl.port!=='54371'||metadataUrl.pathname!=='/steelkeep'||metadataUrl.username!=='steelkeep')throw new Error('Integration tests require the isolated loopback Steelkeep metadata fixture on port 54371.')
const {db}=connectDb(),app=createApp(new Services(db))
const token=config.token()
const request=(path:string,body?:unknown,auth=true)=>app.handle(new Request('http://localhost/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{...(auth?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)}))
afterAll(async()=>{await db.destroy()})

test('API requires authentication and rejects browser origins outside installation',async()=>{
  expect((await request('/connections',undefined,false)).status).toBe(401)
  const denied=await app.handle(new Request('http://localhost/api/v1/connections',{headers:{authorization:'Bearer '+token,origin:'https://outside.invalid'}}))
  expect(denied.status).toBe(403)
})
test('secret-free connection DTO and real PostgreSQL connection check',async()=>{
  const secret='local-reader-only'
  const created=await request('/connections',{name:'Integration source '+randomUUID(),kind:'postgres',host:'127.0.0.1',port:54372,database:'source',user:'backup_reader',password:secret,tls:false})
  expect(created.status).toBe(200)
  const {id}=await created.json()
  try{
    const checked=await request(`/connections/${id}/test`,{})
    expect((await checked.json()).status).toBe('available')
    const safe=await request('/connections'),body=await safe.text()
    expect(body).not.toContain(secret)
    expect(body).not.toContain('"secret"')
    const row=await db.selectFrom('connections').select('secret').where('id','=',id).executeTakeFirstOrThrow()
    expect(row.secret).not.toContain(secret)
  }finally{await db.deleteFrom('connections').where('id','=',id).execute()}
})
test('untrusted endpoints and option-like database names are rejected by API',async()=>{
  const base={name:'Rejected',kind:'postgres',host:'127.0.0.1',port:54372,database:'--clean',user:'backup_reader',password:'synthetic',tls:false}
  expect((await request('/connections',base)).status).toBe(400)
  expect((await request('/connections',{...base,database:'source',host:'169.254.169.254'})).status).toBe(403)
})
test('OpenAPI is built in and lists operation contracts',async()=>{
  const response=await app.handle(new Request('http://localhost/openapi/json',{headers:{authorization:'Bearer '+token}}))
  expect(response.status).toBe(200)
  const spec=await response.json()
  expect(spec.info.title).toBe('Steelkeep API')
  expect(spec.paths['/api/v1/plans/{id}/run'].post.operationId).toBe('runBackup')
})
test('job plus dispatch outbox survive API call and retry returns same job',async()=>{
  const service=new Services(db),suffix=randomUUID()
  const source=await service.createConnection({name:'Queue source',kind:'postgres',host:'127.0.0.1',port:54372,database:'source',user:'backup_reader',password:'local-reader-only',tls:false})
  const storage=await service.createConnection({name:'Queue storage',kind:'s3',endpoint:'http://127.0.0.1:54373',bucket:'steelkeep-test',accessKey:'synthetic',secretKey:'synthetic'})
  const plan=await service.createPlan({name:'Queue test',sourceId:source.id,storageId:storage.id,timezone:'Asia/Bangkok'})
  try{
    const [a,b]=await Promise.all([request(`/plans/${plan.id}/run`,{idempotencyKey:suffix}),request(`/plans/${plan.id}/run`,{idempotencyKey:suffix})])
    expect(a.status).toBe(202);expect(b.status).toBe(202)
    const first=await a.json(),second=await b.json();expect(first.id).toBe(second.id)
    expect(first.status).toBe('queued')
    const dispatch=await db.selectFrom('outbox').selectAll().where('run_id','=',first.id).executeTakeFirst()
    expect(dispatch?.dispatched_at).toBeNull()
    expect((await service.cancel(first.id)).status).toBe('cancelled')
  }finally{
    const ids=(await db.selectFrom('runs').select('id').where('plan_id','=',plan.id).execute()).map(r=>r.id)
    if(ids.length){await db.deleteFrom('events').where('run_id','in',ids).execute();await db.deleteFrom('outbox').where('run_id','in',ids).execute();await db.deleteFrom('runs').where('id','in',ids).execute()}
    await db.deleteFrom('plans').where('id','=',plan.id).execute()
    await db.deleteFrom('connections').where('id','in',[source.id,storage.id]).execute()
  }
})

test('safe API jobs omit worker ownership tokens and restore fingerprints',async()=>{
 const response=await request('/jobs'),text=await response.text()
 expect(response.status).toBe(200)
 expect(text).not.toContain('execution_token')
 expect(text).not.toContain('review_fingerprint')
})
test('restore commands have explicit OpenAPI request, response and operation contracts',async()=>{
 const response=await app.handle(new Request('http://localhost/openapi/json',{headers:{authorization:'Bearer '+token}})),spec=await response.json()
 expect(spec.paths['/api/v1/restores/prepare'].post.operationId).toBe('prepareRestore')
 expect(spec.paths['/api/v1/restores/start'].post.responses['202']).toBeDefined()
 expect(spec.paths['/api/v1/jobs/{id}'].get.responses['200']).toBeDefined()
 expect((await request('/restores/start',{intentId:'--clean',idempotencyKey:randomUUID()})).status).toBe(422)
})

test('configure scope cannot run or cancel jobs through canonical or slash aliases',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'steelkeep-scopes-')),path=join(dir,'tokens.json'),scopedToken=randomUUID(),old=process.env.STEELKEEP_SCOPED_TOKENS_FILE
 await writeFile(path,JSON.stringify([{token:scopedToken,actor:'configure-only',scopes:['configure']}]),{mode:0o600})
 process.env.STEELKEEP_SCOPED_TOKENS_FILE=path
 try{
  for(const route of [`/plans/${randomUUID()}/run`,`/jobs/${randomUUID()}/cancel`]){
   for(const suffix of ['', '/']){
    const response=await app.handle(new Request('http://localhost/api/v1'+route+suffix,{method:'POST',headers:{authorization:'Bearer '+scopedToken,'content-type':'application/json'},body:JSON.stringify({idempotencyKey:randomUUID()})}))
    if(suffix)expect([403,404]).toContain(response.status)
    else expect(response.status).toBe(403)
   }
  }
 }finally{
  if(old===undefined)delete process.env.STEELKEEP_SCOPED_TOKENS_FILE;else process.env.STEELKEEP_SCOPED_TOKENS_FILE=old
  await rm(dir,{recursive:true,force:true})
 }
})

test('database-backed agent tokens are read-only by default, hashed, bounded and revocable',async()=>{
 const service=new Services(db),owner={actor:'installation-owner',scopes:allScopes},agent=await service.agents.create(owner,{name:'Synthetic access test '+randomUUID()})
 try{
  const issued=await service.agents.issue(owner,agent.id,{name:'Read-only test'})
  const row=await db.selectFrom('agent_tokens').select(['token_hash','scopes']).where('id','=',issued.id).executeTakeFirstOrThrow()
  expect(row.token_hash).toBe(tokenHash(issued.token));expect(row.token_hash).not.toBe(issued.token);expect(issued.scopes).toEqual(['read'])
  const headers={authorization:'Bearer '+issued.token}
  const me=await app.handle(new Request('http://localhost/api/v1/me',{headers}));expect(me.status).toBe(200);expect((await me.json()).actor).toBe('agent:'+agent.id)
  const denied=await app.handle(new Request('http://localhost/api/v1/plans/'+randomUUID()+'/run',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({idempotencyKey:randomUUID()})}));expect(denied.status).toBe(403)
  const listed=await service.agents.tokens(owner,agent.id);expect(JSON.stringify(listed)).not.toContain(issued.token);expect(JSON.stringify(listed)).not.toContain('token_hash')
  await expect(service.agents.issue(owner,agent.id,{name:'Invalid lifetime',expiresInHours:721})).rejects.toThrow()
  const expired=await service.agents.issue(owner,agent.id,{name:'Expiry test'})
  await db.updateTable('agent_tokens').set({expires_at:new Date('2000-01-01T00:00:00Z')}).where('id','=',expired.id).execute()
  expect((await app.handle(new Request('http://localhost/api/v1/me',{headers:{authorization:'Bearer '+expired.token}}))).status).toBe(401)
  await service.agents.revokeToken(owner,issued.id)
  expect((await app.handle(new Request('http://localhost/api/v1/me',{headers}))).status).toBe(401)
 }finally{await db.deleteFrom('agent_tokens').where('agent_id','=',agent.id).execute();await db.deleteFrom('agents').where('id','=',agent.id).execute()}
})
test('token delegation cannot escalate scopes and revocation cascades to delegated credentials',async()=>{
 const service=new Services(db),owner={actor:'installation-owner',scopes:allScopes},agent=await service.agents.create(owner,{name:'Synthetic delegation '+randomUUID()})
 try{
  const parent=await service.agents.issue(owner,agent.id,{name:'Delegate',scopes:['read','agents:manage'],expiresInHours:1})
  const principal=await service.authenticate(new Request('http://localhost',{headers:{authorization:'Bearer '+parent.token}}))
  await expect(service.agents.issue(principal,agent.id,{name:'Forbidden escalation',scopes:['restore:run']})).rejects.toThrow()
  const child=await service.agents.issue(principal,agent.id,{name:'Child reader'})
  expect(new Date(child.expiresAt).getTime()).toBeLessThanOrEqual(new Date(parent.expiresAt).getTime())
  const manager=await service.agents.issue(principal,agent.id,{name:'Child manager',scopes:['read','agents:manage']})
  const managerPrincipal=await service.authenticate(new Request('http://localhost',{headers:{authorization:'Bearer '+manager.token}}))
  const [grant,revocation]=await Promise.allSettled([service.agents.issue(managerPrincipal,agent.id,{name:'Racing grandchild'}),service.agents.revokeToken(owner,parent.id)])
  expect(revocation.status).toBe('fulfilled')
  if(grant.status==='fulfilled')await expect(service.authenticate(new Request('http://localhost',{headers:{authorization:'Bearer '+grant.value.token}}))).rejects.toThrow()
  else expect((grant.reason as {code?:string}).code).toBe('UNAUTHORIZED')
  await expect(service.authenticate(new Request('http://localhost',{headers:{authorization:'Bearer '+child.token}}))).rejects.toThrow()
  const history=await service.agents.history(owner),text=JSON.stringify(history)
  expect(text).not.toContain(parent.token);expect(text).not.toContain(child.token)
 }finally{await db.deleteFrom('agent_tokens').where('agent_id','=',agent.id).execute();await db.deleteFrom('agents').where('id','=',agent.id).execute()}
})

test('source lock journals fence stale workers, serialize aliases and retain uncertain outcomes',async()=>{
 const service=new Services(db),source=await service.createConnection({name:'Synthetic lock source',kind:'postgres',host:'127.0.0.1',port:54372,database:'source',user:'backup_reader',password:'local-reader-only',tls:false}),storage=await service.createConnection({name:'Synthetic lock storage',kind:'s3',endpoint:'http://127.0.0.1:54373',bucket:'steelkeep-test',accessKey:'synthetic',secretKey:'synthetic'})
 const plan=await service.createPlan({name:'Synthetic source lock test',sourceId:source.id,storageId:storage.id,timezone:'UTC'}),run=await service.runBackup(plan.id,randomUUID()),token=randomUUID(),secondId=randomUUID(),secondToken=randomUUID(),suffix=randomUUID()
 const context={resourceKey:'mongodb:synthetic_'+suffix,serverIdentity:'synthetic-server:'+suffix,ownerToken:randomUUID()}
 try{
  await db.updateTable('runs').set({status:'running',execution_token:token}).where('id','=',run.id).execute()
  await db.insertInto('runs').values({...run,id:secondId,idempotency_key:randomUUID(),status:'running',execution_token:secondToken}).execute()
  const hooks=createSourceLockHooks(service,run.id,token),other=createSourceLockHooks(service,secondId,secondToken)
  await hooks.beforeAcquire(context)
  expect((await db.selectFrom('source_blocks').select('state').where('resource_key','=',context.resourceKey).executeTakeFirstOrThrow()).state).toBe('acquiring')
  await expect(other.beforeAcquire({...context,ownerToken:randomUUID()})).rejects.toThrow()
  await expect(other.beforeAcquire({...context,resourceKey:'mongodb:alias_'+suffix,ownerToken:randomUUID()})).rejects.toThrow()
  await hooks.onUncertain(context,'SYNTHETIC_RELEASE_UNKNOWN')
  await expect(hooks.afterRelease(context)).rejects.toThrow()
  const retained=await db.selectFrom('source_blocks').selectAll().where('resource_key','=',context.resourceKey).executeTakeFirstOrThrow();expect(retained.state).toBe('uncertain')
  expect(JSON.stringify(await service.sourceBlocks())).not.toContain('owner_token')
  expect(JSON.stringify(await service.sourceBlocks())).not.toContain('execution_token')
  await db.updateTable('runs').set({execution_token:randomUUID()}).where('id','=',run.id).execute()
  await expect(hooks.beforeAcquire({...context,resourceKey:'mongodb:fenced_'+suffix,serverIdentity:'synthetic-fenced:'+suffix})).rejects.toThrow()
  expect(await db.selectFrom('source_blocks').select('resource_key').where('resource_key','=','mongodb:fenced_'+suffix).executeTakeFirst()).toBeUndefined()
 }finally{
  await db.deleteFrom('source_blocks').where('run_id','in',[run.id,secondId]).execute()
  await db.deleteFrom('events').where('run_id','in',[run.id,secondId]).execute();await db.deleteFrom('outbox').where('run_id','in',[run.id,secondId]).execute();await db.deleteFrom('runs').where('id','in',[run.id,secondId]).execute()
  await db.deleteFrom('plans').where('id','=',plan.id).execute();await db.deleteFrom('connections').where('id','in',[source.id,storage.id]).execute()
 }
})

test('native MCP advertises typed outputs and preserves legacy text beside structured arrays',async()=>{
 const client=new Client({name:'steelkeep-contract-test',version:'0.1.0'})
 const transport=new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}},fetch:async(input,init)=>app.handle(new Request(input,init))})
 try{
  await client.connect(transport)
  const listed=await client.listTools()
  expect(listed.tools.length).toBeGreaterThan(10)
  for(const tool of listed.tools)expect(tool.outputSchema).toBeDefined()
  const response=await client.callTool({name:'list_connections',arguments:{}})
  expect(response.isError).not.toBe(true)
  const text=response.content.find(item=>item.type==='text')
  expect(text?.type).toBe('text')
  if(text?.type==='text')expect((response.structuredContent as {data:unknown}).data).toEqual(JSON.parse(text.text))
 }finally{await client.close()}
})
