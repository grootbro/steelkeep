import {createHash} from 'node:crypto'
import {z} from 'zod'
import type {Kysely} from 'kysely'
import type {Schema} from './db'
import {authorize,type Principal} from './auth'
import {audit} from './agents'
import {AppError} from './security'
import {maxArchiveBytes} from './process'

const extensions={postgres:'.dump',mysql:'.sql',mariadb:'.sql',mongodb:'.archive.gz',sqlite:'.sqlite',redis:'.redis.ndjson',clickhouse:'.zip',mssql:'.bacpac'} as const
type DownloadArtifact={id:string;storage_id:string;object_key:string;size:string;sha256:string;engine:string;deletion_state:string}
export type DownloadSource={length:number|undefined;body:AsyncIterable<Uint8Array>;close:()=>void}
export type DownloadOpen=(artifact:DownloadArtifact,signal:AbortSignal)=>Promise<DownloadSource>
export function downloadDescriptor(artifact:DownloadArtifact){
 const extension=Object.hasOwn(extensions,artifact.engine)?extensions[artifact.engine as keyof typeof extensions]:undefined
 if(!z.uuid().safeParse(artifact.id).success||!extension||!/^\d+$/.test(artifact.size)||BigInt(artifact.size)<=0n||BigInt(artifact.size)>BigInt(maxArchiveBytes)||!/^[a-f0-9]{64}$/.test(artifact.sha256))throw new AppError('INVALID_ARTIFACT','Archive metadata is invalid or exceeds the resource limit.')
 if(artifact.deletion_state==='deleted')throw new AppError('NOT_FOUND','The stored snapshot has been deleted.',404)
 if(artifact.deletion_state!=='active')throw new AppError('SNAPSHOT_UNAVAILABLE','Snapshot cleanup has reserved this object. Inspect its cleanup state before downloading.',409)
 return {id:artifact.id,filename:`steelkeep-${artifact.id}${extension}`,size:artifact.size,sha256:artifact.sha256,path:`/api/v1/backups/${artifact.id}/download`,verification:'sha256-before-completion' as const}
}

/** Hold the final block until the entire archive agrees; corrupt transfers stay incomplete. */
export async function* verifiedArchive(body:AsyncIterable<Uint8Array>,expected:{size:string;sha256:string},signal:AbortSignal){
 const hash=createHash('sha256'),size=BigInt(expected.size);let seen=0n,pending:Uint8Array|undefined
 for await(const chunk of body){
  signal.throwIfAborted();seen+=BigInt(chunk.byteLength)
  if(seen>size||seen>BigInt(maxArchiveBytes))throw new AppError('ARTIFACT_SIZE_MISMATCH','Archive bytes exceed the published size.')
  hash.update(chunk)
  for(let offset=0;offset<chunk.byteLength;offset+=65536){if(pending)yield pending;pending=chunk.subarray(offset,Math.min(offset+65536,chunk.byteLength))}
 }
 signal.throwIfAborted()
 if(seen!==size||hash.digest('hex')!==expected.sha256)throw new AppError('CHECKSUM_MISMATCH','Archive integrity verification failed; discard this incomplete download.')
 if(pending)yield pending
}

export class ArtifactDownloadServices{
 private active=0
 constructor(private db:Kysely<Schema>,private openSource:DownloadOpen){}
 private async artifact(principal:Principal,id:string){
  authorize(principal,'backup:download')
  if(!z.uuid().safeParse(id).success)throw new AppError('INVALID_ID','Use a valid snapshot identifier.')
  const artifact=await this.db.selectFrom('artifacts').select(['id','storage_id','object_key','size','sha256','engine','deletion_state']).where('id','=',id).executeTakeFirst()
  if(!artifact)throw new AppError('NOT_FOUND','Backup not found.',404)
  return artifact
 }
 async describe(principal:Principal,id:string){return downloadDescriptor(await this.artifact(principal,id))}
 async response(principal:Principal,id:string,request:Request){
  const artifact=await this.artifact(principal,id),descriptor=downloadDescriptor(artifact)
  if(request.method!=='GET')throw new AppError('METHOD_NOT_ALLOWED','Download with GET.',405)
  if(request.headers.has('range'))throw new AppError('RANGE_NOT_SUPPORTED','Download the complete archive. Restart an interrupted download.',416)
  if(this.active>=2)throw new AppError('DOWNLOAD_LIMIT','Two downloads are already active. Try again after one finishes.',429)
  const remaining=Math.min(15*60*1000,(principal.expiresAt?.getTime()??Infinity)-Date.now())
  if(remaining<=0)throw new AppError('UNAUTHORIZED','The download credential has expired.',401)
  this.active++
  const controller=new AbortController(),signal=AbortSignal.any([request.signal,controller.signal,AbortSignal.timeout(remaining)])
  let source:DownloadSource|undefined,closed=false,streamController:ReadableStreamDefaultController<Uint8Array>|undefined
  const close=()=>{if(closed)return;closed=true;this.active--;try{source?.close()}catch{};signal.removeEventListener('abort',aborted)}
  const aborted=()=>{close();try{streamController?.error(new Error('Download interrupted. Restart the complete download.'))}catch{}}
  signal.addEventListener('abort',aborted,{once:true})
  let headerTimer:ReturnType<typeof setTimeout>|undefined
  try{
   signal.throwIfAborted()
   const timeout=new Promise<never>((_,reject)=>{headerTimer=setTimeout(()=>{controller.abort();reject(new AppError('STORAGE_TIMEOUT','Storage did not start the download in time.',504))},10000)})
   source=await Promise.race([this.openSource(artifact,signal).then(value=>{if(closed){value.close();throw new AppError('DOWNLOAD_ABORTED','The download was interrupted.')}return value}),timeout])
   clearTimeout(headerTimer)
   if(source.length!==Number(artifact.size))throw new AppError('ARTIFACT_SIZE_MISMATCH','Stored archive size differs from the published metadata.',409)
   await audit(this.db,principal.actor,'backup.download.started',id)
   const iterator=verifiedArchive(source.body,descriptor,signal)[Symbol.asyncIterator](),db=this.db
   const stream=new ReadableStream<Uint8Array>({
    start(value){streamController=value},
    async pull(output){
     try{
      signal.throwIfAborted();const next=await iterator.next()
      if(next.done){await audit(db,principal.actor,'backup.download.verified',id);close();output.close()}
      else output.enqueue(next.value)
     }catch{close();output.error(new Error('Archive download failed integrity or transport checks. Discard the incomplete file.'))}
    },
    cancel(){controller.abort();close();void iterator.return?.().catch(()=>{})}
   })
   return new Response(stream,{headers:{'content-type':'application/octet-stream','content-length':descriptor.size,'content-disposition':`attachment; filename="${descriptor.filename}"`,'cache-control':'no-store, private','x-content-type-options':'nosniff','referrer-policy':'no-referrer','accept-ranges':'none','x-steelkeep-recorded-sha256':descriptor.sha256}})
  }catch(error){close();if(error instanceof AppError)throw error;throw new AppError('DOWNLOAD_UNAVAILABLE','The archive could not be downloaded. Check storage and try again.',503)}
  finally{clearTimeout(headerTimer)}
 }
}
