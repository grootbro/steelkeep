import {test,expect} from 'bun:test'
import {randomBytes,randomUUID,createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'

// Authored only. Never starts services or runs provisioning as an import effect.
const recovery=process.env.STEELKEEP_ACCEPTANCE==='synthetic-local-clickhouse'?test:test.skip
const base='http://127.0.0.1:4311'
type Job={id:string;status:string;artifact_id:string|null;validation:Record<string,unknown>|null}
type Connection={id:string;kind:string;name:string;config:Record<string,unknown>}
const metadata=['databases','tables','columns','data_skipping_indices','projections','detached_tables','dictionaries','grants','role_grants','enabled_roles','row_policies','disks','backups','mutations','asynchronous_inserts','replicas','clusters','functions','parts']

async function ch(sql:string,user='fixture_owner',password='local-clickhouse-owner-only'){
  const response=await fetch('http://127.0.0.1:54378/',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:'Basic '+Buffer.from(user+':'+password).toString('base64'),'content-type':'text/plain'},body:sql})
  if(!response.ok||Number(response.headers.get('X-ClickHouse-Exception-Code')??0)!==0){await response.body?.cancel();throw new Error('Independent ClickHouse fixture query failed; raw body withheld')}
  return response
}
async function rows(sql:string){const body=await(await ch(sql+' FORMAT JSON')).json() as {data:Record<string,unknown>[];exception?:string};if(body.exception||!Array.isArray(body.data))throw new Error('Malformed independent ClickHouse JSON');return body.data}

