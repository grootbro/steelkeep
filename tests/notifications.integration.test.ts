import {test,expect} from 'bun:test'
import {randomBytes,randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer,type Socket} from 'node:net'
import pg from 'pg'
import {Kysely,PostgresDialect,sql} from 'kysely'
import type {Schema} from '../server/db'
import {Services} from '../server/services'
import {createApp} from '../server/app'
import {allScopes,type Principal} from '../server/auth'
import {processNotification,recoverNotificationClaims} from '../server/notifications-worker'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'

const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-local-notifications'?test:test.skip
acceptance('schema9 durable notifications: terminal events, real loopback HTTP/SMTP, bounded retry, uncertainty and scoped MCP',async()=>{
 if(await realpath(process.cwd())!=='/Users/dobrota/dev/steelkeep')throw new Error('Require fixed Steelkeep checkout.')
 const database='steelkeep_notifications_test',target=new URL(process.env.DATABASE_URL??'')
 if(target.hostname!=='127.0.0.1'||target.port!=='54371'||target.pathname!==`/${database}`||target.username!=='steelkeep'||target.search||target.hash)throw new Error('Require only the new dedicated loopback steelkeep_notifications_test database.')
 const adminUrl=new URL(target);adminUrl.pathname='/postgres'
 const admin=new pg.Client({connectionString:adminUrl.toString(),connectionTimeoutMillis:5000,statement_timeout:10000}),pool=new pg.Pool({connectionString:target.toString(),max:4,connectionTimeoutMillis:5000,statement_timeout:30000}),db=new Kysely<Schema>({dialect:new PostgresDialect({pool})}),service=new Services(db)
 const saved=Object.fromEntries(['STEELKEEP_KEY_FILE','STEELKEEP_TOKEN_FILE','STEELKEEP_ALLOWED_HOSTS','STEELKEEP_ALLOWED_ORIGINS','STEELKEEP_SCOPED_TOKENS_FILE'].map(key=>[key,process.env[key]]))
 const directory=await mkdtemp(join(tmpdir(),'steelkeep-notifications-')),nonce=randomBytes(10).toString('hex'),token=randomBytes(32).toString('hex'),epoch=randomUUID(),nextEpoch=randomUUID(),owner:Principal={actor:'installation-owner',scopes:allScopes}
 const channelIds=new Set<string>(),connectionIds=new Set<string>(),runIds=new Set<string>(),agentIds=new Set<string>(),sockets=new Set<Socket>(),httpMessages:Array<{path:string;body:Record<string,unknown>;key:string|null}>=[],smtpMessages:string[]=[]
 let sink:ReturnType<typeof Bun.serve>|undefined,smtp:ReturnType<typeof createServer>|undefined,created=false,oid:number|undefined,emptyVerified=false,mode='accepted',redirects=0
 const row=async(id:string)=>db.selectFrom('notification_deliveries').selectAll().where('id','=',id).executeTakeFirstOrThrow()
 async function tick(id:string){expect(await processNotification(db,epoch,new AbortController().signal)).toBe(true);return row(id)}
 async function channel(name:string,kind:'webhook'|'email',config:Record<string,string|number|string[]>,secrets:Record<string,string>,enabled=false,events={success:true,failure:true}){const c=await service.notifications.create(owner,{name:nonce+' '+name,kind,config,secrets,enabled,events});channelIds.add(c.id);return c}
 async function run(status='queued'){
  const id=randomUUID();runIds.add(id);await db.insertInto('runs').values({id,plan_id:null,type:'backup',status,phase:status,idempotency_key:randomUUID(),source_id:[...connectionIds][0],storage_id:[...connectionIds][1],target_id:null,artifact_id:null,started_at:null,finished_at:null,heartbeat_at:null,error_code:null,error_message:null,validation:null,cancel_requested:false,attempt:0,execution_token:null,review_fingerprint:null}).execute();return id
 }
 try{
  await writeFile(join(directory,'key'),randomBytes(32),{mode:0o600});await writeFile(join(directory,'token'),token,{mode:0o600})
  process.env.STEELKEEP_KEY_FILE=join(directory,'key');process.env.STEELKEEP_TOKEN_FILE=join(directory,'token');process.env.STEELKEEP_ALLOWED_HOSTS='127.0.0.1';process.env.STEELKEEP_ALLOWED_ORIGINS='http://localhost';delete process.env.STEELKEEP_SCOPED_TOKENS_FILE
  await admin.connect();if((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount)throw new Error('Dedicated notification database already exists; retain it for explicit inspection.')
  await admin.query('CREATE DATABASE steelkeep_notifications_test');created=true;oid=(await admin.query<{oid:number}>('SELECT oid FROM pg_database WHERE datname=$1',[database])).rows[0].oid
  const migration=Bun.spawn([process.execPath,'server/migrate.ts'],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:target.toString(),STEELKEEP_DATABASE_PASSWORD_FILE:''},stdout:'ignore',stderr:'ignore',timeout:15000});if(await migration.exited!==0)throw new Error('Dedicated schema9 migration failed; raw diagnostics withheld.')
  expect((await sql<{database:string;role:string}>`SELECT current_database() AS database,current_user AS role`.execute(db)).rows[0]).toEqual({database,role:'steelkeep'})
  expect((await sql<{version:number}>`SELECT version FROM steelkeep_migrations WHERE version=9`.execute(db)).rows[0].version).toBe(9)
  await db.insertInto('worker_state').values({singleton:true,epoch}).execute()
  sink=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const path=new URL(request.url).pathname;if(path==='/redirect-target')redirects++;const body=await request.json() as Record<string,unknown>;httpMessages.push({path,body,key:request.headers.get('Idempotency-Key')});if(mode==='temporary')return new Response('secret-provider-body-'+nonce,{status:503});if(mode==='redirect')return new Response(null,{status:302,headers:{location:'/redirect-target'}});if(mode==='ambiguous')return new Response('x'.repeat(65537));return Response.json({accepted:true})}})
  const endpoint='http://127.0.0.1:'+sink.port,webhook=await channel('webhook','webhook',{}, {url:endpoint+'/private?token='+nonce,bearerToken:nonce})
  expect(webhook.destination).toBe(endpoint);expect(webhook.secretFields.sort()).toEqual(['bearerToken','url']);expect(JSON.stringify(webhook)).not.toContain('/private');expect(JSON.stringify(webhook)).not.toContain('?token=')
  const sealed=await db.selectFrom('notification_channels').select('secret').where('id','=',webhook.id).executeTakeFirstOrThrow();expect(sealed.secret).not.toContain(endpoint);expect(sealed.secret).not.toContain(nonce)
  const testKey=randomUUID(),delivery=await service.notifications.test(owner,webhook.id,1,testKey)
  expect(delivery.status).toBe('queued');expect(delivery.attempt).toBe(0);expect(httpMessages.length).toBe(0)
  expect((await tick(delivery.id)).status).toBe('succeeded');expect(httpMessages.length).toBe(1);expect(httpMessages[0].key).toBe(delivery.id);expect(httpMessages[0].body.deliveryId).toBe(delivery.id)
  expect((await service.notifications.delivery(delivery.id)).attempts[0].status).toBe('succeeded')
  const edited=await service.notifications.update(owner,webhook.id,{revision:1,name:webhook.name,enabled:false,events:webhook.events,config:{},secrets:{url:'',bearerToken:''}});expect(edited.revision).toBe(2)
  expect((await service.notifications.test(owner,webhook.id,1,testKey)).id).toBe(delivery.id)
  await expect(service.notifications.test(owner,webhook.id,2,testKey)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'})
  await expect(service.notifications.update(owner,webhook.id,{revision:1,name:webhook.name,enabled:false,events:webhook.events,config:{}})).rejects.toMatchObject({code:'REVISION_CONFLICT'})
  mode='temporary';const failure=await service.notifications.test(owner,webhook.id,2,randomUUID())
  for(let i=1;i<=3;i++){await db.updateTable('notification_deliveries').set({next_attempt_at:sql`clock_timestamp()`}).where('id','=',failure.id).execute();const current=await tick(failure.id);expect(current.attempt).toBe(i);expect(current.status).toBe(i<3?'retry_wait':'failed');expect(current.error_message).not.toContain(nonce);if(i<3)expect(new Date(current.next_attempt_at!).getTime()).toBeGreaterThan(Date.now())}
  expect((await service.notifications.delivery(failure.id)).attempts.map(a=>a.status)).toEqual(['failed','retry_wait','retry_wait'])
  expect(await processNotification(db,epoch,new AbortController().signal)).toBe(false)
  mode='accepted';const retryKey=randomUUID(),retry=await service.notifications.retry(owner,failure.id,retryKey);expect(retry.maxAttempts).toBe(6);expect((await tick(failure.id)).status).toBe('succeeded');expect((await service.notifications.retry(owner,failure.id,retryKey)).status).toBe('retry_wait')
  mode='redirect';const redirect=await service.notifications.test(owner,webhook.id,2,randomUUID());expect((await tick(redirect.id)).error_code).toBe('NOTIFICATION_REDIRECT_REFUSED');expect(redirects).toBe(0)
  mode='ambiguous';const ambiguous=await service.notifications.test(owner,webhook.id,2,randomUUID());expect((await tick(ambiguous.id)).status).toBe('uncertain');expect(await processNotification(db,epoch,new AbortController().signal)).toBe(false)
  await expect(service.notifications.retry(owner,ambiguous.id,randomUUID())).rejects.toMatchObject({code:'NOTIFICATION_DUPLICATE_CONFIRMATION_REQUIRED'})
  const acknowledgedKey=randomUUID();await service.notifications.retry(owner,ambiguous.id,acknowledgedKey,true);mode='accepted';expect((await tick(ambiguous.id)).status).toBe('succeeded');expect((await service.notifications.retry(owner,ambiguous.id,acknowledgedKey,true)).id).toBe(ambiguous.id)
  await expect(service.notifications.retry(owner,ambiguous.id,acknowledgedKey,false)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'})
  const pending=await service.notifications.test(owner,webhook.id,2,randomUUID());const current=await service.notifications.update(owner,webhook.id,{revision:2,name:webhook.name,enabled:true,events:{success:true,failure:false},config:{}});expect((await row(pending.id)).status).toBe('cancelled')
  for(const kind of ['postgres','s3'] as const){const id=randomUUID();connectionIds.add(id);await db.insertInto('connections').values({id,name:nonce+' synthetic '+kind,kind,config:{},secret:'synthetic-no-valid-ciphertext',check_status:'untested',checked_at:null}).execute()}
  const historic=await run('succeeded'),success=await run(),failed=await run();const before=await db.selectFrom('notification_deliveries').selectAll().execute()
  await db.updateTable('runs').set({status:'running'}).where('id','=',success).execute();expect((await db.selectFrom('notification_deliveries').selectAll().execute()).length).toBe(before.length)
  await db.updateTable('runs').set({status:'succeeded',phase:'completed'}).where('id','=',success).execute();await db.updateTable('runs').set({status:'failed',error_code:'SYNTHETIC',error_message:'never-send-'+nonce}).where('id','=',failed).execute()
  let terminal=await db.selectFrom('notification_deliveries').selectAll().where('run_id','is not',null).execute();expect(terminal.length).toBe(1);expect(terminal[0].run_id).toBe(success);expect(terminal[0].event).toBe('success');expect((await tick(terminal[0].id)).status).toBe('succeeded')
  const updated=await service.notifications.update(owner,webhook.id,{revision:current.revision,name:webhook.name,enabled:true,events:{success:true,failure:true},config:{}})
  expect((await db.selectFrom('notification_deliveries').selectAll().where('run_id','=',historic).execute()).length).toBe(0);expect((await db.selectFrom('notification_deliveries').selectAll().where('run_id','=',failed).execute()).length).toBe(0)
  const interrupted=await run(),cancelled=await run();await db.updateTable('runs').set({status:'interrupted',error_code:'SYNTHETIC',error_message:'never-send-'+nonce}).where('id','=',interrupted).execute();await db.updateTable('runs').set({status:'cancelled'}).where('id','=',cancelled).execute()
  terminal=await db.selectFrom('notification_deliveries').selectAll().where('run_id','in',[interrupted,cancelled]).execute();expect(terminal.map(d=>d.event)).toEqual(['failure','failure']);expect(JSON.stringify(terminal.map(d=>d.payload))).not.toContain('never-send-')
  for(const d of terminal)expect((await tick(d.id)).status).toBe('succeeded')
  await db.updateTable('runs').set({status:'succeeded'}).where('id','=',success).execute();expect((await db.selectFrom('notification_deliveries').selectAll().where('run_id','=',success).execute()).length).toBe(1)
  // A real minimal SMTP server accepts only this synthetic loopback transaction.
  smtp=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.write('220 steelkeep-synthetic ESMTP\r\n');let buffer='',data=false,body='';socket.on('data',chunk=>{buffer+=chunk.toString();for(;;){const end=buffer.indexOf('\r\n');if(end<0)return;const line=buffer.slice(0,end);buffer=buffer.slice(end+2);if(data){if(line==='.'){smtpMessages.push(body);body='';data=false;socket.write('250 synthetic queued\r\n')}else body+=line+'\r\n';continue}if(/^EHLO|^HELO/.test(line))socket.write('250 steelkeep-synthetic\r\n');else if(/^MAIL FROM:|^RCPT TO:|^RSET/.test(line))socket.write('250 OK\r\n');else if(line==='DATA'){data=true;socket.write('354 End with dot\r\n')}else if(line==='QUIT'){socket.end('221 Bye\r\n')}else socket.write('502 Unsupported synthetic command\r\n')}})})
  await new Promise<void>(resolve=>smtp!.listen(0,'127.0.0.1',resolve));const address=smtp.address();if(!address||typeof address==='string')throw new Error('Expected loopback TCP SMTP sink.')
  const email=await channel('email','email',{host:'127.0.0.1',port:address.port,tls:'none',from:'backup@example.test',to:['owner@example.test']},{})
  const mail=await service.notifications.test(owner,email.id,1,randomUUID());const sent=await tick(mail.id);expect(sent.status).toBe('succeeded');expect(smtpMessages.length).toBe(1);expect(smtpMessages[0].toLowerCase()).toContain('x-steelkeep-delivery-id: '+mail.id);expect(smtpMessages[0]).toContain('steelkeep notification test')
  const app=createApp(service),agent=await service.agents.create(owner,{name:nonce+' agent',description:'Synthetic notification fixture'});agentIds.add(agent.id)
  const credential=await service.agents.issue(owner,agent.id,{name:'configure',scopes:['read','configure'],expiresInHours:1}),reader=await service.agents.issue(owner,agent.id,{name:'read',scopes:['read'],expiresInHours:1})
  const request=(path:string,method='GET',body?:unknown,auth=credential.token)=>app.handle(new Request('http://localhost/api/v1'+path,{method,headers:{authorization:'Bearer '+auth,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)}))
  expect((await request('/notification-channels')).status).toBe(200);expect((await request('/notification-channels/'+email.id+'/test','POST',{revision:1,idempotencyKey:randomUUID()},reader.token)).status).toBe(403)
  const apiKey=randomUUID(),apiTest=await request('/notification-channels/'+email.id+'/test','POST',{revision:1,idempotencyKey:apiKey});expect(apiTest.status).toBe(202);const apiDelivery=await apiTest.json() as {id:string};expect((await tick(apiDelivery.id)).status).toBe('succeeded');expect((await request('/notification-deliveries/'+apiDelivery.id)).status).toBe(200)
  const transport=new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),{requestInit:{headers:{authorization:'Bearer '+credential.token}},fetch:async(input,init)=>app.handle(input instanceof Request?input:new Request(input,init))}),mcp=new Client({name:'notification-proof',version:'1'})
  await mcp.connect(transport)
  try{const tools=await mcp.listTools();expect(tools.tools.some(t=>t.name==='test_notification_channel')).toBe(true);const listed=await mcp.callTool({name:'list_notification_channels',arguments:{}});expect(listed.isError).not.toBe(true);expect(JSON.stringify(listed.structuredContent)).not.toContain('/private?');const accepted=await mcp.callTool({name:'test_notification_channel',arguments:{id:email.id,revision:1,idempotencyKey:randomUUID()}});expect(accepted.isError).not.toBe(true);const id=(accepted.structuredContent as {data:{id:string}}).data.id;expect((await tick(id)).status).toBe('succeeded');const detail=await mcp.callTool({name:'get_notification_delivery',arguments:{id}});expect(detail.isError).not.toBe(true);expect((detail.structuredContent as {data:{attempts:unknown[]}}).data.attempts.length).toBe(1)}finally{await mcp.close()}
  const lost=await service.notifications.test(owner,email.id,1,randomUUID());await db.updateTable('notification_deliveries').set({status:'sending',attempt:1,execution_token:randomUUID(),worker_epoch:epoch,next_attempt_at:null}).where('id','=',lost.id).execute();await db.insertInto('notification_attempts').values({delivery_id:lost.id,attempt:1,status:'sending',finished_at:null,error_code:null,error_message:null}).execute()
  await db.transaction().execute(async trx=>{await trx.updateTable('worker_state').set({epoch:nextEpoch}).where('singleton','=',true).execute();await recoverNotificationClaims(trx,nextEpoch)})
  expect((await row(lost.id)).status).toBe('uncertain');expect((await service.notifications.delivery(lost.id)).attempts[0].status).toBe('uncertain')
  const fenced=await service.notifications.test(owner,email.id,1,randomUUID());await expect(processNotification(db,epoch,new AbortController().signal)).rejects.toMatchObject({code:'NOTIFICATION_WORKER_FENCED'});expect((await row(fenced.id)).attempt).toBe(0)
  await service.notifications.remove(owner,email.id,1);expect((await service.notifications.test(owner,email.id,1,(await db.selectFrom('notification_requests').select('key').where('resource_id','=',email.id).where('kind','=','test').executeTakeFirstOrThrow()).key)).channelId).toBe(email.id)
  await service.notifications.remove(owner,webhook.id,updated.revision);expect((await service.notifications.list()).length).toBe(0)
  console.info(JSON.stringify({proof:'notifications',schema:9,actualLoopbackHttp:httpMessages.length,actualLoopbackSmtp:smtpMessages.length,terminalOnly:true,noHistoricalReplay:true,boundedAttemptBudget:3,uncertainty:'manual-duplicate-ack-only',attemptHistory:true,epochFence:true,delegatedConfigure:true,mcp:true,externalMessages:0}))
 }finally{
  sink?.stop(true);for(const socket of sockets)socket.destroy();if(smtp?.listening)await new Promise<void>((resolve,reject)=>smtp!.close(error=>error?reject(error):resolve()))
  try{
   if(created){
    for(const [table,ids]of [['notification_channels',channelIds],['connections',connectionIds],['runs',runIds],['agents',agentIds]] as const){const rows=await db.selectFrom(table).select('id').execute();if(rows.some(row=>!ids.has(row.id)))throw new Error('Foreign data detected in dedicated notification DB; preserve fixture.')}
    for(const table of ['notification_requests','notification_attempts','notification_deliveries','notification_channels','agent_tokens','agents','audit_events','runs','connections','worker_state'] as const)await db.deleteFrom(table).execute()
    const tables=await sql<{tablename:string}>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'steelkeep_migrations'`.execute(db)
    for(const {tablename}of tables.rows){if(!/^[a-z_]+$/.test(tablename))throw new Error('Unexpected dedicated schema table.');const result=await sql<{n:number}>`SELECT count(*)::int AS n FROM ${sql.table(tablename)}`.execute(db);if(result.rows[0].n!==0)throw new Error('Dedicated notification DB contains retained application data; no drop.')}
    emptyVerified=true
   }
  }finally{await db.destroy()}
  try{if(created){const identity=(await admin.query<{oid:number;clients:number}>('SELECT d.oid,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=d.datname) AS clients FROM pg_database d WHERE d.datname=$1',[database])).rows[0];if(!emptyVerified||!identity||identity.oid!==oid||identity.clients!==0)throw new Error('Dedicated notification DB identity/empty/client guard failed; preserve.');await admin.query('DROP DATABASE steelkeep_notifications_test');expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount).toBe(0)}}finally{await admin.end();for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value}await rm(directory,{recursive:true,force:true})}
 }
},90000)
