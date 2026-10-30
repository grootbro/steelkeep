import {test,expect} from 'bun:test'
import {randomBytes,randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import pg from 'pg'
import mysql from 'mysql2/promise'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'

// Opt-in only. Source authoring is not evidence that this acceptance suite passed.
const recovery=process.env.STEELKEEP_ACCEPTANCE==='synthetic-local'?test:test.skip
const base='http://127.0.0.1:4311'
type Job={id:string;status:string;artifact_id:string|null;validation:Record<string,unknown>|null;error_code:string|null}
type Connection={id:string;kind:string;name:string;config:Record<string,unknown>}

async function fixtureTarget(engine:'postgres'|'mariadb'){
  const suffix=randomBytes(6).toString('hex'),database=`recovery_${suffix}`,user=`restore_${suffix}`,password=randomBytes(20).toString('hex')
  // These identifiers/passwords are generated here, never supplied by the API or a user.
  if(engine==='postgres'){
    const admin=new pg.Client({host:'127.0.0.1',port:54372,database:'source',user:'fixture_admin',password:'local-fixture-only'})
    try{await admin.connect();await admin.query(`CREATE ROLE ${user} LOGIN PASSWORD '${password}'`);await admin.query(`CREATE DATABASE ${database} OWNER ${user}`)}finally{await admin.end()}
  }else{
    const admin=await mysql.createConnection({host:'127.0.0.1',port:54375,user:'root',password:'local-mariadb-fixture-only'})
    try{
      await admin.query(`CREATE DATABASE \`${database}\``)
      await admin.query(`CREATE USER '${user}'@'%' IDENTIFIED BY '${password}'`)
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, CREATE VIEW, SHOW VIEW, TRIGGER, EVENT, EXECUTE, LOCK TABLES ON \`${database.replace(/[%_]/g,'\\$&')}\`.* TO '${user}'@'%'`)
    }finally{await admin.end()}
  }
  return {name:`Acceptance ${engine} ${suffix}`,kind:engine,host:engine==='postgres'?'fixture':'mysql-fixture',port:engine==='postgres'?5432:3306,database,user,password,tls:false,restoreTarget:true}
}

for(const engine of ['postgres','mariadb'] as const)recovery(`MCP ${engine}: native backup -> S3 -> distinct target -> validated data`,async()=>{
  const token=(await readFile('.steelkeep/token','utf8')).trim()
  async function rest<T>(path:string,body?:unknown):Promise<T>{
    const response=await fetch(base+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})
    if(!response.ok)throw new Error(`Acceptance API ${path} failed (${response.status})`)
    return response.json() as Promise<T>
  }
  const client=new Client({name:'steelkeep-acceptance',version:'0.1.0'})
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}}))
  async function tool<T>(name:string,args:Record<string,unknown>={}):Promise<T>{
    const result=await client.callTool({name,arguments:args})
    if(result.isError)throw new Error(`MCP ${name} returned a tool error`)
    const text=result.content?.find(c=>c.type==='text')
    if(!text||text.type!=='text')throw new Error('Expected structured JSON tool output')
    return JSON.parse(text.text) as T
  }
  async function finished(id:string){
    const deadline=Date.now()+120000
    while(Date.now()<deadline){
      const job=await tool<Job>('get_job',{id})
      if(['succeeded','failed','cancelled','interrupted'].includes(job.status))return job
      await new Promise(resolve=>setTimeout(resolve,200))
    }
    throw new Error('Durable job did not finish within the acceptance deadline')
  }
  try{
    const tools=await client.listTools();expect(tools.tools.map(t=>t.name)).toContain('prepare_restore')
    const connections=await tool<Connection[]>('list_connections')
    expect(JSON.stringify(connections)).not.toContain('local-reader-only')
    const plans=await tool<{id:string;source_id:string}[]>('list_plans')
    const source=connections.find(c=>c.kind===engine&&!c.config.restoreTarget)
    if(!source)throw new Error('Seed the isolated fixture stack first')
    const plan=plans.find(p=>p.source_id===source.id)
    if(!plan)throw new Error('Fixture plan not found')
    const backupKey=randomUUID(),accepted=await tool<Job>('run_backup',{planId:plan.id,idempotencyKey:backupKey})
    expect((await tool<Job>('run_backup',{planId:plan.id,idempotencyKey:backupKey})).id).toBe(accepted.id)
    const backup=await finished(accepted.id)
    expect(backup.status).toBe('succeeded');expect(backup.artifact_id).toBeTruthy()
    const targetConfig=await fixtureTarget(engine),target=await rest<{id:string}>('/connections',targetConfig)
    const prepared=await tool<{intentId:string;review:{sourceDatabase:string;targetDatabase:string}}>('prepare_restore',{artifactId:backup.artifact_id,targetId:target.id})
    expect(prepared.review.sourceDatabase).not.toBe(prepared.review.targetDatabase)
    const key=randomUUID(),restore=await tool<Job>('start_restore',{intentId:prepared.intentId,idempotencyKey:key})
    expect((await tool<Job>('start_restore',{intentId:prepared.intentId,idempotencyKey:key})).id).toBe(restore.id)
    const completed=await finished(restore.id)
    expect(completed.status).toBe('succeeded')
    expect(completed.validation?.status).toBe('passed')
    expect(completed.validation?.restore).toBe('completed')
    // Independent data checks: do not merely trust the worker's result record.
    if(engine==='postgres'){
      const targetDb=new pg.Client({host:'127.0.0.1',port:54372,database:targetConfig.database,user:targetConfig.user,password:targetConfig.password})
      try{await targetDb.connect();expect((await targetDb.query('SELECT count(*)::int AS n FROM entries')).rows[0].n).toBe(1000);expect((await targetDb.query('SELECT sum(amount)::text AS total FROM entries')).rows[0].total).toBe('625625.00');expect((await targetDb.query('INSERT INTO projects(name) VALUES($1) RETURNING id',['Recovered fixture insert'])).rows[0].id).toBe(2)}finally{await targetDb.end()}
    }else{
      const targetDb=await mysql.createConnection({host:'127.0.0.1',port:54375,database:targetConfig.database,user:targetConfig.user,password:targetConfig.password})
      try{const [rows]=await targetDb.query<mysql.RowDataPacket[]>('SELECT count(*) AS n,sum(amount) AS total FROM entries');expect(Number(rows[0].n)).toBe(3);expect(Number(rows[0].total)).toBe(7.5)}finally{await targetDb.end()}
    }
    const blocked=await client.callTool({name:'prepare_restore',arguments:{artifactId:backup.artifact_id,targetId:target.id}})
    expect(blocked.isError).toBe(true)
  }finally{await client.close()}
  // Fixture targets are deliberately retained; never auto-drop a possibly useful partial restore.
},180000)
