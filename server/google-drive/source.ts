import {createCipheriv,createDecipheriv,createHash,hkdfSync,randomBytes,randomUUID} from 'node:crypto'
import {createReadStream,createWriteStream,readFileSync,lstatSync} from 'node:fs'
import {lstat,mkdtemp,open,rm,statfs} from 'node:fs/promises'
import {join} from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {config} from '../config'
import {AppError,seal,unseal} from '../security'
import {maxArchiveBytes} from '../process'
import type {AdapterOptions,EngineAdapter,EnginePhase,Identity,Manifest,ValidationComparison} from '../engines/types'
import {driveId,driveExportFormat,type DriveFile,type DriveContent,type GoogleDriveClient} from './client'

const magic=Buffer.from('SKDRV001'),headerBytes=52,tagBytes=16,maxInventoryBytes=1024*1024
const maxEntries=1000,maxDepth=32,maxContentBytes=maxArchiveBytes-8*1024*1024
const folderMime='application/vnd.google-apps.folder'
const supportedExports=new Set(['application/vnd.google-apps.document','application/vnd.google-apps.spreadsheet','application/vnd.google-apps.presentation'])
const profile='google-drive-folder-v1'
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const byId=(a:{id:string},b:{id:string})=>a.id<b.id?-1:a.id>b.id?1:0
type DriveSourceClient=Pick<GoogleDriveClient,'account'|'metadata'|'children'|'download'|'export'|'generateIds'|'createFolder'|'uploadFile'>

export type DriveArchiveEntry={id:string;parentId:string;name:string;mimeType:string;version:string;modifiedTime?:string;kind:'folder'|'file';archiveName?:string;archiveMimeType?:string;size?:number;sha256?:string}
export type DriveArchiveInventory={format:1;profile:typeof profile;archiveId:string;rootId:string;rootName:string;sourceAccountId:string;capturedAt:string;consistency:'version-checked-folder-inventory';entries:DriveArchiveEntry[]}
type FileFrame={offset:number;size:number;sha256:string}
type OpenArchive={manifest:Manifest;inventory:DriveArchiveInventory;plainFile:string;files:Map<string,FileFrame>;cleanup():Promise<void>}

const invalidArchive=()=>new AppError('GOOGLE_DRIVE_ARCHIVE_INVALID','The Drive archive structure, content digests or authentication could not be verified.')
function checkSignal(signal:AbortSignal){if(signal.aborted)throw signal.reason instanceof AppError?signal.reason:new AppError('CANCELLED','Operation cancelled.')}
function text(value:unknown,max=1024):string{if(typeof value!=='string'||!value.length||value.length>max||value.includes('\0'))throw invalidArchive();return value}
function integer(value:unknown,max=maxContentBytes):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>max)throw invalidArchive();return value}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw invalidArchive();return value as Record<string,unknown>}
function archiveId(value:unknown){const id=text(value,128);if(!/^[a-f0-9-]{36}$/.test(id))throw invalidArchive();return id}
function version(value:unknown){const result=text(value,128);if(!/^\d+$/.test(result))throw invalidArchive();return result}

/** Export this derived key, never the installation metadata encryption key. */
export function deriveDriveRecoveryKey():Buffer{
 const file=process.env.STEELKEEP_DRIVE_RECOVERY_KEY_FILE
 if(file){
  return configuredRecoveryKey(file)
 }
 return Buffer.from(hkdfSync('sha256',config.key(),Buffer.alloc(0),Buffer.from('steelkeep-google-drive-archive-v1'),32))
}

function configuredRecoveryKey(file:string){
 try{const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size!==32||(info.mode&0o077)!==0)throw new Error();const key=readFileSync(file);if(key.length!==32)throw new Error();return key}
 catch{throw new AppError('GOOGLE_DRIVE_RECOVERY_KEY_INVALID','The configured Drive recovery key must be a private regular 32-byte file.')}
}

