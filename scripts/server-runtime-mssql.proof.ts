import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {readFile,writeFile,lstat,statfs} from 'node:fs/promises'
import {isDeepStrictEqual} from 'node:util'
import pg from 'pg'
import mssql from 'mssql'
import {S3Client,HeadBucketCommand,CreateBucketCommand,GetObjectCommand} from '@aws-sdk/client-s3'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'

const state='/run/steelkeep-proof/state.json',result='/run/steelkeep-proof/result.json'
const helperSha='df38390e28016e772ae8032c57fa739c5455c308091cf9634850658e4afa5bf3'
type Job={id:string;status:string;error_code:string|null;artifact_id:string|null;attempt:number;validation:Record<string,unknown>|null}
const pools:mssql.ConnectionPool[]=[],client=new Client({name:'steelkeep-server-runtime-mssql',version:'1.0.0'})
let stage='capabilities',started=false,backupRunId:string|undefined,restoreRunId:string|undefined,targetId:string|undefined,targetDatabase:string|undefined,targetLogin:string|undefined
async function metadata(text:string,values:unknown[]=[],old=false){
 const url=new URL(process.env.DATABASE_URL!);if(old)url.pathname='/steelkeep_mssql_proof'
 const connection=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:5000,statement_timeout:10000,options:'-c default_transaction_read_only=on'});connection.on('error',()=>{})
 try{await connection.connect();return(await connection.query(text,values)).rows as Record<string,unknown>[]}finally{await connection.end()}
}
async function tool<T>(name:string,args:Record<string,unknown>={}):Promise<T>{
 const value=await client.callTool({name,arguments:args});if(value.isError)throw new Error('Safe MCP refusal')
 const structured=value.structuredContent as {data?:unknown}|undefined,block=value.content?.find(item=>item.type==='text')
 const data=structured&&'data'in structured?structured.data:block?.type==='text'?JSON.parse(block.text):undefined
 if(data===undefined)throw new Error('Missing MCP result');return data as T
}
async function finished(id:string){const until=Date.now()+240000;while(Date.now()<until){const job=await tool<Job>('get_job',{id});if(['succeeded','failed','interrupted','cancelled'].includes(job.status)){if(job.status!=='succeeded'){stage+='-'+job.status+(/^[A-Z0-9_]{1,60}$/.test(job.error_code??'')?'-'+job.error_code:'');throw new Error('Native job refused')}return job}await Bun.sleep(250)}throw new Error('Unknown outcome; never replay this state')}
async function sql(database:string,user:string,password:string){const pool=new mssql.ConnectionPool({server:'mssql-runtime',port:1433,database,user,password,connectionTimeout:10000,requestTimeout:30000,pool:{max:1,min:0},options:{encrypt:false,trustServerCertificate:false}});pool.on('error',()=>{});pools.push(pool);try{await pool.connect();return pool}catch(error){await pool.close().catch(()=>{});throw error}}
const normalize=(value:unknown)=>JSON.parse(JSON.stringify(value)),hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const applicationSql=`SELECT t.name AS table_name,c.name,ty.name AS type,c.max_length,c.precision,c.scale,c.is_nullable,c.is_identity,dc.definition FROM sys.tables t JOIN sys.columns c ON c.object_id=t.object_id JOIN sys.types ty ON ty.user_type_id=c.user_type_id LEFT JOIN sys.default_constraints dc ON dc.object_id=c.default_object_id WHERE t.is_ms_shipped=0 ORDER BY t.name,c.column_id;
SELECT t.name AS table_name,i.name,i.type_desc,i.is_unique,i.is_primary_key,i.is_unique_constraint,c.name AS column_name,ic.key_ordinal,ic.is_descending_key,ic.is_included_column FROM sys.tables t JOIN sys.indexes i ON i.object_id=t.object_id JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE t.is_ms_shipped=0 AND i.index_id>0 ORDER BY t.name,i.name,ic.index_column_id;
SELECT name,definition,is_disabled,is_not_trusted FROM sys.check_constraints ORDER BY name;
SELECT f.name,OBJECT_SCHEMA_NAME(f.parent_object_id) AS parent_schema,OBJECT_NAME(f.parent_object_id) AS parent_table,pc.name AS parent_column,OBJECT_SCHEMA_NAME(f.referenced_object_id) AS target_schema,OBJECT_NAME(f.referenced_object_id) AS target_table,rc.name AS target_column,f.delete_referential_action,f.update_referential_action,f.is_disabled,f.is_not_trusted FROM sys.foreign_keys f JOIN sys.foreign_key_columns fc ON fc.constraint_object_id=f.object_id JOIN sys.columns pc ON pc.object_id=fc.parent_object_id AND pc.column_id=fc.parent_column_id JOIN sys.columns rc ON rc.object_id=fc.referenced_object_id AND rc.column_id=fc.referenced_column_id ORDER BY f.name,fc.constraint_column_id;
SELECT OBJECT_SCHEMA_NAME(object_id) AS schema_name,OBJECT_NAME(object_id) AS table_name,name,CONVERT(varchar(100),seed_value) AS seed,CONVERT(varchar(100),increment_value) AS increment,CONVERT(varchar(100),last_value) AS last FROM sys.identity_columns ORDER BY table_name,name;
SELECT id,name FROM dbo.projects ORDER BY id;
SELECT CONVERT(varchar(30),id) AS id,project_id,CONVERT(varchar(40),amount) AS amount,label,CASE WHEN payload IS NULL THEN NULL ELSE CONVERT(varchar(40),payload,2) END AS payload,CONVERT(varchar(40),CAST(recorded AS datetime2(7)),126) AS local_time,DATEPART(TZOFFSET,recorded) AS offset_minutes FROM dbo.entries ORDER BY id;`
const securitySql=`SELECT name,type_desc,default_schema_name,CONVERT(varchar(max),sid,2) AS sid FROM sys.database_principals ORDER BY principal_id;SELECT role_principal_id,member_principal_id FROM sys.database_role_members ORDER BY role_principal_id,member_principal_id;SELECT class,major_id,minor_id,grantee_principal_id,grantor_principal_id,type,state FROM sys.database_permissions ORDER BY class,major_id,minor_id,grantee_principal_id,grantor_principal_id,type,state;`
const serverSql=`SELECT name,CONVERT(varchar(max),sid,2) AS sid,is_disabled FROM sys.sql_logins ORDER BY name;SELECT role_principal_id,member_principal_id FROM sys.server_role_members ORDER BY role_principal_id,member_principal_id;SELECT class,major_id,grantee_principal_id,grantor_principal_id,type,state FROM sys.server_permissions ORDER BY class,major_id,grantee_principal_id,grantor_principal_id,type,state;`
async function main(){
 if(process.env.STEELKEEP_MSSQL_RUNTIME!=='synthetic-ef8b'||process.platform!=='linux'||process.arch!=='x64'||process.getuid?.()!==10001||new URL(process.env.DATABASE_URL!).pathname!=='/steelkeep_mssql_runtime_20261031')throw new Error('Dedicated proof configuration required')
 const nonce=(await readFile('/run/steelkeep/runtime-nonce','utf8')).trim(),oldNonce=(await readFile('/run/steelkeep/old-proof-nonce','utf8')).trim(),adminPassword=(await readFile('/run/steelkeep/mssql-sa-password','utf8')).trim(),token=(await readFile('/run/steelkeep/token','utf8')).trim()
 if(!/^[a-f0-9]{64}$/.test(nonce)||!/^[a-f0-9]{64}$/.test(oldNonce)||adminPassword.length<16||createHash('sha256').update(await readFile('/opt/steelkeep-dacfx/Steelkeep.DacFx.dll')).digest('hex')!==helperSha)throw new Error('Proof capabilities or helper mismatch')
 try{await lstat(state);throw new Error('Retained state forbids replay')}catch(error){if((error as {code?:string}).code!=='ENOENT')throw error}
 const oldMarker=await metadata('SELECT nonce FROM steelkeep_mssql_proof_identity',[],true),oldHolds=await metadata('SELECT target_id,run_id FROM target_blocks ORDER BY target_id',[],true)
 if(oldMarker.length!==1||oldMarker[0].nonce!==oldNonce||!oldHolds.some(row=>row.target_id==='38862a02-7954-4988-805b-cc45df7b8ec5'&&row.run_id==='c715a9db-9094-4a2a-8036-2e2288be48fc'))throw new Error('Original quarantine or stand changed')
 const [identity]=await metadata("SELECT current_database() AS database,current_user AS actor,(SELECT count(*) FROM runs)::int AS runs,(SELECT count(*) FROM connections)::int AS connections,(SELECT count(*) FROM owner_account)::int AS owners")
 if(identity.database!=='steelkeep_mssql_runtime_20261031'||identity.actor!=='steelkeep'||identity.runs!==0||identity.connections!==0||identity.owners!==0)throw new Error('Fresh metadata required')
 const runtimeMarker=await metadata('SELECT nonce FROM steelkeep_runtime_mssql_identity');if(runtimeMarker.length!==1||runtimeMarker[0].nonce!==nonce)throw new Error('Runtime metadata marker mismatch')
 stage='sql-readiness'
 let admin:mssql.ConnectionPool|undefined;const deadline=Date.now()+60000
 while(Date.now()<deadline){try{admin=await sql('master','sa',adminPassword);break}catch{await Bun.sleep(500)}}
 if(!admin)throw new Error('SQL readiness deadline')
 const serverIdentity=(await admin.request().query("SELECT ORIGINAL_LOGIN() AS actor,CONVERT(int,SERVERPROPERTY('ProductMajorVersion')) AS major,CONVERT(nvarchar(128),SERVERPROPERTY('MachineName')) AS machine")).recordset[0]
 if(serverIdentity.actor!=='sa'||serverIdentity.major!==16||serverIdentity.machine!=='mssql-proof-'+oldNonce.slice(0,12))throw new Error('SQL synthetic identity mismatch')
 const source=await sql('fixture_mssql_source','sa',adminPassword),sourceBefore=normalize((await source.request().query(applicationSql+securitySql+'SELECT is_read_only FROM sys.databases WHERE database_id=DB_ID();')).recordsets)
 if(sourceBefore.at(-1)?.[0]?.is_read_only!==true||sourceBefore[5].length!==2||sourceBefore[6].length!==3)throw new Error('READ_ONLY source fixture mismatch')
 const space=await statfs('/run/steelkeep-proof');if(space.bavail*space.bsize<8858370048)throw new Error('8.25GiB disk guard')
 const suffix=randomBytes(8).toString('hex'),password='Runtime-Mssql!'+randomBytes(24).toString('hex'),bucket='steelkeep-mssql-runtime-'+nonce.slice(0,12)
 targetDatabase='runtime_mssql_'+suffix;targetLogin='runtime_mssql_'+suffix
 await writeFile(state,JSON.stringify({nonce,targetDatabase,targetLogin,password,bucket,replayAllowed:false}),{mode:0o600,flag:'wx'});started=true
 stage='new-target'
 await admin.request().input('name',mssql.NVarChar,targetDatabase).query("DECLARE @sql nvarchar(max)=N'CREATE DATABASE '+QUOTENAME(@name);EXEC(@sql)")
 await admin.request().input('name',mssql.NVarChar,targetLogin).input('password',mssql.NVarChar,password).query("DECLARE @sql nvarchar(max)=N'CREATE LOGIN '+QUOTENAME(@name)+N' WITH PASSWORD='''+REPLACE(@password,N'''',N'''''')+N''',CHECK_POLICY=ON';EXEC(@sql)")
 const target=await sql(targetDatabase,'sa',adminPassword)
 await target.request().input('name',mssql.NVarChar,targetLogin).query("DECLARE @sql nvarchar(max)=N'CREATE USER '+QUOTENAME(@name)+N' FOR LOGIN '+QUOTENAME(@name)+N';ALTER ROLE db_owner ADD MEMBER '+QUOTENAME(@name);EXEC(@sql)")
 const targetSecurity=normalize((await target.request().query(securitySql)).recordsets),serverSecurity=normalize((await admin.request().query(serverSql)).recordsets)
 await writeFile('/run/steelkeep-proof/baseline.json',JSON.stringify({sourceBefore,targetSecurity,serverSecurity}),{mode:0o600,flag:'wx'})
 const s3=new S3Client({endpoint:'http://s3:9000',region:'us-east-1',forcePathStyle:true,maxAttempts:1,credentials:{accessKeyId:'steelkeep-local',secretAccessKey:'local-s3-fixture-only'}})
 try{
  stage='fresh-bucket'
  try{await s3.send(new HeadBucketCommand({Bucket:bucket}));throw new Error('Retain an existing bucket')}catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==404)throw error}
  await s3.send(new CreateBucketCommand({Bucket:bucket}))
  await client.connect(new StreamableHTTPClientTransport(new URL('http://mssql-runtime-api:4311/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}}))
  const sourceProfile=await tool<{id:string}>('create_connection',{connection:{name:'Runtime READ_ONLY SQL2022 fixture',kind:'mssql',host:'mssql-runtime',port:1433,database:'fixture_mssql_source',user:'fixture_mssql_reader',password:'Local-Mssql-Reader-Only!2026',tls:false}})
  const storage=await tool<{id:string}>('create_connection',{connection:{name:'Runtime synthetic S3',kind:'s3',endpoint:'http://s3:9000',region:'us-east-1',bucket,prefix:'runtime-mssql/'+nonce.slice(0,12),accessKey:'steelkeep-local',secretKey:'local-s3-fixture-only'}})
  const targetProfile=await tool<{id:string}>('create_connection',{connection:{name:'Runtime fresh empty SQL2022 target',kind:'mssql',host:'mssql-runtime',port:1433,database:targetDatabase,user:targetLogin,password,tls:false,restoreTarget:true}});targetId=targetProfile.id
  for(const id of [sourceProfile.id,storage.id,targetId])if((await tool<{status:string}>('test_connection',{id})).status!=='available')throw new Error('Profile unavailable')
  const plan=await tool<{id:string}>('create_plan',{name:'Runtime MSSQL proof',sourceId:sourceProfile.id,storageId:storage.id,timezone:'UTC',cron:null})
  stage='native-backup'
  const key=randomUUID(),accepted=await tool<Job>('run_backup',{planId:plan.id,idempotencyKey:key});backupRunId=accepted.id
  if((await tool<Job>('run_backup',{planId:plan.id,idempotencyKey:key})).id!==backupRunId)throw new Error('Backup idempotency failed')
  const backup=await finished(backupRunId);if(!backup.artifact_id||backup.attempt!==1)throw new Error('Expected one completed backup attempt')
  const [artifact]=await metadata('SELECT id,size,sha256,object_key,engine FROM artifacts WHERE id=$1 AND run_id=$2',[backup.artifact_id,backupRunId]);if(!artifact||artifact.engine!=='mssql')throw new Error('Published artifact missing')
  stage='independent-s3-get'
  const response=await s3.send(new GetObjectCommand({Bucket:bucket,Key:String(artifact.object_key)}),{abortSignal:AbortSignal.timeout(30000)});if(!response.Body)throw new Error('No archive body')
  let bytes=0;const digest=createHash('sha256');try{for await(const chunk of response.Body as AsyncIterable<Uint8Array>){bytes+=chunk.length;if(bytes>64*1024*1024)throw new Error('Fixture archive exceeded limit');digest.update(chunk)}}finally{(response.Body as {destroy?:()=>void}).destroy?.()}
  if(String(bytes)!==String(artifact.size)||digest.digest('hex')!==artifact.sha256)throw new Error('Independent GET mismatch')
  const prepared=await tool<{intentId:string;review:{sourceDatabase:string;targetDatabase:string}}>('prepare_restore',{artifactId:artifact.id,targetId})
  if(prepared.review.sourceDatabase!=='fixture_mssql_source'||prepared.review.targetDatabase!==targetDatabase)throw new Error('Review identity mismatch')
  stage='native-restore'
  const restoreKey=randomUUID(),acceptedRestore=await tool<Job>('start_restore',{intentId:prepared.intentId,idempotencyKey:restoreKey});restoreRunId=acceptedRestore.id
  await writeFile('/run/steelkeep-proof/started.json',JSON.stringify({backupRunId,restoreRunId,targetId,targetDatabase,targetLogin,artifactId:artifact.id}),{mode:0o600,flag:'wx'})
  if((await tool<Job>('start_restore',{intentId:prepared.intentId,idempotencyKey:restoreKey})).id!==restoreRunId)throw new Error('Restore idempotency failed')
  const restored=await finished(restoreRunId);if(restored.validation?.status!=='passed'||restored.validation?.integrity!=='sha256-matched'||restored.validation?.restore!=='completed')throw new Error('Restore validation not passed')
  stage='independent-sql'
  const sourceAfter=normalize((await source.request().query(applicationSql+securitySql+'SELECT is_read_only FROM sys.databases WHERE database_id=DB_ID();')).recordsets),application=normalize((await target.request().query(applicationSql)).recordsets)
  if(!isDeepStrictEqual(sourceBefore,sourceAfter)||!isDeepStrictEqual(sourceBefore.slice(0,7),application))throw new Error('Source or recovered application changed')
  if(!isDeepStrictEqual(targetSecurity,normalize((await target.request().query(securitySql)).recordsets))||!isDeepStrictEqual(serverSecurity,normalize((await admin.request().query(serverSql)).recordsets)))throw new Error('Security catalogs changed')
  const roles=(await target.request().input('login',mssql.NVarChar,targetLogin).query("SELECT IS_ROLEMEMBER('db_owner',@login) AS owner,(SELECT count(*) FROM sys.database_principals WHERE name='fixture_mssql_reader') AS sourcePrincipal")).recordset[0]
  if(roles.owner!==1||roles.sourcePrincipal!==0)throw new Error('Target ownership boundary failed')
  if(!isDeepStrictEqual(oldHolds,await metadata('SELECT target_id,run_id FROM target_blocks ORDER BY target_id',[],true)))throw new Error('Original reservations changed')
  const holds=await metadata('SELECT target_id,run_id FROM target_blocks');if(holds.length!==1||holds[0].target_id!==targetId||holds[0].run_id!==restoreRunId)throw new Error('Successful reservation missing')
  const phases=(await metadata('SELECT phase FROM events WHERE run_id=$1 ORDER BY id',[restoreRunId])).map(row=>row.phase)
  if(!phases.includes('restoring')||!phases.includes('validating-data')||phases.at(-1)!=='completed')throw new Error('Native phases missing')
  const proof={proof:'server-runtime-mssql',status:'passed',product:'ef8bae643ac1',helperSha,backupRunId,restoreRunId,targetId,targetDatabase,targetLogin,artifactId:artifact.id,archiveBytes:bytes,sha256:artifact.sha256,independentS3Get:true,schemaDataIdentityMatched:true,sourceReadOnlyUnchanged:true,targetSecurityUnchanged:true,targetDbOwnerRetained:true,sourcePrincipalAbsent:true,serverSecurityUnchanged:true,oldReservationsUnchanged:true,successReservationOwned:true,phases,applicationSha256:hash(application),sourceSha256:hash(sourceBefore),replayAllowed:false}
  await writeFile(result,JSON.stringify(proof),{mode:0o600,flag:'wx'});console.log(JSON.stringify(proof))
 }finally{s3.destroy()}
}
try{await main()}catch{
 const proof={proof:'server-runtime-mssql',status:'refused',stage,started,backupRunId,restoreRunId,targetId,targetDatabase,targetLogin,helperSha,replayAllowed:false,reuseAllowed:false,quarantined:true}
 if(started)await writeFile(result,JSON.stringify(proof),{mode:0o600,flag:'wx'}).catch(()=>{})
 console.log(JSON.stringify(proof));process.exitCode=1
}finally{await Promise.allSettled([...pools.map(pool=>pool.close()),client.close()])}
