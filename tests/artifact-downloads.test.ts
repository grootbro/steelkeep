import {expect,test} from 'bun:test'
import {createHash,randomUUID} from 'node:crypto'
import {downloadDescriptor,verifiedArchive} from '../server/artifact-downloads'

const digest=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex')
const artifact=(value:Uint8Array)=>({id:randomUUID(),storage_id:randomUUID(),object_key:'private/archive',size:String(value.byteLength),sha256:digest(value),engine:'postgres',deletion_state:'active'})
async function* chunks(...values:Uint8Array[]){yield* values}

test('download descriptors refuse cleanup and unsafe metadata without exposing storage paths',()=>{
 const value=artifact(new Uint8Array([1,2,3])),result=downloadDescriptor(value)
 expect(result.filename).toBe(`steelkeep-${value.id}.dump`);expect(result.path).toBe(`/api/v1/backups/${value.id}/download`)
 expect(JSON.stringify(result)).not.toContain('private/archive');expect(result.verification).toBe('sha256-before-completion')
 for(const deletion_state of ['queued','deleting','held','deleted'])expect(()=>downloadDescriptor({...value,deletion_state})).toThrow()
 for(const size of ['0','-1','2147483649','10000000000000000000','1.5'])expect(()=>downloadDescriptor({...value,size})).toThrow()
 for(const engine of ['../../unsafe','constructor','toString','__proto__'])expect(()=>downloadDescriptor({...value,engine})).toThrow()
 expect(()=>downloadDescriptor({...value,sha256:'g'.repeat(64)})).toThrow()
})

test('archive completion verifies bytes and holds the final block on corruption or truncation',async()=>{
 const data=Uint8Array.from({length:160000},(_,i)=>i%251),expected=artifact(data),signal=new AbortController().signal
 const output=[];for await(const chunk of verifiedArchive(chunks(data.subarray(0,70000),data.subarray(70000)),expected,signal)){expect(chunk.length).toBeLessThanOrEqual(65536);output.push(Buffer.from(chunk))}
 expect(Buffer.concat(output)).toEqual(Buffer.from(data))
 for(const supplied of [data.subarray(0,-1),Uint8Array.from(data,byte=>byte^1)]){
  let received=0,error:unknown
  try{for await(const chunk of verifiedArchive(chunks(supplied),expected,signal))received+=chunk.length}catch(value){error=value}
  expect(error).toBeDefined();expect(received).toBeLessThan(data.length)
 }
 const excess=new Uint8Array(data.length+1);let received=0
 await expect((async()=>{for await(const chunk of verifiedArchive(chunks(excess),expected,signal))received+=chunk.length})()).rejects.toThrow()
 expect(received).toBe(0)
})

test('small corrupt archives expose no bytes and abort cannot complete an archive',async()=>{
 const data=new Uint8Array([1,2,3]),expected=artifact(data),controller=new AbortController();let received=0
 await expect((async()=>{for await(const chunk of verifiedArchive(chunks(new Uint8Array([3,2,1])),expected,controller.signal))received+=chunk.length})()).rejects.toThrow()
 expect(received).toBe(0)
 controller.abort();await expect(verifiedArchive(chunks(data),expected,controller.signal).next()).rejects.toThrow()
})
