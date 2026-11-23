import {S3Client,PutObjectCommand,HeadObjectCommand,GetObjectCommand} from '@aws-sdk/client-s3'
import {createReadStream} from 'node:fs'
import {createHash} from 'node:crypto'
import {Readable} from 'node:stream'
import type {ReadableStream as NodeReadableStream} from 'node:stream/web'
import type {Kysely} from 'kysely'
import type {Schema} from './db'
import type {Manifest} from './engines/types'
import {AppError,allowedHost,unseal} from './security'
import {GoogleDriveClient,type DriveFile} from './google-drive/client'
import {GoogleDriveOAuth} from './google-drive/oauth'
export {isStorageKind} from '../shared/connections'

export type StorageConfig={endpoint:string;region:string;bucket:string;prefix:string}
export type S3Secret={accessKey:string;secretKey:string}
export type StoredConnection={id:string;kind:string;config:Record<string,unknown>;secret:string}
export type PortableArchive={format:'steelkeep-recovery-v1';artifactId:string;engine:string;sourceDatabase:string;serverVersion:string;toolVersion:string;manifest:Manifest;size:string;sha256:string;createdAt:string;archiveFileId:string;filename:string}
export async function verifyDriveContent(client:Pick<GoogleDriveClient,'download'>,file:DriveFile,expected:{size:number;sha256:string},signal:AbortSignal){
 if(file.size!==String(expected.size))throw new AppError('ARTIFACT_SIZE_MISMATCH','Google Drive returned a different archive size.')
 if(file.sha256Checksum){if(file.sha256Checksum!==expected.sha256)throw new AppError('CHECKSUM_MISMATCH','Google Drive reported a different content checksum.');return}
 const content=await client.download(file),hash=createHash('sha256');let bytes=0
 try{for await(const chunk of content.body){signal.throwIfAborted();bytes+=chunk.byteLength;if(bytes>expected.size)throw new AppError('ARTIFACT_SIZE_MISMATCH','Google Drive content exceeded the captured size.');hash.update(chunk)}}finally{content.close()}
 if(bytes!==expected.size||hash.digest('hex')!==expected.sha256)throw new AppError('CHECKSUM_MISMATCH','The complete Google Drive upload did not match the captured content.')
}
export function storageClient(c:StorageConfig,s:S3Secret,maxAttempts:1|2=2){
 allowedHost(new URL(c.endpoint).hostname)
 return new S3Client({endpoint:c.endpoint,region:c.region,forcePathStyle:true,credentials:{accessKeyId:s.accessKey,secretAccessKey:s.secretKey},maxAttempts})
}
export function driveClient(db:Kysely<Schema>,row:StoredConnection,signal:AbortSignal){
 const purpose=row.kind==='google_drive_storage'?(row.config.grantPurpose==='recovery'?'recovery':'storage'):row.config.restoreTarget===true?'restore':'source'
 const oauth=new GoogleDriveOAuth(db),grantId=String(row.config.grantId??'')
 return new GoogleDriveClient({signal,getAccessToken:async(requestSignal,forceRefresh)=>{
  const grant=await oauth.grant(grantId,purpose)
  if(grant.revision!==row.config.grantRevision)throw new AppError('DRIVE_RECONNECT_REQUIRED','This Google connection was reconnected. Review its identity before using it.',409)
  return oauth.accessToken(grantId,purpose,requestSignal,forceRefresh)
 }})
}
export async function storedHead(db:Kysely<Schema>,row:StoredConnection,key:string,signal:AbortSignal){
 if(row.kind==='google_drive_storage'){
  const file=await driveClient(db,row,signal).metadata(key)
  if(file.trashed||!file.parents?.includes(String(row.config.folderId)))throw new AppError('DRIVE_ARCHIVE_MOVED','The archive is trashed or outside its configured folder.',409)
  if(file.appProperties?.sha256&&file.properties?.sha256&&file.appProperties.sha256!==file.properties.sha256)throw new AppError('DRIVE_METADATA_CHANGED','Google Drive archive ownership metadata is inconsistent.',409)
  return {ContentLength:Number(file.size),Metadata:{sha256:file.appProperties?.sha256??file.properties?.sha256??'',engine:file.appProperties?.engine??file.properties?.engine??''}}
 }
 if(row.kind!=='s3')throw new AppError('INVALID_STORAGE','Choose S3 or Google Drive storage.')
 const c=row.config as StorageConfig,client=storageClient(c,unseal<S3Secret>(row.secret))
 try{return await client.send(new HeadObjectCommand({Bucket:c.bucket,Key:key}),{abortSignal:signal})}finally{client.destroy()}
}
export async function openStoredArchive(db:Kysely<Schema>,row:StoredConnection,key:string,signal:AbortSignal){
 if(row.kind==='google_drive_storage'){
  const client=driveClient(db,row,signal),file=await client.metadata(key)
  if(file.trashed||!file.parents?.includes(String(row.config.folderId)))throw new AppError('DRIVE_ARCHIVE_MOVED','The archive is trashed or outside its configured folder.',409)
  const value=await client.download(file),body=Readable.from(value.body)
  return {length:Number(file.size),body,close:()=>{body.destroy();value.close()}}
 }
 if(row.kind!=='s3')throw new AppError('INVALID_STORAGE','Choose S3 or Google Drive storage.')
 const c=row.config as StorageConfig,client=storageClient(c,unseal<S3Secret>(row.secret))
 try{
  const value=await client.send(new GetObjectCommand({Bucket:c.bucket,Key:key}),{abortSignal:signal})
  if(!value.Body||value.ContentRange){if(value.Body instanceof Readable)value.Body.destroy();throw new AppError('INVALID_DOWNLOAD','Storage did not return a complete archive.')}
  const body=value.Body instanceof Readable?value.Body:Readable.fromWeb(value.Body.transformToWebStream() as unknown as NodeReadableStream<Uint8Array>)
  return {length:value.ContentLength,body,close:()=>{body.destroy();client.destroy()}}
 }catch(error){client.destroy();throw error}
}
export async function publishStoredArchive(db:Kysely<Schema>,row:StoredConnection,input:{file:string;key:string;size:number;sha256:string;engine:string;artifactId:string;manifest:Manifest;toolVersion:string;extension:string},signal:AbortSignal){
 if(row.kind==='google_drive_storage'){
  if(row.config.readOnly)throw new AppError('DRIVE_READ_ONLY','This connection is for recovering existing archives; it cannot receive new backups.')
  const client=driveClient(db,row,signal),ids=await client.generateIds(2),archiveId=ids[0]!,recoveryId=ids[1]!
  const filename=`steelkeep-${new Date().toISOString().slice(0,10)}-${input.engine}-${input.artifactId}${input.extension}`
  const properties={steelkeepArchive:'1',artifactId:input.artifactId,sha256:input.sha256,engine:input.engine,recoveryId}
  const uploaded=await client.uploadFile({id:archiveId,parentId:String(row.config.folderId),name:filename,mimeType:'application/octet-stream',body:Bun.file(input.file),appProperties:properties,properties})
  await verifyDriveContent(client,uploaded,{size:input.size,sha256:input.sha256},signal)
  const descriptor:PortableArchive={format:'steelkeep-recovery-v1',artifactId:input.artifactId,engine:input.engine,sourceDatabase:input.manifest.database,serverVersion:input.manifest.serverVersion,toolVersion:input.toolVersion,manifest:input.manifest,size:String(input.size),sha256:input.sha256,createdAt:new Date().toISOString(),archiveFileId:archiveId,filename}
  const json=JSON.stringify(descriptor)
  if(Buffer.byteLength(json)>3*1024*1024)throw new AppError('RESOURCE_LIMIT','The portable recovery descriptor exceeds its limit.')
  const descriptorBytes=new TextEncoder().encode(json),written=await client.uploadFile({id:recoveryId,parentId:String(row.config.folderId),name:filename+'.recovery.json',mimeType:'application/json',body:descriptorBytes,appProperties:{steelkeepRecovery:'1',archiveId,artifactId:input.artifactId},properties:{steelkeepRecovery:'1',archiveId,artifactId:input.artifactId}})
  await verifyDriveContent(client,written,{size:descriptorBytes.byteLength,sha256:createHash('sha256').update(descriptorBytes).digest('hex')},signal)
  const head=await storedHead(db,row,archiveId,signal)
  const observed=await client.metadata(archiveId)
  if(observed.sha256Checksum&&observed.sha256Checksum!==input.sha256)throw new AppError('CHECKSUM_MISMATCH','Google Drive reported a different content checksum.')
  if(head.ContentLength!==input.size||head.Metadata.sha256!==input.sha256)throw new AppError('ARTIFACT_SIZE_MISMATCH','Google Drive archive metadata differs from the captured archive.')
  return archiveId
 }
 if(row.kind!=='s3')throw new AppError('INVALID_STORAGE','Choose S3 or Google Drive storage.')
 const c=row.config as StorageConfig,client=storageClient(c,unseal<S3Secret>(row.secret)),body=createReadStream(input.file)
 try{
  await client.send(new PutObjectCommand({Bucket:c.bucket,Key:input.key,Body:body,ContentLength:input.size,IfNoneMatch:'*',Metadata:{sha256:input.sha256,engine:input.engine}}),{abortSignal:signal})
  const head=await client.send(new HeadObjectCommand({Bucket:c.bucket,Key:input.key}),{abortSignal:signal})
  if(head.ContentLength!==input.size||head.Metadata?.sha256!==input.sha256)throw new AppError('ARTIFACT_SIZE_MISMATCH','Uploaded object metadata did not match the archive.')
  return input.key
 }finally{body.destroy();client.destroy()}
}

export async function assertDriveStorageOutsideSource(db:Kysely<Schema>,source:StoredConnection,storage:StoredConnection,signal:AbortSignal){
 if(source.kind!=='google_drive'||storage.kind!=='google_drive_storage'||source.config.accountId!==storage.config.accountId)return
 const client=driveClient(db,source,signal),pending=[String(storage.config.folderId)],seen=new Set<string>()
 for(let depth=0;pending.length&&depth<64;depth++){
  const id=pending.pop()!
  if(id===source.config.folderId)throw new AppError('DRIVE_STORAGE_OVERLAP','Choose a backup storage folder outside the Drive source tree.')
  if(seen.has(id))continue;seen.add(id)
  const folder=await client.metadata(id);pending.push(...folder.parents.filter(parent=>!seen.has(parent)))
 }
 if(pending.length)throw new AppError('DRIVE_STORAGE_OVERLAP','The source and archive folder relationship could not be proven distinct.')
}
