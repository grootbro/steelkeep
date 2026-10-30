import {randomUUID,createHash} from 'node:crypto'
import {createWriteStream} from 'node:fs'
import {rm} from 'node:fs/promises'
import {join} from 'node:path'
import {Readable,Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import type {ReadableStream as NodeReadableStream} from 'node:stream/web'
import {GetObjectCommand} from '@aws-sdk/client-s3'
import {Services,storageClient,type StorageConfig,type S3Secret} from './services'
import {AppError,unseal} from './security'
import {maxArchiveBytes} from './process'
import {workingDirectory} from './backup'
import {digest,manifestComparison,assertProtectedDatabase} from './engines/database'
import type {Engine,Manifest} from './engines/types'
import {createEngineAdapter,engineKinds} from './engines'
import {runControl} from './engines/execution'
import {resourceKey} from './resources'

/** Read-only review. Worker supplies ownRunId to permit only its own durable target block. */
export async function inspectRestore(services:Services,artifactId:string,targetId:string,ownRunId?:string){
  const artifact=await services.db.selectFrom('artifacts').selectAll().where('id','=',artifactId).executeTakeFirst()
  if(!artifact||artifact.availability!=='present')throw new AppError('ARTIFACT_UNAVAILABLE','Choose an available backup created by this installation.')
  const origin=await services.db.selectFrom('runs').selectAll().where('id','=',artifact.run_id).executeTakeFirst()
  if(!origin||origin.type!=='backup'||origin.status!=='succeeded'||origin.artifact_id!==artifact.id||origin.source_id!==artifact.source_id||origin.storage_id!==artifact.storage_id)throw new AppError('UNTRUSTED_ARTIFACT','Only a completed backup published by this installation may be restored.')
  const manifest=artifact.manifest as Manifest|null
  if(!manifest||manifest.format!==1||manifest.engine!==artifact.engine||!manifest.database||!manifest.objects||!manifest.data||!manifest.sequences)throw new AppError('MANIFEST_UNAVAILABLE','This archive has no supported source validation manifest.')
  if(!/^[a-f0-9]{64}$/.test(artifact.sha256)||!Number.isSafeInteger(Number(artifact.size))||Number(artifact.size)<=0||Number(artifact.size)>maxArchiveBytes)throw new AppError('INVALID_ARTIFACT','Archive metadata is invalid or exceeds the resource limit.')
  const [source,target,storage]=await Promise.all([services.connection(artifact.source_id),services.connection(targetId),services.connection(artifact.storage_id)])
  if(!engineKinds.includes(target.kind as Engine)||target.kind!==artifact.engine||source.kind!==artifact.engine||storage.kind!=='s3')throw new AppError('ENGINE_MISMATCH','Source archive and target must use the same supported database engine.')
  const config=target.config,sourceConfig=source.config,targetDatabase=String(config.database??'')
  if(!config.restoreTarget||sourceConfig.restoreTarget)throw new AppError('TARGET_NOT_DESIGNATED','Choose a connection explicitly designated as a restore target.')
  assertProtectedDatabase(targetDatabase);assertProtectedDatabase(manifest.database)
  if(sourceConfig.database!==manifest.database)throw new AppError('IDENTITY_UNCERTAIN','Source configuration differs from the identity recorded in this archive.')
  // Different DB names prove distinct databases even through aliases of one server.
  // Equal names on different hosts remain ambiguous and are deliberately refused.
  if(source.id===target.id||manifest.database.toLowerCase()===targetDatabase.toLowerCase())throw new AppError('SOURCE_TARGET_CONFLICT','The target must have a different database identity from the recorded source, even when endpoint names differ.')
  const blocks=await services.db.selectFrom('target_blocks').innerJoin('connections','connections.id','target_blocks.target_id')
    .select(['target_blocks.run_id','connections.kind','connections.config']).execute()
  if(blocks.some(b=>resourceKey(b)===resourceKey(target)&&b.run_id!==ownRunId))throw new AppError('TARGET_BLOCKED','This target or an alias is reserved by another restore. Reconcile its outcome before another operation.',409)
  const session=createEngineAdapter(target.kind as Engine,{config,secret:unseal<Record<string,unknown>>(target.secret),signal:AbortSignal.timeout(30000)})
  try{
    const identity=await session.connect()
    assertProtectedDatabase(identity.database)
    if(identity.database!==targetDatabase)throw new AppError('IDENTITY_UNCERTAIN','The target did not confirm its configured database identity.')
    if(target.kind==='sqlite'&&(!manifest.binding||manifest.binding===identity.binding))throw new AppError('SOURCE_TARGET_CONFLICT','SQLite source and target file identities must be proven distinct.')
    if(target.kind==='redis'&&Number.parseInt(manifest.serverVersion)!==Number.parseInt(identity.serverVersion))throw new AppError('VERSION_MISMATCH','Redis source and target must use the same major version.')
    await session.restrictedRestoreRole()
    if(!await session.empty())throw new AppError('TARGET_NOT_EMPTY','The designated precreated restore target is not empty. No restore data has been applied.')
    const fingerprint=digest({artifact:artifact.id,checksum:artifact.sha256,size:artifact.size,manifest:digest(manifest),source:{id:source.id,config:source.config,secret:digest(source.secret)},target:{id:target.id,config:target.config,secret:digest(target.secret),identity},storage:{id:storage.id,config:storage.config,secret:digest(storage.secret)}})
    return {artifactId,targetId,fingerprint,engine:target.kind as Engine,sourceDatabase:manifest.database,targetDatabase:identity.database,
      sourceVersion:manifest.serverVersion,targetVersion:identity.serverVersion,archiveBytes:Number(artifact.size),sha256:artifact.sha256,
      checks:{trustedArtifact:true,targetEmpty:true,targetAllowlisted:true,distinctDatabase:true},warnings:['Restore validation checks captured structure, serialized data and sequence state. Application-level acceptance remains separate.']}
  }finally{await session.close().catch(()=>{})}
}

export async function executeRestore(services:Services,runId:string,token:string,signal:AbortSignal){
  signal=AbortSignal.any([signal,AbortSignal.timeout(2*60*60*1000)])
  const db=services.db,{phase,check}=runControl(services,runId,token,signal)
  const run=await db.selectFrom('runs').selectAll().where('id','=',runId).where('execution_token','=',token).executeTakeFirstOrThrow()
  if(!run.artifact_id||!run.target_id||!run.review_fingerprint)throw new AppError('REVIEW_REQUIRED','A confirmed restore review is required.')
  const block=await db.selectFrom('target_blocks').selectAll().where('target_id','=',run.target_id).where('run_id','=',runId).executeTakeFirst()
  if(!block)throw new AppError('TARGET_NOT_RESERVED','This restore no longer owns its target reservation.')
  await phase('preflight','Repeating the reviewed target identity, emptiness and archive provenance checks.')
  const review=await inspectRestore(services,run.artifact_id,run.target_id,runId)
  if(review.fingerprint!==run.review_fingerprint)throw new AppError('REVIEW_CHANGED','The restore context changed after confirmation. Prepare a new review.')
  const [artifact,target,storage]=await Promise.all([
    db.selectFrom('artifacts').selectAll().where('id','=',run.artifact_id).executeTakeFirstOrThrow(),services.connection(run.target_id),services.connection(run.storage_id)
  ])
  if(artifact.storage_id!==storage.id||artifact.source_id!==run.source_id)throw new AppError('REVIEW_CHANGED','The restore run does not match the reviewed artifact.')
  const engine=review.engine,config=target.config,secret=unseal<Record<string,unknown>>(target.secret),s3config=storage.config as StorageConfig
  const session=createEngineAdapter(engine,{config,secret,signal,checkpoint:check})
  const s3=storageClient(s3config,unseal<S3Secret>(storage.secret)),dir=await workingDirectory(),file=join(dir,randomUUID()+session.archiveExtension)
  signal=AbortSignal.any([signal,session.failureSignal])
  try{
    await phase('downloading','Downloading the trusted artifact into bounded private temporary storage.')
    const response=await s3.send(new GetObjectCommand({Bucket:s3config.bucket,Key:artifact.object_key}),{abortSignal:signal})
    if(!response.Body||response.ContentLength!==Number(artifact.size)){
      if(response.Body instanceof Readable)response.Body.destroy()
      else if(response.Body)await response.Body.transformToWebStream().cancel().catch(()=>{})
      throw new AppError('ARTIFACT_SIZE_MISMATCH','Stored archive size differs from its published metadata.')
    }
    const input=response.Body instanceof Readable?response.Body:Readable.fromWeb(response.Body.transformToWebStream() as unknown as NodeReadableStream<Uint8Array>)
    const hash=createHash('sha256');let bytes=0
    const bound=new Transform({transform(chunk:Buffer,_encoding,callback){
      bytes+=chunk.length
      if(bytes>Number(artifact.size)||bytes>maxArchiveBytes){callback(new AppError('RESOURCE_LIMIT','Downloaded archive exceeded its published size.'));return}
      hash.update(chunk);callback(null,chunk)
    }})
    await pipeline(input,bound,createWriteStream(file,{flags:'wx',mode:0o600}),{signal})
    await phase('verifying','Checking the complete downloaded archive SHA-256 before any target write.')
    if(bytes!==Number(artifact.size)||hash.digest('hex')!==artifact.sha256)throw new AppError('CHECKSUM_MISMATCH','Archive integrity verification failed. No restore data was applied.')
    // Recheck after download: a UI review or earlier check never authorizes a changed target.
    const repeated=await inspectRestore(services,artifact.id,target.id,runId)
    if(repeated.fingerprint!==review.fingerprint)throw new AppError('REVIEW_CHANGED','Target identity or restore configuration changed before execution.')
    await session.connect();await session.restrictedRestoreRole()
    if(!await session.empty())throw new AppError('TARGET_NOT_EMPTY','Target contents appeared before execution. No restore data was applied.')
    await phase('restoring','Applying the verified artifact to the designated empty target. No source or nonempty target will be replaced.')
    await check()
    const {toolVersion}=await session.restore(file,dir,signal,artifact.manifest as Manifest)
    await phase('validating-data','Native restore completed. Comparing the engine-specific structure, data and sequence state with the captured source.')
    await db.updateTable('runs').set({validation:{restore:'completed',integrity:'sha256-matched',status:'running',toolVersion}}).where('id','=',runId).where('execution_token','=',token).execute()
    const actual=await session.manifest(),comparison=session.compare?.(artifact.manifest as Manifest,actual)??manifestComparison(artifact.manifest as Manifest,actual)
    const validation={restore:'completed',integrity:'sha256-matched',status:comparison.passed?'passed':'failed',...comparison,toolVersion,completedAt:new Date().toISOString()}
    await check()
    await db.updateTable('runs').set({validation}).where('id','=',runId).where('execution_token','=',token).where('status','=','running').execute()
    if(!comparison.passed)throw new AppError('VALIDATION_FAILED','The native restore completed, but captured schema, data or sequence validation did not match. The target remains blocked.')
    await session.close();await rm(dir,{recursive:true,force:true})
    await db.transaction().execute(async trx=>{
      const owned=await trx.selectFrom('runs').select(['status','cancel_requested']).where('id','=',runId).where('execution_token','=',token).forUpdate().executeTakeFirstOrThrow()
      if(owned.status!=='running'||owned.cancel_requested||signal.aborted)throw new AppError('CANCELLED','Restore finished, but confirmation was interrupted. Reconcile the target before another operation.')
      await trx.updateTable('runs').set({status:'succeeded',phase:'completed',finished_at:new Date(),validation}).where('id','=',runId).where('execution_token','=',token).execute()
      await trx.insertInto('events').values({run_id:runId,phase:'completed',message:'Native restore completed; archive integrity, schema, row digests and sequence checks passed. Application acceptance is a separate step.'}).execute()
    })
  }finally{
    await session.close().catch(()=>{});s3.destroy();await rm(dir,{recursive:true,force:true}).catch(()=>{})
  }
}
