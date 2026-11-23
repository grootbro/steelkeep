import {test,expect} from 'bun:test'
import {createHash,randomBytes} from 'node:crypto'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {GoogleDriveAdapter,deriveDriveRecoveryKey,driveManifestInventory,inspectDriveArchive} from '../server/google-drive/source'
import type {DriveFile,DriveContent} from '../server/google-drive/client'
import type {AdapterOptions} from '../server/engines/types'

const folderMime='application/vnd.google-apps.folder',sourceId='synthetic_source_folder',targetId='synthetic_target_folder',accountId='synthetic_account_permission'
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
class FakeDrive {
 files=new Map<string,DriveFile>()
 bytes=new Map<string,Uint8Array>()
 writes=0
 serial=0
 afterRead?:()=>void
 constructor(){this.folder(sourceId,undefined,'Sensitive source folder');this.folder(targetId,undefined,'Recovery destination')}
 folder(id:string,parentId?:string,name='duplicate'){this.files.set(id,{id,name,mimeType:folderMime,parents:parentId?[parentId]:[],version:'1',trashed:false,capabilities:{canAddChildren:true}})}
 file(id:string,parentId:string,name:string,bytes:Uint8Array,mimeType='application/octet-stream'){
  this.bytes.set(id,bytes);this.files.set(id,{id,name,mimeType,parents:[parentId],version:'1',trashed:false,size:String(bytes.length),sha256Checksum:sha(bytes),modifiedTime:'2026-11-20T12:00:00.000Z',capabilities:{canDownload:true}})
 }
 async account(){return {permissionId:accountId}}
 async metadata(id:string){const file=this.files.get(id);if(!file)throw new Error('synthetic absent');return structuredClone(file)}
 async children(id:string,{pageToken}:{pageToken?:string}={}){const all=[...this.files.values()].filter(file=>file.parents.includes(id)&&!file.trashed).map(file=>structuredClone(file)),start=Number(pageToken??0),files=all.slice(start,start+2);return {files,...(start+2<all.length?{nextPageToken:String(start+2)}:{})}}
 private content(id:string):DriveContent{const bytes=this.bytes.get(id)!;const self=this;async function* body(){yield bytes.subarray(0,3);yield bytes.subarray(3);self.afterRead?.()}return {body:body(),size:bytes.length,close(){}}}
 async download(file:DriveFile){return this.content(file.id)}
 async export(file:DriveFile,_mimeType:string){return this.content(file.id)}
 async generateIds(count=1){return Array.from({length:count},()=>`synthetic_generated_${++this.serial}`)}
 async createFolder(input:{id:string;parentId:string;name:string;appProperties?:Record<string,string>}){this.writes++;this.folder(input.id,input.parentId,input.name);Object.assign(this.files.get(input.id)!,{appProperties:input.appProperties});return this.metadata(input.id)}
 async uploadFile(input:{id:string;parentId:string;name:string;mimeType:string;body:Blob|Uint8Array;modifiedTime?:string;appProperties?:Record<string,string>}){this.writes++;const bytes=input.body instanceof Uint8Array?input.body:new Uint8Array(await input.body.arrayBuffer());this.file(input.id,input.parentId,input.name,bytes,input.mimeType);Object.assign(this.files.get(input.id)!,{appProperties:input.appProperties,...(input.modifiedTime?{modifiedTime:input.modifiedTime}:{})});return this.metadata(input.id)}
}
const options=(folderId:string,restoreTarget=false):AdapterOptions=>({config:{database:folderId,folderId,accountId,restoreTarget},secret:{grantId:'synthetic-grant'},signal:new AbortController().signal})
const phase=async()=>{}
async function fixture(work:(value:{dir:string;drive:FakeDrive;source:GoogleDriveAdapter;target:GoogleDriveAdapter;archive:string;keyFile:string})=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'steelkeep-drive-source-')),keyFile=join(dir,'recovery-key'),previous=process.env.STEELKEEP_DRIVE_RECOVERY_KEY_FILE
 await writeFile(keyFile,randomBytes(32),{mode:0o600});process.env.STEELKEEP_DRIVE_RECOVERY_KEY_FILE=keyFile
 const drive=new FakeDrive(),source=new GoogleDriveAdapter(options(sourceId),drive),target=new GoogleDriveAdapter(options(targetId,true),drive),archive=join(dir,'backup.skdrive')
 try{await source.connect();await target.connect();await work({dir,drive,source,target,archive,keyFile})}
 finally{if(previous===undefined)delete process.env.STEELKEEP_DRIVE_RECOVERY_KEY_FILE;else process.env.STEELKEEP_DRIVE_RECOVERY_KEY_FILE=previous;await rm(dir,{recursive:true,force:true})}
}

