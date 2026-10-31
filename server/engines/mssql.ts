import {mkdtemp,writeFile,rm,realpath,stat,statfs} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,isAbsolute} from 'node:path'
import mssql from 'mssql'
import type {AdapterOptions,EngineAdapter,Identity,Manifest} from './types'
import {AppError,allowedHost,databaseName} from '../security'
import {assertArchiveSize,maxArchiveBytes,runTool,toolEnv} from '../process'

type Inspection={identity:Identity;empty:boolean;restricted:boolean;manifest?:Manifest;toolVersion:string;packageVersion?:string}

const helperFailures={
  request:'The SQL Server helper refused its input or execution platform.',
  connection:'The SQL Server helper could not establish its database session.',
  identity:'The SQL Server helper could not verify the selected database identity.',
  catalog:'The SQL Server helper could not inspect the database catalog.',
  manifest:'The SQL Server source or target does not satisfy the portable validation profile.',
  manifest_permissions:'The SQL Server validation could not verify database permissions.',
  manifest_features:'The SQL Server validation could not verify portable database features.',
  manifest_tables:'The SQL Server validation could not verify the user-table catalog.',
  manifest_columns:'The SQL Server validation could not verify portable column types.',
  manifest_schema:'The SQL Server validation could not verify the complete schema catalog.',
  manifest_data:'The SQL Server validation could not verify the complete row digest.',
  manifest_sequences:'The SQL Server validation could not verify identity and sequence values.',

  export:'The SQL Server BACPAC export failed; no successful archive is implied.',
  import:'The SQL Server BACPAC import failed; its target remains protected until reviewed.',
  runtime:'The SQL Server helper could not verify its pinned DacFx runtime.'
} as const

export function parseMssqlHelperResponse(output:string,database:string):Inspection {
  let result:Inspection&{error?:{code?:unknown;stage?:unknown}}
  try{result=JSON.parse(output)}catch{throw new AppError('INVALID_TOOL_RESPONSE','The SQL Server helper returned an invalid result.')}
  if(!result||typeof result!=='object')throw new AppError('INVALID_TOOL_RESPONSE','The SQL Server helper returned an invalid result.')
  if(result.error?.code==='MSSQL_HELPER_FAILED'&&typeof result.error.stage==='string'&&Object.hasOwn(helperFailures,result.error.stage)){
    const stage=result.error.stage as keyof typeof helperFailures
    throw new AppError('MSSQL_HELPER_'+stage.toUpperCase(),helperFailures[stage])
  }
  if(result.error)throw new AppError('INVALID_TOOL_RESPONSE','The SQL Server helper returned an invalid failure result.')
  if(result.identity?.engine!=='mssql'||result.identity.database!==database||typeof result.empty!=='boolean'||typeof result.restricted!=='boolean'||result.packageVersion!=='170.5.96'||typeof result.toolVersion!=='string'||!/^DacFx 170\.[0-9.]+$/.test(result.toolVersion))throw new AppError('INVALID_TOOL_RESPONSE','The SQL Server helper identity or actual runtime version could not be verified.')
  return result
}

