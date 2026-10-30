import {createHash,randomUUID} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {MongoClient,BSON,Binary,DBRef,type Db} from 'mongodb'
import type {AdapterOptions,EngineAdapter,Manifest,SourceLockContext,SourceLockHooks} from './types'
import {AppError,allowedHost,identifier} from '../security'
import {assertArchiveSize,maxArchiveBytes,runTool,toolEnv} from '../process'

/**
 * MongoDB 8.0 standalone logical archives. Replica sets/shards are deliberately
 * refused: single-DB --oplog is invalid, and an election can invalidate fsync.
 * Official contracts used (reviewed 31 October 2026):
 * https://www.mongodb.com/docs/database-tools/mongodump/#--oplog
 * https://www.mongodb.com/docs/database-tools/mongorestore/#--config
 * https://www.mongodb.com/docs/manual/reference/command/fsync/
 * https://mongodb.github.io/node-mongodb-native/7.1/interfaces/FindOptions.html#raw
 * No third-party implementation was copied.
 */
export type MongoConfig={host:string;port:number;database:string;user:string;tls:boolean;restoreTarget:boolean;authDatabase?:string;allowGlobalReadLock?:boolean}
export type MongoSecret={password:string}
export type MongoIdentity={engine:'mongodb';database:string;serverVersion:string}
export type MongoManifest={format:1;engine:'mongodb';database:string;serverVersion:string;objects:Record<string,unknown>;data:Record<string,unknown>;sequences:Record<string,unknown>}
export type MongoLockContext=SourceLockContext&{engine:'mongodb';host:string;port:number;database:string}
export type MongoLockHooks=SourceLockHooks
export type MongoAdapterOptions={lockHooks?:MongoLockHooks}
export const mongoTargetSentinel='__steelkeep_empty_target'
const commandTimeout=15000
const readTimeout=120000
const maximumCollections=500
const maximumDocuments=5_000_000
const lockMaximumMs=5*60*1000
const modulus=1n<<256n
const fail=(code:string,message:string):never=>{throw new AppError(code,message)}
const checkAbort=(signal?:AbortSignal)=>{if(signal?.aborted)fail('CANCELLED','Operation cancelled.')}
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex')
const plainObject=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)

