import {mkdtemp,rm,chmod,statfs} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createReadStream} from 'node:fs'
import {createHash,randomUUID} from 'node:crypto'
import {PutObjectCommand,HeadObjectCommand} from '@aws-sdk/client-s3'
import {sql} from 'kysely'
import {Services,storageClient,type StorageConfig,type S3Secret} from './services'
import {AppError,unseal} from './security'
import {assertArchiveSize,maxArchiveBytes} from './process'
import {assertProtectedDatabase} from './engines/database'
import type {Engine} from './engines/types'
import {createEngineAdapter,engineKinds} from './engines'
import {runControl} from './engines/execution'
import {createSourceLockHooks} from './source-locks'
import {storageBackupFailure} from './storage-errors'

export const isRetryableBackupError=(error:unknown)=>error instanceof AppError&&error.code==='STORAGE_UNAVAILABLE'

export async function fileSha256(path:string,signal:AbortSignal){
  const hash=createHash('sha256'),stream=createReadStream(path)
  const abort=()=>stream.destroy(signal.reason instanceof AppError?signal.reason:new AppError('CANCELLED','Operation cancelled.'))
  signal.addEventListener('abort',abort,{once:true})
  if(signal.aborted)abort()
  try{for await(const chunk of stream)hash.update(chunk);return hash.digest('hex')}
  finally{signal.removeEventListener('abort',abort);stream.destroy()}
}

export async function workingDirectory(){
  const dir=await mkdtemp(join(tmpdir(),'steelkeep-'))
  try{
    await chmod(dir,0o700)
    const fs=await statfs(dir)
    // One bounded archive plus a reserve; fail before acquiring a source snapshot.
    if(fs.bavail*fs.bsize<maxArchiveBytes+128*1024*1024)throw new AppError('DISK_SPACE','At least 2 GiB plus 128 MiB temporary space is required.')
    return dir
  }catch(error){await rm(dir,{recursive:true,force:true}).catch(()=>{});throw error}
}

export async function executeBackup(services:Services,runId:string,token:string,signal:AbortSignal){
  signal=AbortSignal.any([signal,AbortSignal.timeout(2*60*60*1000)])
  const db=services.db,{phase,check}=runControl(services,runId,token,signal)
  const run=await db.selectFrom('runs').selectAll().where('id','=',runId).where('execution_token','=',token).executeTakeFirstOrThrow()
  const source=await services.connection(run.source_id),storage=await services.connection(run.storage_id)
  if(!engineKinds.includes(source.kind as Engine)||storage.kind!=='s3')throw new AppError('INVALID_ENGINE','Unsupported backup configuration.')
  const config=source.config,secret=unseal<Record<string,unknown>>(source.secret),engine=source.kind as Engine
  assertProtectedDatabase(String(config.database??''))
  if(config.restoreTarget)throw new AppError('INVALID_SOURCE','A restore target cannot be used as a backup source.')
  const storageConfig=storage.config as StorageConfig
  const session=createEngineAdapter(engine,{config,secret,signal,checkpoint:check,lockHooks:createSourceLockHooks(services,runId,token)})
  signal=AbortSignal.any([signal,session.failureSignal])
  const s3=storageClient(storageConfig,unseal<S3Secret>(storage.secret)),dir=await workingDirectory()
  try{
    await phase('preflight','Checking source identity, server and native client compatibility.')
    const info=await session.connect(),file=join(dir,'backup'+session.archiveExtension)
    if(info.database!==String(config.database))throw new AppError('IDENTITY_UNCERTAIN','The source identity differs from its configured database.')
    const {manifest,toolVersion}=await session.backup(file,dir,signal,phase)
    if(Buffer.byteLength(JSON.stringify(manifest))>2*1024*1024)throw new AppError('RESOURCE_LIMIT','The validation manifest exceeds the 2 MiB limit.')
    await check()
    if(signal.aborted)throw signal.reason
    await session.close()
    const size=await assertArchiveSize(file),checksum=await fileSha256(file,signal)
    const artifactId=randomUUID(),key=[storageConfig.prefix,runId,token,artifactId+session.archiveExtension].filter(Boolean).join('/')
    await phase('uploading',`Uploading ${size} bytes to the configured storage.`)
    // Immutable, attempt-specific object keys; an orphan is safer than deleting data after uncertain publication.
    try{
      const body=createReadStream(file)
      try{await s3.send(new PutObjectCommand({Bucket:storageConfig.bucket,Key:key,Body:body,ContentLength:size,IfNoneMatch:'*',Metadata:{sha256:checksum,engine}}),{abortSignal:signal})}
      finally{body.destroy()}
      await check()
      const head=await s3.send(new HeadObjectCommand({Bucket:storageConfig.bucket,Key:key}),{abortSignal:signal})
      if(head.ContentLength!==size||head.Metadata?.sha256!==checksum)throw new AppError('ARTIFACT_SIZE_MISMATCH','Uploaded object metadata did not match the archive.')
    }catch(error){
      throw storageBackupFailure(error,signal)
    }
    await phase('publishing','Recording the completed artifact, native client version and validation manifest.')
    await rm(dir,{recursive:true,force:true})
    await db.transaction().execute(async trx=>{
      const owned=await trx.selectFrom('runs').select(['status','cancel_requested']).where('id','=',runId).where('execution_token','=',token).forUpdate().executeTakeFirstOrThrow()
      if(owned.status!=='running'||owned.cancel_requested||signal.aborted)throw new AppError('CANCELLED','Operation cancelled before publication.')
      await trx.insertInto('artifacts').values({id:artifactId,run_id:runId,source_id:source.id,storage_id:storage.id,object_key:key,size:String(size),sha256:checksum,engine,server_version:manifest.serverVersion,tool_version:toolVersion,manifest,availability:'present',checked_at:sql<Date>`now()`}).execute()
      await trx.updateTable('runs').set({status:'succeeded',phase:'completed',finished_at:new Date(),artifact_id:artifactId}).where('id','=',runId).where('execution_token','=',token).execute()
      await trx.insertInto('events').values({run_id:runId,phase:'completed',message:'Backup stored with SHA-256 and source validation manifest. Restore has not yet been validated.'}).execute()
    })
  }finally{
    await session.close().catch(()=>{})
    s3.destroy()
    await rm(dir,{recursive:true,force:true}).catch(()=>{})
  }
}
