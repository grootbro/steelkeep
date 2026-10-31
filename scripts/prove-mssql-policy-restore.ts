// One authorized fresh-target MCP restore from the retained independently checksummed synthetic artifact.
import mssql from 'mssql'
import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {lstat,readFile,writeFile,statfs} from 'node:fs/promises'
import {isDeepStrictEqual} from 'node:util'
import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'
import {mssqlProof,sqlConfig,proofMetadata,type MssqlProof} from './seed-mssql-fixture'

const statePath='/run/steelkeep/policy-positive-1-state.json',resultPath='/run/steelkeep/policy-positive-1-result.json',startedPath='/run/steelkeep/policy-positive-1-started.json'
const artifactId='e7316e24-50d8-494a-b4d4-d80bfb48b843',archiveSha='5b3225d2539b8a98991a518b54546457baf78d6b9f107c5cbdf71090889c347d'
const normalHelperSha='df38390e28016e772ae8032c57fa739c5455c308091cf9634850658e4afa5bf3',adapterSha='315e0d91a6748905367a8beab74914847ef44c30c7bdab40af54e65ee70dc3f6'
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const pools:mssql.ConnectionPool[]=[],client=new Client({name:'steelkeep-policy-positive-proof',version:'1.0.0'})
let stage='preflight',createdState=false,targetDatabase:string|undefined,targetLogin:string|undefined,targetId:string|undefined,restoreRunId:string|undefined
async function absent(path:string){try{await lstat(path)}catch(error){if((error as {code?:string}).code==='ENOENT')return}throw new Error('Retained state forbids replay')}
async function connect(proof:MssqlProof,database:string,user='sa',password=proof.adminPassword){const pool=new mssql.ConnectionPool(sqlConfig(proof,database,user,password));pool.on('error',()=>{});pools.push(pool);await pool.connect();return pool}
async function tool<T>(name:string,args:Record<string,unknown>={}):Promise<T>{
  const result=await client.callTool({name,arguments:args});if(result.isError)throw new Error('Safe MCP refusal')
  const structured=result.structuredContent as {data?:unknown}|undefined,text=result.content?.find(item=>item.type==='text')
  const value=structured&&'data'in structured?structured.data:text?.type==='text'?JSON.parse(text.text):undefined
  if(value===undefined)throw new Error('MCP result missing');return value as T
}
const applicationSql=`SELECT t.name AS table_name,c.name,ty.name AS type,c.max_length,c.precision,c.scale,c.is_nullable,c.is_identity,dc.definition FROM sys.tables t JOIN sys.columns c ON c.object_id=t.object_id JOIN sys.types ty ON ty.user_type_id=c.user_type_id LEFT JOIN sys.default_constraints dc ON dc.object_id=c.default_object_id WHERE t.is_ms_shipped=0 ORDER BY t.name,c.column_id;
SELECT t.name AS table_name,i.name,i.type_desc,i.is_unique,i.is_primary_key,i.is_unique_constraint,c.name AS column_name,ic.key_ordinal,ic.is_descending_key,ic.is_included_column FROM sys.tables t JOIN sys.indexes i ON i.object_id=t.object_id JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE t.is_ms_shipped=0 AND i.index_id>0 ORDER BY t.name,i.name,ic.index_column_id;
SELECT name,definition,is_disabled,is_not_trusted FROM sys.check_constraints ORDER BY name;
SELECT f.name,OBJECT_SCHEMA_NAME(f.parent_object_id) AS parent_schema,OBJECT_NAME(f.parent_object_id) AS parent_table,pc.name AS parent_column,OBJECT_SCHEMA_NAME(f.referenced_object_id) AS target_schema,OBJECT_NAME(f.referenced_object_id) AS target_table,rc.name AS target_column,f.delete_referential_action,f.update_referential_action,f.is_disabled,f.is_not_trusted FROM sys.foreign_keys f JOIN sys.foreign_key_columns fc ON fc.constraint_object_id=f.object_id JOIN sys.columns pc ON pc.object_id=fc.parent_object_id AND pc.column_id=fc.parent_column_id JOIN sys.columns rc ON rc.object_id=fc.referenced_object_id AND rc.column_id=fc.referenced_column_id ORDER BY f.name,fc.constraint_column_id;
SELECT OBJECT_SCHEMA_NAME(object_id) AS schema_name,OBJECT_NAME(object_id) AS table_name,name,CONVERT(varchar(100),seed_value) AS seed,CONVERT(varchar(100),increment_value) AS increment,CONVERT(varchar(100),last_value) AS last FROM sys.identity_columns ORDER BY table_name,name;
SELECT id,name FROM dbo.projects ORDER BY id;
SELECT CONVERT(varchar(30),id) AS id,project_id,CONVERT(varchar(40),amount) AS amount,label,CASE WHEN payload IS NULL THEN NULL ELSE CONVERT(varchar(40),payload,2) END AS payload,CONVERT(varchar(40),CAST(recorded AS datetime2(7)),126) AS local_time,DATEPART(TZOFFSET,recorded) AS offset_minutes FROM dbo.entries ORDER BY id;`
const securitySql=`SELECT name,type_desc,default_schema_name,CONVERT(varchar(max),sid,2) AS sid FROM sys.database_principals ORDER BY principal_id;
SELECT role_principal_id,member_principal_id FROM sys.database_role_members ORDER BY role_principal_id,member_principal_id;
SELECT class,major_id,minor_id,grantee_principal_id,grantor_principal_id,type,state FROM sys.database_permissions ORDER BY class,major_id,minor_id,grantee_principal_id,grantor_principal_id,type,state;`
const serverSql=`SELECT name,CONVERT(varchar(max),sid,2) AS sid,is_disabled FROM sys.sql_logins ORDER BY name;
SELECT role_principal_id,member_principal_id FROM sys.server_role_members ORDER BY role_principal_id,member_principal_id;
SELECT class,major_id,grantee_principal_id,grantor_principal_id,type,state FROM sys.server_permissions ORDER BY class,major_id,grantee_principal_id,grantor_principal_id,type,state;`
async function main(){
  if(process.getuid?.()!==10001)throw new Error('Runtime UID mismatch')
  await absent(statePath);await absent(resultPath);await absent(startedPath)
  for(const [path,expected]of [['/opt/steelkeep-dacfx/Steelkeep.DacFx.dll',normalHelperSha],['/app/server/engines/mssql.ts',adapterSha]])if(createHash('sha256').update(await readFile(path)).digest('hex')!==expected)throw new Error('Pinned normal runtime mismatch')
  const proof=await mssqlProof();if(!proof.remote)throw new Error('Remote synthetic stand required')
  const negative=JSON.parse(await readFile('/run/steelkeep/policy-negative-2-result.json','utf8'))
  if(negative.status!=='passed'||negative.actualImportCalls!==1||negative.contributorEntered!==true||negative.planAcknowledged!==false||negative.beforeHash!==negative.afterHash)throw new Error('Negative execution gate not established')
  const marker=await proofMetadata(proof,'SELECT nonce FROM steelkeep_mssql_proof_identity'),held=await proofMetadata(proof,'SELECT target_id,run_id FROM target_blocks ORDER BY target_id')
  if(marker.length!==1||marker[0].nonce!==proof.nonce||held.length!==1||held[0].target_id!=='38862a02-7954-4988-805b-cc45df7b8ec5'||held[0].run_id!=='c715a9db-9094-4a2a-8036-2e2288be48fc')throw new Error('Retained identity or quarantine changed')
  const runs=await proofMetadata(proof,'SELECT id,status FROM runs ORDER BY id')
  if(runs.length!==3||runs.some(row=>!['f6f5e10d-c0af-45bd-a966-e8475b4f9741','f099a768-662a-41cc-abb9-144795910c75','c715a9db-9094-4a2a-8036-2e2288be48fc'].includes(String(row.id))||!['failed','succeeded','interrupted'].includes(String(row.status))))throw new Error('Unexpected operation state')
  const [pending]=await proofMetadata(proof,'SELECT (SELECT count(*) FROM source_blocks)::int AS sources,(SELECT count(*) FROM outbox WHERE dispatched_at IS NULL)::int AS pending')
  if(pending.sources!==0||pending.pending!==0)throw new Error('Outstanding operations forbid proof')
  const [artifact]=await proofMetadata(proof,'SELECT id,object_key,sha256,size,source_id,storage_id,run_id FROM artifacts WHERE id=$1',[artifactId])
  if(!artifact||String(artifact.size)!=='4636'||artifact.sha256!==archiveSha||artifact.run_id!=='f099a768-662a-41cc-abb9-144795910c75'||artifact.object_key!=='mssql/f099a768-662a-41cc-abb9-144795910c75/1ac8f540-74b7-4912-8a3e-f006d70c48b5/e7316e24-50d8-494a-b4d4-d80bfb48b843.bacpac')throw new Error('Retained artifact mismatch')
  stage='independent-s3-get'
  const s3=new S3Client({endpoint:proof.s3Endpoint,region:'us-east-1',forcePathStyle:true,maxAttempts:1,credentials:{accessKeyId:'steelkeep-local',secretAccessKey:'local-s3-fixture-only'}})
  try{const response=await s3.send(new GetObjectCommand({Bucket:'steelkeep-mssql-fixture',Key:String(artifact.object_key)}),{abortSignal:AbortSignal.timeout(30000)});if(!response.Body)throw new Error('No archive body');let bytes=0;const digest=createHash('sha256');try{for await(const chunk of response.Body as AsyncIterable<Uint8Array>){bytes+=chunk.length;if(bytes>32768)throw new Error('Archive exceeded synthetic bound');digest.update(chunk)}}finally{(response.Body as {destroy?:()=>void}).destroy?.()}if(bytes!==4636||digest.digest('hex')!==archiveSha)throw new Error('Independent bytes mismatch')}finally{s3.destroy()}
  stage='sql-identity'
  let admin:mssql.ConnectionPool|undefined
  const readinessDeadline=Date.now()+45000
  while(Date.now()<readinessDeadline){const candidate=new mssql.ConnectionPool({...sqlConfig(proof,'master','sa',proof.adminPassword),connectionTimeout:1000,requestTimeout:3000});candidate.on('error',()=>{});try{await candidate.connect();admin=candidate;pools.push(candidate);break}catch{await candidate.close().catch(()=>{});await Bun.sleep(500)}}
  if(!admin)throw new Error('SQL readiness deadline')
  const identity=(await admin.request().query("SELECT ORIGINAL_LOGIN() AS actor,CONVERT(int,SERVERPROPERTY('ProductMajorVersion')) AS major,CONVERT(nvarchar(128),SERVERPROPERTY('MachineName')) AS machine")).recordset[0]
  if(identity.actor!=='sa'||identity.major!==16||identity.machine!==proof.sqlHostname)throw new Error('Synthetic SQL identity mismatch')
  const databases=(await admin.request().query('SELECT name FROM sys.databases WHERE database_id>4 ORDER BY name')).recordset.map(row=>row.name)
  if(!isDeepStrictEqual(databases,['fixture_mssql_source','fixture_mssql_target','policy_deny_b79703161d87d255','recovery_mssql_f768c9613ff4']))throw new Error('Unrelated database found')
  const source=await connect(proof,'fixture_mssql_source'),sourceBefore=(await source.request().query(applicationSql+securitySql+'SELECT is_read_only FROM sys.databases WHERE database_id=DB_ID();')).recordsets
  if((sourceBefore as any[]).at(-1)?.[0]?.is_read_only!==true)throw new Error('Source is not READ_ONLY')
  const suffix=randomBytes(8).toString('hex'),password='Positive-Proof!'+randomBytes(24).toString('hex'),key=randomUUID()
  const space=await statfs('/run/steelkeep');if(space.bavail*space.bsize<8*1024**3)throw new Error('Remote disk floor')
  targetDatabase='policy_restore_'+suffix;targetLogin='policy_restore_'+suffix
  await writeFile(statePath,JSON.stringify({nonce:proof.nonce,targetDatabase,targetLogin,password,idempotencyKey:key,artifactId,archiveSha,normalHelperSha,adapterSha,replayAllowed:false}),{mode:0o600,flag:'wx'});createdState=true
  stage='fresh-target-database'
  await admin.request().input('name',mssql.NVarChar,targetDatabase).query("DECLARE @sql nvarchar(max)=N'CREATE DATABASE '+QUOTENAME(@name);EXEC(@sql)")
  stage='fresh-target-login'
  await admin.request().input('name',mssql.NVarChar,targetLogin).input('password',mssql.NVarChar,password).query("DECLARE @sql nvarchar(max)=N'CREATE LOGIN '+QUOTENAME(@name)+N' WITH PASSWORD='''+REPLACE(@password,N'''',N'''''')+N''',CHECK_POLICY=ON';EXEC(@sql)")
  const target=await connect(proof,targetDatabase)
  await target.request().input('name',mssql.NVarChar,targetLogin).query("DECLARE @sql nvarchar(max)=N'CREATE USER '+QUOTENAME(@name)+N' FOR LOGIN '+QUOTENAME(@name)+N';ALTER ROLE db_owner ADD MEMBER '+QUOTENAME(@name);EXEC(@sql)")
  const targetSecurityBefore=(await target.request().query(securitySql)).recordsets,serverBefore=(await admin.request().query(serverSql)).recordsets
  await writeFile('/run/steelkeep/policy-positive-1-baseline.json',JSON.stringify({sourceBefore,targetSecurityBefore,serverBefore}),{mode:0o600,flag:'wx'})
  stage='mcp-review'
  await client.connect(new StreamableHTTPClientTransport(new URL(proof.base+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+proof.token}}}))
  const targetConnection=await tool<{id:string}>('create_connection',{connection:{name:'SQL Server policy proof '+suffix,kind:'mssql',host:'mssql-fixture',port:1433,database:targetDatabase,user:targetLogin,password,tls:false,restoreTarget:true}});targetId=targetConnection.id
  if((await tool<{status:string}>('test_connection',{id:targetId})).status!=='available')throw new Error('Target unavailable')
  const prepared=await tool<{intentId:string;review:{sourceDatabase:string;targetDatabase:string}}>('prepare_restore',{artifactId,targetId})
  if(prepared.review.sourceDatabase!=='fixture_mssql_source'||prepared.review.targetDatabase!==targetDatabase)throw new Error('Restore review mismatch')
  stage='native-import'
  const started=await tool<{id:string}>('start_restore',{intentId:prepared.intentId,idempotencyKey:key});restoreRunId=started.id
  await writeFile(startedPath,JSON.stringify({restoreRunId,targetId,targetDatabase,targetLogin,intentId:prepared.intentId,idempotencyKey:key,replayAllowed:false}),{mode:0o600,flag:'wx'})
  if((await tool<{id:string}>('start_restore',{intentId:prepared.intentId,idempotencyKey:key})).id!==restoreRunId)throw new Error('Same-key request produced another job')
  let completed:{status:string;error_code:string|null;validation:Record<string,unknown>|null}|undefined
  const deadline=Date.now()+240000
  while(Date.now()<deadline){const job=await tool<{status:string;error_code:string|null;validation:Record<string,unknown>|null}>('get_job',{id:restoreRunId});if(['succeeded','failed','cancelled','interrupted'].includes(job.status)){completed=job;break}await Bun.sleep(250)}
  if(!completed||completed.status!=='succeeded'||completed.validation?.status!=='passed'||completed.validation?.integrity!=='sha256-matched'||completed.validation?.restore!=='completed'){
    const safeCode=completed?.error_code&&/^[A-Z0-9_]{1,60}$/.test(completed.error_code)?completed.error_code:'UNKNOWN_OUTCOME'
    stage='native-import-'+(completed?.status??'unknown')+'-'+safeCode;throw new Error('Native restore not qualified')
  }
  stage='independent-sql-validation'
  const sourceAfter=(await source.request().query(applicationSql+securitySql+'SELECT is_read_only FROM sys.databases WHERE database_id=DB_ID();')).recordsets,targetApplication=(await target.request().query(applicationSql)).recordsets
  if(!isDeepStrictEqual(sourceBefore,sourceAfter)||!isDeepStrictEqual((sourceBefore as any[]).slice(0,7),targetApplication))throw new Error('Independent schema/data/sequence validation mismatch')
  const targetSecurityAfter=(await target.request().query(securitySql)).recordsets,serverAfter=(await admin.request().query(serverSql)).recordsets
  if(!isDeepStrictEqual(targetSecurityBefore,targetSecurityAfter)||!isDeepStrictEqual(serverBefore,serverAfter))throw new Error('Security catalog changed')
  const roles=(await target.request().input('login',mssql.NVarChar,targetLogin).query("SELECT IS_ROLEMEMBER('db_owner',@login) AS targetOwner,(SELECT COUNT(*) FROM sys.database_principals WHERE name='fixture_mssql_reader') AS sourcePrincipal")).recordset[0]
  if(roles.targetOwner!==1||roles.sourcePrincipal!==0)throw new Error('Destination role/source-principal boundary failed')
  const heldAfter=await proofMetadata(proof,'SELECT target_id,run_id FROM target_blocks ORDER BY target_id')
  if(heldAfter.length!==held.length+1||!held.every(old=>heldAfter.some(row=>row.target_id===old.target_id&&row.run_id===old.run_id))||!heldAfter.some(row=>row.target_id===targetId&&row.run_id===restoreRunId))throw new Error('Original or successful-target reservation ownership changed')
  const events=await proofMetadata(proof,'SELECT phase FROM events WHERE run_id=$1 ORDER BY id',[restoreRunId]),phases=events.map(row=>row.phase)
  if(!phases.includes('restoring')||!phases.includes('validating-data')||phases.at(-1)!=='completed')throw new Error('Native phases not established')
  const result={proof:'mssql-policy-positive-native',status:'passed',restoreRunId,targetId,targetDatabase,targetLogin,artifactId,archiveSha,archiveBytes:4636,independentS3Get:true,sameKeyJobPreserved:true,phases,sourceReadOnlyUnchanged:true,independentSchemaDataSequencesMatched:true,targetDbOwnerRetained:true,sourcePrincipalAbsent:true,serverSecurityUnchanged:true,destinationSecurityUnchanged:true,oldHeldTargetGuardUnchanged:true,applicationHash:hash(targetApplication),sourceHash:hash(sourceBefore),normalHelperSha,adapterSha,baseCommit:'680c7add4ac855c43921d64078bab0334c1b6389',replayAllowed:false,reuseAllowed:false}
  await writeFile(resultPath,JSON.stringify(result),{mode:0o600,flag:'wx'});console.log(JSON.stringify(result))
}
try{await main()}catch{
  const result={proof:'mssql-policy-positive-native',status:'refused',stage,createdState,targetDatabase,targetLogin,targetId,restoreRunId,artifactId,normalHelperSha,adapterSha,quarantined:true,replayAllowed:false,reuseAllowed:false}
  if(createdState)await writeFile(resultPath,JSON.stringify(result),{mode:0o600,flag:'wx'}).catch(()=>{})
  console.log(JSON.stringify(result));process.exitCode=1
}finally{await Promise.allSettled([...pools.map(pool=>pool.close()),client.close()])}
