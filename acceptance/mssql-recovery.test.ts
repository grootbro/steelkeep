import {test,expect} from 'bun:test'
import {randomBytes,randomUUID,createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {writeFile} from 'node:fs/promises'
import mssql from 'mssql'
import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'
import {mssqlProof,sqlConfig,guardMssqlMetadata,guardMssqlServer,proofMetadata} from '../scripts/seed-mssql-fixture'

const recovery=['synthetic-local-mssql','synthetic-remote-mssql'].includes(process.env.STEELKEEP_ACCEPTANCE??'')?test:test.skip
type Job={id:string;status:string;artifact_id:string|null;validation:Record<string,unknown>|null;error_code:string|null}
type Connection={id:string;name:string;kind:string;config:Record<string,unknown>}
type EntryRow={id:string;project_id:number;amount:string;label:string;payload:string|null;local_time:string;offset_minutes:number}
type ProjectRow={id:number;name:string}
type ColumnRow={name:string;type:string;precision:number;scale:number;max_length:number;is_identity:boolean}
type ConstraintRow={name:string;is_disabled:boolean;is_not_trusted:boolean}

recovery('MCP SQL Server: READ_ONLY export → S3 GET/SHA → distinct empty target → exact independent recovery checks',async()=>{
  const proof=await mssqlProof(),token=proof.token,base=proof.base
  await guardMssqlMetadata(proof,'recovery')
  const client=new Client({name:'steelkeep-mssql-acceptance',version:'0.1.0'})
  async function tool<T>(name:string,args:Record<string,unknown>={}):Promise<T>{
    const result=await client.callTool({name,arguments:args});if(result.isError)throw new Error('SQL Server MCP command returned a safe tool error.')
    const structured=result.structuredContent as {data?:unknown}|undefined,block=result.content?.find(item=>item.type==='text')
    const value=structured&&'data' in structured?structured.data:block?.type==='text'?JSON.parse(block.text):undefined
    if(value===undefined)throw new Error('Expected structured JSON MCP output.')
    expect(JSON.stringify(value).includes(token)).toBe(false);return value as T
  }
  let stage='preflight'
  const publicResult:Record<string,unknown>={proof:'mssql-native',status:'preflight'},resultPath='/run/steelkeep/proof-result.json'
  async function record(values:Record<string,unknown>){Object.assign(publicResult,values);if(proof.remote)await writeFile(resultPath,JSON.stringify(publicResult,null,2)+'\n',{mode:0o600})}
  async function finished(id:string){const until=Date.now()+240000;while(Date.now()<until){const job=await tool<Job>('get_job',{id});if(['succeeded','failed','cancelled','interrupted'].includes(job.status)){if(job.status!=='succeeded'){stage+='-'+job.status+(/^[A-Z0-9_]{1,60}$/.test(job.error_code??'')?'-'+job.error_code:'');throw new Error('Native SQL Server operation did not succeed.')}return job}await new Promise(resolve=>setTimeout(resolve,250))}throw new Error('SQL Server job deadline exceeded; retain target and inspect result, never replay import')}
  let targetPool:mssql.ConnectionPool|undefined,sourcePool:mssql.ConnectionPool|undefined
  try{
    const inspector=new mssql.ConnectionPool(sqlConfig(proof,'master','sa',proof.adminPassword));inspector.on('error',()=>{})
    try{await inspector.connect();await guardMssqlServer(proof,inspector,'recovery')}finally{await inspector.close().catch(()=>{})}
    if(proof.remote)await writeFile(resultPath,JSON.stringify(publicResult,null,2)+'\n',{mode:0o600,flag:'wx'})
    await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}}))
    const connections=await tool<Connection[]>('list_connections'),source=connections.find(row=>row.name==='SQL Server · fixture'&&row.kind==='mssql'&&row.config.database==='fixture_mssql_source'&&!row.config.restoreTarget)
    if(!source||source.config.host!=='mssql-fixture'||source.config.port!==1433||source.config.user!=='fixture_mssql_reader'||source.config.tls!==false)throw new Error('Provision and seed the exact isolated SQL Server fixture first.')
    const persisted=await proofMetadata(proof,'SELECT id,kind,config FROM connections')
    if(persisted.length!==connections.length||connections.some(row=>!persisted.some(saved=>saved.id===row.id&&saved.kind===row.kind&&isDeepStrictEqual(saved.config,row.config))))throw new Error('MCP profiles do not correlate with the inspected synthetic metadata; no backup is allowed.')
    expect(JSON.stringify(connections)).not.toContain('Local-Mssql-Reader-Only!2026')
    sourcePool=new mssql.ConnectionPool(sqlConfig(proof,'fixture_mssql_source','fixture_mssql_reader','Local-Mssql-Reader-Only!2026'));sourcePool.on('error',()=>{});await sourcePool.connect()
    expect((await sourcePool.request().query<{is_read_only:boolean}>('SELECT is_read_only FROM sys.databases WHERE database_id=DB_ID()')).recordset[0].is_read_only).toBe(true)
    expect([...(await sourcePool.request().query<{name:string}>("SELECT SCHEMA_NAME(schema_id)+'.'+name AS name FROM sys.tables WHERE is_ms_shipped=0 ORDER BY name")).recordset]).toEqual([{name:'dbo.entries'},{name:'dbo.projects'}])
    expect((await sourcePool.request().query<{projects:number;entries:number}>('SELECT (SELECT count(*) FROM dbo.projects) AS projects,(SELECT count(*) FROM dbo.entries) AS entries')).recordset[0]).toMatchObject({projects:2,entries:3})
    const plans=await tool<{id:string;source_id:string;storage_id:string}[]>('list_plans'),plan=plans.find(row=>row.source_id===source.id)
    if(!plan)throw new Error('SQL Server fixture plan missing')
    const storedPlan=await proofMetadata(proof,'SELECT id FROM plans WHERE id=$1 AND source_id=$2 AND storage_id=$3',[plan.id,source.id,plan.storage_id])
    if(storedPlan.length!==1||proof.remote&&plans.length!==1)throw new Error('MCP plan does not correlate with the dedicated synthetic metadata.')
    stage='native-export'
    const backupKey=randomUUID(),accepted=await tool<Job>('run_backup',{planId:plan.id,idempotencyKey:backupKey})
    await record({planId:plan.id,sourceId:source.id,storageId:plan.storage_id,backupRunId:accepted.id,status:'export-started'})
    expect((await tool<Job>('run_backup',{planId:plan.id,idempotencyKey:backupKey})).id).toBe(accepted.id)
    const backup=await finished(accepted.id);expect(backup.status).toBe('succeeded');expect(backup.artifact_id).toBeTruthy()
    const artifacts=await tool<{id:string;storage_id:string;object_key:string;size:string;sha256:string;engine:string;tool_version:string}[]>('list_backups'),artifact=artifacts.find(row=>row.id===backup.artifact_id)
    if(!artifact)throw new Error('Published SQL Server artifact missing')
    await record({artifactId:artifact.id,objectKey:artifact.object_key,size:artifact.size,sha256:artifact.sha256,status:'export-succeeded'})
    const storedArtifact=await proofMetadata(proof,'SELECT id FROM artifacts WHERE id=$1 AND run_id=$2 AND source_id=$3 AND storage_id=$4 AND object_key=$5 AND sha256=$6',[artifact.id,backup.id,source.id,artifact.storage_id,artifact.object_key,artifact.sha256])
    expect(storedArtifact.length).toBe(1)
    expect(artifact.engine).toBe('mssql');expect(artifact.object_key.endsWith('.bacpac')).toBe(true);expect(artifact.tool_version).toMatch(/^DacFx 170\./)
    const storage=connections.find(row=>row.id===artifact.storage_id)
    if(storage?.kind!=='s3'||storage.id!==plan.storage_id||storage.config.endpoint!=='http://s3:9000'||storage.config.bucket!=='steelkeep-mssql-fixture')throw new Error('Refuse independent GET from an unrelated storage profile')
    // Independent full GET and checksum: HEAD metadata alone is not proof.
    stage='independent-s3-get'
    const s3=new S3Client({endpoint:proof.s3Endpoint,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'steelkeep-local',secretAccessKey:'local-s3-fixture-only'}})
    try{
      const object=await s3.send(new GetObjectCommand({Bucket:'steelkeep-mssql-fixture',Key:artifact.object_key}),{abortSignal:AbortSignal.timeout(30000)}),hash=createHash('sha256'),header:number[]=[];let bytes=0
      if(!object.Body)throw new Error('Fixture BACPAC body missing')
      try{for await(const chunk of object.Body as AsyncIterable<Uint8Array>){bytes+=chunk.byteLength;if(bytes>32*1024*1024)throw new Error('Tiny synthetic BACPAC exceeded acceptance bound');for(let i=0;i<chunk.byteLength&&header.length<4;i++)header.push(chunk[i]);hash.update(chunk)}}finally{(object.Body as {destroy?:()=>void}).destroy?.()}
      expect(String(bytes)).toBe(artifact.size);expect(hash.digest('hex')).toBe(artifact.sha256);expect(bytes).toBeGreaterThan(0)
      expect(Buffer.from(header).toString('hex')).toBe('504b0304')
    }finally{s3.destroy()}
    // Only the fixture owner provisions a fresh target. Never DROP/REPLACE.
    stage='fresh-target-provision'
    const suffix=randomBytes(6).toString('hex'),database='recovery_mssql_'+suffix,user='restore_'+suffix,password='Fixture!Aa1'+randomBytes(20).toString('hex')
    await record({targetDatabase:database,targetLogin:user,status:'target-provisioning'})
    console.info(JSON.stringify({proof:'mssql-native',targetDatabase:database,targetLogin:user,status:'provisioning',resources:'retained'}))
    const admin=new mssql.ConnectionPool(sqlConfig(proof,'master','sa',proof.adminPassword));admin.on('error',()=>{})
    try{await admin.connect();await admin.request().batch(`CREATE DATABASE ${database}`);await admin.request().batch(`CREATE LOGIN ${user} WITH PASSWORD='${password}',CHECK_POLICY=ON`);await admin.request().batch(`USE ${database}; CREATE USER ${user} FOR LOGIN ${user}; ALTER ROLE db_owner ADD MEMBER ${user};`)}finally{await admin.close()}
    targetPool=new mssql.ConnectionPool(sqlConfig(proof,database,user,password));targetPool.on('error',()=>{});await targetPool.connect()
    expect([...(await targetPool.request().query<{permission_name:string}>("SELECT permission_name FROM sys.fn_my_permissions(NULL,'SERVER') WHERE permission_name NOT IN ('CONNECT SQL','VIEW ANY DATABASE')")).recordset]).toEqual([])
    expect((await targetPool.request().query<{n:number}>("SELECT COUNT(*) AS n FROM sys.objects WHERE is_ms_shipped=0")).recordset[0].n).toBe(0)
    const target=await tool<{id:string}>('create_connection',{connection:{name:'SQL Server acceptance '+suffix,kind:'mssql',host:'mssql-fixture',port:1433,database,user,password,tls:false,restoreTarget:true}})
    await record({targetId:target.id,status:'target-prepared'})
    const savedTarget=await proofMetadata(proof,"SELECT id FROM connections WHERE id=$1 AND kind='mssql' AND config->>'host'='mssql-fixture' AND config->>'database'=$2 AND config->>'user'=$3 AND config->>'restoreTarget'='true'",[target.id,database,user])
    expect(savedTarget.length).toBe(1)
    expect((await tool<{status:string}>('test_connection',{id:target.id})).status).toBe('available')
    expect((await client.callTool({name:'prepare_restore',arguments:{artifactId:artifact.id,targetId:source.id}})).isError).toBe(true)
    const prepared=await tool<{intentId:string;review:{sourceDatabase:string;targetDatabase:string}}>('prepare_restore',{artifactId:artifact.id,targetId:target.id})
    expect(prepared.review.sourceDatabase).toBe('fixture_mssql_source');expect(prepared.review.targetDatabase).toBe(database)
    stage='native-import'
    const key=randomUUID(),started=await tool<Job>('start_restore',{intentId:prepared.intentId,idempotencyKey:key})
    await record({restoreRunId:started.id,status:'import-started'})
    expect((await tool<Job>('start_restore',{intentId:prepared.intentId,idempotencyKey:key})).id).toBe(started.id)
    const completed=await finished(started.id);expect(completed.status).toBe('succeeded');expect(completed.validation?.status).toBe('passed');expect(completed.validation?.integrity).toBe('sha256-matched');expect(completed.validation?.restore).toBe('completed')
    stage='independent-sql-validation'
    const dataSql=`SELECT CONVERT(varchar(30),id) AS id,project_id,CONVERT(varchar(40),amount) AS amount,label,CASE WHEN payload IS NULL THEN NULL ELSE CONVERT(varchar(40),payload,2) END AS payload,CONVERT(varchar(40),CAST(recorded AS datetime2(7)),126) AS local_time,DATEPART(TZOFFSET,recorded) AS offset_minutes FROM dbo.entries ORDER BY id`
    const expected=[
      {id:'100',project_id:10,amount:'12.3400',label:'Юникод 🦊',payload:'0001FF',local_time:'2026-01-02T03:04:05.1234567',offset_minutes:330},
      {id:'110',project_id:15,amount:'0.0001',label:'Null binary',payload:null,local_time:'2026-02-03T04:05:06.7654321',offset_minutes:-240},
      {id:'120',project_id:10,amount:'900719925474.0993',label:'Exact decimal',payload:'',local_time:'2026-03-04T05:06:07.1111111',offset_minutes:0}
    ]
    expect([...(await targetPool.request().query<EntryRow>(dataSql)).recordset]).toEqual(expected);expect([...(await sourcePool.request().query<EntryRow>(dataSql)).recordset]).toEqual(expected)
    expect([...(await targetPool.request().query<ProjectRow>('SELECT id,name FROM dbo.projects ORDER BY id')).recordset]).toEqual([{id:10,name:'Первый'},{id:15,name:'Second'}])
    expect([...(await targetPool.request().query<ColumnRow>("SELECT c.name,t.name AS type,c.precision,c.scale,c.max_length,c.is_identity FROM sys.columns c JOIN sys.types t ON t.user_type_id=c.user_type_id WHERE c.object_id=OBJECT_ID('dbo.entries') ORDER BY c.column_id")).recordset]).toEqual([
      {name:'id',type:'bigint',precision:19,scale:0,max_length:8,is_identity:true},
      {name:'project_id',type:'int',precision:10,scale:0,max_length:4,is_identity:false},
      {name:'amount',type:'decimal',precision:20,scale:4,max_length:13,is_identity:false},
      {name:'label',type:'nvarchar',precision:0,scale:0,max_length:200,is_identity:false},
      {name:'payload',type:'varbinary',precision:0,scale:0,max_length:16,is_identity:false},
      {name:'recorded',type:'datetimeoffset',precision:34,scale:7,max_length:10,is_identity:false}
    ])
    expect([...(await targetPool.request().query<ConstraintRow>("SELECT name,is_disabled,is_not_trusted FROM sys.foreign_keys UNION ALL SELECT name,is_disabled,is_not_trusted FROM sys.check_constraints ORDER BY name")).recordset]).toEqual([{name:'CK_entries_amount',is_disabled:false,is_not_trusted:false},{name:'FK_entries_projects',is_disabled:false,is_not_trusted:false}])
    expect([...(await targetPool.request().query<{name:string}>("SELECT name FROM sys.indexes WHERE object_id=OBJECT_ID('dbo.entries') AND name='IX_entries_project' AND is_disabled=0")).recordset]).toEqual([{name:'IX_entries_project'}])
    expect((await client.callTool({name:'prepare_restore',arguments:{artifactId:artifact.id,targetId:target.id}})).isError).toBe(true)
    // Test identity and constraints AFTER independent exact recovered-data checks.
    expect((await targetPool.request().query<{id:number}>("INSERT dbo.projects(name) OUTPUT inserted.id VALUES(N'After recovery')")).recordset[0].id).toBe(20)
    expect(String((await targetPool.request().query<{id:string|number}>("INSERT dbo.entries(project_id,amount,label,payload,recorded) OUTPUT inserted.id VALUES(20,1.0000,N'After recovery',0x01,'2026-04-05T06:07:08.1234567+00:00')")).recordset[0].id)).toBe('130')
    async function rejected(sql:string,numbers:number[]){let code:number|undefined;try{await targetPool!.request().query<never>(sql)}catch(error){code=(error as {number?:number}).number}expect(numbers).toContain(code as number)}
    await rejected("INSERT dbo.projects(name) VALUES(N'Первый')",[2601,2627])
    await rejected("INSERT dbo.entries(project_id,amount,label,recorded) VALUES(999999,1,N'Bad FK',SYSDATETIMEOFFSET())",[547])
    await rejected("INSERT dbo.entries(project_id,amount,label,recorded) VALUES(10,-1,N'Bad check',SYSDATETIMEOFFSET())",[547])
    let sourceWrite:number|undefined;try{await sourcePool.request().query<never>("INSERT dbo.projects(name) VALUES(N'Must fail')")}catch(error){sourceWrite=(error as {number?:number}).number}expect(sourceWrite).toBe(3906)
    await record({status:'passed'})
    console.info(JSON.stringify({proof:'mssql-native',backupRunId:backup.id,restoreRunId:completed.id,artifactId:artifact.id,targetId:target.id,targetDatabase:database,targetLogin:user,status:'passed',resources:'retained'}))
  }catch{if(proof.remote&&stage!=='preflight')await record({status:'failed',stage}).catch(()=>{});throw new Error(`SQL Server native proof failed during ${stage}. Retain the isolated project; raw driver details and credentials are omitted.`)}finally{await targetPool?.close().catch(()=>{});await sourcePool?.close().catch(()=>{});await client.close().catch(()=>{})}
  // Retain all databases/logins, including partial imports; never DROP on failure.
},300000)
