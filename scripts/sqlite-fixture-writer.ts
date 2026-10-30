import {Database} from 'bun:sqlite'
import {lstat,realpath,open} from 'node:fs/promises'

// One-off Linux fixture tool. No caller-selected path, database creation or reset.
const source='/var/lib/steelkeep-fixtures/sqlite/source/source.sqlite'
const sourceRoot='/var/lib/steelkeep-fixtures/sqlite/source'
const maxPayloadBytes=64*1024,maxLineBytes=96*1024
let ready=false,stopping=false,db:Database|undefined
let stopped!:()=>void
const stopRequested=new Promise<void>(resolve=>{stopped=resolve})
const stop=()=>{stopping=true;stopped()}
process.once('SIGTERM',stop);process.once('SIGINT',stop)

// Unlike readline, this refuses an oversized unterminated line before buffering it.
const input=process.stdin[Symbol.asyncIterator]()
let buffered:Buffer=Buffer.alloc(0)
async function line(limit:number):Promise<string|null>{
  while(true){
    const newline=buffered.indexOf(10)
    if(newline>=0){
      if(newline>limit)throw new Error('INPUT_LIMIT')
      const value=buffered.subarray(0,newline).toString('utf8')
      buffered=buffered.subarray(newline+1)
      return value
    }
    if(buffered.length>limit)throw new Error('INPUT_LIMIT')
    const next=await input.next()
    if(next.done){if(buffered.length)throw new Error('INCOMPLETE_LINE');return null}
    const chunk=Buffer.isBuffer(next.value)?next.value:Buffer.from(next.value)
    if(buffered.length+chunk.length>maxLineBytes+256)throw new Error('INPUT_LIMIT')
    buffered=Buffer.concat([buffered,chunk])
  }
}
async function emit(value:Record<string,unknown>){
  await new Promise<void>((resolve,reject)=>process.stdout.write(JSON.stringify(value)+'\n',error=>error?reject(new Error('OUTPUT_CLOSED')):resolve()))
}
function request(value:string|null){
  if(value===null)throw new Error('REQUEST_REQUIRED')
  const parsed:unknown=JSON.parse(value)
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('INVALID_REQUEST')
  const row=parsed as Record<string,unknown>
  if(Object.keys(row).length!==2||typeof row.marker!=='string'||typeof row.payloadbase64!=='string')throw new Error('INVALID_REQUEST')
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.marker))throw new Error('INVALID_MARKER')
  if(!row.payloadbase64||row.payloadbase64.length>Math.ceil(maxPayloadBytes/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.payloadbase64))throw new Error('INVALID_PAYLOAD')
  const payload=Buffer.from(row.payloadbase64,'base64')
  if(!payload.length||payload.length>maxPayloadBytes||payload.toString('base64')!==row.payloadbase64)throw new Error('INVALID_PAYLOAD')
  return {marker:row.marker,payload}
}
async function identity(){
  if(await realpath(sourceRoot)!==sourceRoot||await realpath(source)!==source)throw new Error('INVALID_SOURCE')
  const info=await lstat(source)
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw new Error('INVALID_SOURCE')
  return {dev:info.dev,ino:info.ino}
}
async function sidecars(){
  for(const suffix of ['-wal','-shm']){
    try{const info=await lstat(source+suffix);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw new Error('INVALID_SIDECAR')}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  }
}
function fixture(){
  if(!db)throw new Error('SOURCE_NOT_OPEN')
  const application=db.query('PRAGMA application_id').get() as {application_id:number}
  const version=db.query('PRAGMA user_version').get() as {user_version:number}
  if(application.application_id!==1398033232||version.user_version!==7)throw new Error('FIXTURE_IDENTITY')
  const tables=db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{name:string}>
  if(JSON.stringify(tables.map(row=>row.name))!==JSON.stringify(['entries','notes','projects','wal_markers']))throw new Error('FIXTURE_SCHEMA')
  const marker=db.query("SELECT count(*) AS n FROM projects WHERE id=1 AND name='Synthetic SQLite recovery fixture'").get() as {n:number}
  if(marker.n!==1)throw new Error('FIXTURE_IDENTITY')
  const columns=db.query('PRAGMA table_info(wal_markers)').all() as Array<{name:string;type:string;notnull:number;pk:number}>
  if(columns.length!==2||columns[0].name!=='id'||columns[0].type!=='TEXT'||columns[0].pk!==1||columns[1].name!=='payload'||columns[1].type!=='BLOB'||columns[1].notnull!==1||columns[1].pk!==0)throw new Error('FIXTURE_SCHEMA')
  if(db.query("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name='wal_markers' LIMIT 1").get())throw new Error('FIXTURE_SCHEMA')
}

async function main(){
  if(process.platform!=='linux'||process.env.STEELKEEP_ACCEPTANCE!=='synthetic-local-extra'||process.argv.length!==2)throw new Error('FIXTURE_OPT_IN')
  const first=await Promise.race([line(maxLineBytes),stopRequested.then(()=>null)])
  if(stopping)return
  const {marker,payload}=request(first),bound=await identity()
  await sidecars()
  const file=await open(source,'r'),header=Buffer.alloc(16)
  try{await file.read(header,0,16,0)}finally{await file.close()}
  if(!header.equals(Buffer.from('SQLite format 3\0')))throw new Error('INVALID_SOURCE')
  db=new Database(source,{readonly:false,strict:true,create:false})
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000')
  fixture()
  const current=await identity()
  if(current.dev!==bound.dev||current.ino!==bound.ino)throw new Error('SOURCE_CHANGED')
  if(stopping)return
  const mode=db.query('PRAGMA journal_mode=WAL').get() as {journal_mode:string}
  if(mode.journal_mode.toLowerCase()!=='wal')throw new Error('WAL_REQUIRED')
  db.exec('PRAGMA wal_autocheckpoint=0')
  // Commit before readiness; keep this same handle open so native Linux readers see a live WAL.
  // Duplicate markers fail instead of replacing a previous invocation's retained row.
  db.query('INSERT INTO wal_markers(id,payload) VALUES(?,?)').run(marker,payload)
  const count=(db.query('SELECT count(*) AS n FROM wal_markers').get() as {n:number}).n
  const row=db.query('SELECT count(*) AS n FROM wal_markers WHERE id=? AND typeof(payload)=\'blob\' AND hex(payload)=?').get(marker,payload.toString('hex').toUpperCase()) as {n:number}
  const wal=await lstat(source+'-wal'),after=await identity()
  if(row.n!==1||!wal.isFile()||wal.isSymbolicLink()||wal.nlink!==1||wal.size<=32||after.dev!==bound.dev||after.ino!==bound.ino)throw new Error('WAL_NOT_READY')
  await emit({ready:true,marker,count,markerCount:row.n,walBytes:wal.size})
  ready=true
  const release=await Promise.race([line(128),stopRequested.then(()=>null)])
  if(release!==null&&!stopping){
    const value:unknown=JSON.parse(release)
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||(value as Record<string,unknown>).release!==true)throw new Error('INVALID_RELEASE')
  }
}

try{await main()}
catch{
  process.exitCode=1
  if(!ready)await emit({ready:false,error:'SQLITE_FIXTURE_WRITER_FAILED'}).catch(()=>{})
  process.stderr.write('SQLite fixture writer failed; request data and raw database errors are omitted.\n')
}finally{
  try{db?.close()}catch{process.exitCode=1;process.stderr.write('SQLite fixture writer could not confirm a clean close.\n')}
  process.stdin.destroy()
  process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop)
}
