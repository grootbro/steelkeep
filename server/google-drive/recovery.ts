import {createHash,randomUUID} from 'node:crypto'
import {createWriteStream} from 'node:fs'
import {rm} from 'node:fs/promises'
import {join} from 'node:path'
import {Readable,Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {isDeepStrictEqual} from 'node:util'
import {sql,type Kysely} from 'kysely'
import type {Schema} from '../db'
import type {Manifest} from '../engines/types'
import {assertArchivedSourceDatabase} from '../engines/database'
import {workingDirectory} from '../backup'
import {maxArchiveBytes} from '../process'
import {AppError,seal} from '../security'
import {audit} from '../agents'
import {driveClient,openStoredArchive,type PortableArchive,type StoredConnection} from '../storage'
import {isSourceKind,type SourceKind} from '../../shared/connections'
import {driveId,type DriveFile,type GoogleDriveClient} from './client'
import {driveManifestInventory,inspectDriveArchive} from './source'

const descriptorLimit=3*1024*1024,manifestLimit=2*1024*1024
type RecoveryFile=DriveFile&{properties?:Record<string,string>}
type RecoveryClient=Pick<GoogleDriveClient,'metadata'|'children'|'download'>
type ArchiveSource={length:number|undefined;body:AsyncIterable<Uint8Array>;close():void}
type Imported={artifactId:string;runId:string;sourceId:string;imported:true;verification:'full-sha256';notice:string}
type ImportRequest={storageId:string;fileId:string;idempotencyKey:string;confirmImport:boolean}
const invalid=()=>new AppError('DRIVE_RECOVERY_INVALID','The selected archive and recovery descriptor do not establish one valid portable snapshot.',409)
const changed=()=>new AppError('DRIVE_RECOVERY_CHANGED','The archive, descriptor or storage connection changed during import. No snapshot was adopted.',409)
const notice='Snapshot imported after full-byte verification. Recovery into a separate empty target still requires its own review and execution.'
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw invalid();return value as Record<string,unknown>}
function text(value:unknown,max=4096):string{if(typeof value!=='string'||!value.length||value.length>max||/[\0\r\n]/.test(value))throw invalid();return value}
function uuid(value:unknown){const result=text(value,36);if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(result))throw invalid();return result}
function sha(value:unknown){const result=text(value,64);if(!/^[a-f0-9]{64}$/.test(result))throw invalid();return result}
function size(value:unknown){const result=text(value,20);if(!/^[1-9]\d*$/.test(result)||BigInt(result)>BigInt(maxArchiveBytes))throw invalid();return result}
function validateManifestTree(value:unknown){
 const pending:Array<{value:unknown;depth:number}>=[{value,depth:0}];let items=0
 while(pending.length){const next=pending.pop()!;if(++items>100000||next.depth>40)throw invalid()
  if(next.value===null||typeof next.value==='boolean'||typeof next.value==='string')continue
  if(typeof next.value==='number'){if(!Number.isFinite(next.value))throw invalid();continue}
  if(!next.value||typeof next.value!=='object')throw invalid()
  if(!Array.isArray(next.value))object(next.value)
  for(const key of Object.keys(next.value)){if(key==='__proto__')throw invalid();pending.push({value:(next.value as Record<string,unknown>)[key],depth:next.depth+1})}
 }
 if(Buffer.byteLength(JSON.stringify(value))>manifestLimit)throw invalid()
}

export function parsePortableArchive(value:unknown):PortableArchive{
 const row=object(value)
 if(row.format!=='steelkeep-recovery-v1'||!isSourceKind(String(row.engine)))throw invalid()
 const engine=row.engine as SourceKind,sourceDatabase=text(row.sourceDatabase),manifest=object(row.manifest)
 if(manifest.format!==1||manifest.engine!==engine||manifest.database!==sourceDatabase||manifest.serverVersion!==row.serverVersion)throw invalid()
 object(manifest.objects);object(manifest.data);object(manifest.sequences);validateManifestTree(manifest)
 if(manifest.binding!==undefined)text(manifest.binding)
 if(engine==='google_drive')driveId(sourceDatabase)
 else assertArchivedSourceDatabase(engine,sourceDatabase)
 const createdAt=text(row.createdAt,64);if(!Number.isFinite(Date.parse(createdAt)))throw invalid()
 return {format:'steelkeep-recovery-v1',artifactId:uuid(row.artifactId),engine,sourceDatabase,serverVersion:text(row.serverVersion,512),toolVersion:text(row.toolVersion,512),manifest:manifest as Manifest,size:size(row.size),sha256:sha(row.sha256),createdAt,archiveFileId:driveId(text(row.archiveFileId,200)),filename:text(row.filename,1024)}
}

