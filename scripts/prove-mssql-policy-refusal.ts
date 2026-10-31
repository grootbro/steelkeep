// One explicitly authorized negative Import on a fresh synthetic target; never replay this state file.
import mssql from 'mssql'
import {createHash,randomBytes} from 'node:crypto'
import {mkdtemp,readFile,writeFile,rm,lstat} from 'node:fs/promises'
import {isDeepStrictEqual} from 'node:util'
import {mssqlProof,proofMetadata,sqlConfig,type MssqlProof} from './seed-mssql-fixture'
import {runTool,toolEnv} from '../server/process'

const statePath='/run/steelkeep/policy-negative-2-state.json',resultPath='/run/steelkeep/policy-negative-2-result.json',baselinePath='/run/steelkeep/policy-negative-2-baseline.json'
const artifact='/run/steelkeep/artifact-e7316e24-50d8-494a-b4d4-d80bfb48b843.bacpac'
const archiveSha='5b3225d2539b8a98991a518b54546457baf78d6b9f107c5cbdf71090889c347d'
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
let stage='identity',createdState=false,targetName:string|undefined,targetLogin:string|undefined
const pools:mssql.ConnectionPool[]=[]
async function connect(proof:MssqlProof,database:string,user='sa',password=proof.adminPassword){
  const pool=new mssql.ConnectionPool(sqlConfig(proof,database,user,password));pool.on('error',()=>{});pools.push(pool);await pool.connect();return pool
}
async function absent(path:string){try{await lstat(path)}catch(error){if((error as {code?:string}).code==='ENOENT')return}throw new Error('Retained proof state prevents replay')}
async function main(){
  if(process.getuid?.()!==10001)throw new Error('Proof UID mismatch')
  await absent(statePath);await absent(resultPath);await absent(baselinePath)
  const helper=await readFile('/opt/steelkeep-dacfx/Steelkeep.DacFx.dll')
  if(createHash('sha256').update(helper).digest('hex')!=='14395c6cf7c052672826f087660d120c4b04844efa1b638aa6278a5b5b8984c4')throw new Error('Exact compile-only deny artifact required')
  const proof=await mssqlProof();if(!proof.remote)throw new Error('Dedicated remote stand required')
  const marker=await proofMetadata(proof,'SELECT nonce FROM steelkeep_mssql_proof_identity')
  const held=await proofMetadata(proof,'SELECT run_id FROM target_blocks WHERE target_id=$1',['38862a02-7954-4988-805b-cc45df7b8ec5'])
  if(marker.length!==1||marker[0].nonce!==proof.nonce||held.length!==1||held[0].run_id!=='c715a9db-9094-4a2a-8036-2e2288be48fc')throw new Error('Retained stand identity or hold mismatch')
  const bytes=await readFile(artifact);if(bytes.length!==4636||createHash('sha256').update(bytes).digest('hex')!==archiveSha)throw new Error('Archive mismatch')
  let admin:mssql.ConnectionPool|undefined
  const readinessDeadline=Date.now()+45000
  while(Date.now()<readinessDeadline){
    const candidate=new mssql.ConnectionPool({...sqlConfig(proof,'master','sa',proof.adminPassword),connectionTimeout:1000,requestTimeout:3000});candidate.on('error',()=>{})
    try{await candidate.connect();admin=candidate;pools.push(candidate);break}catch{await candidate.close().catch(()=>{});await Bun.sleep(500)}
  }
  if(!admin)throw new Error('SQL readiness deadline')
  const observer=admin
  const identity=(await admin.request().query("SELECT CONVERT(int,SERVERPROPERTY('ProductMajorVersion')) AS major,CONVERT(nvarchar(128),SERVERPROPERTY('MachineName')) AS machine,ORIGINAL_LOGIN() AS actor")).recordset[0]
  if(identity.major!==16||identity.machine!==proof.sqlHostname||identity.actor!=='sa')throw new Error('SQL identity mismatch')
  const names=(await admin.request().query('SELECT name FROM sys.databases WHERE database_id>4 ORDER BY name')).recordset.map(row=>row.name)
  if(!isDeepStrictEqual(names,['fixture_mssql_source','fixture_mssql_target','recovery_mssql_f768c9613ff4']))throw new Error('Unexpected synthetic database set')
  const suffix=randomBytes(8).toString('hex'),password='Proof-Only!'+randomBytes(24).toString('hex')
  targetName='policy_deny_'+suffix;targetLogin='policy_deny_'+suffix
  await writeFile(statePath,JSON.stringify({proof:'negative-import-policy',nonce:proof.nonce,targetName,targetLogin,password,archiveSha,replayAllowed:false}),{mode:0o600,flag:'wx'});createdState=true
  stage='fresh-target-database'
  await admin.request().input('name',mssql.NVarChar,targetName).query("DECLARE @sql nvarchar(max)=N'CREATE DATABASE '+QUOTENAME(@name);EXEC(@sql)")
  stage='fresh-target-login'
  await admin.request().input('name',mssql.NVarChar,targetLogin).input('password',mssql.NVarChar,password).query("DECLARE @sql nvarchar(max)=N'CREATE LOGIN '+QUOTENAME(@name)+N' WITH PASSWORD='''+REPLACE(@password,N'''',N'''''')+N''',CHECK_POLICY=ON';EXEC(@sql)")
  const target=await connect(proof,targetName)
  stage='fresh-target-user'
  await target.request().input('name',mssql.NVarChar,targetLogin).query("DECLARE @sql nvarchar(max)=N'CREATE USER '+QUOTENAME(@name)+N' FOR LOGIN '+QUOTENAME(@name)+N'; ALTER ROLE db_owner ADD MEMBER '+QUOTENAME(@name);EXEC(@sql)")
  const source=await connect(proof,'fixture_mssql_source')
  async function snapshot(){
    const catalog=(await target.request().query(`SELECT name,type_desc,default_schema_name,CONVERT(varchar(max),sid,2) AS sid FROM sys.database_principals ORDER BY principal_id;
      SELECT role_principal_id,member_principal_id FROM sys.database_role_members ORDER BY role_principal_id,member_principal_id;
      SELECT class,major_id,minor_id,grantee_principal_id,grantor_principal_id,type,state FROM sys.database_permissions ORDER BY class,major_id,minor_id,grantee_principal_id,grantor_principal_id,type,state;
      SELECT name,principal_id FROM sys.schemas ORDER BY schema_id;
      SELECT name,type FROM sys.objects WHERE is_ms_shipped=0 ORDER BY object_id;
      SELECT collation_name,compatibility_level,user_access,state,is_read_only,is_trustworthy_on,is_db_chaining_on,is_broker_enabled,snapshot_isolation_state,is_read_committed_snapshot_on,recovery_model,CONVERT(varchar(max),owner_sid,2) AS owner_sid FROM sys.databases WHERE database_id=DB_ID();`)).recordsets
    const server=(await observer.request().query("SELECT name,CONVERT(varchar(max),sid,2) AS sid,is_disabled FROM sys.sql_logins ORDER BY name; SELECT role_principal_id,member_principal_id FROM sys.server_role_members ORDER BY role_principal_id,member_principal_id; SELECT class,major_id,grantee_principal_id,grantor_principal_id,type,state FROM sys.server_permissions ORDER BY class,major_id,grantee_principal_id,grantor_principal_id,type,state;")).recordsets
    const sourceFacts=(await source.request().query("SELECT is_read_only FROM sys.databases WHERE database_id=DB_ID();SELECT * FROM dbo.projects ORDER BY id;SELECT * FROM dbo.entries ORDER BY id;")).recordsets
    if(!Array.isArray(sourceFacts)||sourceFacts[0]?.[0]?.is_read_only!==true&&sourceFacts[0]?.[0]?.is_read_only!==1||sourceFacts[1]?.length!==2||sourceFacts[2]?.length!==3)throw new Error('Read-only source fixture changed')
    const checks=(await target.request().input('login',mssql.NVarChar,targetLogin).query("SELECT (SELECT COUNT(*) FROM sys.objects WHERE is_ms_shipped=0) AS objects,IS_ROLEMEMBER('db_owner',@login) AS targetOwner,(SELECT COUNT(*) FROM sys.database_principals WHERE name='fixture_mssql_reader') AS sourcePrincipal")).recordset[0]
    if(checks.objects!==0||checks.targetOwner!==1||checks.sourcePrincipal!==0)throw new Error('Target catalog or membership changed')
    return {catalog,server,sourceFacts}
  }
  stage='before-import'
  const limited=await connect(proof,targetName,targetLogin,password)
  const role=(await limited.request().query("SELECT IS_ROLEMEMBER('db_owner') AS owner,(SELECT COUNT(*) FROM sys.fn_my_permissions(NULL,'SERVER') WHERE permission_name NOT IN ('CONNECT SQL','VIEW ANY DATABASE')) AS privileged")).recordset[0]
  if(role.owner!==1||role.privileged!==0)throw new Error('Target is not independently restricted')
  await limited.close()
  const before=await snapshot(),dir=await mkdtemp('/tmp/steelkeep-policy-deny-')
  await writeFile(baselinePath,JSON.stringify(before),{mode:0o600,flag:'wx'})
  let error:Record<string,unknown>
  try{
    const request=dir+'/request.json'
    await writeFile(request,JSON.stringify({mode:'import',host:proof.sqlHost,port:proof.sqlPort,database:targetName,user:targetLogin,password,tls:false,restoreTarget:true,file:artifact}),{mode:0o600,flag:'wx'})
    stage='negative-import-once'
    const output=await runTool('dotnet',['/opt/steelkeep-dacfx/Steelkeep.DacFx.dll'],{signal:AbortSignal.timeout(120000),env:toolEnv({DOTNET_CLI_HOME:dir,DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_NOLOGO:'1',DOTNET_EnableDiagnostics:'0'}),stdinFile:request,capture:true,captureLimitBytes:4096,timeoutMs:120000})
    error=JSON.parse(output).error
    const diagnostic=error?.policyDiagnostic as Record<string,unknown>|undefined
    if(error?.code!=='MSSQL_HELPER_FAILED'||error.stage!=='import'||diagnostic?.contributorEntered!==true||diagnostic.planAcknowledged!==false||diagnostic.reason!=='compile_probe')throw new Error('Required callback refusal not established')
  }finally{await rm(dir,{recursive:true,force:true})}
  stage='independent-after'
  const after=await snapshot();if(!isDeepStrictEqual(before,after))throw new Error('Read-only callback gate changed catalogs or source')
  const holdAfter=await proofMetadata(proof,'SELECT run_id FROM target_blocks WHERE target_id=$1',['38862a02-7954-4988-805b-cc45df7b8ec5']);if(!isDeepStrictEqual(held,holdAfter))throw new Error('Original quarantine changed')
  const result={proof:'negative-import-policy',status:'passed',targetName,targetLogin,archiveSha,contributorEntered:true,planAcknowledged:false,reason:'compile_probe',actualImportCalls:1,targetCatalogAndPermissionsUnchanged:true,serverLoginsRolesPermissionsUnchanged:true,sourceReadOnlyRowsUnchanged:true,oldHeldTargetGuardUnchanged:true,beforeHash:hash(before),afterHash:hash(after),replayAllowed:false,reuseAllowed:false}
  await writeFile(resultPath,JSON.stringify(result),{mode:0o600,flag:'wx'});console.log(JSON.stringify(result))
}
try{await main()}catch{
  const result={proof:'negative-import-policy',status:'refused',stage,targetName,targetLogin,createdState,quarantined:true,replayAllowed:false,reuseAllowed:false}
  if(createdState)await writeFile(resultPath,JSON.stringify(result),{mode:0o600,flag:'wx'}).catch(()=>{})
  console.log(JSON.stringify(result));process.exitCode=1
}finally{await Promise.allSettled(pools.map(pool=>pool.close()))}
