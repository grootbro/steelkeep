import {Database} from 'bun:sqlite'
import {createClient} from 'redis'
import {readFile,mkdir,realpath,lstat,open,chmod} from 'node:fs/promises'
import {resolve,join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'

// Deliberately absent from package.json/default scripts. Authoring is not a run.
if(process.env.STEELKEEP_ACCEPTANCE!=='synthetic-local-extra')throw new Error('Set STEELKEEP_ACCEPTANCE=synthetic-local-extra to prepare only the disposable extra fixtures.')
const workspace=await realpath(resolve(dirname(fileURLToPath(import.meta.url)),'..'))
const local=join(workspace,'.steelkeep','extra-fixtures','sqlite')
const mounted='/var/lib/steelkeep-fixtures/sqlite'
const base='http://127.0.0.1:4311/api/v1'
type Row={id:string;name:string;kind:string;config:Record<string,unknown>}

async function privateDirectory(path:string){
  try{const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Fixture directories must be regular project-local directories.')}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await mkdir(path,{mode:0o700})}
  if(await realpath(path)!==path)throw new Error('Refusing a fixture path that resolves outside the project-local directory.')
}
async function createFile(path:string,sql:string){
  try{
    const info=await lstat(path)
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw new Error('Existing fixture files must be regular, unaliased files.')
    return // Preserve prior source data and any completed/partial target.
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  const reserved=await open(path,'wx',0o600);await reserved.close()
  const db=new Database(path,{create:true,strict:true})
  try{db.exec(sql)}finally{db.close()}
  await chmod(path,0o600)
}
async function prepareFiles(){
  let path=workspace
  for(const name of ['.steelkeep','extra-fixtures','sqlite']){path=join(path,name);await privateDirectory(path)}
  await privateDirectory(join(local,'source'));await privateDirectory(join(local,'target'))
  await createFile(join(local,'source','source.sqlite'),`
    PRAGMA journal_mode=WAL;
    PRAGMA wal_autocheckpoint=0;
    PRAGMA foreign_keys=ON;
    PRAGMA user_version=7;
    PRAGMA application_id=1398033232;
    CREATE TABLE projects(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE);
    CREATE TABLE entries(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id INTEGER NOT NULL REFERENCES projects(id),body TEXT NOT NULL,amount NUMERIC NOT NULL CHECK(amount>=0),binary_value BLOB NOT NULL,optional_text TEXT);
    CREATE TABLE notes(body TEXT NOT NULL);
    CREATE TABLE wal_markers(id TEXT PRIMARY KEY,payload BLOB NOT NULL);
    CREATE INDEX entries_project ON entries(project_id);
    INSERT INTO projects(name) VALUES('Synthetic SQLite recovery fixture');
    INSERT INTO projects(id,name) VALUES(10,'Synthetic sequence reservation');
    DELETE FROM projects WHERE id=10;
    INSERT INTO entries(project_id,body,amount,binary_value,optional_text) VALUES
      (1,'Synthetic row one',1.25,X'00FF7F00',NULL),
      (1,'Синтетическая строка',2.50,X'01020304',''),
      (1,'Synthetic row three',3.75,X'FF00FF00','fixture');
    INSERT INTO notes(rowid,body) VALUES(1,'Implicit rowid one'),(7,'Implicit rowid seven');
  `)
  // A nonzero user_version initializes a real header without user objects.
  await createFile(join(local,'target','restore_seed.sqlite'),'PRAGMA user_version=1;')
}

await prepareFiles()
if(process.argv.includes('--prepare-files')){
  console.log('Project-local SQLite fixture files prepared; no service or API was contacted. Start the explicit fixture overlay separately.')
}else{
  const token=(await readFile(join(workspace,'.steelkeep','token'),'utf8')).trim()
  if(token.length<32)throw new Error('Prepare the local installation token before fixture API setup.')
  async function request<T>(path:string,body?:unknown):Promise<T>{
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)})
    if(!response.ok)throw new Error(`Extra fixture API ${path} failed (${response.status}); no credentials are included in this error.`)
    return response.json() as Promise<T>
  }
  const existing=await request<Row[]>('/connections')
  const storage=existing.find(row=>row.name==='Local S3 · RustFS'&&row.kind==='s3'&&row.config.endpoint==='http://s3:9000'&&row.config.bucket==='steelkeep-fixture')
  if(!storage)throw new Error('Seed the base isolated fixtures first; the correct existing Local S3 · RustFS destination is required.')
  async function connection(name:string,input:Record<string,unknown>){
    const found=existing.find(row=>row.name===name)
    if(found){
      const safeKeys=['host','port','database','path','dbIndex','user','tls','authDatabase','restoreTarget','allowGlobalReadLock']
      if(found.kind!==input.kind||safeKeys.some(key=>input[key]!==undefined&&found.config[key]!==input[key]))throw new Error('An existing extra-fixture connection has conflicting configuration; it was not replaced.')
      return found
    }
    return request<{id:string}>('/connections',{name,...input})
  }
  const redis=createClient({socket:{host:'127.0.0.1',port:54377,connectTimeout:5000,reconnectStrategy:false},username:'fixture_admin',password:'local-redis-admin-only',database:0,disableOfflineQueue:true})
  redis.on('error',()=>{})
  try{
    await redis.connect()
    const count=await redis.dbSize()
    if(count!==0&&await redis.get('fixture:identity')!=='steelkeep-extra-fixture')throw new Error('Redis source index 0 is not the known synthetic fixture; nothing was flushed or replaced.')
    if(count===0){
      await redis.set('fixture:identity','steelkeep-extra-fixture')
      await redis.set('fixture:ttl_seed','synthetic one-day TTL',{PX:86400000})
      await redis.set(Buffer.from([0x66,0x00,0xff,0x7f]),Buffer.from([0x00,0xff,0x41,0x00,0x7f]))
      await redis.hSet('fixture:hash',{name:'synthetic',amount:'7.5'})
      await redis.rPush('fixture:list',['alpha','beta','gamma'])
      await redis.sAdd('fixture:set',['one','two'])
      await redis.zAdd('fixture:zset',[{score:1.25,value:'one'},{score:2.5,value:'two'}])
      await redis.xAdd('fixture:stream','1-0',{kind:'synthetic',body:'stream entry'})
    }
  }finally{await redis.close().catch(()=>{})}
  const definitions=[
    {engine:'mongodb',name:'MongoDB',source:{kind:'mongodb',host:'mongodb-fixture',port:27017,database:'source_mongo',user:'backup_reader',password:'local-mongo-reader-only',authDatabase:'admin',tls:false,restoreTarget:false,allowGlobalReadLock:true},target:{kind:'mongodb',host:'mongodb-fixture',port:27017,database:'restore_mongo',user:'restore_writer',password:'local-mongo-writer-only',authDatabase:'admin',tls:false,restoreTarget:true}},
    {engine:'redis',name:'Redis',source:{kind:'redis',host:'redis-fixture',port:6379,dbIndex:0,user:'backup_reader',password:'local-redis-reader-only',tls:false,restoreTarget:false,allowGlobalReadLock:true},target:{kind:'redis',host:'redis-fixture',port:6379,dbIndex:1,user:'restore_writer',password:'local-redis-writer-only',tls:false,restoreTarget:true}},
    {engine:'sqlite',name:'SQLite',source:{kind:'sqlite',path:mounted+'/source/source.sqlite',restoreTarget:false},target:{kind:'sqlite',path:mounted+'/target/restore_seed.sqlite',restoreTarget:true}}
  ]
  const plans=await request<Array<{id:string;name:string;source_id:string;storage_id:string}>>('/plans'),results:Record<string,unknown>={}
  for(const definition of definitions){
    const source=await connection(definition.name+' · extra fixture',definition.source)
    const target=await connection(definition.name+' recovery · extra fixture',definition.target)
    for(const row of [source,target]){
      const result=await request<{status:string}>(`/connections/${row.id}/test`,{})
      if(result.status!=='available')throw new Error('An extra fixture connection did not pass read-only connectivity inspection; native backup has not been tested.')
    }
    const name=definition.name+' extra fixture',found=plans.find(plan=>plan.name===name)
    if(found&&(found.source_id!==source.id||found.storage_id!==storage.id))throw new Error('An existing extra-fixture plan points elsewhere; it was not replaced.')
    const plan=found??await request<{id:string}>('/plans',{name,sourceId:source.id,storageId:storage.id,timezone:'Asia/Bangkok'})
    results[definition.engine]={sourceId:source.id,targetId:target.id,planId:plan.id}
  }
  console.log(JSON.stringify({fixtures:results,storageId:storage.id,recoveryAcceptance:'not-run',notice:'Connection checks are not native backup/restore evidence; MongoDB Database Tools must be provisioned separately.'}))
}