/** Public properties permit recovery after replacing the original OAuth project. */
export function recoveryProperties(file:RecoveryFile):Record<string,string>{
 const publicProperties=file.properties??{},privateProperties=file.appProperties??{}
 for(const [key,value]of Object.entries(privateProperties))if(Object.hasOwn(publicProperties,key)&&publicProperties[key]!==value)throw invalid()
 return {...privateProperties,...publicProperties}
}
export function validateRecoveryArchiveFile(file:RecoveryFile,folderId:string){
 const properties=recoveryProperties(file)
 if(file.trashed||file.mimeType!=='application/octet-stream'||file.parents.length!==1||file.parents[0]!==folderId||properties.steelkeepArchive!=='1'||!isSourceKind(properties.engine??''))throw invalid()
 return {fileId:driveId(file.id),name:file.name,size:size(file.size),sha256:sha(properties.sha256),engine:properties.engine as SourceKind,originalArtifactId:uuid(properties.artifactId),recoveryId:driveId(properties.recoveryId??'')}
}
export function validateRecoveryPair(archive:RecoveryFile,descriptorFile:RecoveryFile,folderId:string,descriptor:PortableArchive){
 const metadata=validateRecoveryArchiveFile(archive,folderId),properties=recoveryProperties(descriptorFile)
 if(descriptorFile.id!==metadata.recoveryId||descriptorFile.trashed||descriptorFile.mimeType!=='application/json'||descriptorFile.parents.length!==1||descriptorFile.parents[0]!==folderId||properties.steelkeepRecovery!=='1'||properties.archiveId!==archive.id||properties.artifactId!==metadata.originalArtifactId)throw invalid()
 if(descriptor.archiveFileId!==archive.id||descriptor.artifactId!==metadata.originalArtifactId||descriptor.engine!==metadata.engine||descriptor.size!==metadata.size||descriptor.sha256!==metadata.sha256)throw invalid()
 return metadata
}

export async function writeVerifiedRecoveryArchive(source:ArchiveSource,file:string,expected:{size:string;sha256:string},signal:AbortSignal){
 const expectedSize=Number(size(expected.size)),expectedHash=sha(expected.sha256)
 if(source.length!==expectedSize){source.close();throw invalid()}
 const hash=createHash('sha256');let bytes=0
 const bound=new Transform({transform(chunk:Buffer,_encoding,done){bytes+=chunk.length;if(bytes>expectedSize||bytes>maxArchiveBytes){done(invalid());return}hash.update(chunk);done(null,chunk)}})
 try{
  await pipeline(Readable.from(source.body),bound,createWriteStream(file,{flags:'wx',mode:0o600}),{signal})
  if(bytes!==expectedSize||hash.digest('hex')!==expectedHash)throw new AppError('CHECKSUM_MISMATCH','The complete downloaded archive did not match its recovery descriptor. No snapshot was adopted.',409)
 }finally{source.close()}
}

export function recoveryImportKey(actor:string,storageId:string,idempotencyKey:string){
 if(typeof actor!=='string'||!actor.length||actor.length>200||/[\0\r\n]/.test(actor)||typeof idempotencyKey!=='string'||idempotencyKey.length<16||idempotencyKey.length>160||/[\0\r\n]/.test(idempotencyKey))throw new AppError('INVALID_REQUEST_KEY','Use an authenticated actor and a request key of 16 to 160 characters.')
 uuid(storageId)
 return 'drive-import:'+createHash('sha256').update(JSON.stringify([actor,storageId,idempotencyKey])).digest('hex')
}

function importedSourceConfig(descriptor:PortableArchive):Record<string,unknown>{
 const result:Record<string,unknown>={database:descriptor.sourceDatabase,restoreTarget:false,importedArchive:true,sourceBinding:descriptor.manifest.binding??null}
 if(descriptor.engine==='google_drive'){
  const inventory=driveManifestInventory(descriptor.manifest)
  if(inventory.rootId!==descriptor.sourceDatabase||descriptor.manifest.binding!==`drive:${inventory.sourceAccountId}:${inventory.rootId}`)throw invalid()
  result.folderId=inventory.rootId;result.accountId=inventory.sourceAccountId
 }else if(descriptor.engine==='sqlite'){
  if(!descriptor.sourceDatabase.startsWith('/'))throw invalid();result.path=descriptor.sourceDatabase
 }else if(descriptor.engine==='redis'){
  const index=descriptor.sourceDatabase.match(/^redis:(\d|1[0-5])$/);if(!index)throw invalid();result.dbIndex=Number(index[1])
 }
 return result
}