function parseInventory(value:unknown):DriveArchiveInventory{
 const input=object(value)
 if(input.format!==1||input.profile!==profile||input.consistency!=='version-checked-folder-inventory'||!Array.isArray(input.entries)||input.entries.length>maxEntries)throw invalidArchive()
 const rootId=driveId(text(input.rootId,256)),ids=new Set<string>(),entries:DriveArchiveEntry[]=[]
 let total=0
 for(const raw of input.entries){
  const row=object(raw),id=driveId(text(row.id,256)),parentId=driveId(text(row.parentId,256)),kind=row.kind
  if(ids.has(id)||id===rootId||(kind!=='folder'&&kind!=='file'))throw invalidArchive();ids.add(id)
  const entry:DriveArchiveEntry={id,parentId,name:text(row.name),mimeType:text(row.mimeType,256),version:version(row.version),kind}
  if(row.modifiedTime!==undefined){entry.modifiedTime=text(row.modifiedTime,128);if(!Number.isFinite(Date.parse(entry.modifiedTime)))throw invalidArchive()}
  if(kind==='folder'){if(entry.mimeType!==folderMime)throw invalidArchive()}
  else{
   entry.archiveName=text(row.archiveName);entry.archiveMimeType=text(row.archiveMimeType,256);entry.size=integer(row.size)
   if(typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256))throw invalidArchive();entry.sha256=row.sha256
   if(entry.mimeType.startsWith('application/vnd.google-apps.')){
    const format=driveExportFormat(entry.mimeType),expectedName=format&&(entry.name.toLowerCase().endsWith(format.extension)?entry.name:entry.name+format.extension)
    if(!supportedExports.has(entry.mimeType)||!format||entry.archiveMimeType!==format.mimeType||entry.archiveName!==expectedName)throw invalidArchive()
   }else if(entry.archiveMimeType!==entry.mimeType||entry.archiveName!==entry.name||!/^[-\w!#$&^_.+]+\/[-\w!#$&^_.+]+$/.test(entry.mimeType))throw invalidArchive()
   total+=entry.size;if(total>maxContentBytes)throw invalidArchive()
  }
  entries.push(entry)
 }
 const byId=new Map(entries.map(entry=>[entry.id,entry]))
 for(const entry of entries){let parent=entry.parentId,depth=1;const seen=new Set([entry.id]);while(parent!==rootId){const ancestor=byId.get(parent);if(!ancestor||ancestor.kind!=='folder'||seen.has(parent)||++depth>maxDepth)throw invalidArchive();seen.add(parent);parent=ancestor.parentId}}
 const capturedAt=text(input.capturedAt,128);if(!Number.isFinite(Date.parse(capturedAt)))throw invalidArchive()
 const inventory:DriveArchiveInventory={format:1,profile,archiveId:archiveId(input.archiveId),rootId,rootName:text(input.rootName),sourceAccountId:text(input.sourceAccountId,256),capturedAt,consistency:'version-checked-folder-inventory',entries}
 if(Buffer.byteLength(JSON.stringify(inventory))>maxInventoryBytes)throw new AppError('RESOURCE_LIMIT','The Drive inventory exceeds the 1 MiB profile limit.')
 return inventory
}

export function driveManifestInventory(manifest:Manifest):DriveArchiveInventory{
 try{if(manifest.engine!=='google_drive'||manifest.objects.profile!==profile||typeof manifest.objects.inventory!=='string')throw invalidArchive();return parseInventory(unseal(manifest.objects.inventory,deriveDriveRecoveryKey()))}
 catch(error){if(error instanceof AppError)throw error;throw new AppError('GOOGLE_DRIVE_RECOVERY_KEY_REQUIRED','This Drive manifest requires its original exported Drive recovery key.')}
}

const normalizedTree=(inventory:DriveArchiveInventory)=>inventory.entries.map(entry=>({id:entry.id,parentId:entry.parentId,name:entry.name,mimeType:entry.mimeType,kind:entry.kind,...(entry.kind==='file'?{archiveName:entry.archiveName,archiveMimeType:entry.archiveMimeType}:{})})).sort(byId)
const normalizedData=(inventory:DriveArchiveInventory)=>inventory.entries.filter(entry=>entry.kind==='file').map(entry=>({id:entry.id,size:entry.size,sha256:entry.sha256})).sort(byId)
function makeManifest(identity:Identity,inventory:DriveArchiveInventory):Manifest{
 const parsed=parseInventory(inventory),files=normalizedData(parsed)
 return {format:1,...identity,objects:{profile,treeHash:digest(normalizedTree(parsed)),inventory:seal(parsed,deriveDriveRecoveryKey())},data:{files:files.length,bytes:files.reduce((sum,file)=>sum+(file.size??0),0),sha256:digest(files)},sequences:{}}
}
function sourceIdentity(inventory:DriveArchiveInventory):Identity{return {engine:'google_drive',database:inventory.rootId,binding:`drive:${inventory.sourceAccountId}:${inventory.rootId}`,serverVersion:'Drive API v3 / folder-v1'}}
function frame(value:unknown){const bytes=Buffer.from(JSON.stringify(value));if(!bytes.length||bytes.length>maxInventoryBytes+1024)throw invalidArchive();const length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);return Buffer.concat([length,bytes])}
function streamKey(key:Buffer,salt:Buffer){return Buffer.from(hkdfSync('sha256',key,salt,Buffer.from('steelkeep-google-drive-stream-v1'),32))}
async function readExact(handle:Awaited<ReturnType<typeof open>>,length:number,position:number){const bytes=Buffer.alloc(length);let offset=0;while(offset<length){const result=await handle.read(bytes,offset,length-offset,position+offset);if(!result.bytesRead)throw invalidArchive();offset+=result.bytesRead}return bytes}
async function digestRange(handle:Awaited<ReturnType<typeof open>>,position:number,size:number,signal:AbortSignal){const hash=createHash('sha256'),buffer=Buffer.alloc(64*1024);let read=0;while(read<size){checkSignal(signal);const result=await handle.read(buffer,0,Math.min(buffer.length,size-read),position+read);if(!result.bytesRead)throw invalidArchive();hash.update(buffer.subarray(0,result.bytesRead));read+=result.bytesRead}return hash.digest('hex')}

