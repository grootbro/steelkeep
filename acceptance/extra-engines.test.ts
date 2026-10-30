import {test,expect} from 'bun:test'
import {Database} from 'bun:sqlite'
import {randomBytes,randomUUID,createHash} from 'node:crypto'
import {readFile,open,chmod,stat,access,link,unlink} from 'node:fs/promises'
import {resolve,join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {MongoClient,BSON} from 'mongodb'
import {createClient,RESP_TYPES} from 'redis'
import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'

// Source-only acceptance authoring. Not imported by the default `bun test tests`.
// No native tool/image download, stack startup, source reset, FLUSH or DB drop.
// Explicit future command:
// STEELKEEP_ACCEPTANCE=synthetic-local-extra bun test acceptance/extra-engines.test.ts
const recovery=process.env.STEELKEEP_ACCEPTANCE==='synthetic-local-extra'?test:test.skip
const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const base='http://127.0.0.1:4311',mounted='/var/lib/steelkeep-fixtures/sqlite'
const local=join(workspace,'.steelkeep','extra-fixtures','sqlite')
type Job={id:string;status:string;artifact_id:string|null;validation:Record<string,unknown>|null;error_code:string|null;events?:unknown[]}
type Connection={id:string;name:string;kind:string;config:Record<string,unknown>;blocked:boolean}
type Artifact={id:string;object_key:string;size:string;sha256:string;engine:string;tool_version:string;availability:string}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))