/** Optional x64 DacFx profile. BACPAC portability is distinct from native SQL Server disaster recovery. */
export function createMssqlAdapter(options:AdapterOptions):EngineAdapter {
  const {config,secret}=options
  const failure=new AbortController()
  const signal=AbortSignal.any([options.signal,failure.signal])
  const database=String(config.database??'')
  databaseName(database);allowedHost(String(config.host??''))
  if(['master','model','msdb','tempdb','steelkeep'].includes(database.toLowerCase()))throw new AppError('PROTECTED_DATABASE','SQL Server system and metadata databases are protected.')
  if(!Number.isInteger(config.port)||Number(config.port)<1||Number(config.port)>65535||!config.user||typeof secret.password!=='string'||!secret.password)throw new AppError('INVALID_CONNECTION','SQL Server requires a valid TCP endpoint and SQL authentication.')
  let toolVersion=''
  let pool:mssql.ConnectionPool|undefined
  const abort=()=>{void pool?.close().catch(()=>{})}
  signal.addEventListener('abort',abort,{once:true})
  async function inspect():Promise<Inspection>{
    if(signal.aborted)throw new AppError('CANCELLED','Operation cancelled.')
    if(!pool){
      pool=new mssql.ConnectionPool({server:String(config.host),port:Number(config.port),database,user:String(config.user),password:String(secret.password),connectionTimeout:10000,requestTimeout:15000,pool:{max:2,min:0},options:{encrypt:config.tls===true,trustServerCertificate:false,enableArithAbort:true}})
      pool.on('error',()=>failure.abort(new AppError('DATABASE_SESSION_LOST','The SQL Server inspection session was lost.')))
      await pool.connect()
    }
    if(signal.aborted)throw new AppError('CANCELLED','Operation cancelled.')
    const result=await pool.request().query<{database:string;serverVersion:string;major:number;serverName:string;empty:number;restricted:number}>(`SELECT DB_NAME() AS [database],CONVERT(nvarchar(128),SERVERPROPERTY('ProductVersion')) AS serverVersion,CONVERT(int,SERVERPROPERTY('ProductMajorVersion')) AS major,CONVERT(nvarchar(128),SERVERPROPERTY('ServerName')) AS serverName,
      CASE WHEN NOT EXISTS(SELECT 1 FROM sys.objects WHERE is_ms_shipped=0) AND NOT EXISTS(SELECT 1 FROM sys.schemas WHERE schema_id>4 AND schema_id<16384) AND NOT EXISTS(SELECT 1 FROM sys.types WHERE is_user_defined=1)
      AND NOT EXISTS(SELECT 1 FROM sys.database_scoped_credentials) AND NOT EXISTS(SELECT 1 FROM sys.external_data_sources) AND NOT EXISTS(SELECT 1 FROM sys.external_file_formats) AND NOT EXISTS(SELECT 1 FROM sys.assemblies WHERE is_user_defined=1) AND NOT EXISTS(SELECT 1 FROM sys.security_policies) AND NOT EXISTS(SELECT 1 FROM sys.partition_functions) AND NOT EXISTS(SELECT 1 FROM sys.certificates) AND NOT EXISTS(SELECT 1 FROM sys.symmetric_keys) AND NOT EXISTS(SELECT 1 FROM sys.asymmetric_keys) AND NOT EXISTS(SELECT 1 FROM sys.external_libraries) AND NOT EXISTS(SELECT 1 FROM sys.external_languages WHERE language NOT IN (N'R',N'Python')) AND NOT EXISTS(SELECT 1 FROM sys.xml_schema_collections WHERE xml_collection_id>0 AND schema_id<>4) THEN 1 ELSE 0 END AS empty,
      CASE WHEN IS_ROLEMEMBER('db_owner')=1 AND HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','VIEW DEFINITION')=1 AND NOT EXISTS(SELECT 1 FROM sys.fn_my_permissions(NULL,'SERVER') WHERE permission_name NOT IN ('CONNECT SQL','VIEW ANY DATABASE')) THEN 1 ELSE 0 END AS restricted`)
    const row=result.recordset[0]
    if(!row||row.database!==database||![15,16].includes(row.major))throw new AppError('UNSUPPORTED_VERSION','This SQL Server profile requires a verified SQL Server 2019 or 2022 database identity.')
    return {identity:{engine:'mssql',database,serverVersion:row.serverVersion,binding:row.serverName+':'+database},empty:row.empty===1,restricted:config.restoreTarget===true&&row.restricted===1,toolVersion}
  }
  async function call(mode:'inspect'|'manifest'|'export'|'import',file?:string):Promise<Inspection>{
    if(signal.aborted)throw new AppError('CANCELLED','Operation cancelled.')
    const configured=process.env.STEELKEEP_DACFX_HELPER
    if(!configured||!isAbsolute(configured)||!configured.endsWith('.dll'))throw new AppError('ENGINE_PROFILE_REQUIRED','SQL Server needs the explicitly provisioned Linux x64 DacFx helper. See docs/engine-profiles.md.')
    let helper:string
    try{helper=await realpath(configured);if(!(await stat(helper)).isFile())throw new Error()}catch{throw new AppError('TOOL_UNAVAILABLE','The configured SQL Server helper is unavailable.')}
    const dir=await mkdtemp(join(tmpdir(),'steelkeep-dacfx-')),request=join(dir,'request.json')
    try{
      await writeFile(request,JSON.stringify({mode,host:config.host,port:config.port,database,user:config.user,password:secret.password,tls:config.tls===true,restoreTarget:config.restoreTarget===true,file}),{mode:0o600,flag:'wx'})
      const output=await runTool('dotnet',[helper],{signal,env:toolEnv({DOTNET_CLI_TELEMETRY_OPTOUT:'1',DOTNET_CLI_HOME:dir,DOTNET_NOLOGO:'1',DOTNET_EnableDiagnostics:'0'}),stdinFile:request,capture:true,captureLimitBytes:2*1024*1024,timeoutMs:mode==='inspect'?60000:2*60*60*1000})
      const result=parseMssqlHelperResponse(output,database)
      toolVersion=result.toolVersion
      return result
    }finally{await rm(dir,{recursive:true,force:true})}
  }
  const adapter:EngineAdapter={
    engine:'mssql',archiveExtension:'.bacpac',failureSignal:failure.signal,
    async connect(){return (await inspect()).identity},
    async identity(){return (await inspect()).identity},
    async empty(){return (await inspect()).empty},
    async restrictedRestoreRole(){if(!(await inspect()).restricted)throw new AppError('UNSAFE_TARGET_ROLE','Use a dedicated SQL Server target login with db_owner on the precreated target and no privileged server role.')},
    async manifest(){const result=await call('manifest');if(!result.manifest)throw new AppError('INVALID_TOOL_RESPONSE','The SQL Server validation manifest is missing.');return result.manifest},
    async backup(file,_dir,_signal,phase){
      if(config.restoreTarget)throw new AppError('INVALID_SOURCE','Restore targets cannot be backup sources.')
      const space=await statfs(_dir)
      if(space.bavail*space.bsize<2*maxArchiveBytes+128*1024*1024)throw new AppError('DISK_SPACE','SQL Server export needs 4 GiB plus 128 MiB for its bounded archive and table-data scratch space.')
      await options.checkpoint?.()
      await phase('manifest','Inspecting a read-only SQL Server source and its application schema and data.')
      const before=await adapter.manifest()
      await phase('dumping','Exporting a BACPAC from the read-only database; this profile does not produce a native .bak or transaction log chain.')
      await call('export',file)
      const after=await adapter.manifest()
      if(JSON.stringify(before)!==JSON.stringify(after))throw new AppError('SOURCE_CHANGED','SQL Server source identity, schema or data changed during export.')
      await assertArchiveSize(file);await options.checkpoint?.()
      return {manifest:before,toolVersion}
    },
    async restore(file,_dir,_signal,expected){
      if(expected.engine!=='mssql')throw new AppError('ENGINE_MISMATCH','Choose a SQL Server BACPAC artifact.')
      await adapter.restrictedRestoreRole()
      if(!await adapter.empty())throw new AppError('TARGET_NOT_EMPTY','SQL Server requires a precreated empty target.')
      await assertArchiveSize(file);await options.checkpoint?.()
      // The helper rechecks emptiness and role immediately before DacFx import.
      // Cancellation cannot establish the server-side import outcome; the domain target reservation is retained.
      await call('import',file)
      return {toolVersion}
    },
    async close(){signal.removeEventListener('abort',abort);await pool?.close();pool=undefined}
  }
  return adapter
}