recovery('MCP ClickHouse: native backup → object storage → distinct Atomic target → independently checked rows and types',async()=>{
  const token=(await readFile('.steelkeep/token','utf8')).trim()
  async function rest<T>(path:string,body:unknown):Promise<T>{
    const response=await fetch(base+'/api/v1'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)})
    if(!response.ok)throw new Error(`ClickHouse acceptance API ${path} failed (${response.status})`)
    return response.json() as Promise<T>
  }
  const client=new Client({name:'steelkeep-clickhouse-acceptance',version:'0.1.0'})
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}}))
  async function tool<T>(name:string,args:Record<string,unknown>={}):Promise<T>{
    const result=await client.callTool({name,arguments:args})
    if(result.isError)throw new Error(`MCP ${name} returned a tool error`)
    const block=result.content?.find(item=>item.type==='text')
    if(!block||block.type!=='text')throw new Error('Expected JSON MCP result')
    return JSON.parse(block.text) as T
  }
  async function finished(id:string){
    const until=Date.now()+180000
    while(Date.now()<until){const job=await tool<Job>('get_job',{id});if(['succeeded','failed','cancelled','interrupted'].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,250))}
    throw new Error('ClickHouse acceptance deadline exceeded; inspect durable job/native journals, never resubmit restore')
  }
  try{
    const connections=await tool<Connection[]>('list_connections')
    const source=connections.find(row=>row.name==='ClickHouse · fixture'&&row.kind==='clickhouse'&&row.config.database==='fixture_ch_source'&&!row.config.restoreTarget)
    if(!source)throw new Error('Prepare the isolated ClickHouse fixture and register it with seed-clickhouse-fixture.ts first')
    expect(JSON.stringify(connections)).not.toContain('local-clickhouse-reader-only')
    const plans=await tool<{id:string;source_id:string}[]>('list_plans'),plan=plans.find(row=>row.source_id===source.id)
    if(!plan)throw new Error('Fixture plan missing')
    // Reader has no write grants. Fixture owner performs no source writes here.
    const before=await rows("SELECT toString(count()) AS n FROM fixture_ch_source.entries")
    expect(before).toEqual([{n:'3'}])
    const backupKey=randomUUID(),accepted=await tool<Job>('run_backup',{planId:plan.id,idempotencyKey:backupKey})
    expect((await tool<Job>('run_backup',{planId:plan.id,idempotencyKey:backupKey})).id).toBe(accepted.id)
    const backup=await finished(accepted.id)
    expect(backup.status).toBe('succeeded');expect(backup.artifact_id).toBeTruthy()
    // New empty database and target-only direct grants per run. Keep it on failure.
    const suffix=randomBytes(6).toString('hex'),database='ch_recovery_'+suffix,user='restore_'+suffix,password=randomBytes(24).toString('hex')
    for(const sql of [`CREATE DATABASE ${database} ENGINE = Atomic`,`CREATE USER ${user} IDENTIFIED WITH sha256_password BY '${password}'`,`GRANT SELECT, INSERT, CREATE TABLE, SHOW TABLES ON ${database}.* TO ${user}`,...metadata.map(table=>`GRANT SELECT ON system.${table} TO ${user}`),`GRANT SHOW USERS, SHOW ROLES, SHOW ROW POLICIES ON *.* TO ${user}`])await(await ch(sql)).arrayBuffer()
    // Prove least privilege independently; never add broad grants to silence errors.
    const grantResponse=await(await ch('CHECK GRANT CREATE DATABASE ON *.*',user,password)).text()
    expect(grantResponse.trim()).toBe('0')
    const target=await rest<{id:string}>('/connections',{name:'ClickHouse acceptance '+suffix,kind:'clickhouse',host:'clickhouse-fixture',port:8123,database,user,password,tls:false,restoreTarget:true,backupDisk:'steelkeep_backup',sharedBackupRoot:'/steelkeep-clickhouse-backups'})
    expect((await tool<{status:string}>('test_connection',{id:target.id})).status).toBe('available')
    const sourceAttempt=await client.callTool({name:'prepare_restore',arguments:{artifactId:backup.artifact_id,targetId:source.id}})
    expect(sourceAttempt.isError).toBe(true)
    const prepared=await tool<{intentId:string;review:{sourceDatabase:string;targetDatabase:string}}>('prepare_restore',{artifactId:backup.artifact_id,targetId:target.id})
    expect(prepared.review.sourceDatabase).toBe('fixture_ch_source');expect(prepared.review.targetDatabase).toBe(database)
    const key=randomUUID(),started=await tool<Job>('start_restore',{intentId:prepared.intentId,idempotencyKey:key})
    expect((await tool<Job>('start_restore',{intentId:prepared.intentId,idempotencyKey:key})).id).toBe(started.id)
    const completed=await finished(started.id)
    expect(completed.status).toBe('succeeded');expect(completed.validation?.status).toBe('passed');expect(completed.validation?.restore).toBe('completed')
    const expectedTypes=[['id','UInt64'],['label','String'],['amount','Decimal(18, 4)'],['optional','Nullable(Int64)'],['tags','Array(String)'],['occurred',"DateTime64(3, 'UTC')"],['fixed','FixedString(4)']]
    expect((await rows(`SELECT name,type FROM system.columns WHERE database='${database}' AND table='entries' ORDER BY position`)).map(row=>[row.name,row.type])).toEqual(expectedTypes)
    const projection="toString(id) AS id,label,toString(toInt128(amount*10000)) AS scaledAmount,if(isNull(optional),NULL,toString(optional)) AS optional,tags,toString(occurred) AS occurred,hex(fixed) AS fixed"
    const expectedRows=[
      {id:'1',label:'alpha',scaledAmount:'123400',optional:null,tags:['a','b'],occurred:'2026-01-02 03:04:05.678',fixed:'61626364'},
      {id:'2',label:'Юникод',scaledAmount:'-1',optional:'-7',tags:[],occurred:'2026-02-03 04:05:06.001',fixed:'7778797A'},
      {id:'3',label:'comma,quote"line',scaledAmount:'90071992547409',optional:'9223372036854775807',tags:['x'],occurred:'2026-03-04 05:06:07.999',fixed:'30313233'}
    ]
    expect(await rows(`SELECT ${projection} FROM ${database}.entries ORDER BY id`)).toEqual(expectedRows)
    expect(await rows(`SELECT ${projection} FROM fixture_ch_source.entries ORDER BY id`)).toEqual(expectedRows)
    // Independent lossless Native example: deterministic ORDER BY, same columns
    // and types. This is an additional check, not the worker's RowBinary digest.
    const native=async(db:string)=>new Uint8Array(await(await ch(`SELECT * FROM ${db}.entries ORDER BY id SETTINGS max_threads=1,max_block_size=65536 FORMAT Native`)).arrayBuffer())
    const sourceNative=await native('fixture_ch_source'),targetNative=await native(database)
    expect(sourceNative.length).toBeGreaterThan(0)
    expect(createHash('sha256').update(targetNative).digest('hex')).toBe(createHash('sha256').update(sourceNative).digest('hex'))
    expect((await client.callTool({name:'prepare_restore',arguments:{artifactId:backup.artifact_id,targetId:target.id}})).isError).toBe(true)
  }finally{await client.close()}
  // Retain all fixture targets, archives and uncertain journals; no DROP cleanup.
},240000)
