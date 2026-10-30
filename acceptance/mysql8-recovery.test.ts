import {test,expect} from 'bun:test'
import {randomUUID,randomBytes,createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {resolve,dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import mysql,{type Connection as MySQL,type RowDataPacket,type ResultSetHeader} from 'mysql2/promise'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'
import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3'

// Never part of the default test command. This source has not been executed.
// STEELKEEP_ACCEPTANCE=synthetic-local-mysql bun test acceptance/mysql8-recovery.test.ts
const recovery=process.env.STEELKEEP_ACCEPTANCE==='synthetic-local-mysql'?test:test.skip
const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'..'),base='http://127.0.0.1:4311'
type Job={id:string;status:string;artifact_id:string|null;error_code:string|null;validation:Record<string,unknown>|null;events?:Array<{phase:string;message:string}>}
type Connection={id:string;name:string;kind:string;config:Record<string,unknown>}
type Artifact={id:string;engine:string;object_key:string;size:string;sha256:string;tool_version:string;server_version:string;availability:string}
const rowProjection="CAST(id AS CHAR) AS id,CAST(project_id AS CHAR) AS project_id,CAST(external_id AS CHAR) AS external_id,body,CAST(amount AS CHAR) AS amount,HEX(binary_value) AS bytes,optional_text,CAST(payload AS CHAR CHARACTER SET utf8mb4) AS json_text,DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f') AS created_at"

async function mysqlConnection(database:string,user:string,password:string){
  let client:MySQL
  try{client=await mysql.createConnection({host:'127.0.0.1',port:54379,database,user,password,connectTimeout:5000,supportBigNumbers:true,bigNumberStrings:true,dateStrings:true,multipleStatements:false,charset:'utf8mb4'})}
  catch{throw new Error('Cannot connect to the explicit loopback MySQL 8 fixture; connection credentials are omitted.')}
  try{
    await client.query("SET time_zone='+00:00'")
    await client.query('SET SESSION information_schema_stats_expiry=0')
    const [version]=await client.query<RowDataPacket[]>('SELECT VERSION() AS version,@@version_comment AS vendor')
    if(!/^8\.0\.46(?:\D|$)/.test(String(version[0].version))||/mariadb/i.test(String(version[0].version)+' '+String(version[0].vendor)))throw new Error('This acceptance profile requires actual MySQL 8.0.46; MariaDB is not an interchangeable fixture.')
    return client
  }catch(error){await client.end();throw error}
}
async function rows(client:MySQL){
  const [values]=await client.query<RowDataPacket[]>(`SELECT ${rowProjection} FROM entries ORDER BY id`)
  return values.map(row=>({...row}))
}
async function schemas(client:MySQL){
  const [projects]=await client.query<RowDataPacket[]>('SHOW CREATE TABLE projects')
  const [entries]=await client.query<RowDataPacket[]>('SHOW CREATE TABLE entries')
  return {projects:projects[0]['Create Table'],entries:entries[0]['Create Table']}
}
async function newTarget(admin:MySQL,occupied=false){
  const suffix=randomBytes(6).toString('hex'),database='restore_mysql8_'+suffix,user='restore_m8_'+suffix,password=randomBytes(24).toString('hex')
  // Only generated identifiers/hex passwords are interpolated by this owner
  // harness. No caller-controlled SQL is accepted, and partial targets remain.
  const [mode]=await admin.query<RowDataPacket[]>("SHOW GLOBAL VARIABLES LIKE 'partial_revokes'")
  if(mode.length!==1||!['ON','OFF'].includes(String(mode[0].Value)))throw new Error('Cannot verify fixture privilege wildcard mode.')
  const grantDatabase=mode[0].Value==='ON'?database:database.replace(/[%_]/g,'\\$&')
  try{
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`)
    await admin.query(`CREATE USER '${user}'@'%' IDENTIFIED WITH caching_sha2_password BY '${password}'`)
    await admin.query(`GRANT SELECT, INSERT, CREATE, ALTER, INDEX, REFERENCES, SHOW VIEW, TRIGGER, EVENT, EXECUTE, LOCK TABLES ON \`${grantDatabase}\`.* TO '${user}'@'%'`)
    if(occupied){
      await admin.query(`CREATE TABLE \`${database}\`.safety_keep(value VARCHAR(40) NOT NULL) ENGINE=InnoDB`)
      await admin.query(`INSERT INTO \`${database}\`.safety_keep(value) VALUES('keep-me')`)
    }
  }catch{throw new Error('Synthetic MySQL target provisioning failed; generated credentials are omitted and any partial resources are retained.')}
  return {name:'MySQL 8 acceptance '+suffix,kind:'mysql',host:'mysql8-fixture',port:3306,database,user,password,tls:false,restoreTarget:true}
}