async function openArchive(file:string,dir:string,signal:AbortSignal):Promise<OpenArchive>{
 checkSignal(signal)
 const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size<headerBytes+tagBytes+4||info.size>maxArchiveBytes)throw invalidArchive()
 const free=await statfs(dir);if(free.bavail*free.bsize<info.size+128*1024*1024)throw new AppError('DISK_SPACE','Drive recovery needs private temporary space for the fully authenticated archive.')
 const temporary=await mkdtemp(join(dir,'drive-open-')),plainFile=join(temporary,'authenticated.frames'),cleanup=()=>rm(temporary,{recursive:true,force:true})
 try{
  const encrypted=await open(file,'r');let header:Buffer,tag:Buffer
  try{header=await readExact(encrypted,headerBytes,0);tag=await readExact(encrypted,tagBytes,info.size-tagBytes)}finally{await encrypted.close()}
  if(!header.subarray(0,8).equals(magic))throw invalidArchive()
  const decipher=createDecipheriv('aes-256-gcm',streamKey(deriveDriveRecoveryKey(),header.subarray(8,40)),header.subarray(40,52));decipher.setAAD(header);decipher.setAuthTag(tag)
  try{await pipeline(createReadStream(file,{start:headerBytes,end:info.size-tagBytes-1}),decipher,createWriteStream(plainFile,{flags:'wx',mode:0o600}),{signal})}
  catch(error){checkSignal(signal);if(error instanceof AppError)throw error;throw new AppError('GOOGLE_DRIVE_RECOVERY_KEY_REQUIRED','Drive archive authentication failed. Use its original exported recovery key; no target data was applied.')}
  const input=await open(plainFile,'r'),length=(await input.stat()).size,files=new Map<string,FileFrame>();let offset=0,inventory:DriveArchiveInventory|undefined
  try{
   while(offset<length){
    checkSignal(signal);if(length-offset<4)throw invalidArchive()
    const jsonBytes=(await readExact(input,4,offset)).readUInt32BE();offset+=4
    if(!jsonBytes||jsonBytes>maxInventoryBytes+1024||offset+jsonBytes>length)throw invalidArchive()
    let record:Record<string,unknown>;try{record=object(JSON.parse((await readExact(input,jsonBytes,offset)).toString('utf8')))}catch{throw invalidArchive()}offset+=jsonBytes
    if(record.type==='file'){
     const id=driveId(text(record.id,256)),size=integer(record.size)
     if(files.size>=maxEntries||files.has(id)||offset+size>length)throw invalidArchive()
     files.set(id,{offset,size,sha256:await digestRange(input,offset,size,signal)});offset+=size
    }else if(record.type==='manifest'){
     if(inventory||offset!==length)throw invalidArchive();inventory=parseInventory(record.inventory)
    }else throw invalidArchive()
   }
  }finally{await input.close()}
  if(!inventory)throw invalidArchive()
  const entries=inventory.entries.filter(entry=>entry.kind==='file');if(entries.length!==files.size)throw invalidArchive()
  for(const entry of entries){const value=files.get(entry.id);if(!value||value.size!==entry.size||value.sha256!==entry.sha256)throw invalidArchive()}
  return {manifest:makeManifest(sourceIdentity(inventory),inventory),inventory,files,plainFile,cleanup}
 }catch(error){await cleanup().catch(()=>{});throw error}
}

