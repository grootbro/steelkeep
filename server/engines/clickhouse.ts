import {createHash,randomUUID} from 'node:crypto'
import {constants} from 'node:fs'
import {open,realpath,lstat,statfs,mkdir,readdir,rm} from 'node:fs/promises'
import {isAbsolute,relative,join,normalize} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {AppError,allowedHost,identifier} from '../security'
import {assertArchiveSize,maxArchiveBytes} from '../process'
import {assertProtectedDatabase} from './database'
import type {AdapterOptions,EngineAdapter,EnginePhase,Identity,Manifest} from './types'

/**
 * Native ClickHouse 25.8 LTS, one local Atomic database, plain MergeTree tables.
 * Operator-enforced source quiescence is required. Before/after manifests detect
 * changes but are NOT proof of an atomic multi-table snapshot or maintenance.
 * HTTP cancellation is not native cancellation: known operation IDs are journaled
 * before submission and reconciled against system.backups. Unknown native work
 * keeps its journal/archive and must never be automatically replayed.
 * Primary references checked against v25.8.12.129-lts source:
 * https://clickhouse.com/docs/concepts/features/backup-restore/local-disk
 * https://clickhouse.com/docs/concepts/features/interfaces/http
 * https://clickhouse.com/docs/reference/system-tables/backups
 * https://github.com/ClickHouse/ClickHouse/blob/v25.8.12.129-lts/src/Backups/RestoreSettings.cpp
 * https://github.com/ClickHouse/ClickHouse/blob/v25.8.12.129-lts/src/Functions/formatRow.cpp
 */
export type ClickHouseConfig={host:string;port:number;database:string;user:string;tls:boolean;restoreTarget:boolean;backupDisk:string;sharedBackupRoot:string;quiescentSource?:boolean}
type Row=Record<string,unknown>
type Journal={id:string;kind:'backup'|'restore';queryId:string;archive:string;database:string;server:string;createdAt:string}
type NativeStatus='CREATING_BACKUP'|'BACKUP_CREATED'|'BACKUP_FAILED'|'RESTORING'|'RESTORED'|'RESTORE_FAILED'|'BACKUP_CANCELLED'|'RESTORE_CANCELLED'
const terminal=new Set(['BACKUP_CREATED','BACKUP_FAILED','RESTORED','RESTORE_FAILED','BACKUP_CANCELLED','RESTORE_CANCELLED','NOT_SUBMITTED'])
const modulus=1n<<256n
const maxTables=500
const maxRows=5_000_000
const maxLineBytes=512*1024
const metadataLimit=2*1024*1024
const quote=(value:string)=>'`'+identifier(value)+'`'
const literal=(value:string)=>"'"+value.replaceAll('\\','\\\\').replaceAll("'","\\'")+"'"
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail=(code:string,message:string):never=>{throw new AppError(code,message)}
const abortCheck=(signal:AbortSignal)=>{if(signal.aborted)fail('CANCELLED','Operation cancelled.')}
const uint=(value:unknown)=>{const text=String(value);if(!/^\d+$/.test(text))fail('INVALID_ENGINE_RESPONSE','ClickHouse returned an invalid nonnegative counter.');return BigInt(text)}
const uuid=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const inside=(root:string,path:string)=>{const child=relative(root,path);return child===''||(!isAbsolute(child)&&child!=='..'&&!child.startsWith('../'))}
const safeArchive=(name:string)=>/^[0-9a-f-]{36}\.zip$/.test(name)
const metadataTables=new Set(['databases','tables','columns','data_skipping_indices','projections','detached_tables','dictionaries','grants','role_grants','enabled_roles','row_policies','disks','backups','mutations','asynchronous_inserts','replicas','clusters','functions','parts'])