export class GoogleDriveRecovery{
 private active=0
 constructor(readonly db:Kysely<Schema>,readonly options:{client?:(storage:StoredConnection,signal:AbortSignal)=>RecoveryClient;open?:(storage:StoredConnection,key:string,signal:AbortSignal)=>Promise<ArchiveSource>;inspect?:(file:string,dir:string,signal:AbortSignal)=>Promise<Manifest>}={}){}
 private async storage(id:string){
  uuid(id);const row=await this.db.selectFrom('connections').selectAll().where('id','=',id).executeTakeFirst()
  if(!row||row.kind!=='google_drive_storage')throw new AppError('INVALID_STORAGE','Choose a configured Google Drive storage or read-only recovery folder.',409)
  driveId(String(row.config.folderId??''));return row
 }
 private client(storage:StoredConnection,signal:AbortSignal){return this.options.client?.(storage,signal)??driveClient(this.db,storage,signal)}
 async browse(storageId:string,pageToken?:string){
  const storage=await this.storage(storageId),signal=AbortSignal.timeout(30000),client=this.client(storage,signal),folder=await client.metadata(String(storage.config.folderId))
  if(folder.trashed||folder.mimeType!=='application/vnd.google-apps.folder')throw invalid()
  const page=await client.children(folder.id,{...(folder.driveId?{driveId:folder.driveId}:{}),...(pageToken?{pageToken}:{})})
  const items=page.files.flatMap(file=>{
   const properties=recoveryProperties(file)
   if(properties.steelkeepArchive!=='1')return []
   try{const value=validateRecoveryArchiveFile(file,folder.id);return [{...value,portable:true as const,verification:'metadata-only' as const}]}catch(error){if(error instanceof AppError)return [];throw error}
  })
  return {items,nextPageToken:page.nextPageToken??null,verification:'metadata-only' as const,notice:'Listed metadata is not a verified recovery. Import downloads and hashes the complete archive before adoption.'}
 }
 private async replay(db:Kysely<Schema>,key:string,input:ImportRequest):Promise<Imported|undefined>{
  const run=await db.selectFrom('runs').select(['id','source_id','storage_id','artifact_id','validation','type','status']).where('idempotency_key','=',key).executeTakeFirst()
  if(!run)return
  const imported=run.validation?.driveImport
  if(run.type!=='backup'||run.status!=='succeeded'||!run.artifact_id||run.storage_id!==input.storageId||!imported||typeof imported!=='object'||Array.isArray(imported)||(imported as Record<string,unknown>).fileId!==input.fileId)throw new AppError('REQUEST_KEY_CONFLICT','This import key already belongs to a different archive or operation.',409)
  const artifact=await db.selectFrom('artifacts').select(['id','run_id','source_id','storage_id','object_key','deletion_state']).where('id','=',run.artifact_id).executeTakeFirst()
  if(!artifact||artifact.run_id!==run.id||artifact.source_id!==run.source_id||artifact.storage_id!==input.storageId||artifact.object_key!==input.fileId||artifact.deletion_state!=='active')throw new AppError('DRIVE_IMPORT_UNAVAILABLE','The previously imported snapshot is unavailable. Inspect its existing history.',409)
  return {artifactId:artifact.id,runId:run.id,sourceId:run.source_id,imported:true,verification:'full-sha256',notice}
 }
 private async assertNotAdopted(db:Kysely<Schema>,fileId:string,request?:{key:string;input:ImportRequest}){
  if(await db.selectFrom('artifacts').select('id').where('object_key','=',fileId).executeTakeFirst()){
   // Another identical import may have committed after the initial request lookup.
   const existing=request?await this.replay(db,request.key,request.input):undefined
   if(existing)return existing
   throw new AppError('DRIVE_ARCHIVE_ALREADY_IMPORTED','This Drive archive is already recorded by this installation. Use its existing snapshot instead of adopting it again.',409)
  }
 }
 async import(input:ImportRequest,actor:string,requestSignal?:AbortSignal):Promise<Imported>{
  if(input.confirmImport!==true)throw new AppError('DRIVE_IMPORT_CONFIRMATION','Confirm adoption of this externally stored archive before importing it.',409)
  driveId(input.fileId);const key=recoveryImportKey(actor,input.storageId,input.idempotencyKey)
  const prior=await this.replay(this.db,key,input);if(prior)return prior
  const raced=await this.assertNotAdopted(this.db,input.fileId,{key,input});if(raced)return raced
  if(this.active>=2)throw new AppError('DRIVE_IMPORT_LIMIT','Two archive imports are already active. Wait for one to finish.',429)
  this.active++
  const signal=AbortSignal.any([...(requestSignal?[requestSignal]:[]),AbortSignal.timeout(2*60*60*1000)]);let directory:string|undefined
  try{
   const storage=await this.storage(input.storageId),folderId=String(storage.config.folderId),client=this.client(storage,signal),archive=await client.metadata(input.fileId)
   const metadata=validateRecoveryArchiveFile(archive,folderId),descriptorFile=await client.metadata(metadata.recoveryId)
   if(descriptorFile.size===undefined||BigInt(descriptorFile.size)>BigInt(descriptorLimit))throw invalid()
   const content=await client.download(descriptorFile),chunks:Uint8Array[]=[];let length=0
   try{for await(const chunk of content.body){signal.throwIfAborted();length+=chunk.length;if(length>descriptorLimit)throw invalid();chunks.push(chunk)}}finally{content.close()}
   let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))}catch{throw invalid()}
   let descriptor=parsePortableArchive(raw)
   validateRecoveryPair(archive,descriptorFile,folderId,descriptor)
   // Refuse missing recovery keys or impossible source identities before a large transfer.
   let sourceConfig=importedSourceConfig(descriptor)
   directory=await workingDirectory();const file=join(directory,'portable-archive')
   const source=this.options.open?await this.options.open(storage,input.fileId,signal):await openStoredArchive(this.db,storage,input.fileId,signal)
   await writeVerifiedRecoveryArchive(source,file,descriptor,signal)
   if(descriptor.engine==='google_drive'){
    const actual=await(this.options.inspect??inspectDriveArchive)(file,directory,signal)
    const withoutInventory=(manifest:Manifest)=>({...manifest,objects:Object.fromEntries(Object.entries(manifest.objects).filter(([name])=>name!=='inventory'))})
    if(!isDeepStrictEqual(withoutInventory(descriptor.manifest),withoutInventory(actual))||!isDeepStrictEqual(driveManifestInventory(descriptor.manifest),driveManifestInventory(actual)))throw invalid()
    descriptor={...descriptor,manifest:actual}
    sourceConfig=importedSourceConfig(descriptor)
   }
   const [archiveAfter,descriptorAfter]=await Promise.all([client.metadata(archive.id),client.metadata(descriptorFile.id)])
   validateRecoveryPair(archiveAfter,descriptorAfter,folderId,descriptor)
   if(archiveAfter.version!==archive.version||descriptorAfter.version!==descriptorFile.version)throw changed()
   const engine=descriptor.engine;if(!isSourceKind(engine))throw invalid()
   return await this.db.transaction().execute(async db=>{
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'drive-import-file:'+input.fileId},0))`.execute(db)
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`.execute(db)
    const replay=await this.replay(db,key,input);if(replay)return replay
    await this.assertNotAdopted(db,input.fileId)
    const current=await db.selectFrom('connections').select(['kind','revision','config','secret']).where('id','=',storage.id).forShare().executeTakeFirst()
    if(!current||current.kind!==storage.kind||current.revision!==storage.revision||current.secret!==storage.secret||!isDeepStrictEqual(current.config,storage.config))throw changed()
    signal.throwIfAborted();const sourceId=randomUUID(),runId=randomUUID(),artifactId=randomUUID(),time=new Date()
    await db.insertInto('connections').values({id:sourceId,name:`Imported ${engine} snapshot`,kind:engine,config:sourceConfig,secret:seal({}),check_status:'untested',checked_at:null}).execute()
    const provenance={fileId:input.fileId,recoveryFileId:descriptorFile.id,originalArtifactId:descriptor.artifactId,sourceCreatedAt:descriptor.createdAt,actor,verification:'full-sha256',importedAt:time.toISOString()}
    await db.insertInto('runs').values({id:runId,plan_id:null,type:'backup',status:'succeeded',phase:'imported',idempotency_key:key,source_id:sourceId,storage_id:storage.id,target_id:null,artifact_id:null,started_at:time,finished_at:time,heartbeat_at:null,error_code:null,error_message:null,validation:{driveImport:provenance},cancel_requested:false,attempt:0,execution_token:null}).execute()
    await db.insertInto('artifacts').values({id:artifactId,run_id:runId,source_id:sourceId,storage_id:storage.id,object_key:input.fileId,size:descriptor.size,sha256:descriptor.sha256,engine,server_version:descriptor.serverVersion,tool_version:descriptor.toolVersion,manifest:descriptor.manifest,availability:'present',checked_at:time}).execute()
    await db.updateTable('runs').set({artifact_id:artifactId}).where('id','=',runId).execute()
    await db.insertInto('events').values({run_id:runId,phase:'imported',message:'Portable archive adopted after complete-byte SHA-256 verification. No recovery target was written; restore requires a separate review.'}).execute()
    await audit(db,actor,'drive.archive.imported',artifactId)
    return {artifactId,runId,sourceId,imported:true,verification:'full-sha256',notice}
   })
  }finally{this.active--;if(directory)await rm(directory,{recursive:true,force:true}).catch(()=>{})}
 }
}