function checkedConfig(config:MongoConfig,secret:MongoSecret){
  allowedHost(config.host);identifier(config.database);identifier(config.authDatabase??'admin')
  if(['admin','local','config'].includes(config.database.toLowerCase()))fail('PROTECTED_DATABASE','MongoDB system databases cannot be backup sources or restore targets.')
  if(!Number.isInteger(config.port)||config.port<1||config.port>65535)fail('INVALID_PORT','Use a valid MongoDB TCP port.')
  if(!/^[A-Za-z0-9_.:-]+$/.test(config.host)||/[\r\n\0]/.test(config.user+secret.password)||!config.user||!secret.password)fail('INVALID_CREDENTIAL','Use a valid standalone MongoDB host, username and password without control characters.')
}
function mongoUri(config:MongoConfig,secret:MongoSecret){
  checkedConfig(config,secret)
  const host=config.host.includes(':')?`[${config.host}]`:config.host
  const query=new URLSearchParams({authSource:config.authDatabase??'admin',authMechanism:'SCRAM-SHA-256',directConnection:'true',tls:String(config.tls),retryReads:'false',retryWrites:'false',connectTimeoutMS:'5000',serverSelectionTimeoutMS:'5000',socketTimeoutMS:String(readTimeout)})
  // The complete URI is used in memory or a 0600 file only, never argv/logs.
  return `mongodb://${encodeURIComponent(config.user)}:${encodeURIComponent(secret.password)}@${host}:${config.port}/${encodeURIComponent(config.database)}?${query}`
}
function clientFor(config:MongoConfig,secret:MongoSecret){
  return new MongoClient(mongoUri(config,secret),{maxPoolSize:2,minPoolSize:0,maxConnecting:1,serverSelectionTimeoutMS:5000,connectTimeoutMS:5000,socketTimeoutMS:readTimeout,monitorCommands:false,readPreference:'primary',retryReads:false,retryWrites:false})
}
function sorted(value:unknown):unknown{
  if(Array.isArray(value))return value.map(sorted)
  if(plainObject(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])]))
  return value
}
function metadataDigest(value:unknown){
  // Canonical EJSON retains BSON types. Sorting metadata fields does not reorder
  // compound index key definitions: those are encoded as ordered entry arrays.
  return hash(JSON.stringify(sorted(BSON.EJSON.serialize(value,{relaxed:false}))))
}
function lockCount(value:unknown){
  const count=Number(String(value))
  if(!Number.isSafeInteger(count)||count<0)fail('SOURCE_LOCK_UNCERTAIN','MongoDB returned an invalid fsync lock count. Source lock reconciliation is required.')
  return count
}
function assertPortableBson(value:unknown,depth=0):void {
  if(depth>100)fail('RESOURCE_LIMIT','MongoDB document nesting exceeds the supported validation limit.')
  if(!value||typeof value!=='object'||Buffer.isBuffer(value))return
  const object=value as Record<string,unknown>
  if(value instanceof Binary&&value.sub_type===6)fail('UNSUPPORTED_SCHEMA','Client-side encrypted MongoDB BSON requires a separate key-vault recovery strategy and is not supported by this adapter.')
  if(value instanceof DBRef)fail('UNSUPPORTED_SCHEMA','MongoDB DBRef documents require an explicit cross-database rebinding strategy before restoring under another database name.')
  for(const child of Object.values(object))assertPortableBson(child,depth+1)
}
function collectionName(name:string){
  if(!/^[A-Za-z_][A-Za-z0-9_.-]{0,119}$/.test(name)||name.startsWith('system.'))fail('UNSUPPORTED_SCHEMA','MongoDB archives currently require ordinary user collections with safe names; system and special namespaces are not supported.')
  return name
}
type Privilege={resource:Record<string,unknown>;actions:string[]}
function privilege(value:unknown):value is Privilege {
  return plainObject(value)&&plainObject(value.resource)&&Array.isArray(value.actions)&&value.actions.every(action=>typeof action==='string')
}
function rawBson(value:unknown):Buffer {
  if(!Buffer.isBuffer(value))throw new AppError('BSON_UNAVAILABLE','The MongoDB driver did not return raw BSON. Validation cannot safely coerce document types.')
  return value
}
export function mongoFsyncLocked(value:unknown):boolean {
  if(!plainObject(value)||value.ok!==1||!Array.isArray(value.inprog)||Object.hasOwn(value,'fsyncLock')&&typeof value.fsyncLock!=='boolean')throw new AppError('SOURCE_LOCK_UNCERTAIN','The current MongoDB fsync lock state could not be established.')
  // MongoDB 8.0 currentOp omits this field when unlocked; omission in a
  // successfully validated command response is not an unknown lock outcome.
  return value.fsyncLock===true
}