async function harness(){
  const token=(await readFile(join(workspace,'.steelkeep','token'),'utf8')).trim()
  if(token.length<32)throw new Error('A valid local fixture installation token is required.')
  const client=new Client({name:'steelkeep-extra-acceptance',version:'0.1.0'})
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}}),{mode:'auto'})
  function data(result:Awaited<ReturnType<Client['callTool']>>):unknown{
    const structured=result.structuredContent as {data?:unknown}|undefined
    if(structured&&'data' in structured)return structured.data
    const text=result.content?.find(content=>content.type==='text')
    if(!text||text.type!=='text')throw new Error('The official MCP client did not receive structured JSON output.')
    return JSON.parse(text.text)
  }
  async function tool<T>(name:string,args:Record<string,unknown>={}):Promise<T>{
    const result=await client.callTool({name,arguments:args})
    if(result.isError)throw new Error(`MCP ${name} returned a safe tool error; inspect the local durable job and prerequisites separately.`)
    return data(result) as T
  }
  async function rejected(name:string,args:Record<string,unknown>){
    const result=await client.callTool({name,arguments:args})
    expect(result.isError===true).toBe(true)
    return data(result) as {error:{code:string}}
  }
  async function rest<T>(path:string,body:unknown):Promise<T>{
    const response=await fetch(base+'/api/v1'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)})
    if(!response.ok)throw new Error(`Extra acceptance API ${path} failed (${response.status}).`)
    return response.json() as Promise<T>
  }
  async function finished(id:string,engine:string){
    const deadline=Date.now()+120000
    while(Date.now()<deadline){
      const job=await tool<Job>('get_job',{id})
      if(['succeeded','failed','cancelled','interrupted'].includes(job.status)){
        if(job.status!=='succeeded')throw new Error(`${engine} durable operation ended ${job.status} (${job.error_code??'no-code'}); this is not accepted recovery.`)
        // Boolean assertions avoid printing an installation secret on failure.
        expect(JSON.stringify(job).includes(token)).toBe(false)
        return job
      }
      await pause(250)
    }
    throw new Error('Extra fixture durable job exceeded the acceptance deadline; no target or source lock was automatically cleared.')
  }
  async function setup(engine:'mongodb'|'redis'|'sqlite'){
    const capabilities=await tool<{engines:string[]}>('get_capabilities')
    expect(capabilities.engines.includes(engine)).toBe(true)
    const connections=await tool<Connection[]>('list_connections')
    const names={mongodb:'MongoDB · extra fixture',redis:'Redis · extra fixture',sqlite:'SQLite · extra fixture'}
    const source=connections.find(row=>row.name===names[engine]&&row.kind===engine&&!row.config.restoreTarget)
    if(!source)throw new Error('Run the guarded extra-fixture API seed against the isolated overlay first.')
    if(engine==='mongodb'&&(source.config.host!=='mongodb-fixture'||source.config.port!==27017||source.config.database!=='source_mongo'||source.config.user!=='backup_reader'||source.config.authDatabase!=='admin'||source.config.tls!==false||source.config.allowGlobalReadLock!==true))throw new Error('Refusing a MongoDB source outside the explicit synthetic fixture profile.')
    if(engine==='redis'&&(source.config.host!=='redis-fixture'||source.config.port!==6379||source.config.dbIndex!==0||source.config.user!=='backup_reader'||source.config.tls!==false||source.config.allowGlobalReadLock!==true))throw new Error('Refusing a Redis source outside the explicit synthetic fixture profile.')
    if(engine==='sqlite'&&source.config.path!==mounted+'/source/source.sqlite')throw new Error('Refusing a SQLite source outside the explicit synthetic fixture mount.')
    const storage=connections.find(row=>row.name==='Local S3 · RustFS'&&row.kind==='s3'&&row.config.endpoint==='http://s3:9000'&&row.config.bucket==='steelkeep-fixture')
    if(!storage)throw new Error('The exact isolated Local S3 · RustFS fixture destination is required; no remote storage will be used.')
    const planNames={mongodb:'MongoDB extra fixture',redis:'Redis extra fixture',sqlite:'SQLite extra fixture'}
    const plans=await tool<Array<{id:string;name:string;source_id:string;storage_id:string}>>('list_plans'),plan=plans.find(row=>row.name===planNames[engine]&&row.source_id===source.id&&row.storage_id===storage.id)
    if(!plan)throw new Error('The synthetic extra-fixture plan is missing.')
    return {source,plan,connections}
  }
  async function backup(engine:string,planId:string){
    const key=randomUUID(),accepted=await tool<Job>('run_backup',{planId,idempotencyKey:key})
    expect((await tool<Job>('run_backup',{planId,idempotencyKey:key})).id).toBe(accepted.id)
    const complete=await finished(accepted.id,engine)
    expect(complete.artifact_id!==null).toBe(true)
    expect(complete.validation).toBe(null)
    const artifacts=await tool<Artifact[]>('list_backups'),artifact=artifacts.find(row=>row.id===complete.artifact_id)
    if(!artifact||artifact.availability!=='present'||artifact.engine!==engine)throw new Error('The completed backup did not publish its actual artifact.')
    expect(/^[a-f0-9]{64}$/.test(artifact.sha256)).toBe(true)
    expect(artifact.tool_version.length>0).toBe(true)
    // Independent real object read: do not rely on worker metadata or a fake UI.
    if(Number(artifact.size)>16*1024*1024)throw new Error('The small synthetic fixture unexpectedly produced an archive larger than 16 MiB.')
    const storage=new S3Client({endpoint:'http://127.0.0.1:54373',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'steelkeep-local',secretAccessKey:'local-s3-fixture-only'}})
    let archiveBytes:Uint8Array|undefined
    try{
      const response=await storage.send(new GetObjectCommand({Bucket:'steelkeep-fixture',Key:artifact.object_key}),{abortSignal:AbortSignal.timeout(30000)})
      if(!response.Body||response.ContentLength!==Number(artifact.size))throw new Error('The local S3 object does not match the published size.')
      const body=await response.Body.transformToByteArray()
      archiveBytes=body
      expect(body.length).toBe(Number(artifact.size))
      expect(createHash('sha256').update(body).digest('hex')).toBe(artifact.sha256)
    }finally{storage.destroy()}
    if(!archiveBytes)throw new Error('The actual synthetic archive was not read.')
    return {...artifact,archiveBytes}
  }
  async function restore(engine:string,artifactId:string,targetId:string){
    const prepared=await tool<{intentId:string;review:{sourceDatabase:string;targetDatabase:string;checks:Record<string,boolean>}}>('prepare_restore',{artifactId,targetId})
    expect(prepared.review.sourceDatabase===prepared.review.targetDatabase).toBe(false)
    expect(Object.values(prepared.review.checks).every(Boolean)).toBe(true)
    const key=randomUUID(),accepted=await tool<Job>('start_restore',{intentId:prepared.intentId,idempotencyKey:key})
    expect((await tool<Job>('start_restore',{intentId:prepared.intentId,idempotencyKey:key})).id).toBe(accepted.id)
    const complete=await finished(accepted.id,engine)
    expect(complete.validation?.restore).toBe('completed')
    expect(complete.validation?.integrity).toBe('sha256-matched')
    expect(complete.validation?.status).toBe('passed')
    return complete
  }
  return {client,tool,rejected,rest,setup,backup,restore}
}