/** Authenticates every byte before returning a portable archive's sealed inventory. */
export async function inspectDriveArchive(file:string,dir:string,signal:AbortSignal):Promise<Manifest>{const archive=await openArchive(file,dir,signal);try{return archive.manifest}finally{await archive.cleanup()}}

export class GoogleDriveAdapter implements EngineAdapter {
 readonly engine='google_drive' as const
 readonly archiveExtension='.skdrive'
 readonly failureSignal=new AbortController().signal
 private signal:AbortSignal
 private bound?:Identity
 private root?:DriveFile
 private restored?:DriveArchiveInventory
 constructor(private options:AdapterOptions,private client:DriveSourceClient){this.signal=options.signal}
 private async checkpoint(){checkSignal(this.signal);await this.options.checkpoint?.();checkSignal(this.signal)}
 private folder(){const id=driveId(String(this.options.config.folderId??this.options.config.database??''));if(this.options.config.database!==id)throw new AppError('IDENTITY_UNCERTAIN','The configured Drive folder identity is inconsistent.');return id}
 async connect(){this.bound=await this.identity();return this.bound}
 async identity():Promise<Identity>{
  await this.checkpoint();const [account,root]=await Promise.all([this.client.account(),this.client.metadata(this.folder())])
  if(root.trashed||root.mimeType!==folderMime||root.id!==this.folder())throw new AppError('GOOGLE_DRIVE_FOLDER_UNAVAILABLE','The selected Drive folder is unavailable.')
  if(root.driveId)throw new AppError('GOOGLE_DRIVE_PROFILE_UNSUPPORTED','The initial Drive folder profile supports My Drive; shared drives require separate recovery qualification.')
  if(account.permissionId!==this.options.config.accountId)throw new AppError('IDENTITY_UNCERTAIN','The connected Google account differs from the reviewed folder account.')
  const identity:Identity={engine:this.engine,database:root.id,binding:`drive:${account.permissionId}:${root.id}`,serverVersion:'Drive API v3 / folder-v1'}
  if(this.bound&&identity.binding!==this.bound.binding)throw new AppError('IDENTITY_UNCERTAIN','The Drive account or folder identity changed during the operation.')
  this.root=root;return identity
 }
 async empty(){await this.identity();for await(const child of this.children(this.folder())){if(!child.trashed)return false}return true}
 async restrictedRestoreRole(){if(this.options.config.restoreTarget!==true)throw new AppError('TARGET_NOT_DESIGNATED','Choose a Drive folder explicitly designated for recovery.');await this.identity();if(this.root?.capabilities.canAddChildren!==true)throw new AppError('GOOGLE_DRIVE_TARGET_PERMISSION','The connected Google grant cannot create files in the designated recovery folder.')}
 private async *children(folder:string){let pageToken:string|undefined;const seen=new Set<string>();do{await this.checkpoint();const response=await this.client.children(folder,{pageToken});for(const file of response.files)yield file;pageToken=response.nextPageToken;if(pageToken){if(seen.has(pageToken)||seen.size>maxEntries)throw new AppError('GOOGLE_DRIVE_PAGINATION_INVALID','Drive returned an ambiguous folder listing.');seen.add(pageToken)}}while(pageToken)}
 private async inventory():Promise<{identity:Identity;root:DriveFile;entries:DriveArchiveEntry[]}>{
  const identity=await this.identity(),root=this.root!,entries:DriveArchiveEntry[]=[],seen=new Set([root.id]),pending=[{id:root.id,depth:0}]
  while(pending.length){const current=pending.shift()!;for await(const file of this.children(current.id)){
   if(file.trashed)continue
   if(file.driveId||file.parents.length!==1||file.parents[0]!==current.id||seen.has(file.id))throw new AppError('GOOGLE_DRIVE_TREE_UNCERTAIN','Drive returned an unsupported or ambiguous folder tree.');seen.add(file.id)
   if(entries.length>=maxEntries||current.depth>=maxDepth)throw new AppError('RESOURCE_LIMIT','Drive folders are limited to 1,000 entries and 32 levels in this profile.')
   const item:DriveArchiveEntry={id:driveId(file.id),parentId:current.id,name:text(file.name),mimeType:text(file.mimeType,256),version:version(file.version),kind:file.mimeType===folderMime?'folder':'file',...(file.modifiedTime?{modifiedTime:file.modifiedTime}:{})}
   if(item.kind==='folder')pending.push({id:file.id,depth:current.depth+1})
   else if(file.mimeType.startsWith('application/vnd.google-apps.')){
    if(!supportedExports.has(file.mimeType))throw new AppError('GOOGLE_DRIVE_FILE_UNSUPPORTED','The selected folder contains shortcuts or Google Workspace file types outside the supported recovery profile.')
    const format=driveExportFormat(file.mimeType);if(!format)throw new AppError('GOOGLE_DRIVE_FILE_UNSUPPORTED','This Google Workspace export is unsupported.')
    item.archiveMimeType=format.mimeType;item.archiveName=file.name.toLowerCase().endsWith(format.extension)?file.name:file.name+format.extension
   }else{item.archiveMimeType=file.mimeType;item.archiveName=file.name}
   entries.push(item)
  }}
  entries.sort(byId);return {identity,root,entries}
 }
 private metadataMatches(entry:DriveArchiveEntry,file:DriveFile){return !file.trashed&&!file.driveId&&file.id===entry.id&&file.version===entry.version&&file.name===entry.name&&file.mimeType===entry.mimeType&&file.parents.length===1&&file.parents[0]===entry.parentId}
 private async capture(entry:DriveArchiveEntry,file?:string):Promise<{size:number;sha256:string}>{
  await this.checkpoint();const before=await this.client.metadata(entry.id)
  if(!this.metadataMatches(entry,before))throw new AppError('GOOGLE_DRIVE_SOURCE_CHANGED','A Drive entry changed during capture; no complete snapshot was published.')
  if(before.capabilities.canDownload!==true)throw new AppError('GOOGLE_DRIVE_DOWNLOAD_FORBIDDEN','A selected Drive file cannot be downloaded; the backup cannot claim a complete folder.')
  let content:DriveContent|undefined,output:Awaited<ReturnType<typeof open>>|undefined,size=0,lastCheckpoint=Date.now();const hash=createHash('sha256')
  try{
   content=before.mimeType.startsWith('application/vnd.google-apps.')?await this.client.export(before,entry.archiveMimeType!):await this.client.download(before)
   if(file)output=await open(file,'wx',0o600)
   for await(const chunk of content.body){checkSignal(this.signal);if(Date.now()-lastCheckpoint>=1000){await this.checkpoint();lastCheckpoint=Date.now()}size+=chunk.byteLength;if(size>maxContentBytes||(before.mimeType.startsWith('application/vnd.google-apps.')&&size>10*1024*1024))throw new AppError('RESOURCE_LIMIT','A Drive file exceeds its bounded binary or Workspace-export profile.');hash.update(chunk);if(output){let offset=0;while(offset<chunk.byteLength){const result=await output.write(chunk,offset,chunk.byteLength-offset);if(!result.bytesWritten)throw new AppError('DISK_SPACE','The private Drive capture could not be written.');offset+=result.bytesWritten}}}
  }finally{content?.close();await output?.close()}
  const sha256=hash.digest('hex'),after=await this.client.metadata(entry.id)
  if(!this.metadataMatches(entry,after)||(!before.mimeType.startsWith('application/vnd.google-apps.')&&(before.size!==String(size)||(before.sha256Checksum&&before.sha256Checksum!==sha256))))throw new AppError('GOOGLE_DRIVE_SOURCE_CHANGED','Drive content or its version changed during capture; no complete snapshot was published.')
  return {size,sha256}
 }
 private signature(root:DriveFile,entries:DriveArchiveEntry[]){return digest({root:{id:root.id,name:root.name,version:root.version},entries:entries.map(({size,sha256,...entry})=>entry)})}
 private async recheckTree(initial:Awaited<ReturnType<GoogleDriveAdapter['inventory']>>){const latest=await this.inventory();if(this.signature(initial.root,initial.entries)!==this.signature(latest.root,latest.entries))throw new AppError('GOOGLE_DRIVE_SOURCE_CHANGED','The selected Drive tree changed during capture; retry after the folder becomes stable.')}
 private snapshot(root:DriveFile,entries:DriveArchiveEntry[]):DriveArchiveInventory{return parseInventory({format:1,profile,archiveId:randomUUID(),rootId:root.id,rootName:root.name,sourceAccountId:this.options.config.accountId,capturedAt:new Date().toISOString(),consistency:'version-checked-folder-inventory',entries})}
 async manifest():Promise<Manifest>{
  if(this.options.config.restoreTarget)return this.restoredManifest()
  const initial=await this.inventory();let total=0
  for(const entry of initial.entries)if(entry.kind==='file'){Object.assign(entry,await this.capture(entry));total+=entry.size!;if(total>maxContentBytes)throw new AppError('RESOURCE_LIMIT','The selected Drive folder exceeds the archive resource limit.')}
  await this.recheckTree(initial);return makeManifest(initial.identity,this.snapshot(initial.root,initial.entries))
 }
 async backup(file:string,dir:string,signal:AbortSignal,phase:EnginePhase){
  this.signal=AbortSignal.any([this.options.signal,signal]);if(this.options.config.restoreTarget)throw new AppError('INVALID_SOURCE','A designated recovery folder cannot be captured as a source.')
  const initial=await this.inventory(),temporary=await mkdtemp(join(dir,'drive-capture-')),salt=randomBytes(32),nonce=randomBytes(12),header=Buffer.concat([magic,salt,nonce]),cipher=createCipheriv('aes-256-gcm',streamKey(deriveDriveRecoveryKey(),salt),nonce);cipher.setAAD(header)
  let manifest:Manifest|undefined,total=0
  await phase('capturing-files','Capturing the selected Drive tree and portable Workspace exports with version and SHA-256 checks.')
  const self=this
  async function* entries(){for(const entry of initial.entries)if(entry.kind==='file'){
   const captured=join(temporary,randomUUID());try{Object.assign(entry,await self.capture(entry,captured));total+=entry.size!;if(total>maxContentBytes)throw new AppError('RESOURCE_LIMIT','The selected Drive folder exceeds the archive resource limit.');yield frame({type:'file',id:entry.id,size:entry.size});if(entry.size)for await(const chunk of createReadStream(captured))yield chunk}finally{await rm(captured,{force:true})}
  }await self.recheckTree(initial);const inventory=self.snapshot(initial.root,initial.entries);manifest=makeManifest(initial.identity,inventory);yield frame({type:'manifest',inventory})}
  try{
   const output=await open(file,'wx',0o600);try{await output.writeFile(header)}finally{await output.close()}
   await pipeline(Readable.from(entries()),cipher,createWriteStream(file,{flags:'a',mode:0o600}),{signal:this.signal})
   const outputTag=await open(file,'a');try{await outputTag.writeFile(cipher.getAuthTag())}finally{await outputTag.close()}
   if((await lstat(file)).size>maxArchiveBytes)throw new AppError('RESOURCE_LIMIT','The encrypted Drive archive exceeds the archive resource limit.')
   if(!manifest)throw invalidArchive();return {manifest,toolVersion:'Steelkeep Drive folder-v1 / AES-256-GCM'}
  }finally{await rm(temporary,{recursive:true,force:true})}
 }
 async restore(file:string,dir:string,signal:AbortSignal,expected:Manifest){
  this.signal=AbortSignal.any([this.options.signal,signal]);const identity=await this.identity();await this.restrictedRestoreRole()
  const recorded=driveManifestInventory(expected)
  if(identity.database===recorded.rootId||identity.binding===expected.binding)throw new AppError('SOURCE_TARGET_CONFLICT','The recovery folder must be distinct from the recorded Drive source.')
  const archive=await openArchive(file,dir,this.signal)
  try{
   if(digest(recorded)!==digest(archive.inventory)||expected.database!==recorded.rootId||expected.binding!==sourceIdentity(recorded).binding)throw invalidArchive()
   if(!await this.empty())throw new AppError('TARGET_NOT_EMPTY','The designated Drive recovery folder is not empty. No restore data was applied.')
   const ids=new Map<string,string>([[recorded.rootId,identity.database]]),remaining=[...recorded.entries]
   while(remaining.length){const index=remaining.findIndex(entry=>ids.has(entry.parentId));if(index<0)throw invalidArchive();const [entry]=remaining.splice(index,1);await this.checkpoint();await this.identity()
    const [id]=await this.client.generateIds(1);if(!id||ids.has(entry.id))throw invalidArchive()
    const appProperties={steelkeepArchiveId:recorded.archiveId,steelkeepSourceId:entry.id},parentId=ids.get(entry.parentId)!
    // New IDs only. Any ambiguous write leaves the shared durable target reservation intact.
    const created=entry.kind==='folder'?await this.client.createFolder({id,parentId,name:entry.name,appProperties}):await this.client.uploadFile({id,parentId,name:entry.archiveName!,mimeType:entry.archiveMimeType!,body:Bun.file(archive.plainFile).slice(archive.files.get(entry.id)!.offset,archive.files.get(entry.id)!.offset+entry.size!),...(entry.modifiedTime?{modifiedTime:entry.modifiedTime}:{}),appProperties})
    if(created.id!==id||created.trashed||created.parents.length!==1||created.parents[0]!==parentId)throw new AppError('GOOGLE_DRIVE_RESTORE_UNCERTAIN','Drive did not confirm the newly created recovery entry; reconcile the reserved target before another operation.')
    ids.set(entry.id,id)
   }
   this.restored=recorded;return {toolVersion:'Steelkeep Drive folder-v1 / portable files'}
  }finally{await archive.cleanup()}
 }
 private async restoredManifest():Promise<Manifest>{
  const expected=this.restored;if(!expected)throw new AppError('GOOGLE_DRIVE_VALIDATION_CONTEXT','Drive validation requires the current reviewed recovery inventory.')
  const actual=await this.inventory(),bySource=new Map(expected.entries.map(entry=>[entry.id,entry])),mapping=new Map<string,string>([[actual.root.id,expected.rootId]]),observed:DriveArchiveEntry[]=[],seen=new Set<string>()
  for(const entry of actual.entries){const file=await this.client.metadata(entry.id),sourceId=file.appProperties?.steelkeepSourceId,original=sourceId?bySource.get(sourceId):undefined
   if(!original||file.appProperties?.steelkeepArchiveId!==expected.archiveId||seen.has(original.id))throw new AppError('GOOGLE_DRIVE_VALIDATION_FAILED','The recovered Drive tree contains unexpected or duplicate entries.')
   if(file.name!==(original.kind==='folder'?original.name:original.archiveName)||file.mimeType!==(original.kind==='folder'?folderMime:original.archiveMimeType))throw new AppError('GOOGLE_DRIVE_VALIDATION_FAILED','A recovered Drive entry no longer matches its expected name or type.')
   mapping.set(file.id,original.id);seen.add(original.id)
   const value={...original};if(original.kind==='file')Object.assign(value,await this.capture(entry));observed.push(value)
  }
  if(observed.length!==expected.entries.length)throw new AppError('GOOGLE_DRIVE_VALIDATION_FAILED','The recovered Drive tree is incomplete.')
  for(const entry of actual.entries){const original=bySource.get(mapping.get(entry.id)!)!;if(mapping.get(entry.parentId)!==original.parentId)throw new AppError('GOOGLE_DRIVE_VALIDATION_FAILED','The recovered Drive folder hierarchy differs from its inventory.')}
  await this.recheckTree(actual);observed.sort(byId);return makeManifest(actual.identity,{...expected,entries:observed})
 }
 compare(expected:Manifest,actual:Manifest):ValidationComparison{const schema=expected.objects.profile===profile&&actual.objects.profile===profile&&expected.objects.treeHash===actual.objects.treeHash,data=expected.data.files===actual.data.files&&expected.data.bytes===actual.data.bytes&&expected.data.sha256===actual.data.sha256,sequences=Object.keys(expected.sequences).length===0&&Object.keys(actual.sequences).length===0;return {passed:schema&&data&&sequences,checks:{schema,data,sequences},tableCount:Number(expected.data.files??0),method:'drive-folder-tree-and-downloaded-file-sha256',note:'Compared the selected folder hierarchy, portable file names/types, sizes and independently downloaded SHA-256 values. Google-native editability, ACLs, comments and revision history are not restored.'}}
 async close(){}
}