export class MongoSession {
  readonly engine='mongodb' as const
  readonly archiveExtension='.archive.gz'
  private client?:MongoClient
  private database?:Db
  private sourceProcess?:string
  private lockContext?:MongoLockContext
  private ownsLock=false
  private lockUnknown=false
  private snapshotActive=false
  private monitor?:ReturnType<typeof setInterval>
  private snapshotDeadline?:ReturnType<typeof setTimeout>
  private monitoring?:Promise<void>
  private failure=new AbortController()
  readonly failureSignal=this.failure.signal
  constructor(readonly config:MongoConfig,private secret:MongoSecret,private signal?:AbortSignal,private options:MongoAdapterOptions={}){this.failure.signal.addEventListener('abort',this.abort,{once:true})}
  private abort=()=>{void this.client?.close(true).catch(()=>{})}
  private db(){if(!this.database)return fail('DATABASE_UNAVAILABLE','The MongoDB session is not connected.');return this.database}
  async connect():Promise<MongoIdentity>{
    checkAbort(this.signal)
    if(!this.client){
      this.client=clientFor(this.config,this.secret)
      try{await this.client.connect();this.database=this.client.db(this.config.database)}catch(error){await this.client.close(true).catch(()=>{});this.client=undefined;throw error}
      this.signal?.addEventListener('abort',this.abort,{once:true})
    }
    checkAbort(this.signal)
    return this.identity()
  }
  private async topology(client=this.client){
    if(!client)return fail('DATABASE_UNAVAILABLE','The MongoDB session is not connected.')
    const admin=client.db('admin'),hello=await admin.command({hello:1},{timeoutMS:commandTimeout})
    if(hello.msg==='isdbgrid'||hello.setName||hello.hosts||hello.passives||hello.arbiters||hello.serviceId||hello.isWritablePrimary!==true)fail('UNSUPPORTED_TOPOLOGY','Only a writable standalone MongoDB 8.0 server is supported. Replica sets, sharded clusters and load-balanced deployments require a different snapshot strategy.')
    const process=hello.topologyVersion?.processId?.toString()
    if(!process||!/^[a-f0-9]{24}$/i.test(process))fail('IDENTITY_UNCERTAIN','The standalone MongoDB process identity could not be verified.')
    return process as string
  }
  async identity():Promise<MongoIdentity>{
    checkAbort(this.signal)
    const process=await this.topology()
    if(this.sourceProcess&&process!==this.sourceProcess)fail('IDENTITY_UNCERTAIN','The MongoDB server process changed during this operation.')
    this.sourceProcess=process
    const build=await this.db().admin().command({buildInfo:1},{timeoutMS:commandTimeout})
    const serverVersion=String(build.version??'')
    if(!/^8\.0\./.test(serverVersion))fail('UNSUPPORTED_VERSION','This adapter supports MongoDB 8.0 standalone servers only.')
    if(this.db().databaseName!==this.config.database)fail('IDENTITY_UNCERTAIN','The MongoDB logical database identity does not match the configured name.')
    return {engine:'mongodb',database:this.config.database,serverVersion}
  }
  private async privileges():Promise<Privilege[]>{
    const status=await this.db().admin().command({connectionStatus:1,showPrivileges:true},{timeoutMS:commandTimeout})
    const authInfo:unknown=status.authInfo
    if(!plainObject(authInfo))throw new AppError('AUTHENTICATION_REQUIRED','MongoDB returned no inspectable authentication information.')
    const users:unknown=authInfo.authenticatedUsers,privileges:unknown=authInfo.authenticatedUserPrivileges
    if(!Array.isArray(users)||users.length!==1||!plainObject(users[0])||users[0].user!==this.config.user||users[0].db!==(this.config.authDatabase??'admin')||!Array.isArray(privileges)||!privileges.length||!privileges.every(privilege))throw new AppError('AUTHENTICATION_REQUIRED','MongoDB authentication and inspectable effective privileges are required.')
    return privileges
  }
  async restrictedRestoreRole(){
    if(!this.config.restoreTarget)fail('TARGET_NOT_DESIGNATED','Choose an explicitly designated MongoDB restore target.')
    const privileges=await this.privileges()
    const allowed=new Set(['find','insert','createCollection','createIndex','listCollections','listIndexes','collStats','dbStats','validate','killCursors'])
    for(const privilege of privileges){
      if(privilege.resource.db!==this.config.database||typeof privilege.resource.collection!=='string'||privilege.resource.collection.startsWith('system.')||Object.keys(privilege.resource).some(key=>!['db','collection'].includes(key))||privilege.actions.some(action=>!allowed.has(action)))fail('UNSAFE_TARGET_ROLE','Use a dedicated MongoDB restore role granting read, insert, collection/index creation and validation only on the chosen target database. Cluster, system, user/role management and destructive privileges are refused.')
    }
    const grants=(action:string)=>privileges.some(p=>p.resource.db===this.config.database&&p.resource.collection===''&&p.actions.includes(action))
    if(['find','insert','createCollection','createIndex','listCollections','listIndexes'].some(action=>!grants(action)))fail('TARGET_PERMISSIONS','The dedicated MongoDB target role needs find, insert, createCollection, createIndex, listCollections and listIndexes on all target collections.')
  }
  private async collections(){
    checkAbort(this.signal)
    // Never request authorizedCollections-only: hidden namespaces must not be
    // mistaken for an empty database when the role cannot inspect everything.
    const cursor=this.db().listCollections({},{nameOnly:false,authorizedCollections:false,batchSize:100,timeoutMS:readTimeout})
    try{
      const values=[]
      for await(const collection of cursor){checkAbort(this.signal);if(values.length>=maximumCollections+(this.config.restoreTarget?1:0))fail('RESOURCE_LIMIT','MongoDB backup is limited to 500 collections.');values.push(collection)}
      return values.sort((a,b)=>a.name.localeCompare(b.name))
    }finally{await cursor.close().catch(()=>{})}
  }
  private async sentinel(collections:Awaited<ReturnType<MongoSession['collections']>>,only:boolean){
    const sentinel=collections.find(collection=>collection.name===mongoTargetSentinel)
    if(!sentinel||sentinel.type!=='collection'||Object.keys(sentinel.options??{}).length||(only&&collections.length!==1))return false
    const collection=this.db().collection(mongoTargetSentinel)
    const indexes=await collection.listIndexes({timeoutMS:readTimeout}).toArray()
    if(indexes.length!==1||indexes[0]?.name!=='_id_'||JSON.stringify(indexes[0]?.key)!==JSON.stringify({_id:1}))return false
    return await collection.countDocuments({},{limit:1,maxTimeMS:commandTimeout})===0
  }
  async empty(){
    if(!this.config.restoreTarget)fail('TARGET_NOT_DESIGNATED','A MongoDB restore target must be designated explicitly.')
    // MongoDB has no persisted empty database without a collection. An owner
    // must precreate this exact empty marker, using credentials other than the
    // source role. It is retained and excluded from user-data validation.
    return this.sentinel(await this.collections(),true)
  }
  private async markUncertain(reasonCode:string){
    this.lockUnknown=true
    const failure=new AppError('SOURCE_LOCK_UNCERTAIN','The MongoDB source lock outcome is uncertain. The source stays blocked for operator reconciliation; do not blindly run fsyncUnlock.')
    this.failure.abort(failure)
    if(this.lockContext)await this.options.lockHooks?.onUncertain(this.lockContext,reasonCode).catch(()=>{})
  }
  async beginSnapshot():Promise<undefined>{
    if(this.config.restoreTarget)fail('INVALID_SOURCE','A designated MongoDB restore target cannot be backed up.')
    if(this.config.allowGlobalReadLock!==true)fail('SOURCE_LOCK_APPROVAL_REQUIRED','MongoDB backup requires explicit permission for a server-wide fsync write lock, which temporarily blocks writes to every database on that server.')
    const lockHooks=this.options.lockHooks
    if(!lockHooks)throw new AppError('SOURCE_LOCK_JOURNAL_REQUIRED','MongoDB source locks require durable ownership and interruption recovery hooks before execution.')
    if(this.snapshotActive||this.ownsLock||this.lockUnknown)fail('SOURCE_LOCK_UNCERTAIN','This MongoDB session cannot acquire another source lock.')
    await this.identity()
    const privileges=await this.privileges()
    const permitted=(action:string)=>privileges.some(p=>(p.resource.cluster===true||p.resource.anyResource===true)&&(p.actions.includes(action)||p.actions.includes('anyAction')))
    if(['fsync','unlock','inprog'].some(action=>!permitted(action)))fail('SOURCE_PERMISSIONS','MongoDB backup requires explicit fsync, unlock and inprog cluster privileges as well as database read/list privileges.')
    const admin=this.db().admin(),existing=await admin.command({currentOp:1,$all:true},{timeoutMS:commandTimeout})
    if(mongoFsyncLocked(existing))fail('SOURCE_ALREADY_LOCKED','MongoDB already has an fsync lock. It may belong to another operation; this adapter will not unlock it.')
    const context:MongoLockContext={engine:'mongodb',resourceKey:`mongodb:${this.config.host.toLowerCase()}:${this.config.port}`,serverIdentity:this.sourceProcess!,host:this.config.host,port:this.config.port,database:this.config.database,ownerToken:randomUUID()}
    this.lockContext=context
    await lockHooks.beforeAcquire(context)
    if(this.signal?.aborted){await lockHooks.afterRelease(context);this.lockContext=undefined;checkAbort(this.signal)}
    try{
      const result=await admin.command({fsync:1,lock:true,fsyncLockAcquisitionTimeoutMillis:10000,comment:'steelkeep-source-snapshot'},{timeoutMS:commandTimeout})
      this.ownsLock=true
      if(lockCount(result.lockCount)!==1){await this.finishSnapshot();fail('SOURCE_ALREADY_LOCKED','Another fsync lock was detected. Only this operation\'s acknowledged lock was released; reconcile the other lock before retrying.')}
      this.snapshotActive=true
      this.snapshotDeadline=setTimeout(()=>this.failure.abort(new AppError('SOURCE_LOCK_TIMEOUT','The MongoDB source write lock exceeded its five-minute limit.')),lockMaximumMs)
    }catch(error){
      // A lost response does not establish ownership. Decrementing a lock here
      // could release somebody else's lock; keep the durable source block.
      if(!this.ownsLock&&!this.lockUnknown)await this.markUncertain('FSYNC_ACQUIRE_OUTCOME_UNKNOWN')
      throw error
    }
    this.monitor=setInterval(()=>{
      if(this.monitoring||!this.ownsLock||this.signal?.aborted)return
      this.monitoring=this.verifySnapshot().catch(async()=>{if(!this.signal?.aborted&&!this.failureSignal.aborted)await this.markUncertain('SOURCE_LOCK_MONITOR_FAILED')}).finally(()=>{this.monitoring=undefined})
    },2000)
    return undefined
  }
  async verifySnapshot(){
    if(!this.ownsLock)return
    const process=await this.topology()
    if(process!==this.sourceProcess){this.ownsLock=false;await this.markUncertain('SOURCE_PROCESS_CHANGED');return}
    const state=await this.db().admin().command({currentOp:1,$all:true},{timeoutMS:commandTimeout})
    if(!mongoFsyncLocked(state)){this.ownsLock=false;await this.markUncertain('SOURCE_LOCK_RELEASED_EXTERNALLY')}
  }
  async finishSnapshot(){
    if(this.monitor){clearInterval(this.monitor);this.monitor=undefined}
    if(this.snapshotDeadline){clearTimeout(this.snapshotDeadline);this.snapshotDeadline=undefined}
    await this.monitoring
    this.snapshotActive=false
    if(!this.ownsLock)return
    // Cleanup must survive user cancellation. A separate bounded connection is
    // used, and exactly one known acquisition is released; never unlock-loop.
    const cleanup=clientFor(this.config,this.secret)
    try{
      await cleanup.connect()
      if(await this.topology(cleanup)!==this.sourceProcess){this.ownsLock=false;await this.markUncertain('SOURCE_PROCESS_CHANGED_BEFORE_UNLOCK');fail('SOURCE_LOCK_UNCERTAIN','MongoDB process identity changed before unlock. Reconcile source lock ownership manually.')}
      const admin=cleanup.db('admin'),state=await admin.command({currentOp:1,$all:true},{timeoutMS:commandTimeout})
      if(!mongoFsyncLocked(state)){this.ownsLock=false;await this.markUncertain('SOURCE_LOCK_LOST_BEFORE_UNLOCK');fail('SOURCE_LOCK_UNCERTAIN','The MongoDB source lock disappeared before cleanup. This backup cannot be published.')}
      const result=await admin.command({fsyncUnlock:1,comment:'steelkeep-source-snapshot-release'},{timeoutMS:commandTimeout})
      this.ownsLock=false
      if(lockCount(result.lockCount)!==0){await this.markUncertain('SOURCE_EXTERNAL_LOCK_REMAINS');fail('SOURCE_LOCK_UNCERTAIN','This operation released its own MongoDB lock, but other locks remain. The source stays blocked for review.')}
      if(this.lockUnknown)fail('SOURCE_LOCK_UNCERTAIN','The source lock was released, but its earlier ownership or continuity was uncertain. Review the source before another backup.')
      await this.options.lockHooks!.afterRelease(this.lockContext!)
      this.lockContext=undefined
    }catch(error){
      // Never repeat fsyncUnlock after an unknown response. The durable journal
      // must be reconciled by an owner, even if a later connection is possible.
      this.ownsLock=false
      await this.markUncertain('FSYNC_RELEASE_OUTCOME_UNKNOWN')
      if(error instanceof AppError&&error.code==='SOURCE_LOCK_UNCERTAIN')throw error
      fail('SOURCE_LOCK_UNCERTAIN','MongoDB source unlock could not be confirmed. The source may still reject writes and stays blocked for operator reconciliation.')
    }finally{await cleanup.close(true).catch(()=>{})}
  }
  async manifest():Promise<MongoManifest>{
    checkAbort(this.signal)
    if(this.failureSignal.aborted)fail('SOURCE_LOCK_UNCERTAIN','MongoDB source lock continuity was lost. This snapshot cannot be used.')
    const identity=await this.identity(),collections=await this.collections()
    if(this.config.restoreTarget&&!await this.sentinel(collections,false))fail('TARGET_MARKER_INVALID','The owner-created MongoDB empty-target marker is missing or has changed.')
    if(!this.config.restoreTarget&&!this.snapshotActive)fail('SNAPSHOT_REQUIRED','A MongoDB source manifest must be captured under the same fsync lock as its archive.')
    const objects:Record<string,unknown>=Object.create(null),data:Record<string,unknown>=Object.create(null)
    let totalBytes=0,totalDocuments=0
    for(const info of collections){
      checkAbort(this.signal)
      if(info.name===mongoTargetSentinel){if(this.config.restoreTarget)continue;fail('RESERVED_NAMESPACE','The source contains Steelkeep\'s reserved restore-target marker.')}
      collectionName(info.name)
      const options=info.options??{}
      if(info.type!=='collection'||options.capped||options.timeseries||options.clusteredIndex||options.encryptedFields||options.viewOn||options.changeStreamPreAndPostImages)fail('UNSUPPORTED_SCHEMA','MongoDB views, capped/time-series/clustered/encrypted collections and change-stream pre/post images are not supported by this logical restore strategy.')
      const collection=this.db().collection(info.name),indexes=await collection.listIndexes({timeoutMS:readTimeout}).toArray()
      if(indexes.some(index=>index.expireAfterSeconds!==undefined))fail('UNSUPPORTED_SCHEMA','MongoDB TTL indexes are refused because target expiration can change data during restore validation.')
      const normalized=indexes.map(index=>{const {ns:_,key,...rest}=index;return {...rest,key:Object.entries(key??{})}}).sort((a,b)=>String(a.name).localeCompare(String(b.name)))
      objects[info.name]=metadataDigest({type:info.type,options,indexes:normalized})
      let count=0,sum=0n,sumSquares=0n
      const cursor=collection.find({},{raw:true,batchSize:128,maxTimeMS:readTimeout,signal:this.signal?AbortSignal.any([this.signal,this.failureSignal]):this.failureSignal})
      try{
        for await(const document of cursor){
          checkAbort(this.signal)
          if(this.failureSignal.aborted)fail('SOURCE_LOCK_UNCERTAIN','Source write lock continuity was lost during manifest capture.')
          const raw=rawBson(document)
          assertPortableBson(BSON.deserialize(raw,{promoteValues:false,promoteLongs:false,bsonRegExp:true}))
          count++;totalDocuments++;totalBytes+=raw.length
          if(totalDocuments>maximumDocuments||totalBytes>maxArchiveBytes)fail('RESOURCE_LIMIT','MongoDB validation exceeded the 5 million document or 2 GiB uncompressed data limit.')
          const value=BigInt('0x'+hash(raw));sum=(sum+value)%modulus;sumSquares=(sumSquares+value*value)%modulus
        }
      }finally{await cursor.close().catch(()=>{})}
      data[info.name]={documents:String(count),bsonHashSum:sum.toString(16).padStart(64,'0'),bsonHashSquares:sumSquares.toString(16).padStart(64,'0')}
    }
    // JSONB reloads dictionaries as ordinary objects. Preserve own collection
    // keys (including __proto__) without a prototype-only validation mismatch.
    return {format:1,...identity,objects,data,sequences:{}}
  }
  async close(){
    this.signal?.removeEventListener('abort',this.abort)
    try{await this.finishSnapshot()}finally{await this.client?.close(true);this.client=undefined;this.database=undefined}
  }
}