const mongoActions=['find','insert','createCollection','createIndex','listCollections','listIndexes','collStats','dbStats','validate','killCursors']
async function mongoTarget(admin:MongoClient,nonempty=false){
  const suffix=randomBytes(6).toString('hex'),database='restore_extra_'+suffix,user='restore_'+suffix,password=randomBytes(24).toString('hex')
  await admin.db(database).createCollection('__steelkeep_empty_target')
  if(nonempty)await admin.db(database).collection('safety_keep').insertOne({_id:'must-survive',value:'keep-me'})
  await admin.db('admin').command({createRole:user,privileges:[{resource:{db:database,collection:''},actions:mongoActions}],roles:[]})
  await admin.db('admin').command({createUser:user,pwd:password,mechanisms:['SCRAM-SHA-256'],roles:[{role:user,db:'admin'}]})
  return {name:'MongoDB acceptance '+suffix,kind:'mongodb',host:'mongodb-fixture',port:27017,database,user,password,authDatabase:'admin',tls:false,restoreTarget:true}
}

recovery('MongoDB MCP: native BSON archive -> S3 -> restricted empty sentinel target -> independent BSON/index checks',async()=>{
  const h=await harness(),admin=new MongoClient('mongodb://fixture_admin:local-mongo-admin-only@127.0.0.1:54376/admin?directConnection=true&authSource=admin',{promoteValues:false,promoteLongs:false,serverSelectionTimeoutMS:5000})
  let target:MongoClient|undefined
  try{
    await admin.connect();const {source,plan}=await h.setup('mongodb'),sourceDb=admin.db('source_mongo')
    const before=await sourceDb.collection('entries').find({}).sort({_id:1}).toArray()
    expect(before.length).toBe(2)
    expect(String(before[0].counter)).toBe('9007199254740993')
    const artifact=await h.backup('mongodb',plan.id)
    expect(/100\.20\.\d+/.test(artifact.tool_version)).toBe(true)
    const config=await mongoTarget(admin),connection=await h.rest<{id:string}>('/connections',config)
    await h.restore('mongodb',artifact.id,connection.id)
    target=new MongoClient(`mongodb://${config.user}:${config.password}@127.0.0.1:54376/${config.database}?directConnection=true&authSource=admin`,{promoteValues:false,promoteLongs:false,serverSelectionTimeoutMS:5000})
    await target.connect();const recovered=target.db(config.database)
    const after=await recovered.collection('entries').find({}).sort({_id:1}).toArray()
    expect(BSON.EJSON.serialize(after,{relaxed:false})).toEqual(BSON.EJSON.serialize(before,{relaxed:false}))
    expect(await recovered.collection('__steelkeep_empty_target').countDocuments()).toBe(0)
    const sourceOptions=await sourceDb.listCollections({name:'entries'}).next(),targetOptions=await recovered.listCollections({name:'entries'}).next()
    expect(BSON.EJSON.serialize(targetOptions?.options,{relaxed:false})).toEqual(BSON.EJSON.serialize(sourceOptions?.options,{relaxed:false}))
    const indexes=await recovered.collection('entries').listIndexes().toArray()
    expect(indexes.find(index=>index.name==='project_created')?.key).toEqual({projectId:1,createdAt:-1})
    expect((await recovered.collection('projects').listIndexes().toArray()).find(index=>index.name==='fixture_unique')?.unique).toBe(true)
    expect(BSON.EJSON.serialize(await sourceDb.collection('entries').find({}).sort({_id:1}).toArray(),{relaxed:false})).toEqual(BSON.EJSON.serialize(before,{relaxed:false}))
    const state=await admin.db('admin').command({currentOp:1,$all:true})
    expect(state.fsyncLock).toBe(false)
    const sourceBlocks=await h.tool<Array<{resource_key:string}>>('list_source_blocks')
    expect(sourceBlocks.some(block=>block.resource_key==='mongodb:mongodb-fixture:27017')).toBe(false)
    const blocked=await h.rejected('prepare_restore',{artifactId:artifact.id,targetId:connection.id})
    expect(blocked.error.code).toBe('TARGET_BLOCKED')
    const occupied=await mongoTarget(admin,true),occupiedConnection=await h.rest<{id:string}>('/connections',occupied)
    expect((await h.rejected('prepare_restore',{artifactId:artifact.id,targetId:occupiedConnection.id})).error.code).toBe('TARGET_NOT_EMPTY')
    expect((await admin.db(occupied.database).collection('safety_keep').findOne({_id:'must-survive'}))?.value).toBe('keep-me')
    const alias=await h.rest<{id:string}>('/connections',{name:'MongoDB forbidden source alias '+randomUUID(),kind:'mongodb',host:'mongodb-fixture',port:27017,database:'source_mongo',user:'backup_reader',password:'local-mongo-reader-only',authDatabase:'admin',tls:false,restoreTarget:true})
    expect((await h.rejected('prepare_restore',{artifactId:artifact.id,targetId:alias.id})).error.code).toBe('SOURCE_TARGET_CONFLICT')
    expect(source.id!==connection.id).toBe(true)
  }finally{await target?.close();await admin.close();await h.client.close()}
  // Databases, marker collections, roles and possible partial targets are retained.
},300000)

