import {test,expect} from 'bun:test'
import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {sql} from 'kysely'
import {connectDb} from '../server/db'
import {config} from '../server/config'
import {seal,unseal,AppError} from '../server/security'
import {GoogleDriveOAuth,googleDriveScopes,type GoogleDrivePurpose} from '../server/google-drive/oauth'
import {GoogleDriveRecovery,recoveryImportKey} from '../server/google-drive/recovery'
import type {GoogleDriveClient,DriveFile} from '../server/google-drive/client'
import type {PortableArchive} from '../server/storage'

const acceptance=process.env.STEELKEEP_GOOGLE_DRIVE_ACCEPTANCE==='synthetic-ci'?test:test.skip
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')

acceptance('Google Drive OAuth lifecycle and portable import use real isolated PostgreSQL with synthetic Google transport',async()=>{
 if(process.platform!=='linux'||process.env.GITHUB_ACTIONS!=='true')throw new Error('This proof requires the isolated Linux GitHub Actions runner.')
 const url=new URL(process.env.DATABASE_URL??'')
 if(url.protocol!=='postgresql:'||url.hostname!=='127.0.0.1'||url.port!=='5432'||url.pathname!=='/steelkeep_drive_ci'||url.username!=='steelkeep_drive_ci'||url.password!=='synthetic-drive-ci-only'||url.search||url.hash)throw new Error('Use only the exact disposable Google Drive CI database.')
 const {db}=connectDb(),nonce=randomBytes(16).toString('hex'),owner='drive-proof:'+nonce,other=owner+':other',actors=[owner,other],key=config.key()
 const configuration={clientId:'synthetic-ci-client.apps.googleusercontent.com',clientSecret:'synthetic-google-ci-secret-'+nonce,redirectUri:'https://backup.example.test/api/v1/google-drive/oauth/callback'}
 const ownedStorageIds=new Set<string>(),requestKeys=new Set<string>(),ownedTargetIds=new Set<string>()
 let guarded=false
 try{
  expect((await sql<{database:string;actor:string}>`SELECT current_database() AS database,current_user AS actor`.execute(db)).rows[0]).toEqual({database:'steelkeep_drive_ci',actor:'steelkeep_drive_ci'})
  expect((await sql<{version:number}>`SELECT max(version)::integer AS version FROM steelkeep_migrations`.execute(db)).rows[0].version).toBe(12)
  const fresh=(await sql<{connections:number;runs:number;artifacts:number;owners:number;outbox:number;states:number;grants:number}>`SELECT (SELECT count(*)::integer FROM connections) AS connections,(SELECT count(*)::integer FROM runs) AS runs,(SELECT count(*)::integer FROM artifacts) AS artifacts,(SELECT count(*)::integer FROM owner_account) AS owners,(SELECT count(*)::integer FROM outbox) AS outbox,(SELECT count(*)::integer FROM google_drive_oauth_states) AS states,(SELECT count(*)::integer FROM google_drive_grants) AS grants`.execute(db)).rows[0]
  expect(fresh).toEqual({connections:0,runs:0,artifacts:0,owners:0,outbox:0,states:0,grants:0});guarded=true

  let codeRequests=0,refreshRequests=0,revokeRequests=0,mode:'rotate'|'preserve'|'invalid'='rotate'
  const codes=new Map<string,{purpose:GoogleDrivePurpose;challenge:string;wrongScope?:boolean}>(),firstRefresh='synthetic-refresh-'+nonce,rotatedRefresh='synthetic-rotated-'+nonce
  const transport=async(input:Parameters<typeof globalThis.fetch>[0],init?:RequestInit)=>{
   expect(init?.method).toBe('POST');expect(init?.redirect).toBe('error')
   const form=new URLSearchParams(String(init?.body))
   if(String(input)==='https://oauth2.googleapis.com/revoke'){
    revokeRequests++;expect(form.get('token')).toBe(firstRefresh);return new Response(null,{status:200})
   }
   expect(String(input)).toBe('https://oauth2.googleapis.com/token')
   expect(form.get('client_id')).toBe(configuration.clientId);expect(form.get('client_secret')).toBe(configuration.clientSecret)
   if(form.get('grant_type')==='authorization_code'){
    codeRequests++;const expected=codes.get(form.get('code')??'');expect(expected).toBeDefined()
    expect(form.get('redirect_uri')).toBe(configuration.redirectUri)
    expect(createHash('sha256').update(form.get('code_verifier')??'').digest('base64url')).toBe(expected!.challenge)
    return Response.json({access_token:'synthetic-first-access-'+nonce,refresh_token:firstRefresh,token_type:'Bearer',expires_in:3600,scope:expected!.wrongScope?googleDriveScopes.restore:googleDriveScopes[expected!.purpose]})
   }
   expect(form.get('grant_type')).toBe('refresh_token');refreshRequests++
   if(mode==='invalid')return Response.json({error:'invalid_grant',error_description:'must-not-be-exposed-'+nonce},{status:400})
   expect(form.get('refresh_token')).toBe(mode==='rotate'?firstRefresh:rotatedRefresh)
   await new Promise(resolve=>setTimeout(resolve,20))
   return Response.json({access_token:'synthetic-'+mode+'-access-'+nonce,...(mode==='rotate'?{refresh_token:rotatedRefresh}:{}),token_type:'Bearer',expires_in:3600})
  }
  const oauth=new GoogleDriveOAuth(db,{configuration:()=>configuration,fetch:transport as typeof globalThis.fetch,encryptionKey:key})
  async function begin(purpose:GoogleDrivePurpose,wrongScope=false){
   const value=await oauth.start(owner,purpose),authorization=new URL(value.authorizationUrl),state=authorization.searchParams.get('state')!,code=purpose+'-code-'+randomUUID()
   codes.set(code,{purpose,challenge:authorization.searchParams.get('code_challenge')!,wrongScope})
   return {state,code}
  }
  async function connected(purpose:GoogleDrivePurpose){const value=await begin(purpose),callback=await oauth.completeCallback(value);return oauth.claim(owner,callback.claimTicket)}

  const initial=await begin('source'),stateRow=(await sql<{state_hash:string;verifier_secret:string}>`SELECT state_hash,verifier_secret FROM google_drive_oauth_states WHERE actor=${owner}`.execute(db)).rows[0]
  expect(stateRow.state_hash).toBe(hash(initial.state));expect(stateRow.state_hash).not.toContain(initial.state)
  expect(stateRow.verifier_secret).not.toContain('verifier')
  expect(unseal<{verifier:string}>(stateRow.verifier_secret,key).verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
  const callback=await oauth.completeCallback(initial)
  await expect(oauth.completeCallback(initial)).rejects.toMatchObject({code:'GOOGLE_OAUTH_STATE'});expect(codeRequests).toBe(1)
  await expect(oauth.claim(other,callback.claimTicket)).rejects.toMatchObject({code:'GOOGLE_OAUTH_STATE'})
  const grant=await oauth.claim(owner,callback.claimTicket)
  expect(grant).toMatchObject({purpose:'source',status:'active',revision:1,scopes:[googleDriveScopes.source]});expect(grant).not.toHaveProperty('secret')
  await expect(oauth.claim(owner,callback.claimTicket)).rejects.toMatchObject({code:'GOOGLE_OAUTH_STATE'})
  expect(await oauth.listGrants(other)).toEqual([])
  expect((await oauth.listGrants(owner)).map(item=>item.id)).toContain(grant.id)
  const saved=(await sql<{secret:string;revision:number}>`SELECT secret,revision FROM google_drive_grants WHERE id=${grant.id}`.execute(db)).rows[0]
  expect(saved.secret).not.toContain(firstRefresh);expect(saved.secret).not.toContain('synthetic-first-access-'+nonce)
  expect(unseal<{refreshToken:string}>(saved.secret,key).refreshToken).toBe(firstRefresh)
  await expect(oauth.accessToken(grant.id,'storage')).rejects.toMatchObject({code:'GOOGLE_SCOPE_MISMATCH'})
  expect(await oauth.accessToken(grant.id,'source')).toBe('synthetic-first-access-'+nonce);expect(refreshRequests).toBe(0)

  const expiredState=await begin('source')
  await sql`UPDATE google_drive_oauth_states SET expires_at=clock_timestamp()-interval '1 second' WHERE actor=${owner} AND state_hash=${hash(expiredState.state)}`.execute(db)
  await expect(oauth.completeCallback(expiredState)).rejects.toMatchObject({code:'GOOGLE_OAUTH_STATE'});expect(codeRequests).toBe(1)
  const expiredClaim=await oauth.completeCallback(await begin('restore'))
  await sql`UPDATE google_drive_grants SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE actor=${owner} AND claim_hash=${hash(expiredClaim.claimTicket)}`.execute(db)
  await expect(oauth.claim(owner,expiredClaim.claimTicket)).rejects.toMatchObject({code:'GOOGLE_OAUTH_STATE'})
  const denied=await begin('source'),requestsBeforeDenial=codeRequests
  await expect(oauth.completeCallback({...denied,error:'private-provider-description-'+nonce})).rejects.toMatchObject({code:'GOOGLE_OAUTH_DENIED'})
  await expect(oauth.completeCallback(denied)).rejects.toMatchObject({code:'GOOGLE_OAUTH_STATE'});expect(codeRequests).toBe(requestsBeforeDenial)
  await expect(oauth.completeCallback(await begin('source',true))).rejects.toMatchObject({code:'GOOGLE_SCOPE_MISMATCH'})

  await sql`UPDATE google_drive_grants SET secret=${seal({refreshToken:firstRefresh,accessToken:'expired-synthetic-token',expiresAt:0},key)} WHERE id=${grant.id} AND actor=${owner}`.execute(db)
  const parallel=await Promise.all(Array.from({length:4},()=>oauth.accessToken(grant.id,'source')))
  expect(new Set(parallel)).toEqual(new Set(['synthetic-rotate-access-'+nonce]));expect(refreshRequests).toBe(1)
  const rotated=(await sql<{secret:string;revision:number}>`SELECT secret,revision FROM google_drive_grants WHERE id=${grant.id}`.execute(db)).rows[0]
  expect(rotated.revision).toBe(1);expect(unseal<{refreshToken:string}>(rotated.secret,key).refreshToken).toBe(rotatedRefresh)
  mode='preserve';expect(await oauth.accessToken(grant.id,'source',undefined,true)).toBe('synthetic-preserve-access-'+nonce)
  const preserved=(await sql<{secret:string;revision:number}>`SELECT secret,revision FROM google_drive_grants WHERE id=${grant.id}`.execute(db)).rows[0]
  expect(preserved.revision).toBe(1);expect(unseal<{refreshToken:string}>(preserved.secret,key).refreshToken).toBe(rotatedRefresh)
  mode='invalid';await expect(oauth.accessToken(grant.id,'source',undefined,true)).rejects.toMatchObject({code:'GOOGLE_RECONNECT_REQUIRED'})
  const invalidGrant=(await sql<{secret:string;revision:number;status:string}>`SELECT secret,revision,status FROM google_drive_grants WHERE id=${grant.id}`.execute(db)).rows[0]
  expect(invalidGrant.status).toBe('reconnect_required');expect(invalidGrant.revision).toBe(2);expect(unseal(invalidGrant.secret,key)).toEqual({})
  const requestsBeforeRevokedRead=refreshRequests
  await expect(oauth.accessToken(grant.id,'source')).rejects.toMatchObject({code:'GOOGLE_RECONNECT_REQUIRED'});expect(refreshRequests).toBe(requestsBeforeRevokedRead)
  const writable=await connected('storage')
  await expect(oauth.revoke(other,writable.id)).rejects.toMatchObject({code:'GOOGLE_GRANT_NOT_FOUND'});expect(revokeRequests).toBe(0)
  expect(await oauth.revoke(owner,writable.id)).toEqual({revoked:true,providerRevoked:true});expect(revokeRequests).toBe(1)
  expect(await oauth.revoke(owner,writable.id)).toEqual({revoked:true,providerRevoked:false});expect(revokeRequests).toBe(1)
  await expect(oauth.grant(writable.id,'storage')).rejects.toMatchObject({code:'GOOGLE_RECONNECT_REQUIRED'})
  const revoked=(await sql<{secret:string;revision:number;status:string}>`SELECT secret,revision,status FROM google_drive_grants WHERE id=${writable.id}`.execute(db)).rows[0]
  expect(revoked.status).toBe('revoked');expect(revoked.revision).toBe(2);expect(unseal(revoked.secret,key)).toEqual({})
  const readOnly=await connected('recovery');expect(readOnly.scopes).toEqual([googleDriveScopes.source]);expect(readOnly.purpose).toBe('recovery')
  expect(JSON.stringify((await db.selectFrom('audit_events').selectAll().where('actor','in',actors).execute()))).not.toContain(firstRefresh)

  const storageId=randomUUID(),targetId=randomUUID(),folderId='synthetic_folder_'+nonce;ownedStorageIds.add(storageId);ownedTargetIds.add(targetId)
  const storageConfig={folderId,accountId:'synthetic-account-'+nonce,grantId:readOnly.id,grantRevision:readOnly.revision,grantPurpose:'recovery',readOnly:true}
  await db.insertInto('connections').values([{id:storageId,name:'Synthetic recovery storage '+nonce,kind:'google_drive_storage',config:storageConfig,secret:seal({}),check_status:'available',checked_at:new Date()},{id:targetId,name:'Untouched synthetic destination '+nonce,kind:'postgres',config:{database:'synthetic_empty_'+nonce,restoreTarget:true},secret:seal({}),check_status:'untested',checked_at:null}]).execute()
  type Fixture={archive:DriveFile;sidecar:DriveFile;descriptor:PortableArchive;content:Buffer;descriptorContent:Buffer}
  const fixtures=new Map<string,Fixture>(),files=new Map<string,DriveFile>()
  const folder:DriveFile={id:folderId,name:'Synthetic recovery folder',mimeType:'application/vnd.google-apps.folder',parents:[],version:'1',trashed:false,capabilities:{canDownload:true}}
  files.set(folder.id,folder)
  function fixture(label:string){
   const id='synthetic_archive_'+label+'_'+nonce,recoveryId='synthetic_descriptor_'+label+'_'+nonce,originalArtifactId=randomUUID(),content=Buffer.from('Synthetic portable PostgreSQL bytes '+label+' '+nonce),sha256=createHash('sha256').update(content).digest('hex')
   const manifest={format:1 as const,engine:'postgres' as const,database:'synthetic_import_'+nonce,serverVersion:'17.11',objects:{tables:'synthetic-schema-hash'},data:{rows:3},sequences:{}}
   const descriptor:PortableArchive={format:'steelkeep-recovery-v1',artifactId:originalArtifactId,engine:'postgres',sourceDatabase:manifest.database,serverVersion:'17.11',toolVersion:'synthetic-pg-dump',manifest,size:String(content.length),sha256,createdAt:new Date().toISOString(),archiveFileId:id,filename:'synthetic-'+label+'.dump'}
   const descriptorContent=Buffer.from(JSON.stringify(descriptor)),common={parents:[folderId],version:'1',trashed:false,capabilities:{canDownload:true}}
   const archive:DriveFile={...common,id,name:'Synthetic archive '+label,mimeType:'application/octet-stream',size:String(content.length),properties:{steelkeepArchive:'1',artifactId:originalArtifactId,engine:'postgres',sha256,recoveryId}}
   const sidecar:DriveFile={...common,id:recoveryId,name:'Synthetic descriptor '+label,mimeType:'application/json',size:String(descriptorContent.length),properties:{steelkeepRecovery:'1',archiveId:id,artifactId:originalArtifactId}}
   const item={archive,sidecar,descriptor,content,descriptorContent};fixtures.set(id,item);files.set(id,archive);files.set(recoveryId,sidecar);return item
  }
  const first=fixture('first'),second=fixture('second'),corrupt=fixture('corrupt'),moving=fixture('moving'),storageChanging=fixture('storagechanging'),parallelFile=fixture('parallel')
  let opened=0,closed=0,descriptorReads=0,movingReads=0
  const client:Pick<GoogleDriveClient,'metadata'|'children'|'download'>={
   async metadata(id){const file=files.get(id);if(!file)throw new AppError('GOOGLE_DRIVE_NOT_FOUND','Synthetic file not found.',404);const copy=structuredClone(file);if(id===moving.archive.id&&++movingReads>1)copy.version='2';return copy},
   async children(id,options){expect(id).toBe(folderId);expect(options?.pageToken).toBeUndefined();return {files:[structuredClone(first.archive),structuredClone(first.sidecar)]}},
   async download(file){descriptorReads++;const item=[...fixtures.values()].find(value=>value.sidecar.id===file.id);if(!item)throw new Error('Only synthetic descriptors may use this injected reader.');return {size:item.descriptorContent.length,body:(async function*(){yield item.descriptorContent.subarray(0,11);yield item.descriptorContent.subarray(11)})(),close(){}}}
  }
  const recovery=new GoogleDriveRecovery(db,{client:()=>client,open:async(storage,fileId)=>{
   expect(storage.id).toBe(storageId);const item=fixtures.get(fileId);if(!item)throw new Error('Unknown synthetic archive.');opened++
   if(fileId===storageChanging.archive.id)await db.updateTable('connections').set({revision:sql`revision+1`}).where('id','=',storageId).execute()
   const content=fileId===corrupt.archive.id?Buffer.from(item.content.map(value=>value^1)):item.content
   return {length:content.length,body:(async function*(){yield content.subarray(0,7);yield content.subarray(7)})(),close(){closed++}}
  }})
  function request(fileId:string,label:string,actor=owner){const idempotencyKey='synthetic-import-'+label+'-'+nonce;requestKeys.add(recoveryImportKey(actor,storageId,idempotencyKey));return {storageId,fileId,idempotencyKey,confirmImport:true}}
  const browse=await recovery.browse(storageId)
  expect(browse.items).toHaveLength(1);expect(browse.items[0]).toMatchObject({fileId:first.archive.id,verification:'metadata-only',portable:true});expect(descriptorReads).toBe(0);expect(opened).toBe(0)
  const initialRequest=request(first.archive.id,'first'),adopted=await recovery.import(initialRequest,owner)
  expect(adopted).toMatchObject({imported:true,verification:'full-sha256'});expect(opened).toBe(1);expect(closed).toBe(1)
  const importedSource=await db.selectFrom('connections').selectAll().where('id','=',adopted.sourceId).executeTakeFirstOrThrow()
  expect(importedSource.kind).toBe('postgres');expect(importedSource.config).toMatchObject({database:first.descriptor.sourceDatabase,importedArchive:true,restoreTarget:false});expect(unseal(importedSource.secret)).toEqual({})
  const importedRun=await db.selectFrom('runs').selectAll().where('id','=',adopted.runId).executeTakeFirstOrThrow()
  expect(importedRun).toMatchObject({type:'backup',status:'succeeded',phase:'imported',execution_token:null,artifact_id:adopted.artifactId,target_id:null})
  expect(importedRun.validation?.driveImport).toMatchObject({fileId:first.archive.id,actor:owner,verification:'full-sha256'})
  const importedArtifact=await db.selectFrom('artifacts').selectAll().where('id','=',adopted.artifactId).executeTakeFirstOrThrow()
  expect(importedArtifact).toMatchObject({object_key:first.archive.id,sha256:first.descriptor.sha256,size:first.descriptor.size,availability:'present',deletion_state:'active'})
  expect(await recovery.import(initialRequest,owner)).toEqual(adopted);expect(opened).toBe(1)
  await expect(recovery.import({...initialRequest,fileId:second.archive.id},owner)).rejects.toMatchObject({code:'REQUEST_KEY_CONFLICT'});expect(opened).toBe(1)
  requestKeys.add(recoveryImportKey(other,storageId,initialRequest.idempotencyKey))
  await expect(recovery.import(initialRequest,other)).rejects.toMatchObject({code:'DRIVE_ARCHIVE_ALREADY_IMPORTED'});expect(opened).toBe(1)
  await expect(recovery.import({...request(second.archive.id,'unconfirmed'),confirmImport:false},owner)).rejects.toMatchObject({code:'DRIVE_IMPORT_CONFIRMATION'})
  await expect(recovery.import(request(corrupt.archive.id,'corrupt'),owner)).rejects.toMatchObject({code:'CHECKSUM_MISMATCH'})
  await expect(recovery.import(request(moving.archive.id,'moving'),owner)).rejects.toMatchObject({code:'DRIVE_RECOVERY_CHANGED'})
  await expect(recovery.import(request(storageChanging.archive.id,'storagechanging'),owner)).rejects.toMatchObject({code:'DRIVE_RECOVERY_CHANGED'})
  const parallelRequest=request(parallelFile.archive.id,'parallel'),imports=await Promise.all([recovery.import(parallelRequest,owner),recovery.import(parallelRequest,owner)])
  expect(imports[0]).toEqual(imports[1]);expect(imports[0].artifactId).not.toBe(adopted.artifactId)
  expect((await db.selectFrom('artifacts').select('id').execute())).toHaveLength(2)
  expect((await db.selectFrom('outbox').select('run_id').execute())).toHaveLength(0)
  expect((await db.selectFrom('target_blocks').select('target_id').execute())).toHaveLength(0)
  expect((await db.selectFrom('restore_intents').select('id').execute())).toHaveLength(0)
  expect((await db.selectFrom('connections').selectAll().where('id','=',targetId).executeTakeFirstOrThrow()).config).toEqual({database:'synthetic_empty_'+nonce,restoreTarget:true})
  expect(opened).toBe(closed)
  console.log('Google Drive isolated-PG proof: OAuth replay/expiry/actor/scopes/refresh/revocation and portable full-SHA atomic import/idempotency passed; no Google network or native target writes.')
 }finally{
  if(guarded){
   const runs=requestKeys.size?await db.selectFrom('runs').select(['id','source_id','artifact_id']).where('idempotency_key','in',[...requestKeys]).execute():[]
   const runIds=runs.map(row=>row.id),sourceIds=runs.map(row=>row.source_id),artifactIds=runs.flatMap(row=>row.artifact_id?[row.artifact_id]:[])
   if(runIds.length)await db.deleteFrom('events').where('run_id','in',runIds).execute()
   if(artifactIds.length)await db.deleteFrom('artifacts').where('id','in',artifactIds).execute()
   if(runIds.length)await db.deleteFrom('runs').where('id','in',runIds).execute()
   const connections=[...sourceIds,...ownedStorageIds,...ownedTargetIds];if(connections.length)await db.deleteFrom('connections').where('id','in',connections).execute()
   await sql`DELETE FROM google_drive_oauth_states WHERE actor IN (${sql.join(actors)})`.execute(db)
   await sql`DELETE FROM google_drive_grants WHERE actor IN (${sql.join(actors)})`.execute(db)
   await db.deleteFrom('audit_events').where('actor','in',actors).execute()
  }
  await db.destroy()
 }
},120000)
