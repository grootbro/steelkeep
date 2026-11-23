import {test,expect} from 'bun:test'
import {randomBytes,randomUUID} from 'node:crypto'
import {chmod,lstat,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import pg from 'pg'
import {Kysely,PostgresDialect,sql,type RawBuilder} from 'kysely'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'
import type {Schema} from '../server/db'
import {Services} from '../server/services'
import {createApp} from '../server/app'
import {allScopes,type Principal} from '../server/auth'

const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-server-dashboard-activity'?test:test.skip
const statuses=['queued','running','cancelling','succeeded','failed','cancelled','interrupted'] as const
type Counts=Record<typeof statuses[number],number>
const zero=():Counts=>({queued:0,running:0,cancelling:0,succeeded:0,failed:0,cancelled:0,interrupted:0})

acceptance('overview exposes exact UTC status stacks and full 30-day counts beyond its recent jobs, with strict REST/MCP parity',async()=>{
 if(process.platform!=='linux'||process.env.STEELKEEP_SERVER_PROOF_ROOT!=='/work'||await realpath(process.cwd())!=='/work')throw new Error('Dashboard proof requires the authorized isolated Linux server stand at /work.')
 async function capability(path:string){const file=await lstat(path);if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o777)!==0o600||file.uid!==process.getuid?.())throw new Error('Proof capabilities require regular current-user0600 files.');return (await readFile(path,'utf8')).trim()}
 const nonce=await capability('/run/steelkeep/proof-nonce'),password=await capability('/run/steelkeep/metadata-password')
 if(!/^[a-f0-9]{64}$/.test(nonce)||!password)throw new Error('Invalid private proof capability.')
 const database='steelkeep_dashboard_activity_test',controlUrl=new URL('postgresql://steelkeep@metadata:5432/steelkeep_platform_proof');controlUrl.password=password
 const targetUrl=new URL(controlUrl);targetUrl.pathname='/'+database
 const options={connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000},admin=new pg.Client({connectionString:controlUrl.toString(),...options}),db=new Kysely<Schema>({dialect:new PostgresDialect({pool:new pg.Pool({connectionString:targetUrl.toString(),max:4,...options,options:'-c timezone=Pacific/Honolulu'})})}),services=new Services(db),owner:Principal={actor:'installation-owner',scopes:allScopes}
 const saved=Object.fromEntries(['STEELKEEP_KEY_FILE','STEELKEEP_TOKEN_FILE','STEELKEEP_ALLOWED_HOSTS','STEELKEEP_ALLOWED_ORIGINS','STEELKEEP_SCOPED_TOKENS_FILE'].map(key=>[key,process.env[key]]))
 const connections=new Set<string>(),runs=new Set<string>(),agents=new Set<string>(),tokens=new Set<string>()
 let created=false,oid:number|undefined,directory:string|undefined,emptyVerified=false
 try{
  await admin.connect()
  const identity=(await admin.query<{database:string;actor:string}>('SELECT current_database() AS database,current_user AS actor')).rows[0],marker=(await admin.query<{singleton:boolean;nonce:string}>('SELECT singleton,nonce FROM steelkeep_platform_proof_identity')).rows
  if(identity.database!=='steelkeep_platform_proof'||identity.actor!=='steelkeep'||marker.length!==1||marker[0].singleton!==true||marker[0].nonce!==nonce)throw new Error('Wrong proof control database or capability marker.')
  if((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount)throw new Error('Dedicated dashboard database already exists; preserve it for inspection.')
  await admin.query('CREATE DATABASE steelkeep_dashboard_activity_test');created=true;oid=(await admin.query<{oid:number}>('SELECT oid FROM pg_database WHERE datname=$1',[database])).rows[0].oid
  directory=await mkdtemp(join(tmpdir(),'steelkeep-dashboard-activity-'));await chmod(directory,0o700)
  await writeFile(join(directory,'key'),randomBytes(32),{mode:0o600});await writeFile(join(directory,'token'),randomBytes(32).toString('hex'),{mode:0o600})
  process.env.STEELKEEP_KEY_FILE=join(directory,'key');process.env.STEELKEEP_TOKEN_FILE=join(directory,'token');process.env.STEELKEEP_ALLOWED_HOSTS='metadata';process.env.STEELKEEP_ALLOWED_ORIGINS='http://localhost';delete process.env.STEELKEEP_SCOPED_TOKENS_FILE
  const migrate=Bun.spawn([process.execPath,'server/migrate.ts'],{cwd:'/work',env:{...process.env,DATABASE_URL:targetUrl.toString(),STEELKEEP_DATABASE_PASSWORD_FILE:''},stdout:'ignore',stderr:'ignore',timeout:15000});if(await migrate.exited!==0)throw new Error('Dedicated dashboard migration failed; raw diagnostics withheld.')
  expect((await sql<{database:string;timezone:string}>`SELECT current_database() AS database,current_setting('TimeZone') AS timezone`.execute(db)).rows[0]).toEqual({database,timezone:'Pacific/Honolulu'})
  const source=randomUUID(),storage=randomUUID(),restoreTarget=randomUUID();for(const id of [source,storage,restoreTarget])connections.add(id)
  await db.insertInto('connections').values([{id:source,name:'Synthetic dashboard source',kind:'postgres',config:{database:'synthetic_source',restoreTarget:false},secret:'SYNTHETIC_NEVER_DECRYPTED_'+nonce,check_status:'untested',checked_at:null},{id:storage,name:'Synthetic dashboard storage',kind:'s3',config:{endpoint:'https://never-contact.invalid',bucket:'synthetic'},secret:'SYNTHETIC_NEVER_DECRYPTED_'+nonce,check_status:'untested',checked_at:null},{id:restoreTarget,name:'Synthetic dashboard target',kind:'postgres',config:{database:'synthetic_target',restoreTarget:true},secret:'SYNTHETIC_NEVER_DECRYPTED_'+nonce,check_status:'untested',checked_at:null}]).execute()
  const anchor=(await sql<{today:string;first:string;yesterday:string}>`SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') AS today,to_char((now() AT TIME ZONE 'UTC')::date-13,'YYYY-MM-DD') AS first,to_char((now() AT TIME ZONE 'UTC')::date-1,'YYYY-MM-DD') AS yesterday`.execute(db)).rows[0]
  async function run(status:typeof statuses[number],type:'backup'|'restore',createdAt:RawBuilder<Date>){const id=randomUUID();runs.add(id);await db.insertInto('runs').values({id,plan_id:null,type,status,phase:status,idempotency_key:randomUUID(),source_id:source,storage_id:storage,target_id:type==='restore'?restoreTarget:null,artifact_id:null,started_at:null,finished_at:null,heartbeat_at:null,error_code:null,error_message:null,validation:null,cancel_requested:false,attempt:0,execution_token:null,review_fingerprint:null,created_at:createdAt}).execute();return id}
  // 112 records in one complete UTC day exceeds the unchanged 100-job response cap.
  for(const status of statuses)for(let i=0;i<16;i++)await run(status,i%2?'backup':'restore',sql<Date>`((${anchor.yesterday}::date+interval '12 hours') AT TIME ZONE 'UTC')`)
  const firstBoundary=await run('succeeded','backup',sql<Date>`(${anchor.first}::date::timestamp AT TIME ZONE 'UTC')`)
  const beforeFirst=await run('failed','restore',sql<Date>`(${anchor.first}::date::timestamp AT TIME ZONE 'UTC')-interval '1 microsecond'`)
  const yesterdayLast=await run('interrupted','restore',sql<Date>`(${anchor.today}::date::timestamp AT TIME ZONE 'UTC')-interval '1 microsecond'`)
  const todayFirst=await run('cancelled','backup',sql<Date>`(${anchor.today}::date::timestamp AT TIME ZONE 'UTC')`)
  await run('cancelling','restore',sql<Date>`now()-interval '29 days'`)
  const outside30=await run('queued','backup',sql<Date>`now()-interval '31 days'`)
  const overview=await services.overview()
  // Crossing UTC midnight during this small proof changes the expected window; preserve diagnostics instead of guessing.
  expect(overview.activityWindow).toEqual({from:anchor.first,to:anchor.today,timezone:'UTC'})
  expect(overview.activity).toHaveLength(14);expect(overview.jobs).toHaveLength(100);expect(overview.backups).toHaveLength(0)
  const yesterday={queued:16,running:16,cancelling:16,succeeded:16,failed:16,cancelled:16,interrupted:17}
  const expectedSummary={queued:16,running:16,cancelling:17,succeeded:17,failed:17,cancelled:17,interrupted:17}
  expect(overview.jobSummary).toMatchObject({windowDays:30,total:117,succeeded:17,failed:17,cancelled:17,interrupted:17,active:49,scope:'all installation jobs',statusCounts:expectedSummary})
  expect(Object.values(overview.jobSummary.statusCounts).reduce((sum,n)=>sum+n,0)).toBe(117)
  for(const day of overview.activity){
   const expected=day.date===anchor.yesterday?yesterday:day.date===anchor.first?{...zero(),succeeded:1}:day.date===anchor.today?{...zero(),cancelled:1}:zero()
   expect(day.statusCounts).toEqual(expected)
   expect(Object.keys(day.statusCounts).sort()).toEqual([...statuses].sort())
   expect(Object.values(day.statusCounts).reduce((sum,n)=>sum+n,0)).toBe(day.backup+day.restore)
   expect(day.failed).toBe(day.statusCounts.failed)
  }
  expect(overview.activity.find(day=>day.date===anchor.yesterday)).toMatchObject({backup:56,restore:57,failed:16})
  expect(overview.activity.find(day=>day.date===anchor.first)).toMatchObject({backup:1,restore:0,failed:0})
  expect(overview.activity.find(day=>day.date===anchor.today)).toMatchObject({backup:1,restore:0,failed:0})
  expect(overview.jobs.some(job=>job.id===firstBoundary)).toBe(false)
  expect((await db.selectFrom('runs').select('created_at').where('id','in',[firstBoundary,beforeFirst,yesterdayLast,todayFirst,outside30]).execute()).length).toBe(5)
  const agent=await services.agents.create(owner,{name:'Synthetic dashboard reader',description:'Read-only metadata status-stack proof'});agents.add(agent.id)
  const reader=await services.agents.issue(owner,agent.id,{name:'dashboard read',scopes:['read'],expiresInHours:1}),noRead=await services.agents.issue(owner,agent.id,{name:'dashboard configure only',scopes:['configure'],expiresInHours:1});tokens.add(reader.id);tokens.add(noRead.id)
  const app=createApp(services),request=(token?:string)=>app.handle(new Request('http://localhost/api/v1/overview',{headers:token?{authorization:'Bearer '+token}:{}}))
  expect((await request()).status).toBe(401);expect((await request(noRead.token)).status).toBe(403)
  // Exercise a pre-existing strict response before the extended overview to detect shared-schema regressions.
  expect((await app.handle(new Request('http://localhost/api/v1/jobs/'+todayFirst,{headers:{authorization:'Bearer '+reader.token}}))).status).toBe(200)
  const response=await request(reader.token);expect(response.status).toBe(200)
  const rest=await response.json() as {activity:typeof overview.activity;jobSummary:typeof overview.jobSummary;jobs:unknown[]}
  expect(rest.activity).toEqual(overview.activity);expect(rest.jobSummary).toEqual(overview.jobSummary);expect(rest.jobs).toHaveLength(100);expect(JSON.stringify(rest)).not.toContain('SYNTHETIC_NEVER_DECRYPTED')
  const mcp=new Client({name:'dashboard-status-activity-proof',version:'1'}),transport=new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),{requestInit:{headers:{authorization:'Bearer '+reader.token}},fetch:async(input,init)=>app.handle(input instanceof Request?input:new Request(input,init))})
  await mcp.connect(transport)
  try{const result=await mcp.callTool({name:'get_overview',arguments:{}});expect(result.isError).not.toBe(true);const data=(result.structuredContent as {data:{activity:typeof overview.activity;jobSummary:typeof overview.jobSummary}}).data;expect(data.activity).toEqual(rest.activity);expect(data.jobSummary).toEqual(rest.jobSummary)}finally{await mcp.close()}
  for(const table of ['outbox','artifacts','target_blocks','source_blocks','notification_deliveries','retention_jobs'] as const)expect((await db.selectFrom(table).selectAll().execute()).length).toBe(0)
  console.info(JSON.stringify({proof:'dashboard-status-activity',fixtureJobs:runs.size,recentJobs:overview.jobs.length,all30Days:overview.jobSummary.total,statuses:7,utcDays:14,sessionTimezone:'Pacific/Honolulu',microsecondBoundary:true,restMcpParity:true,nativeOrS3Contacts:0}))
 }finally{
  try{
   try{
    if(created){
     for(const [table,ids]of [['connections',connections],['runs',runs],['agents',agents],['agent_tokens',tokens]] as const){const rows=await db.selectFrom(table).select('id').execute();if(rows.some(row=>!ids.has(row.id)))throw new Error('Foreign rows in dedicated dashboard DB; preserve.')}
     const audit=await db.selectFrom('audit_events').select(['actor','subject_id']).execute();if(audit.some(row=>row.actor!==owner.actor||!row.subject_id||!agents.has(row.subject_id)&&!tokens.has(row.subject_id)))throw new Error('Unexpected audit ownership in dedicated dashboard DB; preserve.')
     for(const table of ['runs','connections','agent_tokens','agents','audit_events'] as const)await db.deleteFrom(table).execute()
     const tables=(await sql<{tablename:string}>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'steelkeep_migrations'`.execute(db)).rows
     for(const {tablename}of tables){if(!/^[a-z_]+$/.test(tablename))throw new Error('Unexpected dedicated table identity.');if((await sql<{n:number}>`SELECT count(*)::int AS n FROM ${sql.table(tablename)}`.execute(db)).rows[0].n!==0)throw new Error('Dedicated dashboard DB retains data; no drop.')}
     emptyVerified=true
    }
   }finally{await db.destroy()}
   if(created){const identity=(await admin.query<{oid:number;clients:number}>('SELECT d.oid,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=d.datname) AS clients FROM pg_database d WHERE d.datname=$1',[database])).rows[0];if(!emptyVerified||!identity||identity.oid!==oid||identity.clients!==0)throw new Error('Dedicated dashboard OID/empty/client guard failed; preserve.');await admin.query('DROP DATABASE steelkeep_dashboard_activity_test');expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount).toBe(0)}
  }finally{await admin.end();for(const[key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value}if(directory)await rm(directory,{recursive:true,force:true})}
 }
},90000)
