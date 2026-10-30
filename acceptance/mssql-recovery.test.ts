import {test,expect} from 'bun:test'
import {randomBytes,randomUUID,createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import mssql from 'mssql'
import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'

const recovery=process.env.STEELKEEP_ACCEPTANCE==='synthetic-local-mssql'?test:test.skip
type Job={id:string;status:string;artifact_id:string|null;validation:Record<string,unknown>|null}
type Connection={id:string;name:string;kind:string;config:Record<string,unknown>}
type EntryRow={id:string;project_id:number;amount:string;label:string;payload:string|null;local_time:string;offset_minutes:number}
type ProjectRow={id:number;name:string}
type ColumnRow={name:string;type:string;precision:number;scale:number;max_length:number;is_identity:boolean}
type ConstraintRow={name:string;is_disabled:boolean;is_not_trusted:boolean}
const sqlConfig=(database:string,user:string,password:string):mssql.config=>({server:'127.0.0.1',port:54380,database,user,password,connectionTimeout:10000,requestTimeout:30000,pool:{min:0,max:1},options:{encrypt:false,trustServerCertificate:false}})

recovery('MCP SQL Server: READ_ONLY export → S3 GET/SHA → distinct empty target → exact independent recovery checks',async()=>{
  if(process.env.STEELKEEP_MSSQL_PHYSICAL_X64!=='1'||process.env.STEELKEEP_MSSQL_ACCEPT_EULA!=='Y'||!process.env.STEELKEEP_MSSQL_SA_PASSWORD)throw new Error('Explicit physical Linux x64 fixture/EULA/admin environment required')
  const token=(await readFile('.steelkeep/token','utf8')).trim(),base='http://127.0.0.1:4311'
  const client=new Client({name:'steelkeep-mssql-acceptance',version:'0.1.0'})
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}}))
  async function tool<T>(name:string,args:Record<string,unknown>={}):Promise<T>{const result=await client.callTool({name,arguments:args});if(result.isError)throw new Error(`MCP ${name} returned a tool error`);const block=result.content?.find(item=>item.type==='text');if(!block||block.type!=='text')throw new Error('Expected JSON MCP result');return JSON.parse(block.text) as T}
  async function finished(id:string){const until=Date.now()+240000;while(Date.now()<until){const job=await tool<Job>('get_job',{id});if(['succeeded','failed','cancelled','interrupted'].includes(job.status))return job;await new Promise(resolve=>setTimeout(resolve,250))}throw new Error('SQL Server job deadline exceeded; retain target and inspect result, never replay import')}
  let targetPool:mssql.ConnectionPool|undefined,sourcePool:mssql.ConnectionPool|undefined
  try{
    const connections=await tool<Connection[]>('list_connections'),source=connections.find(row=>row.name==='SQL Server · fixture'&&row.kind==='mssql'&&row.config.database==='fixture_mssql_source'&&!row.config.restoreTarget)
    if(!source)throw new Error('Provision and seed the isolated SQL Server fixture first')
    expect(JSON.stringify(connections)).not.toContain('Local-Mssql-Reader-Only!2026')
    sourcePool=new mssql.ConnectionPool(sqlConfig('fixture_mssql_source','fixture_mssql_reader','Local-Mssql-Reader-Only!2026'));await sourcePool.connect()
    expect((await sourcePool.request().query<{is_read_only:boolean}>('SELECT is_read_only FROM sys.databases WHERE database_id=DB_ID()')).recordset[0].is_read_only).toBe(true)
    const plans=await tool<{id:string;source_id:string}[]>('list_plans'),plan=plans.find(row=>row.source_id===source.id)
    if(!plan)throw new Error('SQL Server fixture plan missing')
    const backupKey=randomUUID(),accepted=await tool<Job>('run_backup',{planId:plan.id,idempotencyKey:backupKey})
    expect((await tool<Job>('run_backup',{planId:plan.id,idempotencyKey:backupKey})).id).toBe(accepted.id)
    const backup=await finished(accepted.id);expect(backup.status).toBe('succeeded');expect(backup.artifact_id).toBeTruthy()
    const artifacts=await tool<{id:string;storage_id:string;object_key:string;size:string;sha256:string;engine:string;tool_version:string}[]>('list_backups'),artifact=artifacts.find(row=>row.id===backup.artifact_id)
    if(!artifact)throw new Error('Published SQL Server artifact missing')
    expect(artifact.engine).toBe('mssql');expect(artifact.object_key.endsWith('.bacpac')).toBe(true);expect(artifact.tool_version).toMatch(/^DacFx 170\./)
    const storage=connections.find(row=>row.id===artifact.storage_id)
    if(storage?.kind!=='s3'||storage.config.bucket!=='steelkeep-mssql-fixture')throw new Error('Refuse independent GET from an unrelated storage profile')
    // Independent full GET and checksum: HEAD metadata alone is not proof.
    const s3=new S3Client({endpoint:'http://127.0.0.1:54373',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'steelkeep-local',secretAccessKey:'local-s3-fixture-only'}})
    try{
      const object=await s3.send(new GetObjectCommand({Bucket:'steelkeep-mssql-fixture',Key:artifact.object_key})),hash=createHash('sha256');let bytes=0
      if(!object.Body)throw new Error('Fixture BACPAC body missing')
      try{for await(const chunk of object.Body as AsyncIterable<Uint8Array>){bytes+=chunk.byteLength;if(bytes>32*1024*1024)throw new Error('Tiny synthetic BACPAC exceeded acceptance bound');hash.update(chunk)}}finally{(object.Body as {destroy?:()=>void}).destroy?.()}
      expect(String(bytes)).toBe(artifact.size);expect(hash.digest('hex')).toBe(artifact.sha256);expect(bytes).toBeGreaterThan(0)
    }finally{s3.destroy()}
    // Only the fixture owner provisions a fresh target. Never DROP/REPLACE.
    const suffix=randomBytes(6).toString('hex'),database='recovery_mssql_'+suffix,user='restore_'+suffix,password='Fixture!Aa1'+randomBytes(20).toString('hex')
    const admin=new mssql.ConnectionPool(sqlConfig('master','sa',process.env.STEELKEEP_MSSQL_SA_PASSWORD!))
    try{await admin.connect();await admin.request().batch(`CREATE DATABASE ${database}`);await admin.request().batch(`CREATE LOGIN ${user} WITH PASSWORD='${password}',CHECK_POLICY=ON`);await admin.request().batch(`USE ${database}; CREATE USER ${user} FOR LOGIN ${user}; ALTER ROLE db_owner ADD MEMBER ${user};`)}finally{await admin.close()}
    targetPool=new mssql.ConnectionPool(sqlConfig(database,user,password));await targetPool.connect()
    expect([...(await targetPool.request().query<{permission_name:string}>("SELECT permission_name FROM sys.fn_my_permissions(NULL,'SERVER') WHERE permission_name NOT IN ('CONNECT SQL','VIEW ANY DATABASE')")).recordset]).toEqual([])
    expect((await targetPool.request().query<{n:number}>("SELECT COUNT(*) AS n FROM sys.objects WHERE is_ms_shipped=0")).recordset[0].n).toBe(0)
    const target=await tool<{id:string}>('create_connection',{connection:{name:'SQL Server acceptance '+suffix,kind:'mssql',host:'mssql-fixture',port:1433,database,user,password,tls:false,restoreTarget:true}})
    expect((await tool<{status:string}>('test_connection',{id:target.id})).status).toBe('available')
    expect((await client.callTool({name:'prepare_restore',arguments:{artifactId:artifact.id,targetId:source.id}})).isError).toBe(true)
    const prepared=await tool<{intentId:string;review:{sourceDatabase:string;targetDatabase:string}}>('prepare_restore',{artifactId:artifact.id,targetId:target.id})
    expect(prepared.review.sourceDatabase).toBe('fixture_mssql_source');expect(prepared.review.targetDatabase).toBe(database)
    const key=randomUUID(),started=await tool<Job>('start_restore',{intentId:prepared.intentId,idempotencyKey:key})
    expect((await tool<Job>('start_restore',{intentId:prepared.intentId,idempotencyKey:key})).id).toBe(started.id)
    const completed=await finished(started.id);expect(completed.status).toBe('succeeded');expect(completed.validation?.status).toBe('passed');expect(completed.validation?.integrity).toBe('sha256-matched');expect(completed.validation?.restore).toBe('completed')
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
  }finally{await targetPool?.close();await sourcePool?.close();await client.close()}
  // Retain all databases/logins, including partial imports; never DROP on failure.
},300000)
