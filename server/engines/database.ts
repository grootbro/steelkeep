import pg from 'pg'
import mysql,{type RowDataPacket,type Connection} from 'mysql2/promise'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {DatabaseConfig,DbSecret} from '../services'
import {AppError,allowedHost,identifier} from '../security'
import {runTool,toolEnv} from '../process'
import {config as installation} from '../config'

export type {Engine,Manifest,Identity} from './types'
import type {Engine,Manifest,Identity} from './types'
const pgName=(s:string)=>'"'+s.replaceAll('"','""')+'"'
const myName=(s:string)=>'`'+s.replaceAll('`','``')+'`'
export const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail=(code:string,message:string):never=>{throw new AppError(code,message)}
const checkSignal=(signal?:AbortSignal)=>{if(signal?.aborted)fail('CANCELLED','Operation cancelled.')}

export function metadataDatabase(){
  try{
    const name=decodeURIComponent(new URL(installation.databaseUrl()).pathname.slice(1))
    if(!name||name.includes('/'))return fail('INSTALLATION_CONFIG','Set an explicit metadata database name before performing backup or restore.')
    return name.toLowerCase()
  }
  catch{return fail('INSTALLATION_CONFIG','The metadata database identity could not be determined.')}
}
export function assertProtectedDatabase(name:string){
  if(!name||[metadataDatabase(),'postgres','template0','template1','mysql','information_schema','performance_schema','sys','admin','config','local','system','master','model','msdb','tempdb'].includes(name.toLowerCase()))fail('PROTECTED_DATABASE','System and Steelkeep metadata databases cannot participate in this operation.')
}

