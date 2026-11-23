import {test,expect} from 'bun:test'
import {randomUUID,createHash} from 'node:crypto'
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {parsePortableArchive,recoveryProperties,recoveryImportKey,validateRecoveryPair,validateRecoveryArchiveFile,writeVerifiedRecoveryArchive} from '../server/google-drive/recovery'
import type {DriveFile} from '../server/google-drive/client'
import type {PortableArchive} from '../server/storage'

const folderId='synthetic_folder_123',archiveId='synthetic_archive_123',recoveryId='synthetic_recovery_123',artifactId=randomUUID(),checksum='a'.repeat(64)
const manifest={format:1 as const,engine:'postgres' as const,database:'synthetic_source',serverVersion:'17.11',objects:{schema:'schema-hash'},data:{rows:5},sequences:{}}
const descriptor:PortableArchive={format:'steelkeep-recovery-v1',artifactId,engine:'postgres',sourceDatabase:'synthetic_source',serverVersion:'17.11',toolVersion:'pg_dump 17.11',manifest,size:'100',sha256:checksum,createdAt:'2026-11-23T00:00:00.000Z',archiveFileId:archiveId,filename:'synthetic.dump'}
function file(id:string,mimeType:string,properties:Record<string,string>):DriveFile&{properties:Record<string,string>}{return {id,name:'Synthetic portable archive',mimeType,parents:[folderId],version:'1',trashed:false,size:'100',capabilities:{canDownload:true},properties}}
const archive=()=>file(archiveId,'application/octet-stream',{steelkeepArchive:'1',artifactId,engine:'postgres',sha256:checksum,recoveryId})
const sidecar=()=>file(recoveryId,'application/json',{steelkeepRecovery:'1',archiveId,artifactId})

test('portable recovery validates explicit profile, full manifest identity and bounded size',()=>{
 const previous=process.env.DATABASE_URL;process.env.DATABASE_URL='postgresql://synthetic@127.0.0.1/steelkeep_unit_metadata'
 try{
 expect(parsePortableArchive(descriptor)).toEqual(descriptor)
 for(const invalid of [{...descriptor,format:'other'},{...descriptor,engine:'unrecognized'},{...descriptor,size:'2147483649'},{...descriptor,size:'0'},{...descriptor,size:'1e2'},{...descriptor,sha256:'not-a-digest'},{...descriptor,sourceDatabase:'other'}, {...descriptor,manifest:{...manifest,engine:'mysql'}},{...descriptor,manifest:{...manifest,objects:[]}}, {...descriptor,createdAt:'not-a-time'}])expect(()=>parsePortableArchive(invalid)).toThrow()
 }finally{if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous}
})

test('cross-project public properties and legacy private properties bind the same explicit archive',()=>{
 expect(validateRecoveryPair(archive(),sidecar(),folderId,descriptor)).toMatchObject({fileId:archiveId,originalArtifactId:artifactId,sha256:checksum,recoveryId})
 const legacy=archive();legacy.appProperties=legacy.properties;delete(legacy as {properties?:Record<string,string>}).properties
 expect(validateRecoveryArchiveFile(legacy,folderId).fileId).toBe(archiveId)
 expect(()=>recoveryProperties({...archive(),appProperties:{sha256:'b'.repeat(64)}})).toThrow()
})

test('portable recovery refuses copied descriptors, moved archives and mismatched checksum metadata',()=>{
 for(const candidate of [{...archive(),parents:['different_folder_123']},{...archive(),trashed:true},{...archive(),properties:{...archive().properties,steelkeepArchive:'0'}},{...archive(),properties:{...archive().properties,sha256:'b'.repeat(64)}}])expect(()=>validateRecoveryPair(candidate,sidecar(),folderId,descriptor)).toThrow()
 for(const candidate of [{...sidecar(),id:'different_recovery_123'},{...sidecar(),parents:['different_folder_123']},{...sidecar(),properties:{...sidecar().properties,archiveId:'different_archive_123'}},{...sidecar(),properties:{...sidecar().properties,artifactId:randomUUID()}}])expect(()=>validateRecoveryPair(archive(),candidate,folderId,descriptor)).toThrow()
})

test('portable imports isolate request keys by actor and storage, not by mutable file name',()=>{
 const storageId=randomUUID(),key='synthetic-import-request-1'
 expect(recoveryImportKey('owner',storageId,key)).toBe(recoveryImportKey('owner',storageId,key))
 expect(recoveryImportKey('another-owner',storageId,key)).not.toBe(recoveryImportKey('owner',storageId,key))
 expect(recoveryImportKey('owner',randomUUID(),key)).not.toBe(recoveryImportKey('owner',storageId,key))
 expect(()=>recoveryImportKey('owner',storageId,'short')).toThrow()
})

test('portable archive import hashes all bytes before acceptance and bounds private scratch writes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'steelkeep-portable-import-')),content=Buffer.from('Synthetic portable database bytes\0with binary content'),sha256=createHash('sha256').update(content).digest('hex'),expected={size:String(content.length),sha256}
 let closed=0
 const source=(chunks:Uint8Array[],length=content.length)=>({length,body:(async function*(){for(const chunk of chunks)yield chunk})(),close(){closed++}})
 try{
  const path=join(root,'verified');await writeVerifiedRecoveryArchive(source([content.subarray(0,7),content.subarray(7)]),path,expected,AbortSignal.timeout(5000))
  expect(await readFile(path)).toEqual(content);expect((await stat(path)).mode&0o777).toBe(0o600)
  await expect(writeVerifiedRecoveryArchive(source([content]),join(root,'wrong-hash'),{...expected,sha256:'b'.repeat(64)},AbortSignal.timeout(5000))).rejects.toMatchObject({code:'CHECKSUM_MISMATCH'})
  await expect(writeVerifiedRecoveryArchive(source([content.subarray(0,4)]),join(root,'truncated'),expected,AbortSignal.timeout(5000))).rejects.toMatchObject({code:'CHECKSUM_MISMATCH'})
  await expect(writeVerifiedRecoveryArchive(source([Buffer.concat([content,Buffer.from('extra')])]),join(root,'oversized'),expected,AbortSignal.timeout(5000))).rejects.toMatchObject({code:'DRIVE_RECOVERY_INVALID'})
  await expect(writeVerifiedRecoveryArchive(source([content],content.length+1),join(root,'header-mismatch'),expected,AbortSignal.timeout(5000))).rejects.toMatchObject({code:'DRIVE_RECOVERY_INVALID'})
  expect(closed).toBe(5)
 }finally{await rm(root,{recursive:true,force:true})}
})