export class ClickHouseAdapter implements EngineAdapter {
  readonly engine='clickhouse' as const
  readonly archiveExtension='.zip'
  private failure=new AbortController()
  readonly failureSignal=this.failure.signal
  private config:ClickHouseConfig
  private root?:string
  private rootIdentity?:string
  private journals?:string
  private bound?:Identity
  private native?:Journal
  private nativeFinished=false
  constructor(private options:AdapterOptions){this.config=options.config as unknown as ClickHouseConfig}
  private async checkpoint(signal=this.options.signal){abortCheck(signal);if(this.failureSignal.aborted)throw this.failureSignal.reason;await this.options.checkpoint?.();abortCheck(signal)}
  private endpoint(){
    const c=this.config
    allowedHost(c.host);identifier(c.database);identifier(c.backupDisk);assertProtectedDatabase(c.database)
    if(c.backupDisk.toLowerCase()==='default')fail('BACKUP_DISK_REQUIRED','Use a dedicated local backup disk rather than the default data disk.')
    if(['system','information_schema','default'].includes(c.database.toLowerCase()))fail('PROTECTED_DATABASE','Use a dedicated ClickHouse user database, excluding system, default and installation metadata databases.')
    if(!/^[A-Za-z0-9_.:-]+$/.test(c.host)||!Number.isInteger(c.port)||c.port<1||c.port>65535)fail('INVALID_ENDPOINT','Use an allowlisted ClickHouse HTTP(S) host and TCP port.')
    if(!/^[A-Za-z_][A-Za-z0-9_.@-]{0,79}$/.test(c.user)||typeof this.options.secret.password!=='string'||!this.options.secret.password||/[\r\n\0]/.test(this.options.secret.password))fail('INVALID_CREDENTIAL','Use a nonempty ClickHouse password without control characters and a dedicated database user.')
    const host=c.host.includes(':')?`[${c.host}]`:c.host
    return new URL(`${c.tls?'https':'http'}://${host}:${c.port}/`)
  }
  private async response(sql:string,signal:AbortSignal,settings:Record<string,string>={}):Promise<Response>{
    const url=this.endpoint()
    url.search=new URLSearchParams({database:this.config.database,default_format:'JSONEachRow',wait_end_of_query:'1',max_execution_time:'120',max_result_rows:String(maxRows+1),result_overflow_mode:'throw',max_memory_usage:String(512*1024*1024),output_format_json_quote_64bit_integers:'1',...settings}).toString()
    const response=await fetch(url,{method:'POST',redirect:'error',signal,headers:{Authorization:'Basic '+Buffer.from(`${this.config.user}:${this.options.secret.password}`).toString('base64'),'Content-Type':'text/plain; charset=utf-8'},body:sql})
    if(!response.ok||Number(response.headers.get('X-ClickHouse-Exception-Code')??'0')!==0){await response.body?.cancel().catch(()=>{});fail('CLICKHOUSE_QUERY_FAILED','ClickHouse rejected the operation. Check the documented version, grants and maintenance profile; raw server errors are withheld.')}
    if(!response.body)fail('INVALID_ENGINE_RESPONSE','ClickHouse returned no response body.')
    return response
  }
  private async *rows(sql:string,signal:AbortSignal,limit=metadataLimit,settings:Record<string,string>={}):AsyncGenerator<Row>{
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined
    try{
      const response=await this.response(sql,signal,settings)
      reader=response.body!.getReader()
      const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',bytes=0
      const parse=(line:string):Row=>{const value:unknown=JSON.parse(line);if(!value||typeof value!=='object'||Array.isArray(value))fail('INVALID_ENGINE_RESPONSE','ClickHouse returned a malformed row.');return value as Row}
      while(true){
        const chunk=await reader.read();if(chunk.done)break
        bytes+=chunk.value.byteLength
        if(bytes>limit)fail('RESOURCE_LIMIT','ClickHouse response exceeded its bounded validation limit.')
        pending+=decoder.decode(chunk.value,{stream:true})
        let end:number
        while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(Buffer.byteLength(line)>maxLineBytes)fail('RESOURCE_LIMIT','ClickHouse metadata row exceeds its limit.');if(line.trim())yield parse(line)}
        if(Buffer.byteLength(pending)>maxLineBytes)fail('RESOURCE_LIMIT','ClickHouse metadata row exceeds its limit.')
        abortCheck(signal)
      }
      pending+=decoder.decode()
      if(pending.trim())yield parse(pending)
    }catch(error){
      if(error instanceof AppError)throw error
      if(signal.aborted)fail('CANCELLED','The ClickHouse HTTP request was stopped. This does not confirm cancellation of a native background operation.')
      fail('CLICKHOUSE_QUERY_FAILED','ClickHouse transport or response validation failed. Raw server responses and credentials were not retained.')
    }finally{await reader?.cancel().catch(()=>{});reader?.releaseLock()}
  }
  private async all(sql:string,signal=this.options.signal,settings:Record<string,string>={}){
    const result:Row[]=[]
    for await(const row of this.rows(sql,AbortSignal.any([signal,AbortSignal.timeout(15000)]),metadataLimit,settings)){if(result.length>10_000)fail('RESOURCE_LIMIT','ClickHouse metadata exceeds its row limit.');result.push(row)}
    return result
  }
  private async sharedRoot(signal=this.options.signal){
    const configured=this.config.sharedBackupRoot
    if(typeof configured!=='string'||!isAbsolute(configured))fail('BACKUP_MOUNT_REQUIRED','Configure an absolute sharedBackupRoot mounted at the same canonical path in the worker and ClickHouse server.')
    const actual=await realpath(configured),roots=(process.env.STEELKEEP_CLICKHOUSE_BACKUP_ROOTS??'').split(',').filter(Boolean)
    let permitted=false
    for(const candidate of roots){if(!isAbsolute(candidate))continue;const root=await realpath(candidate);if(root!=='/'&&inside(root,actual)){permitted=true;break}}
    if(!permitted||actual==='/')fail('ENDPOINT_NOT_ALLOWED','The canonical ClickHouse backup directory is outside STEELKEEP_CLICKHOUSE_BACKUP_ROOTS.',403)
    const info=await lstat(actual)
    if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o007)!==0)fail('UNSAFE_BACKUP_MOUNT','The preprovisioned shared ClickHouse backup directory must be a real directory inaccessible to other OS users. Provision its group/ACL for worker and server access.')
    if(this.root&&actual!==this.root)fail('IDENTITY_UNCERTAIN','The shared ClickHouse backup mount changed.')
    const binding=`${info.dev}:${info.ino}`
    if(this.rootIdentity&&this.rootIdentity!==binding)fail('IDENTITY_UNCERTAIN','The shared ClickHouse backup filesystem identity changed.')
    const disks=await this.all(`SELECT name,path,type,free_space FROM system.disks WHERE name=${literal(this.config.backupDisk)}`,signal)
    if(disks.length!==1||String(disks[0]?.type).toLowerCase()!=='local')fail('BACKUP_DISK_REQUIRED','backupDisk must identify an explicitly configured local ClickHouse backup disk, allowed by the server backup configuration.')
    const serverPath=String(disks[0]?.path??'')
    if(!isAbsolute(serverPath)||normalize(serverPath)!==normalize(actual+'/')){
      if(!isAbsolute(serverPath)||await realpath(serverPath)!==actual)fail('BACKUP_MOUNT_MISMATCH','ClickHouse backup disk and worker sharedBackupRoot must resolve to the same canonical mounted path.')
    }
    this.root=actual;this.rootIdentity=binding
    const directory=join(actual,'.steelkeep-operations')
    await mkdir(directory,{mode:0o700}).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='EEXIST')throw error})
    const journalInfo=await lstat(directory)
    if(!journalInfo.isDirectory()||journalInfo.isSymbolicLink()||(journalInfo.mode&0o077)!==0||await realpath(directory)!==directory)fail('UNSAFE_BACKUP_MOUNT','The native-operation journal directory must be private to the worker and contain no symlink.')
    this.journals=directory
    return {root:actual,free:uint(disks[0]?.free_space)}
  }
  async connect(){
    this.endpoint();abortCheck(this.options.signal)
    const identity=await this.identity()
    await this.sharedRoot()
    const probe=await this.all("SELECT hex(formatRow('RowBinary',toUInt8(1))) AS probe")
    if(probe.length!==1||probe[0]?.probe!=='01')fail('VALIDATION_PROFILE_UNAVAILABLE','This ClickHouse profile requires the native RowBinary row formatter for independent lossless row digests.')
    return identity
  }
  async identity():Promise<Identity>{
    const rows=await this.all(`SELECT name,engine,engine_full,comment,toString(uuid) AS uuid,version() AS version,toString(serverUUID()) AS server FROM system.databases WHERE name=${literal(this.config.database)}`)
    if(rows.length!==1||rows[0]?.name!==this.config.database||rows[0]?.engine!=='Atomic'||rows[0]?.engine_full!=='Atomic'||rows[0]?.comment!==''||!uuid(rows[0]?.uuid)||!uuid(rows[0]?.server))fail('IDENTITY_UNCERTAIN','Use a precreated plain local Atomic ClickHouse database without database-level custom settings or comments, with a verifiable server and database UUID.')
    const serverVersion=String(rows[0]?.version)
    if(!/^25\.8\./.test(serverVersion))fail('UNSUPPORTED_VERSION','This native backup profile supports ClickHouse 25.8 LTS only.')
    const identity:Identity={engine:this.engine,database:this.config.database,serverVersion,binding:`${rows[0]!.server}:${rows[0]!.uuid}`}
    if(this.bound&&(this.bound.binding!==identity.binding||this.bound.serverVersion!==identity.serverVersion))fail('IDENTITY_UNCERTAIN','The ClickHouse server, database UUID or version changed during the operation.')
    this.bound=identity
    return identity
  }
  private async requireGrant(privilege:string){
    const rows=await this.all(`CHECK GRANT ${privilege} ON ${quote(this.config.database)}.*`)
    if(rows.length!==1||Number(Object.values(rows[0]!)[0])!==1)fail('DATABASE_PERMISSIONS','The ClickHouse role lacks required whole-database grants; partial visibility cannot prove a complete backup or empty target.')
  }
  async restrictedRestoreRole(){
    if(this.config.restoreTarget!==true)fail('TARGET_NOT_DESIGNATED','Use an explicitly designated ClickHouse restore destination.')
    await this.identity()
    const roles=await this.all('SELECT granted_role_name FROM system.role_grants WHERE user_name=currentUser()')
    if(roles.length)fail('UNSAFE_TARGET_ROLE','The ClickHouse restore user must have direct grants only and no inherited roles.')
    const grants=await this.all('SELECT access_type,access_object,database,table,column,is_partial_revoke,grant_option FROM system.grants WHERE user_name=currentUser()')
    if(!grants.length)fail('TARGET_PERMISSIONS','Effective ClickHouse restore grants could not be established.')
    const allowed=new Set(['SELECT','INSERT','CREATE TABLE','SHOW TABLES','SHOW COLUMNS','SHOW DATABASES'])
    for(const grant of grants){
      if(Number(grant.grant_option)||Number(grant.is_partial_revoke)||grant.column!==null||String(grant.access_object??'')!=='')fail('UNSAFE_TARGET_ROLE','Grant options, partial revokes, column-only and parameterized privileges are not supported by the dedicated restore profile.')
      const type=String(grant.access_type),database=grant.database,table=grant.table
      const target=database===this.config.database&&allowed.has(type)
      const metadata=database==='system'&&type==='SELECT'&&typeof table==='string'&&metadataTables.has(table)
      const inspect=database===null&&table===null&&['USAGE','SHOW USERS','SHOW ROLES','SHOW ROW POLICIES'].includes(type)
      if(!target&&!metadata&&!inspect)fail('UNSAFE_TARGET_ROLE','Use a target-only ClickHouse restore user with SELECT, INSERT and CREATE TABLE; only specific read-only system metadata grants may be added. Global data, external source, destructive and administrative privileges are refused.')
    }
    for(const privilege of ['SELECT','INSERT','CREATE TABLE','SHOW TABLES'])await this.requireGrant(privilege)
    await this.noRowPolicies()
  }
  private async count(sql:string){const rows=await this.all(sql);if(rows.length!==1)fail('INVALID_ENGINE_RESPONSE','ClickHouse count returned no unique result.');return uint(rows[0]?.count)}
  private async noRowPolicies(){
    const grants=await this.all('CHECK GRANT SHOW ROW POLICIES ON *.*')
    if(grants.length!==1||Number(Object.values(grants[0]!)[0])!==1)fail('DATABASE_PERMISSIONS','The ClickHouse validation user requires SHOW ROW POLICIES so hidden policies cannot be mistaken for unrestricted data.')
    if(await this.count(`SELECT count() AS count FROM system.row_policies WHERE database=${literal(this.config.database)}`)!==0n)fail('ROW_POLICY_UNSUPPORTED','ClickHouse row policies must be absent from this database so validation can read all rows.')
  }
  async empty(){
    await this.requireGrant('SHOW TABLES')
    const database=literal(this.config.database)
    const counts=await Promise.all([this.count(`SELECT count() AS count FROM system.tables WHERE database=${database}`),this.count(`SELECT count() AS count FROM system.detached_tables WHERE database=${database}`),this.count(`SELECT count() AS count FROM system.dictionaries WHERE database=${database}`)])
    return counts.every(value=>value===0n)
  }
  private async profile(){
    await this.identity();await this.requireGrant('SHOW TABLES');await this.requireGrant('SELECT');await this.noRowPolicies()
    const database=literal(this.config.database)
    const local=await this.count("SELECT count() AS count FROM system.disks WHERE name='default' AND lower(type)='local'")
    if(local!==1n)fail('UNSUPPORTED_CLICKHOUSE_PROFILE','The default ClickHouse data disk must be local; external storage policies are not supported by this restore profile.')
    const counts=await Promise.all([
      this.count('SELECT count() AS count FROM system.clusters WHERE is_local=0'),
      this.count(`SELECT count() AS count FROM system.replicas WHERE database=${database}`),
      this.count(`SELECT count() AS count FROM system.mutations WHERE database=${database} AND is_done=0`),
      this.count(`SELECT count() AS count FROM system.asynchronous_inserts WHERE database=${database}`),
      this.count(`SELECT count() AS count FROM system.projections WHERE database=${database}`),
      this.count(`SELECT count() AS count FROM system.detached_tables WHERE database=${database}`),
      this.count(`SELECT count() AS count FROM system.dictionaries WHERE database=${database}`),
      this.count("SELECT count() AS count FROM system.functions WHERE origin!='System'")
    ])
    if(counts.some(value=>value!==0n))fail('UNSUPPORTED_CLICKHOUSE_PROFILE','Use a single-node Atomic database without replicas, remote cluster members, pending mutations/inserts, projections, detached tables, dictionaries or SQL/executable user-defined functions.')
  }
  private normalizedDDL(query:string,table:string){
    const prefix=new RegExp('^CREATE TABLE (?:`?'+this.config.database+'`?\\.)?`?'+table+'`?(?: UUID \'[a-f0-9-]{36}\')?(?=\\s*\\()','i')
    if(!prefix.test(query))fail('UNSUPPORTED_SCHEMA','ClickHouse returned a table definition outside the supported ordinary-table syntax.')
    const definition=query.replace(prefix,'CREATE TABLE <database>.<table>')
    if(/\b(TTL|PROJECTION|CONSTRAINT|DEFINER|SQL\s+SECURITY|dictGet|remote|url|jdbc|odbc|executable|s3)\b/i.test(definition))fail('UNSUPPORTED_SCHEMA','TTL, projections, constraints, external dependencies and definer code require a reviewed ClickHouse recovery strategy.')
    return definition
  }
  async manifest():Promise<Manifest>{
    await this.checkpoint();await this.profile()
    const identity=await this.identity(),database=literal(this.config.database)
    const tables=await this.all(`SELECT name,engine,create_table_query,storage_policy FROM system.tables WHERE database=${database} ORDER BY name`)
    if(tables.length>maxTables)fail('RESOURCE_LIMIT','ClickHouse backup is limited to 500 tables.')
    const objects:Record<string,unknown>=Object.create(null),data:Record<string,unknown>=Object.create(null)
    objects.databaseEngine='Atomic';objects.profile='25.8-plain-MergeTree-quiescent-v1'
    const definitions:Record<string,string>=Object.create(null)
    let totalRows=0,totalBytes=0n
    for(const table of tables){
      await this.checkpoint()
      const name=identifier(String(table.name))
      if(table.engine!=='MergeTree'||table.storage_policy!=='default')fail('UNSUPPORTED_SCHEMA','This profile supports plain nonreplicated MergeTree tables on the default local storage policy only.')
      const columns=await this.all(`SELECT name,type,default_kind,default_expression FROM system.columns WHERE database=${database} AND table=${literal(name)} ORDER BY position`)
      if(!columns.length||columns.length>512)fail('RESOURCE_LIMIT','ClickHouse tables require between 1 and 512 columns.')
      for(const column of columns){identifier(String(column.name));if(column.default_kind||column.default_expression||/\b(AggregateFunction|SimpleAggregateFunction|Object|JSON|Dynamic|Variant|Nested)\b/.test(String(column.type)))fail('UNSUPPORTED_SCHEMA','ClickHouse computed/default columns, aggregate states and dynamic object types are not supported by this validation profile.')}
      definitions[name]=digest({ddl:this.normalizedDDL(String(table.create_table_query),name),columns})
      const projection=columns.map(column=>quote(String(column.name))).join(',')
      const binary=`formatRow('RowBinary',${projection})`
      let count=0n,sum=0n,squares=0n,bytes=0n
      for await(const row of this.rows(`SELECT hex(SHA256(${binary})) AS digest,toString(length(${binary})) AS bytes FROM ${quote(this.config.database)}.${quote(name)} FORMAT JSONEachRow`,AbortSignal.any([this.options.signal,this.failureSignal,AbortSignal.timeout(5*60*1000)]),768*1024*1024,{wait_end_of_query:'0'})){
        if(typeof row.digest!=='string'||!/^[0-9a-f]{64}$/i.test(row.digest))fail('INVALID_ENGINE_RESPONSE','ClickHouse row digest output was malformed or interrupted.')
        const length=uint(row.bytes)
        if(length>8n*1024n*1024n)fail('RESOURCE_LIMIT','ClickHouse validation limits each serialized row to 8 MiB.')
        totalRows++;totalBytes+=length;bytes+=length;count++
        if(totalRows>maxRows||totalBytes>BigInt(maxArchiveBytes))fail('RESOURCE_LIMIT','ClickHouse validation exceeded the 5 million row or 2 GiB serialized-data limit.')
        const value=BigInt('0x'+row.digest);sum=(sum+value)%modulus;squares=(squares+value*value)%modulus
        if(totalRows%128===0)await this.checkpoint()
      }
      data[name]={rows:String(count),rowBinaryBytes:String(bytes),sha256Sum:sum.toString(16).padStart(64,'0'),sha256Squares:squares.toString(16).padStart(64,'0')}
    }
    objects.tables=definitions
    return {format:1,...identity,objects,data,sequences:{}}
  }
  private async journalPath(id:string){
    if(!uuid(id))fail('INVALID_ID','Use a native operation UUID.')
    if(!this.root||!this.journals)await this.sharedRoot(AbortSignal.timeout(15000))
    const root=await realpath(this.config.sharedBackupRoot),info=await lstat(root),journalInfo=await lstat(this.journals!)
    if(root!==this.root||`${info.dev}:${info.ino}`!==this.rootIdentity||!journalInfo.isDirectory()||journalInfo.isSymbolicLink()||(journalInfo.mode&0o077)!==0||await realpath(this.journals!)!==this.journals)fail('UNSAFE_NATIVE_JOURNAL','The private ClickHouse journal mount changed.')
    return join(this.journals!,id+'.jsonl')
  }
  private async append(journal:Journal,event:Row,create=false){
    const path=await this.journalPath(journal.id)
    const handle=await open(path,constants.O_WRONLY|constants.O_NOFOLLOW|(create?constants.O_CREAT|constants.O_EXCL:constants.O_APPEND),0o600)
    try{await handle.writeFile(JSON.stringify(create?{...journal,state:'PREPARED'}:{at:new Date().toISOString(),...event})+'\n');await handle.sync()}finally{await handle.close()}
    if(create){const directory=await open(this.journals!,'r');try{await directory.sync()}finally{await directory.close()}}
  }
  private async readJournal(id:string){
    const path=await this.journalPath(id),file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
    try{
      const info=await file.stat();if(!info.isFile()||info.size>128*1024||(info.mode&0o077)!==0)fail('UNSAFE_NATIVE_JOURNAL','The ClickHouse operation journal is not a private bounded file.')
      const content=await file.readFile('utf8'),lastComplete=content.lastIndexOf('\n')
      if(lastComplete<0)fail('UNSAFE_NATIVE_JOURNAL','The native operation journal is incomplete; ownership must be reconciled manually.')
      let entries:Row[]
      try{entries=content.slice(0,lastComplete).split('\n').map(line=>JSON.parse(line) as Row)}catch{fail('UNSAFE_NATIVE_JOURNAL','The native operation journal is malformed; reconciliation is required.')}
      if(!entries!.length)fail('UNSAFE_NATIVE_JOURNAL','The native operation journal contains no identity.')
      const first=entries![0] as unknown as Journal,last=entries!.at(-1)!
      if(first.id!==id||!safeArchive(first.archive)||!['backup','restore'].includes(first.kind)||typeof first.server!=='string')fail('UNSAFE_NATIVE_JOURNAL','The ClickHouse operation journal has an invalid identity.')
      return {journal:first,state:String(last.state??'PREPARED')}
    }finally{await file.close()}
  }
  private async noPendingOperations(){
    await this.sharedRoot()
    for(const name of await readdir(this.journals!)){
      if(!/^[0-9a-f-]{36}\.jsonl$/.test(name))continue
      const {journal,state}=await this.readJournal(name.slice(0,-6))
      if(journal.server===this.bound!.binding!.split(':')[0]&&!terminal.has(state))fail('NATIVE_OPERATION_UNCERTAIN','A previous native ClickHouse operation has no reconciled terminal state. Reconcile its protected operation journal before starting another native operation.')
    }
  }
  private async status(journal:Journal):Promise<NativeStatus|undefined>{
    // Independent bounded observation must remain possible after caller abort.
    const rows=await this.all(`SELECT id,toString(status) AS status,toString(serverUUID()) AS server FROM system.backups WHERE id=${literal(journal.id)}`,AbortSignal.timeout(10000))
    if(rows.length===0)return undefined
    if(rows.length!==1||rows[0]?.id!==journal.id||rows[0]?.server!==journal.server)fail('NATIVE_OPERATION_UNCERTAIN','The ClickHouse native operation identity could not be reconciled.')
    const status=String(rows[0]?.status)
    if(!['CREATING_BACKUP','BACKUP_CREATED','BACKUP_FAILED','RESTORING','RESTORED','RESTORE_FAILED','BACKUP_CANCELLED','RESTORE_CANCELLED'].includes(status))fail('NATIVE_OPERATION_UNCERTAIN','ClickHouse returned an unsupported native operation state.')
    return status as NativeStatus
  }
  private async unknown(journal:Journal):Promise<never>{
    await this.append(journal,{state:'UNKNOWN'}).catch(()=>{})
    const error=new AppError('NATIVE_OPERATION_UNCERTAIN',`Native ClickHouse operation ${journal.id} has an unknown or still-running outcome. HTTP interruption does not confirm cancellation. Its journal and archive are retained; reconcile before another operation.`)
    this.failure.abort(error);throw error
  }
  async reconcile(id:string){
    await this.identity();const {journal}=await this.readJournal(id)
    if(journal.server!==this.bound!.binding!.split(':')[0])fail('IDENTITY_UNCERTAIN','This operation journal belongs to a different ClickHouse server.')
    const status=await this.status(journal)
    if(status&&terminal.has(status))await this.append(journal,{state:status,reconciled:true})
    return {operationId:id,kind:journal.kind,status:status??'UNKNOWN',terminal:!!status&&terminal.has(status)}
  }
  private async runNative(journal:Journal,sql:string,signal:AbortSignal){
    await this.noPendingOperations();await this.checkpoint(signal)
    await this.append(journal,{},true)
    this.native=journal;this.nativeFinished=false
    if(signal.aborted){await this.append(journal,{state:'NOT_SUBMITTED'});this.nativeFinished=true;abortCheck(signal)}
    try{
      const ack=await this.all(sql,signal,{query_id:journal.queryId,max_execution_time:'3600'})
      if(ack.length!==1||ack[0]?.id!==journal.id)throw new Error('Unconfirmed native acknowledgement')
      await this.append(journal,{state:'SUBMITTED'})
    }catch{
      // Submission may have reached the server. Never send it again, even with
      // the same id: observe the existing operation instead.
      const state=await this.status(journal).catch(()=>undefined)
      if(!state)return this.unknown(journal)
    }
    const deadline=Date.now()+60*60*1000
    try{while(true){
      const state=await this.status(journal).catch(()=>undefined)
      if(state&&terminal.has(state)){
        await this.append(journal,{state});this.nativeFinished=true
        if(state===(journal.kind==='backup'?'BACKUP_CREATED':'RESTORED')){abortCheck(signal);return}
        if(state.endsWith('CANCELLED'))fail('CANCELLED','ClickHouse confirmed cancellation of the native operation; a restore may still have applied partial data.')
        fail(journal.kind==='backup'?'NATIVE_BACKUP_FAILED':'NATIVE_RESTORE_FAILED','ClickHouse confirmed native operation failure. Restore is not transactional and the target must remain reserved for review.')
      }
      if(!state)return this.unknown(journal)
      let ownershipStopped=false
      if(!signal.aborted){try{await this.options.checkpoint?.()}catch{ownershipStopped=true}}
      if(signal.aborted||ownershipStopped||Date.now()>deadline){
        // KILL QUERY targets only the exact query ID generated and journaled by
        // this operation. An HTTP abort or KILL response alone is never enough.
        await this.all(`KILL QUERY WHERE query_id=${literal(journal.queryId)} SYNC`,AbortSignal.timeout(5000)).catch(()=>{})
        const end=Date.now()+15000
        while(Date.now()<end){
          const stopped=await this.status(journal).catch(()=>undefined)
          if(stopped&&terminal.has(stopped)){await this.append(journal,{state:stopped});this.nativeFinished=true;fail('CANCELLED','ClickHouse reported a terminal native result after cancellation. A restore target remains reserved until its result is reviewed.')}
          await delay(500)
        }
        return this.unknown(journal)
      }
      await delay(500)
    }}catch(error){if(this.nativeFinished||error instanceof AppError&&error.code==='NATIVE_OPERATION_UNCERTAIN')throw error;return this.unknown(journal)}
  }
  private async copy(source:string,destination:string,mode:number,signal:AbortSignal){
    const input=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW),before=await input.stat()
    if(!before.isFile()||before.nlink!==1||before.size<=0||before.size>maxArchiveBytes){await input.close();fail('RESOURCE_LIMIT','ClickHouse archive is not a nonempty regular file within the 2 GiB limit.')}
    let output:Awaited<ReturnType<typeof open>>|undefined
    try{
      output=await open(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,mode)
      const buffer=Buffer.alloc(1024*1024);let bytes=0
      while(true){abortCheck(signal);const read=await input.read(buffer,0,buffer.length,null);if(!read.bytesRead)break;bytes+=read.bytesRead;if(bytes>before.size||bytes>maxArchiveBytes)fail('RESOURCE_LIMIT','ClickHouse archive grew during bounded copying.');let offset=0;while(offset<read.bytesRead){const written=await output.write(buffer,offset,read.bytesRead-offset);if(!written.bytesWritten)fail('ARCHIVE_COPY_FAILED','ClickHouse archive copy made no write progress.');offset+=written.bytesWritten}}
      await output.sync();const after=await input.stat()
      if(bytes!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ino!==before.ino)fail('ARTIFACT_CHANGED','ClickHouse archive changed while being copied.')
    }finally{await input.close();await output?.close()}
  }
  private nativeJournal(kind:'backup'|'restore'):Journal{
    const id=randomUUID();return {id,kind,queryId:'steelkeep-'+id,archive:id+'.zip',database:this.config.database,server:this.bound!.binding!.split(':')[0]!,createdAt:new Date().toISOString()}
  }
  async backup(file:string,_dir:string,signal:AbortSignal,phase:EnginePhase){
    if(this.config.restoreTarget)fail('INVALID_SOURCE','A ClickHouse restore destination cannot be a backup source.')
    if(this.config.quiescentSource!==true)fail('QUIESCENT_SOURCE_REQUIRED','This ClickHouse profile requires explicit operator-enforced quiescence of every source writer throughout capture. Native backup is not an atomic cross-table snapshot.')
    await this.identity();await this.requireGrant('BACKUP');await this.noPendingOperations()
    const mounted=await this.sharedRoot(),free=await statfs(mounted.root)
    if(mounted.free<BigInt(maxArchiveBytes+128*1024*1024)||free.bavail*free.bsize<maxArchiveBytes+128*1024*1024)fail('DISK_SPACE','Provision at least 2 GiB plus 128 MiB free on the dedicated shared ClickHouse backup disk.')
    await phase('manifest','Capturing independent ClickHouse schema and RowBinary row digests under the operator-maintained quiescent-source profile.')
    const manifest=await this.manifest()
    if(Object.keys(manifest.data).length===0)fail('EMPTY_SOURCE','This native ClickHouse profile requires at least one ordinary MergeTree table.')
    const journal=this.nativeJournal('backup'),archive=join(mounted.root,journal.archive)
    try{
      await phase('dumping','Starting a native asynchronous ClickHouse backup with a durable operation ID. No database-wide cross-table snapshot is claimed.')
      await this.runNative(journal,`BACKUP DATABASE ${quote(this.config.database)} TO Disk(${literal(this.config.backupDisk)},${literal(journal.archive)}) SETTINGS id=${literal(journal.id)},check_parts=true ASYNC`,signal)
      await phase('manifest','Native backup finished. Rechecking schema and row digests; source changes invalidate this backup.')
      const after=await this.manifest()
      if(digest(manifest.objects)!==digest(after.objects)||digest(manifest.data)!==digest(after.data))fail('SOURCE_CHANGED','ClickHouse source schema or rows changed across capture. Reestablish maintenance quiescence before a new backup.')
      await this.copy(archive,file,0o600,signal);await assertArchiveSize(file)
      return {manifest,toolVersion:'ClickHouse native BACKUP '+this.bound!.serverVersion}
    }finally{if(this.native?.id===journal.id&&this.nativeFinished)await rm(archive,{force:true}).catch(()=>{})}
  }
  async restore(file:string,_dir:string,signal:AbortSignal,expected:Manifest){
    if(expected.format!==1||expected.engine!==this.engine||expected.objects.profile!=='25.8-plain-MergeTree-quiescent-v1')fail('MANIFEST_UNAVAILABLE','A trusted installation-created ClickHouse profile manifest is required.')
    const source=identifier(expected.database)
    if(source.toLowerCase()===this.config.database.toLowerCase()||expected.binding===this.bound?.binding)fail('SOURCE_TARGET_CONFLICT','ClickHouse restore requires a separate precreated empty database, never the recorded source.')
    await this.restrictedRestoreRole();await this.profile();await this.sharedRoot();await this.noPendingOperations()
    if(!await this.empty())fail('TARGET_NOT_EMPTY','The precreated Atomic ClickHouse restore target must contain no tables, detached tables or dictionaries.')
    const tables=Object.keys(expected.data).map(identifier).sort()
    if(!tables.length||tables.length>maxTables||!expected.objects.tables||typeof expected.objects.tables!=='object')fail('MANIFEST_UNAVAILABLE','The trusted ClickHouse manifest has no supported table set.')
    if(Object.keys(expected.objects.tables as Row).sort().join('\0')!==tables.join('\0'))fail('MANIFEST_UNAVAILABLE','ClickHouse schema and data manifest table sets differ.')
    const journal=this.nativeJournal('restore'),archive=join(this.root!,journal.archive)
    try{
      await this.copy(file,archive,0o640,signal)
      await this.checkpoint(signal);await this.identity();await this.restrictedRestoreRole()
      if(!await this.empty())fail('TARGET_NOT_EMPTY','ClickHouse target objects appeared before native restore submission.')
      const selected=tables.map(table=>`TABLE ${quote(source)}.${quote(table)} AS ${quote(this.config.database)}.${quote(table)}`).join(', ')
      await this.runNative(journal,`RESTORE ${selected} FROM Disk(${literal(this.config.backupDisk)},${literal(journal.archive)}) SETTINGS id=${literal(journal.id)},create_database='must-exist',create_table='create',allow_non_empty_tables=false,allow_different_table_def=false,allow_different_database_def=false ASYNC`,signal)
      return {toolVersion:'ClickHouse native RESTORE '+this.bound!.serverVersion}
    }finally{if(!this.native||this.native.id!==journal.id||this.nativeFinished)await rm(archive,{force:true}).catch(()=>{})}
  }
  async close(){
    // Closing an HTTP client is not cancellation of native work. Unknown native
    // operations deliberately retain their durable journal and shared archive.
  }
}

export const createClickHouseAdapter=(options:AdapterOptions):EngineAdapter=>new ClickHouseAdapter(options)
/** Observation only: this never starts/retries an operation or clears a target block. */
export async function reconcileClickHouseOperation(options:AdapterOptions,id:string){const adapter=new ClickHouseAdapter(options);try{await adapter.connect();return await adapter.reconcile(id)}finally{await adapter.close()}}