export class DatabaseSession {
  private postgres?:pg.Client
  private maria?:Connection
  private locked=false
  private closed=false
  private lost=new AbortController()
  readonly failureSignal=this.lost.signal
  constructor(readonly engine:Engine,readonly config:DatabaseConfig,private secret:DbSecret,private signal?:AbortSignal){}
  async connect(){
    allowedHost(this.config.host);identifier(this.config.database)
    checkSignal(this.signal)
    if(this.engine==='postgres'){
      this.postgres=new pg.Client({host:this.config.host,port:this.config.port,database:this.config.database,user:this.config.user,password:this.secret.password,
        ssl:this.config.tls?{rejectUnauthorized:true}:false,connectionTimeoutMillis:5000,statement_timeout:120000,query_timeout:125000})
      this.postgres.on('error',this.connectionLost)
      await this.postgres.connect()
      await this.query("SET TIME ZONE 'UTC'")
      await this.query("SET DateStyle TO 'ISO, YMD'")
      await this.query("SET extra_float_digits TO 3")
      await this.query("SET intervalstyle TO 'postgres'")
      await this.query("SET search_path TO pg_catalog")
      await this.query("SET bytea_output TO 'hex'")
      await this.query("SET lc_monetary TO 'C'")
    }else{
      this.maria=await mysql.createConnection({host:this.config.host,port:this.config.port,database:this.config.database,user:this.config.user,password:this.secret.password,
        ssl:this.config.tls?{rejectUnauthorized:true,verifyIdentity:true}:undefined,connectTimeout:5000,multipleStatements:false,supportBigNumbers:true,bigNumberStrings:true,dateStrings:true,timezone:'Z'})
      this.maria.on('error',this.connectionLost)
      await this.query("SET time_zone = '+00:00'")
      if(this.engine==='mysql')await this.query('SET SESSION information_schema_stats_expiry=0')
    }
    this.signal?.addEventListener('abort',this.abort,{once:true})
    checkSignal(this.signal)
    return this.identity()
  }
  private abort=()=>{void this.postgres?.end().catch(()=>{});this.maria?.destroy()}
  private connectionLost=()=>{
    if(this.closed)return
    this.lost.abort(new AppError('DATABASE_SESSION_LOST','The database inspection session was lost. Native execution has been stopped.'))
    this.abort()
  }
  async query(text:string,values:unknown[]=[]):Promise<Record<string,unknown>[]>{
    if(this.lost.signal.aborted)throw this.lost.signal.reason
    checkSignal(this.signal)
    if(this.postgres)return (await this.postgres.query(text,values)).rows as Record<string,unknown>[]
    if(this.maria){const [rows]=await this.maria.query<RowDataPacket[]>({sql:text,timeout:120000},values);return rows as Record<string,unknown>[]}
    return fail('DATABASE_UNAVAILABLE','The database session is not connected.')
  }
  async identity():Promise<Identity>{
    const [row]=this.engine==='postgres'?await this.query("SELECT current_database() AS name,current_setting('server_version') AS version"):
      await this.query('SELECT DATABASE() AS name,VERSION() AS version')
    const database=String(row.name),serverVersion=String(row.version)
    if(database!==this.config.database)fail('IDENTITY_UNCERTAIN','The database did not report the configured database name.')
    if(this.engine==='postgres'&&Number.parseInt(serverVersion)!==17)fail('UNSUPPORTED_VERSION','This release supports PostgreSQL 17 only.')
    if(this.engine==='mariadb'&&(!serverVersion.toLowerCase().includes('mariadb')||Number.parseInt(serverVersion)!==11))fail('UNSUPPORTED_VERSION','This release supports MariaDB 11 only.')
    if(this.engine==='mysql'&&(serverVersion.toLowerCase().includes('mariadb')||Number.parseInt(serverVersion)!==8))fail('UNSUPPORTED_VERSION','This release supports MySQL 8 only.')
    return {engine:this.engine,database,serverVersion}
  }
  async beginSnapshot():Promise<string|undefined>{
    if(this.engine==='postgres'){
      await this.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const [row]=await this.query('SELECT pg_export_snapshot() AS snapshot')
      return String(row.snapshot)
    }
    // The independent native dump and manifest must observe the same state.
    // This explicit global read lock needs RELOAD; release in finally, never background.
    await this.query('FLUSH TABLES WITH READ LOCK');this.locked=true
    return undefined
  }
  async finishSnapshot(){
    if(this.engine==='postgres')await this.query('ROLLBACK')
    else if(this.locked){await this.query('UNLOCK TABLES');this.locked=false}
  }
  async empty(){
    if(this.engine==='postgres'){
      const [row]=await this.query(`SELECT (
        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_' AND c.relkind IN ('r','p','v','m','S','f','c')) +
        (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_' AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.classid='pg_proc'::regclass AND d.deptype='e')) +
        (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_' AND t.typtype IN ('e','d','r','m')) +
        (SELECT count(*) FROM pg_extension WHERE extname<>'plpgsql') +
        (SELECT count(*) FROM pg_namespace WHERE nspname<>'public' AND nspname<>'information_schema' AND nspname !~ '^pg_') +
        (SELECT count(*) FROM pg_largeobject_metadata)
      )::text AS objects`)
      return row.objects==='0'
    }
    const [row]=await this.query(`SELECT (
      (SELECT count(*) FROM information_schema.tables WHERE table_schema=DATABASE())+
      (SELECT count(*) FROM information_schema.routines WHERE routine_schema=DATABASE())+
      (SELECT count(*) FROM information_schema.events WHERE event_schema=DATABASE())
    ) AS objects`)
    return Number(row.objects)===0
  }
  async restrictedRestoreRole(){
    if(this.engine==='postgres'){
      const [role]=await this.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')
      if(!role||Object.values(role).some(Boolean))fail('UNSAFE_TARGET_ROLE','Use a dedicated restore role without superuser, create-database, create-role or replication privileges.')
      const memberships=await this.query('SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=current_user LIMIT 1')
      if(memberships.length)fail('UNSAFE_TARGET_ROLE','The dedicated restore role must not inherit privileges from other roles.')
      const [schema]=await this.query("SELECT has_schema_privilege(current_user,'public','CREATE') AS can_create")
      if(!schema.can_create)fail('TARGET_PERMISSIONS','The dedicated restore role needs CREATE on the empty target public schema.')
      return
    }
    const grants=await this.query('SHOW GRANTS FOR CURRENT_USER()')
    const target='ON '+myName(this.config.database)+'.* TO '
    for(const grant of grants){
      const statement=String(Object.values(grant)[0])
      if(statement.includes('WITH GRANT OPTION')||!(/^GRANT USAGE ON \*\.\* TO /.test(statement)||statement.includes(target)))fail('UNSAFE_TARGET_ROLE','Use a dedicated restore role with privileges only on the selected target database and no grant option or inherited roles.')
    }
    await this.sourceMetadataVisibility()
  }
  async sourceMetadataVisibility(){
    if(this.engine==='postgres')return
    const grants=await this.query('SHOW GRANTS FOR CURRENT_USER()'),permissions=new Set<string>()
    for(const row of grants){
      const match=String(Object.values(row)[0]).match(/^GRANT (.+) ON (.+) TO /)
      if(!match||!['*.*',myName(this.config.database)+'.*'].includes(match[2]))continue
      if(match[1]==='ALL PRIVILEGES')return
      for(const permission of match[1].split(','))permissions.add(permission.trim())
    }
    if(['SELECT','SHOW VIEW','TRIGGER','EVENT','EXECUTE'].some(p=>!permissions.has(p)))fail('DATABASE_METADATA_PERMISSIONS','The account needs SELECT, SHOW VIEW, TRIGGER, EVENT and EXECUTE on this database so existing schema objects cannot be silently hidden.')
  }
  async manifest():Promise<Manifest>{
    const identity=await this.identity()
    return this.engine==='postgres'?this.pgManifest(identity):this.myManifest(identity)
  }
  private async pgManifest(identity:Identity):Promise<Manifest>{
    // Native logical restore compacts dropped-column slots; compare visible logical ordinals.
    const namespace="n.nspname<>'information_schema' AND n.nspname !~ '^pg_'"
    const tables=await this.query(`SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,c.relispopulated FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespace} AND c.relkind IN ('r','p','m') ORDER BY n.nspname,c.relname`)
    if(tables.length>500)fail('RESOURCE_LIMIT','This release limits a backup to 500 tables.')
    const foreign=await this.query(`SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespace} AND c.relkind='f' LIMIT 1`)
    if(foreign.length)fail('UNSUPPORTED_SCHEMA','Foreign tables require an external data recovery strategy and are not supported yet.')
    const extensions=await this.query("SELECT extname FROM pg_extension WHERE extname<>'plpgsql' LIMIT 1")
    if(extensions.length)fail('UNSUPPORTED_SCHEMA','This release requires an extension-free PostgreSQL source apart from plpgsql. Extension-specific restore and validation are not yet implemented.')
    const largeObjects=await this.query('SELECT oid FROM pg_largeobject_metadata LIMIT 1')
    if(largeObjects.length)fail('UNSUPPORTED_SCHEMA','PostgreSQL large objects require separate recovery validation and are not supported in this release. Bytea columns are supported.')
    const objects:Record<string,unknown>={
      schemas:await this.query(`SELECT n.nspname AS name FROM pg_namespace n WHERE ${namespace} ORDER BY n.nspname`),
      columns:await this.query(`SELECT n.nspname AS schema,c.relname AS table_name,a.attname AS name,(row_number() OVER (PARTITION BY c.oid ORDER BY a.attnum))::integer AS attnum,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE ${namespace} AND c.relkind IN ('r','p','m','c') AND a.attnum>0 AND NOT a.attisdropped ORDER BY n.nspname,c.relname,a.attnum`),
      constraints:await this.query(`SELECT n.nspname AS schema,c.relname AS table,k.conname AS name,pg_get_constraintdef(k.oid,true) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespace} ORDER BY n.nspname,c.relname,k.conname`),
      indexes:await this.query(`SELECT n.nspname AS schema,c.relname AS table,i.relname AS name,pg_get_indexdef(i.oid) AS definition FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespace} ORDER BY n.nspname,c.relname,i.relname`),
      views:await this.query(`SELECT n.nspname AS schema,c.relname AS name,c.relkind,pg_get_viewdef(c.oid,true) AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespace} AND c.relkind IN ('v','m') ORDER BY n.nspname,c.relname`),
      triggers:await this.query(`SELECT n.nspname AS schema,c.relname AS table,t.tgname AS name,pg_get_triggerdef(t.oid,true) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespace} AND NOT t.tgisinternal ORDER BY n.nspname,c.relname,t.tgname`),
      routines:await this.query(`SELECT n.nspname AS schema,p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${namespace} AND p.prokind IN ('f','p') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.classid='pg_proc'::regclass AND d.deptype='e') ORDER BY n.nspname,p.proname,arguments`),
      enums:await this.query(`SELECT n.nspname AS schema,t.typname AS name,e.enumlabel,e.enumsortorder FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE ${namespace} ORDER BY n.nspname,t.typname,e.enumsortorder`)
    }
    const data:Record<string,unknown>={},sequences:Record<string,unknown>={}
    for(const table of tables){
      const name=`${pgName(String(table.schema))}.${pgName(String(table.name))}`
      if(table.kind==='m'&&!table.relispopulated){data[name]={state:'unpopulated'};continue}
      const [row]=await this.query(`SELECT count(*)::text AS rows,COALESCE(sum(('x'||substr(md5(row_to_json(t)::text),1,16))::bit(64)::bigint),0)::text AS hash_a,COALESCE(sum(('x'||substr(md5(row_to_json(t)::text),17,16))::bit(64)::bigint),0)::text AS hash_b FROM ${name} AS t`)
      data[name]=row
    }
    const seqs=await this.query(`SELECT n.nspname AS schema,c.relname AS name,s.seqstart::text,s.seqincrement::text,s.seqmax::text,s.seqmin::text,s.seqcache::text,s.seqcycle FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespace} ORDER BY n.nspname,c.relname`)
    for(const seq of seqs){
      const name=`${pgName(String(seq.schema))}.${pgName(String(seq.name))}`
      const [state]=await this.query(`SELECT last_value::text,is_called FROM ${name}`)
      sequences[name]={...seq,...state}
    }
    return {format:1,...identity,objects:Object.fromEntries(Object.entries(objects).map(([key,value])=>[key,digest(value)])),data,sequences}
  }
  private async myManifest(identity:Identity):Promise<Manifest>{
    // An unqualified SQL dump cannot safely rebind arbitrary cross-database code.
    const [unsupported]=await this.query(`SELECT (
      (SELECT count(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type<>'BASE TABLE')+
      (SELECT count(*) FROM information_schema.triggers WHERE trigger_schema=DATABASE())+
      (SELECT count(*) FROM information_schema.routines WHERE routine_schema=DATABASE())+
      (SELECT count(*) FROM information_schema.events WHERE event_schema=DATABASE())+
      (SELECT count(*) FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE() AND unique_constraint_schema<>DATABASE())
    ) AS objects`)
    if(Number(unsupported.objects))fail('UNSUPPORTED_SCHEMA','This MySQL/MariaDB release supports InnoDB tables, indexes, constraints and auto-increment. Views, stored programs, events and cross-database references need a reviewed rebinding strategy.')
    const tables=await this.query("SELECT table_name AS name,engine AS engine FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY table_name")
    if(tables.length>500)fail('RESOURCE_LIMIT','This release limits a backup to 500 tables.')
    const objects:Record<string,unknown>={},data:Record<string,unknown>={},sequences:Record<string,unknown>={}
    for(const table of tables){
      if(String(table.engine).toLowerCase()!=='innodb')fail('UNSUPPORTED_SCHEMA','Only transactional InnoDB tables are supported.')
      const name=myName(String(table.name)),[ddl]=await this.query(`SHOW CREATE TABLE ${name}`)
      objects[name]=digest(ddl['Create Table'])
      const columns=await this.query('SELECT column_name AS name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? ORDER BY ordinal_position',[table.name])
      if(columns.length>512)fail('RESOURCE_LIMIT','This release limits each table to 512 columns.')
      const rowExpression=columns.map(c=>`IFNULL(HEX(CAST(${myName(String(c.name))} AS BINARY)),'~')`).join(',')
      const hash=`MD5(CONCAT_WS('#',${rowExpression}))`
      const [sum]=await this.query(`SELECT CAST(count(*) AS CHAR) AS \`rows\`,CAST(COALESCE(sum(CAST(CONV(SUBSTR(${hash},1,15),16,10) AS DECIMAL(65,0))),0) AS CHAR) AS hash_a,CAST(COALESCE(sum(CAST(CONV(SUBSTR(${hash},16,15),16,10) AS DECIMAL(65,0))),0) AS CHAR) AS hash_b FROM ${name}`)
      data[name]=sum
      const [state]=await this.query('SELECT CAST(auto_increment AS CHAR) AS next_value FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?',[table.name])
      sequences[name]=state
    }
    return {format:1,...identity,objects,data,sequences}
  }
  async close(){
    if(this.closed)return
    this.closed=true
    this.signal?.removeEventListener('abort',this.abort)
    try{if(this.locked)await this.finishSnapshot()}finally{await this.postgres?.end();await this.maria?.end()}
  }
}

