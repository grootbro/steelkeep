import {test,expect} from 'bun:test'
import pg from 'pg'
import {Kysely,PostgresDialect} from 'kysely'
import {realpath,mkdtemp,writeFile,rm,chmod} from 'node:fs/promises'
import {randomUUID,randomBytes} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'
import type {Schema} from '../server/db'
import {HistoryServices} from '../server/history'
import {createApp} from '../server/app'
import {Services} from '../server/services'
import {allScopes} from '../server/auth'

const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-local-history'?test:test.skip
acceptance('actual PostgreSQL history pagination preserves timestamp ties, filters and records beyond the recent window',async()=>{
  if(await realpath(process.cwd())!=='/Users/dobrota/dev/steelkeep')throw new Error('Use the fixed Steelkeep checkout.')
  const target=new URL(process.env.DATABASE_URL??''),database='steelkeep_history_test'
  if(target.hostname!=='127.0.0.1'||target.port!=='54371'||target.pathname!==`/${database}`||target.username!=='steelkeep'||target.search||target.hash)throw new Error('Require dedicated loopback steelkeep_history_test metadata.')
  const adminUrl=new URL(target);adminUrl.pathname='/postgres'
  const admin=new pg.Client({connectionString:adminUrl.toString(),connectionTimeoutMillis:5000,statement_timeout:10000}),holder=new pg.Client({connectionString:target.toString(),connectionTimeoutMillis:5000,statement_timeout:10000})
  const db=new Kysely<Schema>({dialect:new PostgresDialect({pool:new pg.Pool({connectionString:target.toString(),max:2,connectionTimeoutMillis:5000,statement_timeout:10000})})}),history=new HistoryServices(db,Buffer.alloc(32,7))
  const source=randomUUID(),other=randomUUID(),storage=randomUUID(),plan=randomUUID(),ids=Array.from({length:107},()=>randomUUID()),artifacts=Array.from({length:107},()=>randomUUID())
  let created=false,connected=false,oid:number|undefined,directory:string|undefined
  const saved=Object.fromEntries(['STEELKEEP_KEY_FILE','STEELKEEP_TOKEN_FILE','STEELKEEP_ALLOWED_HOSTS','STEELKEEP_ALLOWED_ORIGINS','STEELKEEP_SCOPED_TOKENS_FILE'].map(key=>[key,process.env[key]]))
  try{
    await admin.connect()
    if((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount)throw new Error('Dedicated history database exists; retain it for explicit inspection.')
    await admin.query('CREATE DATABASE steelkeep_history_test');created=true
    oid=(await admin.query<{oid:number}>('SELECT oid FROM pg_database WHERE datname=$1',[database])).rows[0].oid
    await holder.connect();connected=true
    // Reuse the current public schema without data or a racing development migration.
    const dump=Bun.spawn(['docker','exec','steelkeep-metadata-1','pg_dump','-U','steelkeep','-d','steelkeep','--schema-only','--no-owner','--no-privileges','-t','public.*'],{stdout:'pipe',stderr:'ignore',timeout:10000})
    const ddl=await new Response(dump.stdout).text()
    if(await dump.exited!==0||ddl.length>2*1024*1024||!ddl.includes('CREATE TABLE public.runs'))throw new Error('Expected local metadata schema export was not established.')
    // pg_dump 17 client guards are psql meta commands, not SQL statements.
    await holder.query(ddl.split('\n').filter(line=>!line.startsWith('\\')).join('\n'))
    await holder.query('SET search_path TO public')
    const tables=(await holder.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows
    for(const {tablename} of tables){if(!/^[a-z_]+$/.test(tablename))throw new Error('Unexpected schema identity.');expect(Number((await holder.query(`SELECT count(*) AS n FROM "${tablename}"`)).rows[0].n)).toBe(0)}
    await holder.query("INSERT INTO connections(id,name,kind,config,secret) VALUES($1,'Literal 100%_source','postgres','{}','synthetic-unused'),($2,'Other source','postgres','{}','synthetic-unused'),($3,'History storage','s3','{}','synthetic-unused')",[source,other,storage])
    await holder.query("INSERT INTO plans(id,name,source_id,storage_id,cron,timezone,enabled) VALUES($1,'History fixture',$2,$3,NULL,'UTC',false)",[plan,source,storage])
    for(let index=0;index<ids.length;index++){
      const timestamp=index<4?'2026-10-31T00:00:00.123456Z':index<8?'2026-10-31T00:00:00.123455Z':new Date(Date.UTC(2026,9,30,0,0,index)).toISOString(),sourceId=index===106?other:source
      await holder.query("INSERT INTO runs(id,plan_id,type,status,phase,idempotency_key,source_id,storage_id,artifact_id,created_at,execution_token) VALUES($1,$2,'backup',$3,'completed',$4,$5,$6,$7,$8,$9)",[ids[index],plan,index===105?'failed':'succeeded','history-'+randomUUID(),sourceId,storage,artifacts[index],timestamp,randomUUID()])
      await holder.query("INSERT INTO artifacts(id,run_id,source_id,storage_id,object_key,size,sha256,engine,server_version,tool_version,created_at,availability) VALUES($1,$2,$3,$4,$5,128,$6,'postgres','synthetic','synthetic',$7,'present')",[artifacts[index],ids[index],sourceId,storage,'synthetic/'+artifacts[index],'a'.repeat(64),timestamp])
    }
    async function pages(kind:'jobs'|'snapshots',order:'newest'|'oldest'){
      let cursor:string|undefined;const found:string[]=[]
      do{const result=await history[kind]({limit:3,order,...(cursor?{cursor}:{})});found.push(...result.items.map(row=>row.id));cursor=result.nextCursor??undefined;expect(result.items.length).toBeLessThanOrEqual(3)}while(cursor)
      expect(found).toHaveLength(107);expect(new Set(found).size).toBe(107)
      return found
    }
    const descending=await pages('jobs','newest'),ascending=await pages('jobs','oldest')
    expect(ascending).toEqual([...descending].reverse())
    expect((await pages('snapshots','newest')).slice(0,4)).toEqual(artifacts.slice(0,4).sort().reverse())
    const filtered=await history.jobs({search:'100%_source',status:'failed'})
    expect(filtered.items.map(row=>row.id)).toEqual([ids[105]])
    expect((await history.jobs({search:'100%Xsource'})).items).toEqual([])
    const first=await history.jobs({limit:3}),cursor=first.nextCursor!
    expect(Object.keys(first.items[0])).not.toContain('execution_token');expect(Object.keys(first.items[0])).not.toContain('review_fingerprint')
    const newest=randomUUID()
    await holder.query("INSERT INTO runs(id,type,status,phase,idempotency_key,source_id,storage_id,created_at) VALUES($1,'backup','succeeded','completed',$2,$3,$4,'2026-11-01T00:00:00Z')",[newest,'history-'+randomUUID(),source,storage])
    expect((await history.jobs({limit:3,cursor})).items.map(row=>row.id)).not.toContain(newest)
    expect((await history.jobs({from:'2026-11-01T00:00:00Z'})).items.map(row=>row.id)).toEqual([newest])
    expect((await history.snapshots({sourceId:other})).items.map(row=>row.id)).toEqual([artifacts[106]])
    await holder.query("INSERT INTO runs(id,type,status,phase,idempotency_key,source_id,storage_id,target_id,artifact_id,validation,finished_at) VALUES($1,'restore','succeeded','completed',$2,$3,$4,$5,$6,'{\"status\":\"passed\",\"passed\":true}',clock_timestamp())",[randomUUID(),'history-'+randomUUID(),source,storage,other,artifacts[106]])
    const old=(await history.snapshots({id:artifacts[106]})).items
    expect(old).toHaveLength(1);expect(old[0].last_restore?.status).toBe('succeeded');expect(old[0].last_restore?.validation?.passed).toBe(true)
    directory=await mkdtemp(join(tmpdir(),'steelkeep-history-'));await chmod(directory,0o700)
    const token=randomBytes(32).toString('hex')
    await writeFile(join(directory,'key'),randomBytes(32),{mode:0o600});await writeFile(join(directory,'token'),token,{mode:0o600})
    process.env.STEELKEEP_KEY_FILE=join(directory,'key');process.env.STEELKEEP_TOKEN_FILE=join(directory,'token');process.env.STEELKEEP_ALLOWED_HOSTS='127.0.0.1';process.env.STEELKEEP_ALLOWED_ORIGINS='http://localhost';delete process.env.STEELKEEP_SCOPED_TOKENS_FILE
    const services=new Services(db),owner={actor:'installation-owner',scopes:allScopes},agent=await services.agents.create(owner,{name:'Synthetic history reader'}),reader=await services.agents.issue(owner,agent.id,{name:'Only read',scopes:['read']}),app=createApp(services)
    const request=(path:string,bearer=reader.token)=>app.handle(new Request('http://localhost/api/v1'+path,{headers:{authorization:'Bearer '+bearer}}))
    const page=await request('/history/jobs?limit=3&order=newest');expect(page.status).toBe(200)
    const data=await page.json();expect(data.items).toHaveLength(3);expect(data.items[0].source_name).toBe('Literal 100%_source');expect(data.nextCursor).toBeString()
    const next=await request('/history/jobs?limit=3&order=newest&cursor='+encodeURIComponent(data.nextCursor));expect(next.status).toBe(200);expect((await next.json()).items.some((row:{id:string})=>data.items.some((prior:{id:string})=>prior.id===row.id))).toBe(false)
    const defaults=await request('/history/jobs');expect(defaults.status).toBe(200);const defaultPage=await defaults.json();expect(defaultPage.items).toHaveLength(30);expect(defaultPage.items.some((row:{type:string})=>row.type==='restore')).toBe(true)
    expect((await request('/history/jobs?limit=3&status=failed&cursor='+encodeURIComponent(data.nextCursor))).status).toBe(422)
    expect((await request('/history/jobs?limit=101')).status).toBe(422)
    expect((await request('/history/jobs?unknown=field')).status).toBe(422)
    const lookup=await request('/backups/'+artifacts[106]);expect(lookup.status).toBe(200);expect((await lookup.json()).last_restore.validation.passed).toBe(true)
    expect((await app.handle(new Request('http://localhost/api/v1/history/jobs'))).status).toBe(401)
    const mcp=new Client({name:'synthetic-history-read',version:'0.1.0'})
    try{
      await mcp.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),{requestInit:{headers:{authorization:'Bearer '+reader.token}},fetch:async(input,init)=>app.handle(new Request(input,init))}))
      for(const [name,args]of [['browse_job_history',{limit:3}],['browse_snapshot_history',{id:artifacts[106]}],['get_backup',{id:artifacts[106]}]] as const){const result=await mcp.callTool({name,arguments:args});expect(result.isError).not.toBe(true);expect(JSON.stringify(result)).not.toContain('execution_token')}
    }finally{await mcp.close()}
  }finally{
    await db.destroy();if(connected)await holder.end()
    try{if(created){const row=(await admin.query<{oid:number;clients:number}>('SELECT d.oid,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=d.datname) AS clients FROM pg_database d WHERE d.datname=$1',[database])).rows[0];if(row.oid!==oid||row.clients!==0)throw new Error('History cleanup identity/client guard failed; retain database.');await admin.query('DROP DATABASE steelkeep_history_test')}}finally{await admin.end();for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value}if(directory)await rm(directory,{recursive:true,force:true})}
  }
},60000)