recovery('MySQL 8.0.46 MCP: real native backup/S3/restore with independent decimal, Unicode, binary, JSON, schema and identity checks',async()=>{
  const token=(await readFile(join(workspace,'.steelkeep','token'),'utf8')).trim()
  if(token.length<32)throw new Error('Prepare the isolated installation token before MySQL acceptance.')
  const client=new Client({name:'steelkeep-mysql8-acceptance',version:'0.1.0'})
  let admin:MySQL|undefined,targetDb:MySQL|undefined
  function output(result:Awaited<ReturnType<Client['callTool']>>):unknown{
    const structured=result.structuredContent as {data?:unknown}|undefined
    if(structured&&'data' in structured)return structured.data
    const block=result.content?.find(content=>content.type==='text')
    if(!block||block.type!=='text')throw new Error('Expected structured output from the official MCP client.')
    return JSON.parse(block.text)
  }
  async function tool<T>(name:string,args:Record<string,unknown>={}):Promise<T>{
    const result=await client.callTool({name,arguments:args})
    if(result.isError)throw new Error(`MCP ${name} refused the synthetic operation; inspect the safe durable job separately.`)
    return output(result) as T
  }
  async function rejected(name:string,args:Record<string,unknown>){
    const result=await client.callTool({name,arguments:args})
    expect(result.isError===true).toBe(true)
    return output(result) as {error:{code:string}}
  }
  async function post<T>(path:string,body:unknown):Promise<T>{
    const response=await fetch(base+'/api/v1'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)})
    if(!response.ok)throw new Error(`MySQL acceptance API ${path} failed (${response.status}); credentials are omitted.`)
    return response.json() as Promise<T>
  }
  async function completed(id:string){
    const deadline=Date.now()+120000
    while(Date.now()<deadline){
      const job=await tool<Job>('get_job',{id})
      if(['succeeded','failed','cancelled','interrupted'].includes(job.status)){
        if(job.status!=='succeeded')throw new Error(`MySQL durable operation ended ${job.status} (${job.error_code??'no-code'}). This is not accepted recovery.`)
        expect(JSON.stringify(job).includes(token)).toBe(false)
        return job
      }
      await new Promise(resolve=>setTimeout(resolve,250))
    }
    throw new Error('MySQL fixture operation exceeded its acceptance deadline; no source or target was reset.')
  }
  async function rejectedInsert(sql:string,parameters:Array<string|Buffer>,expectedCode:string|readonly string[]){
    let code=''
    try{await targetDb!.execute(sql,parameters)}catch(error){code=String((error as {code?:unknown}).code??'')}
    expect(typeof expectedCode==='string'?[expectedCode]:expectedCode).toContain(code)
  }
  try{
    admin=await mysqlConnection('source_mysql8','root','local-mysql8-admin-only')
    const before=await rows(admin),beforeSchema=await schemas(admin)
    expect(before.length).toBe(3)
    expect(before[0].external_id).toBe('9007199254740993')
    expect(before[1].external_id).toBe('18446744073709551615')
    expect(before[1].body).toBe('Русский текст, café, 🚀')
    expect(before[0].bytes).toBe('00FF7F0041')
    expect((JSON.parse(String(before[0].json_text)) as {nested:{active:boolean}}).nested.active).toBe(true)
    const [totals]=await admin.query<RowDataPacket[]>('SELECT CAST(SUM(amount) AS CHAR) AS total FROM entries')
    expect(totals[0].total).toBe('123456792.8750')
    const [sourceCounter]=await admin.query<RowDataPacket[]>("SELECT CAST(AUTO_INCREMENT AS CHAR) AS next_value FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='projects'")
    expect(sourceCounter[0].next_value).toBe('51')
    await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}}))
    const tools=await client.listTools();expect(tools.tools.some(tool=>tool.name==='get_job')).toBe(true)
    const capabilities=await tool<{engines:string[]}>('get_capabilities')
    expect(capabilities.engines.includes('mysql')).toBe(true)
    const connections=await tool<Connection[]>('list_connections')
    expect(JSON.stringify(connections).includes('local-mysql8-reader-only')).toBe(false)
    expect(JSON.stringify(connections).includes(token)).toBe(false)
    const source=connections.find(row=>row.name==='MySQL 8 · independent fixture'&&row.kind==='mysql'&&row.config.host==='mysql8-fixture'&&row.config.port===3306&&row.config.database==='source_mysql8'&&row.config.user==='backup_reader'&&row.config.tls===false&&row.config.restoreTarget===false&&row.config.allowGlobalReadLock===true)
    const storage=connections.find(row=>row.name==='Local S3 · RustFS'&&row.kind==='s3'&&row.config.endpoint==='http://s3:9000'&&row.config.bucket==='steelkeep-fixture')
    if(!source||!storage)throw new Error('Guarded MySQL seed and the exact local RustFS fixture are required. No arbitrary source or remote storage is selected.')
    const plans=await tool<Array<{id:string;name:string;source_id:string;storage_id:string}>>('list_plans')
    const plan=plans.find(plan=>plan.name==='MySQL 8 independent fixture'&&plan.source_id===source.id&&plan.storage_id===storage.id)
    if(!plan)throw new Error('The independently configured synthetic MySQL plan is missing.')
    const backupKey=randomUUID(),accepted=await tool<Job>('run_backup',{planId:plan.id,idempotencyKey:backupKey})
    expect((await tool<Job>('run_backup',{planId:plan.id,idempotencyKey:backupKey})).id).toBe(accepted.id)
    const backup=await completed(accepted.id)
    expect(backup.validation).toBe(null)
    const artifacts=await tool<Artifact[]>('list_backups'),artifact=artifacts.find(row=>row.id===backup.artifact_id)
    if(!artifact||artifact.engine!=='mysql'||artifact.availability!=='present')throw new Error('Native MySQL backup did not publish an available artifact.')
    expect(/\b8\.0\.46\b/.test(artifact.tool_version)).toBe(true)
    expect(/mariadb/i.test(artifact.tool_version)).toBe(false)
    expect(/^8\.0\.46(?:\D|$)/.test(artifact.server_version)).toBe(true)
    expect(/^[a-f0-9]{64}$/.test(artifact.sha256)).toBe(true)
    if(Number(artifact.size)<=0||Number(artifact.size)>4*1024*1024)throw new Error('The small synthetic MySQL archive has an unexpected size.')
    const s3=new S3Client({endpoint:'http://127.0.0.1:54373',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'steelkeep-local',secretAccessKey:'local-s3-fixture-only'}})
    try{
      const object=await s3.send(new GetObjectCommand({Bucket:'steelkeep-fixture',Key:artifact.object_key}),{abortSignal:AbortSignal.timeout(30000)})
      if(!object.Body||object.ContentLength!==Number(artifact.size))throw new Error('Actual local S3 object size differs from its published metadata.')
      const body=await object.Body.transformToByteArray()
      expect(body.length).toBe(Number(artifact.size))
      expect(createHash('sha256').update(body).digest('hex')).toBe(artifact.sha256)
      const sql=new TextDecoder().decode(body)
      expect(/^-- MySQL dump\b/m.test(sql)).toBe(true)
      expect(/^\s*(?:CREATE|DROP)\s+DATABASE\b/im.test(sql)).toBe(false)
      expect(/^\s*DROP\s+TABLE\b/im.test(sql)).toBe(false)
      expect(/^\s*USE\s+/im.test(sql)).toBe(false)
    }finally{s3.destroy()}
    const targetConfig=await newTarget(admin),target=await post<{id:string}>('/connections',targetConfig)
    targetDb=await mysqlConnection(targetConfig.database,targetConfig.user,targetConfig.password)
    const [grants]=await targetDb.query<RowDataPacket[]>('SHOW GRANTS FOR CURRENT_USER()')
    const [mode]=await targetDb.query<RowDataPacket[]>("SHOW GLOBAL VARIABLES LIKE 'partial_revokes'")
    expect(mode.length).toBe(1)
    expect(['ON','OFF'].includes(String(mode[0].Value))).toBe(true)
    const grantDatabase=mode[0].Value==='ON'?targetConfig.database:targetConfig.database.replace(/[%_]/g,'\\$&')
    expect(grants.every(row=>{
      const grant=String(Object.values(row)[0])
      return !/\bDROP\b|WITH GRANT OPTION/i.test(grant)&&(/^GRANT USAGE ON \*\.\* TO /.test(grant)||grant.match(/^GRANT [A-Z ,]+ ON (`(?:``|[^`])+`\.\*) TO /)?.[1]==='`'+grantDatabase+'`.*')
    })).toBe(true)
    const prepared=await tool<{intentId:string;review:{sourceDatabase:string;targetDatabase:string;checks:Record<string,boolean>}}>('prepare_restore',{artifactId:artifact.id,targetId:target.id})
    expect(prepared.review.sourceDatabase).toBe('source_mysql8')
    expect(prepared.review.targetDatabase).toBe(targetConfig.database)
    expect(Object.values(prepared.review.checks).every(Boolean)).toBe(true)
    expect((await rejected('start_restore',{intentId:prepared.intentId,idempotencyKey:backupKey})).error.code).toBe('IDEMPOTENCY_CONFLICT')
    const restoreKey=randomUUID(),restore=await tool<Job>('start_restore',{intentId:prepared.intentId,idempotencyKey:restoreKey})
    expect((await tool<Job>('start_restore',{intentId:prepared.intentId,idempotencyKey:restoreKey})).id).toBe(restore.id)
    const restored=await completed(restore.id)
    expect(restored.validation?.restore).toBe('completed')
    expect(restored.validation?.integrity).toBe('sha256-matched')
    expect(restored.validation?.status).toBe('passed')
    expect(/\b8\.0\.46\b/.test(String(restored.validation?.toolVersion))).toBe(true)
    expect(/mariadb/i.test(String(restored.validation?.toolVersion))).toBe(false)
    // Independent actual reads and writes use mysql2 directly, not app manifests.
    expect(await rows(targetDb)).toEqual(before)
    expect(await schemas(targetDb)).toEqual(beforeSchema)
    const [jsonType]=await targetDb.query<RowDataPacket[]>("SELECT DATA_TYPE AS kind FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='entries' AND column_name='payload'")
    expect(jsonType[0].kind).toBe('json')
    const [index]=await targetDb.query<RowDataPacket[]>("SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS columns_in_order FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='entries' AND index_name='entries_project_created'")
    expect(index[0].columns_in_order).toBe('project_id,created_at')
    const [next]=await targetDb.execute<ResultSetHeader>('INSERT INTO projects(name) VALUES(?)',['Recovered fixture '+randomUUID()])
    expect(Number(next.insertId)).toBe(51)
    await rejectedInsert('INSERT INTO projects(name) VALUES(?)',['Synthetic MySQL 8 fixture'],'ER_DUP_ENTRY')
    const insert='INSERT INTO entries(project_id,external_id,body,amount,binary_value,payload,created_at) VALUES(?,?,?,?,?,?,?)'
    await rejectedInsert(insert,['999999','42','Synthetic invalid FK','1.0000',Buffer.from([0]),JSON.stringify({label:'negative-fixture'}),'2026-01-01 00:00:00.000000'],['ER_NO_REFERENCED_ROW','ER_NO_REFERENCED_ROW_2'])
    await rejectedInsert(insert,['1','43','Synthetic invalid CHECK','-1.0000',Buffer.from([0]),JSON.stringify({label:'negative-fixture'}),'2026-01-01 00:00:00.000000'],'ER_CHECK_CONSTRAINT_VIOLATED')
    await rejectedInsert(insert,['1','44','Synthetic invalid JSON shape','1.0000',Buffer.from([0]),JSON.stringify(['not-an-object']),'2026-01-01 00:00:00.000000'],'ER_CHECK_CONSTRAINT_VIOLATED')
    expect(await rows(admin)).toEqual(before)
    expect(await schemas(admin)).toEqual(beforeSchema)
    expect((await rejected('start_restore',{intentId:prepared.intentId,idempotencyKey:randomUUID()})).error.code).toBe('RESTORE_REVIEW_CONSUMED')
    expect((await rejected('prepare_restore',{artifactId:artifact.id,targetId:target.id})).error.code).toBe('TARGET_BLOCKED')
    const occupied=await newTarget(admin,true),occupiedConnection=await post<{id:string}>('/connections',occupied)
    expect((await rejected('prepare_restore',{artifactId:artifact.id,targetId:occupiedConnection.id})).error.code).toBe('TARGET_NOT_EMPTY')
    const [kept]=await admin.query<RowDataPacket[]>(`SELECT value FROM \`${occupied.database}\`.safety_keep`)
    expect(kept[0].value).toBe('keep-me')
    const alias=await post<{id:string}>('/connections',{name:'MySQL forbidden source alias '+randomUUID(),kind:'mysql',host:'mysql8-fixture',port:3306,database:'source_mysql8',user:'backup_reader',password:'local-mysql8-reader-only',tls:false,restoreTarget:true})
    expect((await rejected('prepare_restore',{artifactId:artifact.id,targetId:alias.id})).error.code).toBe('SOURCE_TARGET_CONFLICT')
    const privileged=await newTarget(admin),privilegedConnection=await post<{id:string}>('/connections',{...privileged,name:'MySQL forbidden root '+randomUUID(),user:'root',password:'local-mysql8-admin-only'})
    expect((await rejected('prepare_restore',{artifactId:artifact.id,targetId:privilegedConnection.id})).error.code).toBe('UNSAFE_TARGET_ROLE')
    expect(await rows(admin)).toEqual(before)
  }finally{await targetDb?.end();await admin?.end();await client.close()}
  // All databases/users/partial targets remain for operator review. No DROP/reset.
},300000)
