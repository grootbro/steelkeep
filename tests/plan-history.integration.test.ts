import {test,expect} from 'bun:test'
import {randomUUID,randomBytes} from 'node:crypto'
import {mkdtemp,chmod,writeFile,readFile,lstat,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import pg from 'pg'
import {Kysely,PostgresDialect,sql} from 'kysely'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'
import type {Schema} from '../server/db'
import {Services} from '../server/services'
import {PlanHistoryServices} from '../server/plan-history'
import {allScopes,type Principal} from '../server/auth'
import {createApp} from '../server/app'

const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-server-plans'?test:test.skip
acceptance('complete plan pages preserve cursor ties/nulls, filters, global counts and strict REST/MCP parity',async()=>{
 if(process.platform!=='linux'||process.env.STEELKEEP_SERVER_PROOF_ROOT!=='/work'||await realpath(process.cwd())!=='/work')throw new Error('Plans proof requires the authorized isolated Linux server stand at /work.')
 async function privateFile(path:string){const file=await lstat(path);if(!file.isFile()||(file.mode&0o777)!==0o600||file.uid!==process.getuid?.())throw new Error('Invalid private proof capability file.');return readFile(path,'utf8')}
 const nonce=(await privateFile('/run/steelkeep/proof-nonce')).trim(),password=(await privateFile('/run/steelkeep/metadata-password')).trim()
 if(!/^[a-f0-9]{64}$/.test(nonce)||!password)throw new Error('Invalid proof capability.')
 const database='steelkeep_plan_history_test',controlUrl=new URL('postgresql://steelkeep@metadata:5432/steelkeep_platform_proof');controlUrl.password=password;const target=new URL(controlUrl);target.pathname='/'+database
 const options={connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000},admin=new pg.Client({connectionString:controlUrl.toString(),...options}),db=new Kysely<Schema>({dialect:new PostgresDialect({pool:new pg.Pool({connectionString:target.toString(),max:4,...options})})}),service=new Services(db),history=new PlanHistoryServices(db)
 const owner:Principal={actor:'installation-owner',scopes:allScopes},connections=new Set<string>(),plans=new Set<string>(),agents=new Set<string>(),saved=Object.fromEntries(['STEELKEEP_KEY_FILE','STEELKEEP_TOKEN_FILE','STEELKEEP_ALLOWED_HOSTS','STEELKEEP_ALLOWED_ORIGINS','STEELKEEP_SCOPED_TOKENS_FILE'].map(key=>[key,process.env[key]]))
 const fixtures:Array<{id:string;name:string;createdAt:string;nextDue:string|null;source:string;storage:string;enabled:boolean;scheduled:boolean;mode:'keep_all'|'days'|'gfs'}>=[]
 let created=false,oid:number|undefined,directory:string|undefined,emptyVerified=false
 try{
  await admin.connect();const identity=(await admin.query<{database:string;role:string}>('SELECT current_database() AS database,current_user AS role')).rows[0],marker=await admin.query<{singleton:boolean;nonce:string}>('SELECT singleton,nonce FROM steelkeep_platform_proof_identity')
  if(identity.database!=='steelkeep_platform_proof'||identity.role!=='steelkeep'||marker.rowCount!==1||marker.rows[0].singleton!==true||marker.rows[0].nonce!==nonce)throw new Error('Proof control identity mismatch.')
  if((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount)throw new Error('Dedicated plans database exists; preserve for inspection.')
  await admin.query('CREATE DATABASE steelkeep_plan_history_test');created=true;oid=(await admin.query<{oid:number}>('SELECT oid FROM pg_database WHERE datname=$1',[database])).rows[0].oid
  directory=await mkdtemp(join(tmpdir(),'steelkeep-plans-'));await chmod(directory,0o700);await writeFile(join(directory,'key'),randomBytes(32),{mode:0o600});await writeFile(join(directory,'token'),randomBytes(32).toString('hex'),{mode:0o600})
  process.env.STEELKEEP_KEY_FILE=join(directory,'key');process.env.STEELKEEP_TOKEN_FILE=join(directory,'token');process.env.STEELKEEP_ALLOWED_HOSTS='metadata';process.env.STEELKEEP_ALLOWED_ORIGINS='http://localhost';delete process.env.STEELKEEP_SCOPED_TOKENS_FILE
  const migration=Bun.spawn([process.execPath,'server/migrate.ts'],{cwd:'/work',env:{...process.env,DATABASE_URL:target.toString(),STEELKEEP_DATABASE_PASSWORD_FILE:''},stdout:'ignore',stderr:'ignore',timeout:15000});if(await migration.exited!==0)throw new Error('Dedicated plans migration failed; diagnostics withheld.')
  const source=randomUUID(),other=randomUUID(),storage=randomUUID(),otherStorage=randomUUID();for(const id of [source,other,storage,otherStorage])connections.add(id)
  await db.insertInto('connections').values([{id:source,name:'Literal 100%_source',kind:'postgres',config:{database:'synthetic_source'},secret:'SYNTHETIC_NEVER_DECRYPTED',check_status:'untested',checked_at:null},{id:other,name:'Other source',kind:'mongodb',config:{database:'synthetic_other'},secret:'SYNTHETIC_NEVER_DECRYPTED',check_status:'untested',checked_at:null},{id:storage,name:'Primary storage',kind:'s3',config:{endpoint:'https://never-contact.invalid',bucket:'synthetic'},secret:'SYNTHETIC_NEVER_DECRYPTED',check_status:'untested',checked_at:null},{id:otherStorage,name:'Archive !%_store',kind:'s3',config:{endpoint:'https://never-contact.invalid',bucket:'synthetic'},secret:'SYNTHETIC_NEVER_DECRYPTED',check_status:'untested',checked_at:null}]).execute()
  for(let i=0;i<137;i++){
   const id=randomUUID(),enabled=i%4!==0,scheduled=i%3!==0,name=i===5?'Plan !%_literal':(i%2?'alpha ':'ALPHA ')+i%7,createdAt='2026-10-31T01:02:03.12345'+i%4+'Z',nextDue=enabled&&scheduled?'2035-01-0'+(i%5+1)+'T00:00:00.00000'+i%2+'Z':null,mode=(['keep_all','days','gfs']as const)[i%3],sourceId=i%2?other:source,storageId=i%3?otherStorage:storage
   plans.add(id);fixtures.push({id,name,createdAt,nextDue,source:sourceId,storage:storageId,enabled,scheduled,mode})
   await db.insertInto('plans').values({id,name,source_id:sourceId,storage_id:storageId,cron:scheduled?'0 3 * * *':null,timezone:'UTC',enabled,next_due:nextDue?sql<Date>`${nextDue}::timestamptz`:null,created_at:sql<Date>`${createdAt}::timestamptz`,retention_policy:mode==='keep_all'?{mode}:mode==='days'?{mode,days:30}:{mode,keepDaily:7,keepWeekly:4,keepMonthly:3},retention_enabled:false,retention_checked_at:null}).execute()
  }
  const compare=(a:string,b:string)=>a<b?-1:a>b?1:0
  for(const order of ['newest','oldest','name_asc','name_desc','next_due']as const){
   const found:string[]=[];let cursor:string|undefined
   do{const page=await history.browse({order,limit:17,...(cursor?{cursor}:{})});expect(page.total).toBe(137);expect(page.summary).toEqual({scope:'all-recorded-plans',total:137,enabled:102,paused:35,scheduled:91,manual:46});expect(page.items.length).toBeLessThanOrEqual(17);found.push(...page.items.map(row=>row.id));cursor=page.nextCursor??undefined}while(cursor)
   expect(new Set(found).size).toBe(137)
   const expected=[...fixtures].sort((a,b)=>order==='next_due'?(a.nextDue===null?(b.nextDue===null?compare(a.id,b.id):1):b.nextDue===null?-1:compare(a.nextDue,b.nextDue)||compare(a.id,b.id)):(compare(order.startsWith('name_')?a.name.toLowerCase():a.createdAt,order.startsWith('name_')?b.name.toLowerCase():b.createdAt)||compare(a.id,b.id))*(order==='newest'||order==='name_desc'?-1:1)).map(row=>row.id)
   expect(found).toEqual(expected)
  }
  const filtered=fixtures.filter(row=>row.enabled&&row.scheduled&&row.source===source&&row.storage===otherStorage&&row.mode==='days'),seen:string[]=[];let cursor:string|undefined
  do{const page=await history.browse({limit:3,order:'next_due',kind:'postgres',sourceId:source,storageId:otherStorage,status:'enabled',schedule:'scheduled',retentionMode:'days',...(cursor?{cursor}:{})});expect(page.total).toBe(filtered.length);expect(page.summary.total).toBe(137);seen.push(...page.items.map(row=>row.id));cursor=page.nextCursor??undefined}while(cursor)
  expect(new Set(seen)).toEqual(new Set(filtered.map(row=>row.id)))
  const literal=await history.browse({search:'!%_literal'});expect(literal.items.map(row=>row.id)).toEqual([fixtures[5].id]);expect((await history.browse({search:'100%_source'})).total).toBe(69);expect((await history.browse({search:'!%_store'})).total).toBe(91)
  const first=await history.browse({limit:3});await expect(history.browse({limit:3,order:'oldest',cursor:first.nextCursor!})).rejects.toMatchObject({code:'INVALID_PLAN_CURSOR'})
  const manual=await history.browse({schedule:'manual'});expect(manual.total).toBe(46);expect(manual.items.every(row=>row.upcoming.length===0)).toBe(true)
  const paused=await history.browse({status:'paused'});expect(paused.total).toBe(35);expect(paused.items.every(row=>row.upcoming.length===0)).toBe(true)
  const scheduled=await history.browse({id:fixtures[1].id});expect(scheduled.items[0].upcoming).toHaveLength(3);expect(scheduled.items[0].missed_policy).toBe('skip');expect(scheduled.items[0].retention.enabled).toBe(false);expect((await history.browse({id:randomUUID()})).total).toBe(0)
  const agent=await service.agents.create(owner,{name:'Synthetic plans reader',description:'Plan metadata-only proof'});agents.add(agent.id);const reader=await service.agents.issue(owner,agent.id,{name:'read only',scopes:['read'],expiresInHours:1}),noRead=await service.agents.issue(owner,agent.id,{name:'configure only',scopes:['configure'],expiresInHours:1}),app=createApp(service)
  const request=(path:string)=>app.handle(new Request('http://localhost/api/v1'+path,{headers:{authorization:'Bearer '+reader.token}}))
  const legacy=await request('/plans');expect(legacy.status).toBe(200);const legacyPlans=await legacy.json()as Array<Record<string,unknown>>;expect(legacyPlans).toHaveLength(137);expect(legacyPlans[0]).not.toHaveProperty('source_name')
  const page=await request('/history/plans?status=paused&order=next_due&limit=2');expect(page.status).toBe(200);expect(await page.json()).toMatchObject({total:35,limit:2,order:'next_due',summary:{total:137,scope:'all-recorded-plans'}})
  expect((await request('/history/plans?limit=101')).status).toBe(422);expect((await request('/history/plans?kind=s3')).status).toBe(422)
  expect((await app.handle(new Request('http://localhost/api/v1/history/plans',{headers:{authorization:'Bearer '+noRead.token}}))).status).toBe(403)
  const transport=new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),{requestInit:{headers:{authorization:'Bearer '+reader.token}},fetch:async(input,init)=>app.handle(input instanceof Request?input:new Request(input,init))}),mcp=new Client({name:'plan-history-proof',version:'1'});await mcp.connect(transport)
  try{const result=await mcp.callTool({name:'browse_plans',arguments:{status:'enabled',limit:2,order:'next_due'}});expect(result.isError).not.toBe(true);expect((result.structuredContent as{data:{total:number;summary:{total:number};items:unknown[]}}).data).toMatchObject({total:102,summary:{total:137}});expect((result.structuredContent as{data:{items:unknown[]}}).data.items).toHaveLength(2);expect(JSON.stringify(result.structuredContent)).not.toContain('SYNTHETIC_NEVER_DECRYPTED')}finally{await mcp.close()}
  const deniedTransport=new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),{requestInit:{headers:{authorization:'Bearer '+noRead.token}},fetch:async(input,init)=>app.handle(input instanceof Request?input:new Request(input,init))}),deniedMcp=new Client({name:'plan-history-no-read-proof',version:'1'});await deniedMcp.connect(deniedTransport)
  try{const result=await deniedMcp.callTool({name:'browse_plans',arguments:{}});expect(result.isError).toBe(true);expect((result.structuredContent as{data:{error:{code:string}}}).data.error.code).toBe('FORBIDDEN')}finally{await deniedMcp.close()}
  expect((await db.selectFrom('runs').selectAll().execute()).length).toBe(0);expect((await db.selectFrom('artifacts').selectAll().execute()).length).toBe(0);expect((await db.selectFrom('outbox').selectAll().execute()).length).toBe(0)
  console.info(JSON.stringify({proof:'plan-history',plans:137,orders:5,creationAndDueMicroseconds:true,nullDueBoundary:true,globalAndFilteredCounts:true,strictLegacyFirstRestMcp:true,nativeOrExternalContacts:0}))
 }finally{
  try{
   try{if(created){for(const [table,ids]of [['connections',connections],['plans',plans],['agents',agents]]as const){if((await db.selectFrom(table).select('id').execute()).some(row=>!ids.has(row.id)))throw new Error('Foreign rows in dedicated plans DB; preserve fixture.')}for(const table of ['plans','connections','agent_tokens','agents','audit_events']as const)await db.deleteFrom(table).execute();const tables=await sql<{tablename:string}>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'steelkeep_migrations'`.execute(db);for(const {tablename}of tables.rows){if(!/^[a-z_]+$/.test(tablename))throw new Error('Unexpected dedicated table.');if((await sql<{n:number}>`SELECT count(*)::int AS n FROM ${sql.table(tablename)}`.execute(db)).rows[0].n!==0)throw new Error('Dedicated plans DB retains application data; preserve.')}emptyVerified=true}}finally{await db.destroy()}
   if(created){const identity=(await admin.query<{oid:number;clients:number}>('SELECT d.oid,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=d.datname) AS clients FROM pg_database d WHERE d.datname=$1',[database])).rows[0];if(!emptyVerified||!identity||identity.oid!==oid||identity.clients!==0)throw new Error('Dedicated plans DB identity/empty/client guard failed; preserve.');await admin.query('DROP DATABASE steelkeep_plan_history_test');expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount).toBe(0)}
  }finally{await admin.end();for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value}if(directory)await rm(directory,{recursive:true,force:true})}
 }
},90000)