function redisAdmin(database:number){
  const client=createClient({socket:{host:'127.0.0.1',port:54377,connectTimeout:5000,reconnectStrategy:false},username:'fixture_admin',password:'local-redis-admin-only',database,disableOfflineQueue:true}).withTypeMapping({[RESP_TYPES.BLOB_STRING]:Buffer})
  client.on('error',()=>{});return client
}
const replyText=(value:unknown)=>Buffer.isBuffer(value)?value.toString('utf8'):String(value)
const replyStrings=(value:unknown)=>{if(!Array.isArray(value))throw new Error('Expected a Redis array reply.');return value.map(replyText)}

recovery('Redis MCP: atomic native DUMP -> S3 -> empty index -> binary values, types and exact TTL',async()=>{
  const h=await harness(),source=redisAdmin(0)
  let target:ReturnType<typeof redisAdmin>|undefined
  try{
    await source.connect();const {plan,connections}=await h.setup('redis')
    expect(replyText(await source.sendCommand(['GET','fixture:identity']))).toBe('steelkeep-extra-fixture')
    const suffix=randomBytes(6).toString('hex'),live='fixture:live:'+suffix,expired='fixture:expires:'+suffix,payload=Buffer.from([0,255,17,0,127])
    await source.sendCommand(['SET',live,payload,'PX','600000'])
    await source.sendCommand(['SET',expired,'naturally-expiring-fixture','PX','20000'])
    const absoluteExpiry=Number(await source.sendCommand(['PEXPIRETIME',live]))
    const shortExpiry=Number(await source.sendCommand(['PEXPIRETIME',expired]))
    const artifact=await h.backup('redis',plan.id)
    // Prove that this key was in the actual S3 archive, rather than merely
    // observing absence for a key that had expired before capture started.
    const records=new TextDecoder().decode(artifact.archiveBytes).trim().split('\n').map(line=>JSON.parse(line) as Record<string,unknown>)
    expect(records[0].format).toBe('steelkeep-redis-dump-v1')
    const capturedExpiry=records.slice(1).find(row=>row.key===Buffer.from(expired).toString('base64'))
    if(!capturedExpiry)throw new Error('The short-lived key expired before native capture; this run did not establish expiry-aware recovery coverage.')
    expect(capturedExpiry.expiresAt).toBe(shortExpiry)
    const expiryDeadline=Date.now()+22000
    while(Number(await source.sendCommand(['EXISTS',expired]))!==0){
      if(Date.now()>expiryDeadline)throw new Error('The known short-lived Redis fixture did not expire on schedule.')
      await pause(250)
    }
    // Index 1 is the clean-overlay default. Repeats may choose another already
    // existing empty index, preserving every previous target instead of FLUSH.
    let index=0
    for(let candidate=1;candidate<16;candidate++){
      if(connections.some(row=>row.kind==='redis'&&row.config.dbIndex===candidate&&row.blocked))continue
      const next=redisAdmin(candidate);await next.connect()
      if(Number(await next.sendCommand(['DBSIZE']))===0){target=next;index=candidate;break}
      await next.close()
    }
    if(!target)throw new Error('No empty precreated fixture index remains; all existing data was preserved.')
    const connection=await h.rest<{id:string}>('/connections',{name:'Redis acceptance '+suffix,kind:'redis',host:'redis-fixture',port:6379,dbIndex:index,user:'restore_writer',password:'local-redis-writer-only',tls:false,restoreTarget:true})
    const complete=await h.restore('redis',artifact.id,connection.id)
    expect(complete.validation?.method).toBe('native-redis-DUMP-sha256-and-absolute-expiry')
    expect(await target.sendCommand(['GET',live])).toEqual(payload)
    expect(Number(await target.sendCommand(['PEXPIRETIME',live]))).toBe(absoluteExpiry)
    expect(Number(await target.sendCommand(['EXISTS',expired]))).toBe(0)
    const binaryKey=Buffer.from([0x66,0,255,127])
    expect(await target.sendCommand(['GET',binaryKey])).toEqual(Buffer.from([0,255,0x41,0,127]))
    expect(replyText(await target.sendCommand(['HGET','fixture:hash','name']))).toBe('synthetic')
    expect(replyStrings(await target.sendCommand(['LRANGE','fixture:list','0','-1']))).toEqual(['alpha','beta','gamma'])
    expect(replyStrings(await target.sendCommand(['SMEMBERS','fixture:set'])).sort()).toEqual(['one','two'])
    expect(replyStrings(await target.sendCommand(['ZRANGE','fixture:zset','0','-1','WITHSCORES']))).toEqual(['one','1.25','two','2.5'])
    expect(Number(await target.sendCommand(['XLEN','fixture:stream']))).toBe(1)
    expect(replyText(await target.sendCommand(['TYPE','fixture:stream']))).toBe('stream')
    expect(replyText(await source.sendCommand(['GET','fixture:identity']))).toBe('steelkeep-extra-fixture')
    expect(await source.sendCommand(['GET',live])).toEqual(payload)
    const alias=await h.rest<{id:string}>('/connections',{name:'Redis forbidden source alias '+suffix,kind:'redis',host:'redis-fixture',port:6379,dbIndex:0,user:'restore_writer',password:'local-redis-writer-only',tls:false,restoreTarget:true})
    expect((await h.rejected('prepare_restore',{artifactId:artifact.id,targetId:alias.id})).error.code).toBe('SOURCE_TARGET_CONFLICT')
    expect((await h.rejected('prepare_restore',{artifactId:artifact.id,targetId:connection.id})).error.code).toBe('TARGET_BLOCKED')
  }finally{await target?.close().catch(()=>{});await source.close().catch(()=>{});await h.client.close()}
},300000)