export async function mongoCredentials(config:MongoConfig,secret:MongoSecret,directory:string){
  const path=join(directory,`mongo-${randomUUID()}.yml`)
  // JSON string quoting is valid YAML scalar syntax, including quotes/backslashes.
  await writeFile(path,`uri: ${JSON.stringify(mongoUri(config,secret))}\n`,{mode:0o600,flag:'wx'})
  return {env:toolEnv(),args:['--config',path]}
}
export async function mongoToolVersion(binary:'mongodump'|'mongorestore',signal:AbortSignal){
  const version=await runTool(binary,['--version'],{env:toolEnv(),signal,capture:true,timeoutMs:10000})
  if(!/\b100\.20\.\d+\b/.test(version))fail('UNSUPPORTED_TOOL','MongoDB Database Tools 100.20.x are required for MongoDB 8.0 archives.')
  return {binary,version}
}

export class MongoAdapter extends MongoSession implements EngineAdapter {
  constructor(config:MongoConfig,private credentials:MongoSecret,signal?:AbortSignal,private adapterOptions:MongoAdapterOptions={}){super(config,credentials,signal,adapterOptions)}
  async backup(file:string,directory:string,signal:AbortSignal,phase?:(phase:string,message:string)=>Promise<void>){
    if(!this.adapterOptions.lockHooks)fail('SOURCE_LOCK_JOURNAL_REQUIRED','Durable source-server lock hooks are required for MongoDB backup.')
    const tool=await mongoToolVersion('mongodump',signal),credentials=await mongoCredentials(this.config,this.credentials,directory)
    const bounded=AbortSignal.any([signal,this.failureSignal,AbortSignal.timeout(lockMaximumMs)])
    let manifest:MongoManifest
    try{
      await phase?.('source-lock','Preparing durable source ownership before acquiring an explicitly approved server-wide MongoDB write lock.')
      await this.beginSnapshot()
      await phase?.('manifest','Capturing MongoDB collection options, indexes, BSON document counts and digests under the source lock.')
      manifest=await this.manifest()
      if(Buffer.byteLength(JSON.stringify(manifest))>2*1024*1024)fail('RESOURCE_LIMIT','The MongoDB validation manifest exceeds 2 MiB.')
      await phase?.('dumping','Creating a native MongoDB database archive while the acknowledged source write lock remains held.')
      await runTool(tool.binary,[...credentials.args,'--db',this.config.database,'--archive','--gzip','--numParallelCollections=1','--quiet'],{env:credentials.env,signal:bounded,stdoutFile:file})
      // Verify lock continuity and process identity after the native reader.
      await this.identity();await this.verifySnapshot()
      if(this.failureSignal.aborted)fail('SOURCE_LOCK_UNCERTAIN','MongoDB source lock continuity was not preserved.')
    }finally{await this.finishSnapshot()}
    await assertArchiveSize(file)
    checkAbort(signal)
    return {manifest,toolVersion:tool.version}
  }
  async restore(file:string,directory:string,signal:AbortSignal,expected:Manifest){
    if(expected.engine!=='mongodb'||expected.format!==1)fail('MANIFEST_UNAVAILABLE','A trusted MongoDB source manifest is required.')
    const source=expected.database
    if(!source)fail('MANIFEST_UNAVAILABLE','The trusted MongoDB source namespace is required for restore.')
    identifier(source)
    if(source.toLowerCase()===this.config.database.toLowerCase())fail('SOURCE_TARGET_CONFLICT','MongoDB restore requires a distinct target database name.')
    if(!this.config.restoreTarget)fail('TARGET_NOT_DESIGNATED','Choose a designated MongoDB restore target.')
    const tool=await mongoToolVersion('mongorestore',signal),credentials=await mongoCredentials(this.config,this.credentials,directory)
    await this.identity();await this.restrictedRestoreRole()
    if(!await this.empty())fail('TARGET_NOT_EMPTY','The MongoDB target must contain only the owner-created empty Steelkeep marker before restore.')
    checkAbort(signal)
    // Only installation-created, SHA-256-verified archives may reach this call;
    // shared restore service checks provenance/download checksum/fencing first.
    // No --drop, --preserveUUID, --oplogReplay, bypass validation or user restore.
    // --archive has an optional value: MongoDB Tools requires '=' for a file.
    // Separate argv entries select stdin instead and treat the path as a dump directory.
    await runTool(tool.binary,[...credentials.args,`--archive=${file}`,'--gzip',`--nsInclude=${source}.*`,`--nsFrom=${source}.*`,`--nsTo=${this.config.database}.*`,'--stopOnError','--maintainInsertionOrder','--numParallelCollections=1','--numInsertionWorkersPerCollection=1','--writeConcern={"w":1,"j":true}','--quiet'],{env:credentials.env,signal:AbortSignal.any([signal,this.failureSignal])})
    return {toolVersion:tool.version}
  }
}

export function createMongoAdapter(options:AdapterOptions):EngineAdapter {
  return new MongoAdapter(options.config as unknown as MongoConfig,options.secret as unknown as MongoSecret,options.signal,{lockHooks:options.lockHooks})
}
