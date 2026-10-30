import {Database} from 'bun:sqlite'
import {realpath,stat,open,writeFile} from 'node:fs/promises'
import {isAbsolute,relative,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {setImmediate as yieldTurn} from 'node:timers/promises'
import {AppError} from '../security'
import {runTool,toolEnv,assertArchiveSize} from '../process'
import {digest} from './database'
import type {AdapterOptions,EngineAdapter,Identity,Manifest,EnginePhase} from './types'

const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"'
const metaQuote=(name:string)=>JSON.stringify(name)
const maxRowBytes=8*1024*1024

export async function sqliteIdentity(path:string,target:boolean){
  if(!isAbsolute(path))throw new AppError('INVALID_SQLITE_PATH','Use an absolute SQLite database path.')
  const actual=await realpath(path),roots=(process.env[target?'STEELKEEP_SQLITE_TARGET_ROOTS':'STEELKEEP_SQLITE_SOURCE_ROOTS']??'').split(',').filter(Boolean)
  let allowed=false
  for(const configured of roots){
    if(!isAbsolute(configured))continue
    const root=await realpath(configured),child=relative(root,actual)
    if(root!=='/'&&child!==''&&child!=='..'&&!child.startsWith('../')&&!isAbsolute(child)){allowed=true;break}
  }
  if(!allowed)throw new AppError('ENDPOINT_NOT_ALLOWED','This SQLite file is outside the canonical source or target mount allowlist.',403)
  const info=await stat(actual)
  if(!info.isFile())throw new AppError('INVALID_SQLITE_FILE','SQLite connections require an existing regular database file.')
  if(info.nlink!==1)throw new AppError('IDENTITY_UNCERTAIN','SQLite files with hard-link aliases are not admitted for backup or restore.')
  const file=await open(actual,'r'),header=Buffer.alloc(16)
  try{await file.read(header,0,16,0)}finally{await file.close()}
  if(!header.equals(Buffer.from('SQLite format 3\0')))throw new AppError('INVALID_SQLITE_FILE','The precreated file is not an initialized SQLite database.')
  return {path:actual,binding:`${info.dev}:${info.ino}`}
}

export class SQLiteAdapter implements EngineAdapter {
  readonly engine='sqlite' as const
  readonly archiveExtension='.sqlite'
  readonly failureSignal=new AbortController().signal
  private db?:Database
  private bound?:Awaited<ReturnType<typeof sqliteIdentity>>
  constructor(private options:AdapterOptions){}
  private check(){if(this.options.signal.aborted)throw new AppError('CANCELLED','Operation cancelled.')}
  async connect(){
    this.check();this.bound=await sqliteIdentity(String(this.options.config.path??''),Boolean(this.options.config.restoreTarget))
    this.db=new Database(this.bound.path,{readonly:true,strict:true,create:false})
    this.db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=10000')
    return this.identity()
  }
  async identity():Promise<Identity>{
    this.check()
    if(!this.db||!this.bound)throw new AppError('DATABASE_UNAVAILABLE','The SQLite session is not open.')
    const current=await sqliteIdentity(this.bound.path,Boolean(this.options.config.restoreTarget))
    if(current.binding!==this.bound.binding)throw new AppError('IDENTITY_UNCERTAIN','The SQLite file identity changed while the connection was open.')
    const version=this.db.query('SELECT sqlite_version() AS version').get() as {version:string}
    return {engine:this.engine,database:current.path,binding:current.binding,serverVersion:version.version}
  }
  async empty(){
    if(!this.db)throw new AppError('DATABASE_UNAVAILABLE','The SQLite session is not open.')
    const row=this.db.query('SELECT count(*) AS count FROM sqlite_schema').get() as {count:number}
    return Number(row.count)===0
  }
  async restrictedRestoreRole(){
    // The worker receives only separately mounted, explicitly allowed target files.
    // SQLite has no database roles; the configured OS mount boundary is the authority.
    if(!this.options.config.restoreTarget)throw new AppError('TARGET_NOT_DESIGNATED','This SQLite file is not a designated restore target.')
    await this.identity()
  }
  async manifest(){
    if(!this.db)throw new AppError('DATABASE_UNAVAILABLE','The SQLite session is not open.')
    return this.capture(this.db,await this.identity())
  }
  private async capture(db:Database,identity:Identity):Promise<Manifest>{
    this.check()
    const integrity=db.query('PRAGMA integrity_check').all() as Array<Record<string,unknown>>
    if(integrity.length!==1||Object.values(integrity[0])[0]!=='ok')throw new AppError('SQLITE_INTEGRITY','SQLite integrity checks did not pass.')
    if(db.query('PRAGMA foreign_key_check').get())throw new AppError('SQLITE_CONSTRAINTS','SQLite contains a foreign key violation.')
    const schema=db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as Array<{type:string;name:string;tbl_name:string;sql:string|null}>
    if(schema.some(row=>/CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql??'')))throw new AppError('UNSUPPORTED_SCHEMA','SQLite virtual tables and extension modules require dedicated recovery validation.')
    const tables=schema.filter(row=>row.type==='table')
    if(tables.length>500)throw new AppError('RESOURCE_LIMIT','SQLite backups are limited to 500 ordinary tables.')
    const data:Record<string,unknown>={}
    for(const table of tables){
      this.check();await yieldTurn();this.check()
      const columns=db.query(`PRAGMA table_xinfo(${quote(table.name)})`).all() as Array<{name:string;hidden:number}>
      if(columns.length>512)throw new AppError('RESOURCE_LIMIT','SQLite tables are limited to 512 columns.')
      const names=columns.filter(c=>c.hidden!==1).map(c=>quote(c.name))
      if(!/WITHOUT\s+ROWID/i.test(table.sql??'')){
        const rowid=['rowid','_rowid_','oid'].find(candidate=>!columns.some(c=>c.name.toLowerCase()===candidate))
        if(rowid)names.push(quote(rowid))
      }
      const bytes=names.map(name=>`coalesce(length(cast(${name} AS BLOB)),0)`).join('+')||'0'
      const largest=db.query(`SELECT coalesce(max(${bytes}),0) AS bytes FROM ${quote(table.name)}`).get() as {bytes:number}
      if(Number(largest.bytes)>maxRowBytes)throw new AppError('RESOURCE_LIMIT','SQLite validation limits each row to 8 MiB.')
      const projection=names.flatMap((name,index)=>[`typeof(${name}) AS t${index}`,`hex(cast(${name} AS BLOB)) AS v${index}`]).join(',')
      const statement=db.query(`SELECT ${projection} FROM ${quote(table.name)}`)
      let rows=0n,a=0n,b=0n
      for(const row of statement.iterate()){
        const hash=createHash('sha256')
        for(const value of Object.values(row as Record<string,unknown>)){
          const bytes=Buffer.from(String(value??''))
          hash.update(`${bytes.length}:`);hash.update(bytes)
        }
        const sum=hash.digest('hex');a=(a+BigInt('0x'+sum.slice(0,32)))%(1n<<128n);b=(b+BigInt('0x'+sum.slice(32)))%(1n<<128n);rows++
        if(rows%128n===0n){await yieldTurn();this.check()}
      }
      data[table.name]={rows:rows.toString(),hash_a:a.toString(16),hash_b:b.toString(16)}
    }
    const hasSequences=db.query("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()
    const sequences=hasSequences?db.query('SELECT name,CAST(seq AS TEXT) AS seq FROM sqlite_sequence ORDER BY name').all():[]
    const userVersion=db.query('PRAGMA user_version').get(),applicationId=db.query('PRAGMA application_id').get()
    return {format:1,...identity,objects:{schema:digest(schema),userVersion:digest(userVersion),applicationId:digest(applicationId)},data,sequences:{values:sequences}}
  }
  async backup(file:string,dir:string,signal:AbortSignal,phase:EnginePhase){
    const source=await this.identity()
    const toolVersion=await runTool('sqlite3',['--version'],{signal,env:toolEnv(),capture:true,timeoutMs:10000})
    await phase('dumping','Creating a consistent SQLite snapshot with the native online backup API.')
    const script=join(dir,'backup-commands.txt')
    await writeFile(script,`.bail on\n.timeout 10000\n.backup ${metaQuote(file)}\n`,{mode:0o600,flag:'wx'})
    await runTool('sqlite3',['-batch','-bail','-readonly',this.bound!.path],{signal,env:toolEnv(),stdinFile:script})
    await assertArchiveSize(file)
    const snapshot=new Database(file,{readonly:true,strict:true,create:false})
    snapshot.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF')
    try{return {manifest:await this.capture(snapshot,source),toolVersion}}
    finally{snapshot.close()}
  }
  async restore(file:string,dir:string,signal:AbortSignal,expected:Manifest){
    const identity=await this.identity()
    if(identity.database.toLowerCase()===expected.database.toLowerCase()||identity.binding===expected.binding)throw new AppError('SOURCE_TARGET_CONFLICT','The SQLite target aliases the recorded source file.')
    if(!await this.empty())throw new AppError('TARGET_NOT_EMPTY','SQLite target contains database objects.')
    const toolVersion=await runTool('sqlite3',['--version'],{signal,env:toolEnv(),capture:true,timeoutMs:10000})
    const script=join(dir,'restore-commands.txt')
    await writeFile(script,`.bail on\n.timeout 10000\n.restore ${metaQuote(file)}\n`,{mode:0o600,flag:'wx'})
    await this.options.checkpoint?.();this.check()
    // URI mode=rw refuses to recreate a target deleted after preflight.
    await runTool('sqlite3',['-batch','-bail',pathToFileURL(this.bound!.path).href+'?mode=rw'],{signal,env:toolEnv(),stdinFile:script})
    // Refresh the readonly handle after the native page-level restore.
    this.db?.close();this.db=undefined;await this.connect()
    return {toolVersion}
  }
  async close(){this.db?.close();this.db=undefined}
}

export const createSQLiteAdapter=(options:AdapterOptions):EngineAdapter=>new SQLiteAdapter(options)
