import mssql from 'mssql'
import {S3Client,CreateBucketCommand,HeadBucketCommand} from '@aws-sdk/client-s3'
import {config} from '../server/config'

if(process.env.STEELKEEP_ACCEPTANCE!=='synthetic-local-mssql'||process.env.STEELKEEP_MSSQL_PHYSICAL_X64!=='1')throw new Error('Explicit synthetic-local-mssql and physical Linux x64 fixture confirmation required')
if(process.env.STEELKEEP_MSSQL_ACCEPT_EULA!=='Y')throw new Error('Operator-provided Microsoft EULA acceptance required before provisioning')
const adminPassword=process.env.STEELKEEP_MSSQL_SA_PASSWORD
if(!adminPassword)throw new Error('Synthetic fixture administrator password required')
const token=config.token(),base='http://127.0.0.1:4311/api/v1'
async function api<T>(path:string,body?:unknown):Promise<T>{
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})
  if(!response.ok)throw new Error(`SQL Server fixture API ${path} failed (${response.status})`)
  return response.json() as Promise<T>
}
const existing=await api<{name:string}[]>('/connections')
if(existing.some(row=>['SQL Server · fixture','SQL Server recovery · fixture','SQL Server S3 · fixture'].includes(row.name)))throw new Error('Fixture already registered; inspect retained state instead of reseeding')
const admin=new mssql.ConnectionPool({server:'127.0.0.1',port:54380,database:'master',user:'sa',password:adminPassword,connectionTimeout:10000,requestTimeout:30000,options:{encrypt:false,trustServerCertificate:false}})
const sourcePassword='Local-Mssql-Reader-Only!2026',targetPassword='Local-Mssql-Writer-Only!2026'
try{
  await admin.connect()
  const state=await admin.request().query("SELECT CONVERT(int,SERVERPROPERTY('ProductMajorVersion')) AS major,CASE WHEN DB_ID('fixture_mssql_source') IS NULL AND DB_ID('fixture_mssql_target') IS NULL AND SUSER_ID('fixture_mssql_reader') IS NULL AND SUSER_ID('fixture_mssql_writer') IS NULL THEN 1 ELSE 0 END AS fresh")
  if(state.recordset[0]?.major!==16||state.recordset[0]?.fresh!==1)throw new Error('Requires fresh isolated SQL Server 2022 fixture; existing state is retained')
  await admin.request().batch('CREATE DATABASE fixture_mssql_source')
  await admin.request().batch('CREATE DATABASE fixture_mssql_target')
  await admin.request().batch(`CREATE LOGIN fixture_mssql_reader WITH PASSWORD='${sourcePassword}',CHECK_POLICY=ON; CREATE LOGIN fixture_mssql_writer WITH PASSWORD='${targetPassword}',CHECK_POLICY=ON;`)
  // Fixed identifiers and synthetic literal credentials above are source-owned.
  // Application connections never receive sa or server provisioning privileges.
  await admin.request().batch(`USE fixture_mssql_source;
    CREATE USER fixture_mssql_reader FOR LOGIN fixture_mssql_reader;
    ALTER ROLE db_owner ADD MEMBER fixture_mssql_reader;
    CREATE TABLE dbo.projects(id int IDENTITY(10,5) NOT NULL CONSTRAINT PK_projects PRIMARY KEY,name nvarchar(80) NOT NULL CONSTRAINT UQ_projects_name UNIQUE);
    CREATE TABLE dbo.entries(
      id bigint IDENTITY(100,10) NOT NULL CONSTRAINT PK_entries PRIMARY KEY,
      project_id int NOT NULL,
      amount decimal(20,4) NOT NULL,
      label nvarchar(100) NOT NULL,
      payload varbinary(16) NULL,
      recorded datetimeoffset(7) NOT NULL,
      CONSTRAINT FK_entries_projects FOREIGN KEY(project_id) REFERENCES dbo.projects(id),
      CONSTRAINT CK_entries_amount CHECK(amount>=0));
    CREATE INDEX IX_entries_project ON dbo.entries(project_id) INCLUDE(amount);
    INSERT dbo.projects(name) VALUES(N'Первый'),(N'Second');
    INSERT dbo.entries(project_id,amount,label,payload,recorded) VALUES
      (10,12.3400,N'Юникод 🦊',0x0001FF,'2026-01-02T03:04:05.1234567+05:30'),
      (15,0.0001,N'Null binary',NULL,'2026-02-03T04:05:06.7654321-04:00'),
      (10,900719925474.0993,N'Exact decimal',0x,'2026-03-04T05:06:07.1111111+00:00');`)
  await admin.request().batch('USE fixture_mssql_target; CREATE USER fixture_mssql_writer FOR LOGIN fixture_mssql_writer; ALTER ROLE db_owner ADD MEMBER fixture_mssql_writer;')
  // Close this provisioning session before READ_ONLY; never force-disconnect a
  // database or use WITH ROLLBACK IMMEDIATE to hide unexpected sessions/writers.
}finally{await admin.close()}
const maintenance=new mssql.ConnectionPool({server:'127.0.0.1',port:54380,database:'master',user:'sa',password:adminPassword,connectionTimeout:10000,requestTimeout:15000,options:{encrypt:false,trustServerCertificate:false}})
try{await maintenance.connect();await maintenance.request().batch('ALTER DATABASE fixture_mssql_source SET READ_ONLY WITH NO_WAIT')}finally{await maintenance.close()}
const store=new S3Client({endpoint:'http://127.0.0.1:54373',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'steelkeep-local',secretAccessKey:'local-s3-fixture-only'}})
try{try{await store.send(new HeadBucketCommand({Bucket:'steelkeep-mssql-fixture'}))}catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==404)throw new Error('Cannot establish fixture bucket absence');await store.send(new CreateBucketCommand({Bucket:'steelkeep-mssql-fixture'}))}}finally{store.destroy()}
const common={kind:'mssql',host:'mssql-fixture',port:1433,tls:false}
const source=await api<{id:string}>('/connections',{name:'SQL Server · fixture',...common,database:'fixture_mssql_source',user:'fixture_mssql_reader',password:sourcePassword})
const target=await api<{id:string}>('/connections',{name:'SQL Server recovery · fixture',...common,database:'fixture_mssql_target',user:'fixture_mssql_writer',password:targetPassword,restoreTarget:true})
const storage=await api<{id:string}>('/connections',{name:'SQL Server S3 · fixture',kind:'s3',endpoint:'http://s3:9000',bucket:'steelkeep-mssql-fixture',prefix:'mssql',region:'us-east-1',accessKey:'steelkeep-local',secretKey:'local-s3-fixture-only'})
for(const row of [source,target,storage])if((await api<{status:string}>(`/connections/${row.id}/test`,{})).status!=='available')throw new Error('SQL Server fixture connectivity check failed; no acceptance claimed')
const plan=await api<{id:string}>('/plans',{name:'SQL Server fixture',sourceId:source.id,storageId:storage.id,timezone:'UTC'})
console.log(JSON.stringify({sourceId:source.id,targetId:target.id,storageId:storage.id,planId:plan.id}))
