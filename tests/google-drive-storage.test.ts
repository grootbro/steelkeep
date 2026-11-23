import {test,expect} from 'bun:test'
import {createHash} from 'node:crypto'
import {verifyDriveContent} from '../server/storage'
import type {DriveFile} from '../server/google-drive/client'

test('Drive publication requires provider content SHA or complete bytes, never a self-authored property',async()=>{
 const content=new TextEncoder().encode('captured archive'),sha256=createHash('sha256').update(content).digest('hex')
 const file:DriveFile={id:'synthetic-file-id',name:'archive',mimeType:'application/octet-stream',size:String(content.length),parents:['synthetic-folder-id'],version:'1',trashed:false,capabilities:{canDownload:true},appProperties:{sha256}}
 let closed=0,downloads=0
 const client={download:async()=>{downloads++;return {body:(async function*(){yield content})(),close(){closed++}}}}
 await verifyDriveContent(client,file,{size:content.length,sha256},AbortSignal.timeout(1000))
 expect(downloads).toBe(1);expect(closed).toBe(1)
 await verifyDriveContent(client,{...file,sha256Checksum:sha256},{size:content.length,sha256},AbortSignal.timeout(1000))
 expect(downloads).toBe(1)
 await expect(verifyDriveContent(client,{...file,sha256Checksum:'a'.repeat(64)},{size:content.length,sha256},AbortSignal.timeout(1000))).rejects.toMatchObject({code:'CHECKSUM_MISMATCH'})
 const corrupt={download:async()=>({body:(async function*(){yield new Uint8Array(content.length)})(),close(){closed++}})}
 await expect(verifyDriveContent(corrupt,file,{size:content.length,sha256},AbortSignal.timeout(1000))).rejects.toMatchObject({code:'CHECKSUM_MISMATCH'})
 expect(closed).toBe(2)
})