test('encrypted Drive capture and fresh-folder recovery preserve duplicate names, empty files, binary bytes and portable Workspace exports',async()=>fixture(async({dir,drive,source,target,archive})=>{
 drive.folder('synthetic_child_folder',sourceId,'資料 / documents')
 drive.file('synthetic_binary_file_a',sourceId,'same-name.bin',new Uint8Array([0,255,1,2,128]))
 drive.file('synthetic_binary_file_b',sourceId,'same-name.bin',new Uint8Array())
 drive.file('synthetic_google_doc', 'synthetic_child_folder','Private quarterly plan',Buffer.from('synthetic OOXML document'),'application/vnd.google-apps.document')
 const {manifest}=await source.backup(archive,dir,new AbortController().signal,phase),bytes=await readFile(archive)
 expect(bytes.subarray(0,8).toString()).toBe('SKDRV001')
 for(const secret of ['Sensitive source folder','same-name.bin','Private quarterly plan','synthetic OOXML document']){expect(bytes.includes(Buffer.from(secret))).toBe(false);expect(JSON.stringify(manifest).includes(secret)).toBe(false)}
 const inventory=driveManifestInventory(manifest);expect(inventory.entries).toHaveLength(4);expect(inventory.entries.find(entry=>entry.id==='synthetic_google_doc')?.archiveName).toBe('Private quarterly plan.docx')
 const imported=await inspectDriveArchive(archive,dir,new AbortController().signal);expect(driveManifestInventory(imported)).toEqual(inventory)
 await target.restore(archive,dir,new AbortController().signal,manifest)
 expect(drive.writes).toBe(4)
 const actual=await target.manifest();expect(target.compare(manifest,actual).passed).toBe(true)
 expect(target.compare({...manifest,data:{sha256:manifest.data.sha256,bytes:manifest.data.bytes,files:manifest.data.files}},actual).passed).toBe(true)
 expect(target.compare(manifest,actual).method).toBe('drive-folder-tree-and-downloaded-file-sha256')
 expect((await drive.metadata(sourceId)).name).toBe('Sensitive source folder')
 expect(drive.bytes.get('synthetic_binary_file_a')).toEqual(new Uint8Array([0,255,1,2,128]))
 const recovered=[...drive.files.values()].filter(file=>file.appProperties?.steelkeepArchiveId===inventory.archiveId)
 expect(recovered.filter(file=>file.name==='same-name.bin')).toHaveLength(2)
 expect(recovered.find(file=>file.name.endsWith('.docx'))?.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
}))

test('Drive archive corruption and a wrong recovery key fail before the first target write',async()=>fixture(async({dir,drive,source,target,archive,keyFile})=>{
 drive.file('synthetic_binary_file_a',sourceId,'content.bin',Buffer.from('protected bytes'))
 const {manifest}=await source.backup(archive,dir,new AbortController().signal,phase),original=await readFile(archive),corrupt=Buffer.from(original);corrupt[60]^=1;await writeFile(archive,corrupt)
 await expect(target.restore(archive,dir,new AbortController().signal,manifest)).rejects.toThrow('authentication failed');expect(drive.writes).toBe(0)
 await writeFile(archive,original);await writeFile(keyFile,randomBytes(32))
 await expect(inspectDriveArchive(archive,dir,new AbortController().signal)).rejects.toThrow('authentication failed');expect(drive.writes).toBe(0)
}))

test('Drive restore refuses the original source and nonempty target without modifying either',async()=>fixture(async({dir,drive,source,target,archive})=>{
 drive.file('synthetic_binary_file_a',sourceId,'content.bin',Buffer.from('original'))
 const {manifest}=await source.backup(archive,dir,new AbortController().signal,phase),sameSource=new GoogleDriveAdapter(options(sourceId,true),drive)
 await expect(sameSource.restore(archive,dir,new AbortController().signal,manifest)).rejects.toThrow('distinct')
 drive.file('synthetic_existing_target',targetId,'existing.bin',Buffer.from('keep me'))
 await expect(target.restore(archive,dir,new AbortController().signal,manifest)).rejects.toThrow('not empty');expect(drive.writes).toBe(0);expect(drive.bytes.get('synthetic_existing_target')).toEqual(Buffer.from('keep me'))
}))

test('Drive capture refuses source drift, unsupported shortcuts and shared-drive folders',async()=>fixture(async({dir,drive,source,archive})=>{
 drive.file('synthetic_binary_file_a',sourceId,'content.bin',Buffer.from('stable'))
 drive.afterRead=()=>{drive.files.get('synthetic_binary_file_a')!.version='2'}
 await expect(source.backup(archive,dir,new AbortController().signal,phase)).rejects.toThrow('changed')
 drive.afterRead=undefined;drive.files.delete('synthetic_binary_file_a');drive.file('synthetic_shortcut_file',sourceId,'shortcut',new Uint8Array(),'application/vnd.google-apps.shortcut')
 await expect(source.manifest()).rejects.toThrow('shortcuts')
 drive.files.get(sourceId)!.driveId='synthetic_shared_drive'
 await expect(source.identity()).rejects.toThrow('shared drives')
}))

test('Drive recovery validation detects modified recovered bytes and keeps source bytes untouched',async()=>fixture(async({dir,drive,source,target,archive})=>{
 const original=Buffer.from('original bytes');drive.file('synthetic_binary_file_a',sourceId,'content.bin',original)
 const {manifest}=await source.backup(archive,dir,new AbortController().signal,phase);await target.restore(archive,dir,new AbortController().signal,manifest)
 const recovered=[...drive.files.values()].find(file=>file.appProperties?.steelkeepSourceId==='synthetic_binary_file_a')!,changed=Buffer.from('modified bytes')
 drive.bytes.set(recovered.id,changed);recovered.size=String(changed.length);recovered.sha256Checksum=sha(changed);recovered.version='2'
 const actual=await target.manifest(),comparison=target.compare(manifest,actual)
 expect(comparison.passed).toBe(false);expect(comparison.checks.schema).toBe(true);expect(comparison.checks.data).toBe(false)
 expect(drive.bytes.get('synthetic_binary_file_a')).toEqual(original)
}))

test('Drive recovery retries a complete read-only validation after one metadata drift without replaying writes',async()=>fixture(async({dir,drive,source,target,archive})=>{
 drive.file('synthetic_binary_file_a',sourceId,'content.bin',Buffer.from('original bytes'))
 const {manifest}=await source.backup(archive,dir,new AbortController().signal,phase);await target.restore(archive,dir,new AbortController().signal,manifest)
 const recovered=[...drive.files.values()].find(file=>file.appProperties?.steelkeepSourceId==='synthetic_binary_file_a')!,writes=drive.writes
 let reads=0;drive.afterRead=()=>{if(++reads===1)recovered.version='2'}
 expect(target.compare(manifest,await target.manifest()).passed).toBe(true)
 expect(reads).toBe(2);expect(drive.writes).toBe(writes)
 expect(drive.bytes.get('synthetic_binary_file_a')).toEqual(Buffer.from('original bytes'))
}))

test('persistent Drive target drift stops after four read-only validations while source capture still fails immediately',async()=>fixture(async({dir,drive,source,target,archive})=>{
 drive.file('synthetic_binary_file_a',sourceId,'content.bin',Buffer.from('original bytes'))
 const {manifest}=await source.backup(archive,dir,new AbortController().signal,phase);await target.restore(archive,dir,new AbortController().signal,manifest)
 const recovered=[...drive.files.values()].find(file=>file.appProperties?.steelkeepSourceId==='synthetic_binary_file_a')!,writes=drive.writes
 let reads=0;drive.afterRead=()=>{reads++;recovered.version=String(Number(recovered.version)+1)}
 await expect(target.manifest()).rejects.toMatchObject({code:'GOOGLE_DRIVE_VALIDATION_UNSTABLE'})
 expect(reads).toBe(4);expect(drive.writes).toBe(writes)
 const original=drive.files.get('synthetic_binary_file_a')!;drive.afterRead=()=>{reads++;original.version=String(Number(original.version)+1)}
 await expect(source.backup(join(dir,'source-drift.skdrive'),dir,new AbortController().signal,phase)).rejects.toMatchObject({code:'GOOGLE_DRIVE_SOURCE_CHANGED'})
 expect(reads).toBe(5);expect(drive.writes).toBe(writes)
}))

test('Drive archive manifest must match the reviewed snapshot before any target write',async()=>fixture(async({dir,drive,source,target,archive})=>{
 drive.file('synthetic_binary_file_a',sourceId,'content.bin',Buffer.from('first capture'))
 const {manifest}=await source.backup(archive,dir,new AbortController().signal,phase),otherPath=join(dir,'other.skdrive'),other=await source.backup(otherPath,dir,new AbortController().signal,phase)
 await expect(target.restore(otherPath,dir,new AbortController().signal,manifest)).rejects.toThrow('could not be verified')
 expect(other.manifest.database).toBe(manifest.database);expect(drive.writes).toBe(0)
}))

test('Drive recovery-key override is private, exact-size and portable independently of the new installation metadata key',async()=>fixture(async({keyFile})=>{
 const key=deriveDriveRecoveryKey();expect(key.length).toBe(32);expect(key).toEqual(await readFile(keyFile))
 await writeFile(keyFile,Buffer.alloc(31));expect(()=>deriveDriveRecoveryKey()).toThrow('32-byte')
}))

test('empty Drive folders produce authenticated archives and validate a no-write empty-folder recovery',async()=>fixture(async({dir,drive,source,target,archive})=>{
 const {manifest}=await source.backup(archive,dir,new AbortController().signal,phase)
 expect(manifest.data.files).toBe(0);await target.restore(archive,dir,new AbortController().signal,manifest)
 expect(target.compare(manifest,await target.manifest()).passed).toBe(true);expect(drive.writes).toBe(0)
}))