export function manifestComparison(expected:Manifest,actual:Manifest){
  // Compare the JSON representation persisted in JSONB, not key order or JS prototypes.
  const same=(a:unknown,b:unknown)=>isDeepStrictEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)))
  const checks={schema:same(expected.objects,actual.objects),data:same(expected.data,actual.data),sequences:same(expected.sequences,actual.sequences)}
  return {passed:Object.values(checks).every(Boolean),checks,tableCount:Object.keys(expected.data).length,method:'row-count-and-order-independent-row-digests',note:'Data digests detect accidental recovery differences; they are not a cryptographic proof against deliberately colliding source data.'}
}

export async function nativeCredentials(engine:Engine,c:DatabaseConfig,s:DbSecret,dir:string){
  if(/[\r\n\0]/.test([c.host,c.user,c.database,s.password].join('')))fail('INVALID_CREDENTIAL','Control characters are not supported in database credentials.')
  if(engine==='postgres'){
    const path=join(dir,'pgpass'),escape=(v:string)=>v.replaceAll('\\','\\\\').replaceAll(':','\\:')
    await writeFile(path,[c.host,String(c.port),c.database,c.user,s.password].map(escape).join(':')+'\n',{mode:0o600,flag:'wx'})
    return {env:toolEnv({PGPASSFILE:path,PGSSLMODE:c.tls?'verify-full':'disable',PGCONNECT_TIMEOUT:'10',PGOPTIONS:'-c timezone=UTC -c datestyle=ISO,YMD -c extra_float_digits=3 -c intervalstyle=postgres -c search_path=pg_catalog -c bytea_output=hex -c lc_monetary=C'}),args:['--host',c.host,'--port',String(c.port),'--username',c.user,'--dbname',c.database,'--no-password']}
  }
  const path=join(dir,'client.cnf'),escape=(v:string)=>'"'+v.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"'
  const transport=engine==='mysql'?`ssl-mode=${c.tls?'VERIFY_IDENTITY':'DISABLED'}${c.tls?'':'\nget-server-public-key=TRUE'}`:`ssl=${c.tls?'true':'false'}\nssl-verify-server-cert=${c.tls?'true':'false'}`
  await writeFile(path,`[client]\nhost=${escape(c.host)}\nport=${c.port}\nuser=${escape(c.user)}\npassword=${escape(s.password)}\nprotocol=tcp\n${transport}\n`,{mode:0o600,flag:'wx'})
  return {env:toolEnv(),args:[`--defaults-file=${path}`,...(engine==='mysql'?['--no-login-paths']:[])]}
}

export async function nativeVersion(engine:Engine,signal:AbortSignal){
  const binary=engine==='postgres'?'pg_dump':engine==='mariadb'?'mariadb-dump':'mysqldump'
  const version=await runTool(binary,['--version'],{env:toolEnv(),signal,capture:true,timeoutMs:10000})
  if(engine==='postgres'&&!/\b17\./.test(version))fail('UNSUPPORTED_TOOL','The worker requires PostgreSQL 17 client tools.')
  if(engine==='mariadb'&&(!/mariadb/i.test(version)||!/(?:Distrib |from |Ver )11\./i.test(version)))fail('UNSUPPORTED_TOOL','The worker requires MariaDB 11 client tools.')
  if(engine==='mysql'&&(!/\b8\./.test(version)||/mariadb/i.test(version)))fail('UNSUPPORTED_TOOL','The worker requires a MySQL 8 client for MySQL sources.')
  return {binary,version}
}
