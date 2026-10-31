import mssql from 'mssql'
import pg from 'pg'
import {readFile,lstat,realpath} from 'node:fs/promises'
import {S3Client,CreateBucketCommand,HeadBucketCommand} from '@aws-sdk/client-s3'
import {config} from '../server/config'

export type MssqlProof={remote:boolean;base:string;sqlHost:string;sqlPort:number;s3Endpoint:string;metadataUrl:string;token:string;adminPassword:string;nonce?:string;sqlHostname?:string}
export type FixtureConnection={id:string;name:string;kind:string;config:Record<string,unknown>}
const fixtureDatabases=['fixture_mssql_source','fixture_mssql_target'],fixtureLogins=['fixture_mssql_reader','fixture_mssql_writer']
async function privateFile(path:string){
  const file=await lstat(path)
  if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1||(file.mode&0o777)!==0o600||file.size>4096||await realpath(path)!==path)throw new Error('SQL Server proof requires the exact private regular file.')
  return (await readFile(path,'utf8')).trim()
}
export async function mssqlProof():Promise<MssqlProof>{
  const remote=process.env.STEELKEEP_ACCEPTANCE==='synthetic-remote-mssql'
  if(!remote&&process.env.STEELKEEP_ACCEPTANCE!=='synthetic-local-mssql')throw new Error('Explicit synthetic SQL Server acceptance mode required.')
  if(process.platform!=='linux'||process.arch!=='x64'||process.env.STEELKEEP_MSSQL_PHYSICAL_X64!=='1'||process.env.STEELKEEP_MSSQL_ACCEPT_EULA!=='Y')throw new Error('Physical Linux x64 confirmation and operator-provided Microsoft EULA acceptance are required.')
  if(['DEBUG','PWDEBUG','NODE_DEBUG'].some(key=>!!process.env[key]))throw new Error('Disable debug/protocol logs for the private SQL Server proof.')
  const metadataUrl=remote?'postgres://steelkeep:local-metadata-only@metadata:5432/steelkeep_mssql_proof':'postgres://steelkeep:local-metadata-only@127.0.0.1:54371/steelkeep'
  if(process.env.DATABASE_URL!==metadataUrl||process.env.STEELKEEP_DATABASE_PASSWORD_FILE)throw new Error('SQL Server proof requires its exact fixed synthetic metadata configuration.')
  let nonce:string|undefined,sqlHostname:string|undefined
  if(remote){
    nonce=process.env.STEELKEEP_MSSQL_PROOF_NONCE;sqlHostname=process.env.STEELKEEP_MSSQL_PROOF_SQL_HOSTNAME
    if(!nonce||!/^[a-f0-9]{64}$/.test(nonce)||sqlHostname!=='mssql-proof-'+nonce.slice(0,12)||await privateFile('/run/steelkeep/proof-nonce')!==nonce||process.env.STEELKEEP_TOKEN_FILE!=='/run/steelkeep/token')throw new Error('Remote proof nonce, private file and SQL hostname must match the owner-prepared isolated project.')
  }
  const token=remote?await privateFile('/run/steelkeep/token'):process.env.STEELKEEP_TOKEN_FILE?config.token():(await readFile('.steelkeep/token','utf8')).trim()
  if(!/^[a-f0-9]{64}$/.test(token))throw new Error('The synthetic installation token is invalid.')
  if(process.env.STEELKEEP_MSSQL_SA_PASSWORD_FILE&&process.env.STEELKEEP_MSSQL_SA_PASSWORD_FILE!=='/run/steelkeep/mssql-sa-password')throw new Error('Use the exact private synthetic administrator password path.')
  const adminPassword=process.env.STEELKEEP_MSSQL_SA_PASSWORD_FILE==='/run/steelkeep/mssql-sa-password'?await privateFile('/run/steelkeep/mssql-sa-password'):process.env.STEELKEEP_MSSQL_SA_PASSWORD
  if(!adminPassword||adminPassword.length<16||adminPassword.length>128)throw new Error('A strong synthetic fixture administrator password is required.')
  return {remote,metadataUrl,token,adminPassword,nonce,sqlHostname,base:remote?'http://api:4311':'http://127.0.0.1:4311',sqlHost:remote?'mssql-fixture':'127.0.0.1',sqlPort:remote?1433:54380,s3Endpoint:remote?'http://s3:9000':'http://127.0.0.1:54373'}
}
export function sqlConfig(proof:MssqlProof,database:string,user:string,password:string):mssql.config{return {server:proof.sqlHost,port:proof.sqlPort,database,user,password,connectionTimeout:10000,requestTimeout:30000,pool:{min:0,max:1},options:{encrypt:false,trustServerCertificate:false}}}
export async function proofMetadata(proof:MssqlProof,text:string,values:unknown[]=[]){
  const db=new pg.Client({connectionString:proof.metadataUrl,connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000,options:'-c default_transaction_read_only=on'});db.on('error',()=>{})
  try{await db.connect();return (await db.query(text,values)).rows as Array<Record<string,unknown>>}catch{throw new Error('Private synthetic SQL Server metadata inspection failed; driver details are omitted.')}finally{await db.end().catch(()=>{})}
}
export async function guardMssqlMetadata(proof:MssqlProof,phase:'seed'|'recovery'){
  const [identity]=await proofMetadata(proof,"SELECT current_database() AS name,current_user AS actor,current_setting('server_version_num')::int AS version,to_regclass('public.connections')::text AS connections")
  if(identity?.name!==(proof.remote?'steelkeep_mssql_proof':'steelkeep')||identity.actor!=='steelkeep'||Math.floor(Number(identity.version)/10000)!==17||!identity.connections)throw new Error('Migrated synthetic PostgreSQL 17 metadata identity was not established.')
  if(proof.remote){
    const identityRows=await proofMetadata(proof,'SELECT singleton,nonce FROM steelkeep_mssql_proof_identity')
    if(identityRows.length!==1||identityRows[0].singleton!==true||identityRows[0].nonce!==proof.nonce)throw new Error('The dedicated metadata proof marker does not match the private project nonce.')
    const [counts]=await proofMetadata(proof,'SELECT (SELECT count(*) FROM owner_account)::int AS owners,(SELECT count(*) FROM browser_sessions)::int AS sessions,(SELECT count(*) FROM agents)::int AS agents,(SELECT count(*) FROM agent_tokens)::int AS tokens,(SELECT count(*) FROM runs)::int AS runs,(SELECT count(*) FROM artifacts)::int AS artifacts,(SELECT count(*) FROM source_blocks)::int AS source_blocks,(SELECT count(*) FROM target_blocks)::int AS target_blocks,(SELECT count(*) FROM connections)::int AS connections,(SELECT count(*) FROM plans)::int AS plans')
    if(!counts||Object.entries(counts).some(([key,value])=>Number(value)!==(['connections','plans'].includes(key)&&phase==='recovery'?(key==='connections'?3:1):0)))throw new Error('Dedicated SQL Server proof metadata is not fresh; retain existing state instead of replaying.')
    const [pending]=await proofMetadata(proof,'SELECT (SELECT count(*) FROM outbox)::int AS outbox,(SELECT count(*) FROM restore_intents)::int AS intents,(SELECT count(*) FROM schedule_occurrences)::int AS occurrences,(SELECT count(*) FROM audit_events)::int AS audits')
    if(!pending||Number(pending.outbox)!==0||Number(pending.intents)!==0||Number(pending.occurrences)!==0||phase==='seed'&&Number(pending.audits)!==0)throw new Error('Dedicated metadata contains prior operation or audit history; nothing was reset.')
  }else{
    const [owners]=await proofMetadata(proof,'SELECT count(*)::int AS n FROM owner_account')
    if(Number(owners?.n)!==0)throw new Error('Local SQL Server proof refuses metadata with an owner account.')
  }
  for(const row of await proofMetadata(proof,'SELECT id,name,kind,config FROM connections')){
    const c=row.config as Record<string,unknown>
    if(proof.remote){
      if(row.kind==='s3'?c.endpoint!=='http://s3:9000'||c.bucket!=='steelkeep-mssql-fixture':row.kind!=='mssql'||c.host!=='mssql-fixture'||c.port!==1433||!fixtureDatabases.includes(String(c.database))||!fixtureLogins.includes(String(c.user)))throw new Error('Dedicated SQL Server metadata contains an unrelated profile.')
    }else if(row.kind==='s3'?c.endpoint!=='http://s3:9000':!new Set(['fixture','mysql-fixture','mysql8-fixture','mongodb-fixture','redis-fixture','clickhouse-fixture','mssql-fixture']).has(String(c.host))&&!(row.kind==='sqlite'&&String(c.path).startsWith('/var/lib/steelkeep-fixtures/sqlite/')))throw new Error('Local SQL Server metadata contains a non-fixture profile.')
  }
}
export async function guardMssqlServer(proof:MssqlProof,admin:mssql.ConnectionPool,phase:'seed'|'recovery'){
  const identity=(await admin.request().query<{major:number;machine:string;actor:string;os:string}>("SELECT CONVERT(int,SERVERPROPERTY('ProductMajorVersion')) AS major,CONVERT(nvarchar(128),SERVERPROPERTY('MachineName')) AS machine,ORIGINAL_LOGIN() AS actor,(SELECT TOP(1) host_platform FROM sys.dm_os_host_info) AS os")).recordset[0]
  if(!identity||identity.major!==16||identity.actor!=='sa'||identity.os!=='Linux'||proof.remote&&identity.machine!==proof.sqlHostname)throw new Error('The expected isolated Linux SQL Server 2022 fixture identity was not established.')
  const databases=(await admin.request().query<{name:string}>('SELECT name FROM sys.databases WHERE database_id>4')).recordset.map(row=>row.name)
  const logins=(await admin.request().query<{name:string}>("SELECT name FROM sys.sql_logins WHERE name NOT IN ('sa','##MS_PolicyEventProcessingLogin##','##MS_PolicyTsqlExecutionLogin##')")).recordset.map(row=>row.name)
  if(proof.remote){
    const expectedDatabases=phase==='seed'?[]:fixtureDatabases,expectedLogins=phase==='seed'?[]:fixtureLogins
    if(databases.length!==expectedDatabases.length||databases.some(name=>!expectedDatabases.includes(name))||logins.length!==expectedLogins.length||logins.some(name=>!expectedLogins.includes(name)))throw new Error('The dedicated SQL Server has unexpected databases or logins; nothing was replaced.')
  }else if(phase==='seed'&&(databases.some(name=>fixtureDatabases.includes(name))||logins.some(name=>fixtureLogins.includes(name))))throw new Error('The local SQL Server fixture already exists; inspect retained state instead of reseeding.')
}
export async function fixtureApi<T>(proof:MssqlProof,path:string,body?:unknown):Promise<T>{
  let response:Response
  try{response=await fetch(proof.base+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+proof.token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)})}catch{throw new Error('Synthetic SQL Server API request failed; credentials are omitted.')}
  if(!response.ok)throw new Error(`Synthetic SQL Server API command returned ${response.status}; response details are omitted.`)
  return response.json() as Promise<T>
}
async function seed(){
  const proof=await mssqlProof();await guardMssqlMetadata(proof,'seed')
  const existing=await fixtureApi<FixtureConnection[]>(proof,'/connections')
  if(proof.remote?existing.length!==0:existing.some(row=>['SQL Server · fixture','SQL Server recovery · fixture','SQL Server S3 · fixture'].includes(row.name)))throw new Error('SQL Server fixture API is not fresh; no seed mutation was started.')
  if(proof.remote){
    const auth=await fixtureApi<{setupRequired:boolean;bootstrapAuthorized:boolean;user:unknown}>(proof,'/auth/status')
    if(!auth.setupRequired||!auth.bootstrapAuthorized||auth.user!==null)throw new Error('Dedicated proof API must be an unclaimed installation authorized by its private installation key.')
    for(const path of ['/plans','/jobs','/backups','/agents'])if((await fixtureApi<unknown[]>(proof,path)).length!==0)throw new Error('Dedicated proof API contains existing application data; no seed mutation is allowed.')
  }
  const admin=new mssql.ConnectionPool(sqlConfig(proof,'master','sa',proof.adminPassword)),sourcePassword='Local-Mssql-Reader-Only!2026',targetPassword='Local-Mssql-Writer-Only!2026';admin.on('error',()=>{})
  try{
    await admin.connect();await guardMssqlServer(proof,admin,'seed')
    await admin.request().batch('CREATE DATABASE fixture_mssql_source');await admin.request().batch('CREATE DATABASE fixture_mssql_target')
    await admin.request().batch(`CREATE LOGIN fixture_mssql_reader WITH PASSWORD='${sourcePassword}',CHECK_POLICY=ON; CREATE LOGIN fixture_mssql_writer WITH PASSWORD='${targetPassword}',CHECK_POLICY=ON;`)
    await admin.request().batch(`USE fixture_mssql_source;
      CREATE USER fixture_mssql_reader FOR LOGIN fixture_mssql_reader; ALTER ROLE db_owner ADD MEMBER fixture_mssql_reader;
      CREATE TABLE dbo.projects(id int IDENTITY(10,5) NOT NULL CONSTRAINT PK_projects PRIMARY KEY,name nvarchar(80) NOT NULL CONSTRAINT UQ_projects_name UNIQUE);
      CREATE TABLE dbo.entries(id bigint IDENTITY(100,10) NOT NULL CONSTRAINT PK_entries PRIMARY KEY,project_id int NOT NULL,amount decimal(20,4) NOT NULL,label nvarchar(100) NOT NULL,payload varbinary(16) NULL,recorded datetimeoffset(7) NOT NULL,CONSTRAINT FK_entries_projects FOREIGN KEY(project_id) REFERENCES dbo.projects(id),CONSTRAINT CK_entries_amount CHECK(amount>=0));
      CREATE INDEX IX_entries_project ON dbo.entries(project_id) INCLUDE(amount);
      INSERT dbo.projects(name) VALUES(N'Первый'),(N'Second');
      INSERT dbo.entries(project_id,amount,label,payload,recorded) VALUES
        (10,12.3400,N'Юникод 🦊',0x0001FF,'2026-01-02T03:04:05.1234567+05:30'),
        (15,0.0001,N'Null binary',NULL,'2026-02-03T04:05:06.7654321-04:00'),
        (10,900719925474.0993,N'Exact decimal',0x,'2026-03-04T05:06:07.1111111+00:00');`)
    await admin.request().batch('USE fixture_mssql_target; CREATE USER fixture_mssql_writer FOR LOGIN fixture_mssql_writer; ALTER ROLE db_owner ADD MEMBER fixture_mssql_writer;')
  }finally{await admin.close().catch(()=>{})}
  const maintenance=new mssql.ConnectionPool(sqlConfig(proof,'master','sa',proof.adminPassword));maintenance.on('error',()=>{})
  try{await maintenance.connect();await maintenance.request().batch('ALTER DATABASE fixture_mssql_source SET READ_ONLY WITH NO_WAIT')}finally{await maintenance.close().catch(()=>{})}
  const store=new S3Client({endpoint:proof.s3Endpoint,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'steelkeep-local',secretAccessKey:'local-s3-fixture-only'}})
  try{try{await store.send(new HeadBucketCommand({Bucket:'steelkeep-mssql-fixture'}),{abortSignal:AbortSignal.timeout(15000)});if(proof.remote)throw new Error('Dedicated fixture bucket already exists.')}catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==404)throw new Error('Cannot establish fresh synthetic bucket absence.');await store.send(new CreateBucketCommand({Bucket:'steelkeep-mssql-fixture'}),{abortSignal:AbortSignal.timeout(15000)})}}finally{store.destroy()}
  const common={kind:'mssql',host:'mssql-fixture',port:1433,tls:false}
  const source=await fixtureApi<{id:string}>(proof,'/connections',{name:'SQL Server · fixture',...common,database:'fixture_mssql_source',user:'fixture_mssql_reader',password:sourcePassword})
  const target=await fixtureApi<{id:string}>(proof,'/connections',{name:'SQL Server recovery · fixture',...common,database:'fixture_mssql_target',user:'fixture_mssql_writer',password:targetPassword,restoreTarget:true})
  const storage=await fixtureApi<{id:string}>(proof,'/connections',{name:'SQL Server S3 · fixture',kind:'s3',endpoint:'http://s3:9000',bucket:'steelkeep-mssql-fixture',prefix:'mssql',region:'us-east-1',accessKey:'steelkeep-local',secretKey:'local-s3-fixture-only'})
  for(const row of [source,target,storage])if((await fixtureApi<{status:string}>(proof,`/connections/${row.id}/test`,{})).status!=='available')throw new Error('SQL Server fixture connectivity check failed; no native acceptance is claimed.')
  const plan=await fixtureApi<{id:string}>(proof,'/plans',{name:'SQL Server fixture',sourceId:source.id,storageId:storage.id,timezone:'UTC'})
  await guardMssqlMetadata(proof,'recovery')
  const persisted=await proofMetadata(proof,'SELECT id FROM connections WHERE id=ANY($1::uuid[])',[[source.id,target.id,storage.id]])
  const plans=await proofMetadata(proof,'SELECT id FROM plans WHERE id=$1 AND source_id=$2 AND storage_id=$3',[plan.id,source.id,storage.id])
  if(persisted.length!==3||plans.length!==1)throw new Error('API-created fixture identities do not correlate with the inspected metadata; no backup is allowed.')
  console.log(JSON.stringify({sourceId:source.id,targetId:target.id,storageId:storage.id,planId:plan.id,seeded:true,nativeRecovery:'not-run'}))
}
if(import.meta.main){try{await seed()}catch{console.error('SQL Server fixture preparation failed. Retain the isolated project and inspect its safe state; raw driver errors and credentials are omitted.');process.exitCode=1}}