async function sqliteTarget(filename:string,sql='PRAGMA user_version=1;'){
  const path=join(local,'target',filename),file=await open(path,'wx',0o600);await file.close()
  const db=new Database(path,{create:true,strict:true})
  try{db.exec(sql)}finally{db.close()}
  await chmod(path,0o600)
  return {path,mounted:mounted+'/target/'+filename}
}

recovery('SQLite MCP: live WAL -> native snapshot -> distinct empty file -> rowids, identity, binary data and constraints',async()=>{
  const h=await harness(),sourcePath=join(local,'source','source.sqlite')
  let source:Database|undefined,target:Database|undefined
  try{
    source=new Database(sourcePath,{readonly:false,strict:true,create:false})
    const {plan}=await h.setup('sqlite'),marker=randomUUID(),markerBytes=Buffer.from([0,255,1,127])
    source.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA foreign_keys=ON;')
    source.query('INSERT INTO wal_markers(id,payload) VALUES(?,?)').run(marker,markerBytes)
    // Keep this writer handle open: the newly committed marker remains in WAL,
    // and the read-only source mount must see existing readable WAL and SHM.
    expect((await stat(sourcePath+'-wal')).size>0).toBe(true)
    await access(sourcePath+'-shm')
    const rows=source.query('SELECT id,project_id,body,CAST(amount AS TEXT) AS amount,hex(binary_value) AS bytes,optional_text FROM entries ORDER BY id').all()
    const notes=source.query('SELECT rowid,body FROM notes ORDER BY rowid').all()
    expect(rows.length).toBe(3)
    const artifact=await h.backup('sqlite',plan.id),suffix=randomBytes(6).toString('hex'),file=await sqliteTarget('restore_'+suffix+'.sqlite')
    const connection=await h.rest<{id:string}>('/connections',{name:'SQLite acceptance '+suffix,kind:'sqlite',path:file.mounted,restoreTarget:true})
    await h.restore('sqlite',artifact.id,connection.id)
    target=new Database(file.path,{readonly:false,strict:true,create:false});target.exec('PRAGMA foreign_keys=ON')
    expect(target.query('SELECT id,project_id,body,CAST(amount AS TEXT) AS amount,hex(binary_value) AS bytes,optional_text FROM entries ORDER BY id').all()).toEqual(rows)
    expect(target.query('SELECT rowid,body FROM notes ORDER BY rowid').all()).toEqual(notes)
    expect((target.query('SELECT hex(payload) AS bytes FROM wal_markers WHERE id=?').get(marker) as {bytes:string}).bytes).toBe(markerBytes.toString('hex').toUpperCase())
    expect(Object.values(target.query('PRAGMA integrity_check').get() as Record<string,unknown>)[0]).toBe('ok')
    expect(target.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect((target.query('PRAGMA user_version').get() as {user_version:number}).user_version).toBe(7)
    expect((target.query('SELECT seq FROM sqlite_sequence WHERE name=?').get('projects') as {seq:number}).seq).toBe(10)
    expect((target.query('INSERT INTO projects(name) VALUES(?) RETURNING id').get('Recovered project '+suffix) as {id:number}).id).toBe(11)
    let foreignKeyRejected=false
    try{target.query('INSERT INTO entries(project_id,body,amount,binary_value) VALUES(?,?,?,?)').run(999,'Invalid synthetic FK',1,Buffer.from([1]))}catch{foreignKeyRejected=true}
    expect(foreignKeyRejected).toBe(true)
    expect(source.query('SELECT id,project_id,body,CAST(amount AS TEXT) AS amount,hex(binary_value) AS bytes,optional_text FROM entries ORDER BY id').all()).toEqual(rows)
    expect((source.query('SELECT seq FROM sqlite_sequence WHERE name=?').get('projects') as {seq:number}).seq).toBe(10)
    const occupied=await sqliteTarget('occupied_'+suffix+'.sqlite',"CREATE TABLE safety_keep(value TEXT NOT NULL); INSERT INTO safety_keep VALUES('keep-me');")
    const occupiedConnection=await h.rest<{id:string}>('/connections',{name:'SQLite occupied '+suffix,kind:'sqlite',path:occupied.mounted,restoreTarget:true})
    expect((await h.rejected('prepare_restore',{artifactId:artifact.id,targetId:occupiedConnection.id})).error.code).toBe('TARGET_NOT_EMPTY')
    const preserved=new Database(occupied.path,{readonly:true,strict:true,create:false})
    try{expect((preserved.query('SELECT value FROM safety_keep').get() as {value:string}).value).toBe('keep-me')}finally{preserved.close()}
    const aliasFilename='forbidden_link_'+suffix+'.sqlite',alias=join(local,'target',aliasFilename)
    let linked=false
    try{
      await link(sourcePath,alias);linked=true
      const token=(await readFile(join(workspace,'.steelkeep','token'),'utf8')).trim()
      const response=await fetch(base+'/api/v1/connections',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({name:'SQLite forbidden hard link '+suffix,kind:'sqlite',path:mounted+'/target/'+aliasFilename,restoreTarget:true})})
      expect(response.ok).toBe(false)
    }finally{
      // Remove only the just-created test directory entry. The source and all
      // actual restored/partial database files remain untouched and retained.
      if(linked)await unlink(alias)
    }
    expect((await stat(sourcePath)).nlink).toBe(1)
  }finally{target?.close();source?.close();await h.client.close()}
},300000)
