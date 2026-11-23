import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {lstatSync,readFileSync} from 'node:fs'
import {sql,type Kysely} from 'kysely'
import type {Schema} from '../db'
import {config} from '../config'
import {AppError,seal,unseal} from '../security'
import {audit} from '../agents'

export type GoogleDrivePurpose='source'|'restore'|'storage'|'recovery'|'account'
export const googleDriveScopes={source:'https://www.googleapis.com/auth/drive.readonly',restore:'https://www.googleapis.com/auth/drive.file',storage:'https://www.googleapis.com/auth/drive.file',recovery:'https://www.googleapis.com/auth/drive.readonly',account:'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file'} as const
export type GoogleOAuthConfiguration={clientId:string;clientSecret:string;redirectUri:string}
type Fetch=(...args:Parameters<typeof globalThis.fetch>)=>ReturnType<typeof globalThis.fetch>
type Credentials={refreshToken:string;accessToken?:string;expiresAt?:number}
type GrantRow={id:string;actor:string;purpose:GoogleDrivePurpose;scopes:string[];revision:number;status:'pending'|'active'|'revoked'|'reconnect_required';secret:string;created_at:Date;claimed_at:Date|null;revoked_at:Date|null;claim_expires_at:Date|null}
export type GoogleDriveGrant={id:string;purpose:GoogleDrivePurpose;scopes:string[];revision:number;status:GrantRow['status'];createdAt:string;claimedAt:string|null;revokedAt:string|null}
const tokenEndpoint='https://oauth2.googleapis.com/token',revokeEndpoint='https://oauth2.googleapis.com/revoke'
const opaque=(prefix:string)=>prefix+randomBytes(32).toString('hex')
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const invalidState=()=>new AppError('GOOGLE_OAUTH_STATE','This Google authorization is invalid, already used or expired. Start again.',400)
const reconnect=()=>new AppError('GOOGLE_RECONNECT_REQUIRED','Google authorization expired or was revoked. Reconnect this account.',409)
const invalidConfig=()=>new AppError('GOOGLE_OAUTH_CONFIG','Configure a valid Google OAuth web client, private secret file and exact allowed callback origin.',503)
const publicGrant=(row:GrantRow):GoogleDriveGrant=>({id:row.id,purpose:row.purpose,scopes:row.scopes,revision:row.revision,status:row.status,createdAt:new Date(row.created_at).toISOString(),claimedAt:row.claimed_at?new Date(row.claimed_at).toISOString():null,revokedAt:row.revoked_at?new Date(row.revoked_at).toISOString():null})
function purpose(value:unknown):GoogleDrivePurpose{if(value!=='source'&&value!=='restore'&&value!=='storage'&&value!=='recovery'&&value!=='account')throw new AppError('GOOGLE_OAUTH_PURPOSE','Choose Google Drive account, source, restore, storage or recovery authorization.');return value}
function actor(value:string){if(typeof value!=='string'||value.length<1||value.length>200||/[\r\n\0]/.test(value))throw new AppError('UNAUTHORIZED','An authenticated account is required.',401);return value}
function grantId(value:string){if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))throw new AppError('GOOGLE_GRANT_NOT_FOUND','Google authorization not found.',404);return value}

export function googleGrantSupports(grant:Pick<GoogleDriveGrant,'purpose'|'scopes'|'status'>,requestedPurpose:GoogleDrivePurpose){
 const requested=googleDriveScopes[purpose(requestedPurpose)].split(' '),granted=googleDriveScopes[purpose(grant.purpose)].split(' ')
 return grant.status==='active'&&(grant.purpose===requestedPurpose||grant.purpose==='account')&&requested.every(scope=>grant.scopes.includes(scope))&&granted.every(scope=>grant.scopes.includes(scope))&&grant.scopes.every(scope=>granted.includes(scope))
}

export function validateGoogleOAuthConfiguration(value:GoogleOAuthConfiguration,allowedOrigins:readonly string[]):GoogleOAuthConfiguration{
 let url:URL
 try{url=new URL(value.redirectUri)}catch{throw invalidConfig()}
 const loopback=url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)
 if((url.protocol!=='https:'&&!loopback)||url.username||url.password||url.search||url.hash||url.pathname!=='/api/v1/google-drive/oauth/callback'||!allowedOrigins.includes(url.origin))throw invalidConfig()
 if(!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value.clientId)||value.clientId.length>512||typeof value.clientSecret!=='string'||value.clientSecret.length<8||value.clientSecret.length>512||/\s|\0/.test(value.clientSecret))throw invalidConfig()
 return {clientId:value.clientId,clientSecret:value.clientSecret,redirectUri:url.href}
}

export function googleOAuthConfiguration():GoogleOAuthConfiguration|null{
 const clientId=process.env.STEELKEEP_GOOGLE_CLIENT_ID,secretFile=process.env.STEELKEEP_GOOGLE_CLIENT_SECRET_FILE,redirectUri=process.env.STEELKEEP_GOOGLE_REDIRECT_URI
 if(!clientId&&!secretFile&&!redirectUri)return null
 if(!clientId||!secretFile||!redirectUri)throw invalidConfig()
 let clientSecret:string
 try{const file=lstatSync(secretFile);if(!file.isFile()||file.isSymbolicLink()||file.size>4096||(file.mode&0o077)!==0)throw invalidConfig();clientSecret=readFileSync(secretFile,'utf8').trim()}catch{throw invalidConfig()}
 return validateGoogleOAuthConfiguration({clientId,clientSecret,redirectUri},config.allowedOrigins())
}

export function googleAuthorization(configuration:GoogleOAuthConfiguration,requestedPurpose:GoogleDrivePurpose){
 purpose(requestedPurpose)
 const state=opaque('gds_'),verifier=randomBytes(32).toString('base64url'),url=new URL('https://accounts.google.com/o/oauth2/v2/auth')
 url.search=new URLSearchParams({client_id:configuration.clientId,redirect_uri:configuration.redirectUri,response_type:'code',scope:googleDriveScopes[requestedPurpose],access_type:'offline',prompt:'consent',include_granted_scopes:'false',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString()
 return {authorizationUrl:url.href,state,verifier}
}

async function boundedJson(response:Response):Promise<Record<string,unknown>>{
 if(!response.body)throw new AppError('GOOGLE_OAUTH_FAILED','Google did not return a valid authorization response.',502)
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0
 try{while(true){const value=await reader.read();if(value.done)break;length+=value.value.length;if(length>65536)throw new AppError('GOOGLE_OAUTH_FAILED','Google returned an oversized authorization response.',502);chunks.push(value.value)}}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
 let value:unknown;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw new AppError('GOOGLE_OAUTH_FAILED','Google did not return a valid authorization response.',502)}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('GOOGLE_OAUTH_FAILED','Google did not return a valid authorization response.',502)
 return value as Record<string,unknown>
}
function token(value:unknown){return typeof value==='string'&&value.length>=8&&value.length<=8192&&!/[\r\n\0]/.test(value)}
export function parseGoogleTokens(value:Record<string,unknown>,requestedPurpose:GoogleDrivePurpose,previousRefreshToken?:string,now=Date.now()):Credentials&{accessToken:string;expiresAt:number;scopes:string[]}{
 const required=googleDriveScopes[purpose(requestedPurpose)].split(' ')
 if(!token(value.access_token)||value.token_type!=='Bearer'||!Number.isSafeInteger(value.expires_in)||Number(value.expires_in)<60||Number(value.expires_in)>86400)throw new AppError('GOOGLE_OAUTH_FAILED','Google did not return a usable access token.',502)
 const scopes=typeof value.scope==='string'?[...new Set(value.scope.split(/\s+/).filter(Boolean))]:previousRefreshToken?required:[]
 if(!required.every(scope=>scopes.includes(scope))||scopes.some(scope=>!required.includes(scope)))throw new AppError('GOOGLE_SCOPE_MISMATCH','Google did not grant the requested Drive access. Approve the listed permissions and reconnect.',409)
 const refreshToken=value.refresh_token===undefined?previousRefreshToken:value.refresh_token
 if(!token(refreshToken))throw new AppError('GOOGLE_OFFLINE_ACCESS_REQUIRED','Google did not grant offline access. Reconnect and approve background backups.',409)
 return {accessToken:value.access_token as string,refreshToken:refreshToken as string,expiresAt:now+Number(value.expires_in)*1000,scopes}
}

export async function requestGoogleTokens(configuration:GoogleOAuthConfiguration,requestedPurpose:GoogleDrivePurpose,parameters:Record<string,string>,options:{fetch?:Fetch;signal?:AbortSignal;previousRefreshToken?:string}={}){
 const signal=AbortSignal.any([...(options.signal?[options.signal]:[]),AbortSignal.timeout(15000)])
 let response:Response
 try{response=await(options.fetch??fetch)(tokenEndpoint,{method:'POST',redirect:'error',signal,headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:new URLSearchParams({...parameters,client_id:configuration.clientId,client_secret:configuration.clientSecret})})}catch{if(options.signal?.aborted)throw options.signal.reason;throw new AppError('GOOGLE_OAUTH_UNAVAILABLE','Google authorization is temporarily unavailable. Try again.',503)}
 const value=await boundedJson(response)
 if(!response.ok){if(value.error==='invalid_grant'&&options.previousRefreshToken)throw reconnect();throw new AppError('GOOGLE_OAUTH_FAILED','Google authorization failed. Start a new connection.',409)}
 return parseGoogleTokens(value,requestedPurpose,options.previousRefreshToken)
}

export async function migrateGoogleDriveOAuth(db:Kysely<Schema>){
 await sql`CREATE TABLE google_drive_oauth_states(state_hash text PRIMARY KEY,actor text NOT NULL,purpose text NOT NULL CHECK(purpose IN ('source','restore','storage','recovery')),verifier_secret text NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now())`.execute(db)
 await sql`CREATE TABLE google_drive_grants(id uuid PRIMARY KEY,actor text NOT NULL,purpose text NOT NULL CHECK(purpose IN ('source','restore','storage','recovery')),scopes jsonb NOT NULL,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),status text NOT NULL CHECK(status IN ('pending','active','revoked','reconnect_required')),secret text NOT NULL,claim_hash text UNIQUE,claim_expires_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),claimed_at timestamptz,revoked_at timestamptz)`.execute(db)
 await sql`CREATE INDEX google_drive_grants_actor_idx ON google_drive_grants(actor,status)`.execute(db)
}

export async function migrateGoogleDriveOAuthAccount(db:Kysely<Schema>){
 await sql`ALTER TABLE google_drive_oauth_states DROP CONSTRAINT google_drive_oauth_states_purpose_check,ADD CONSTRAINT google_drive_oauth_states_purpose_check CHECK(purpose IN ('source','restore','storage','recovery','account'))`.execute(db)
 await sql`ALTER TABLE google_drive_grants DROP CONSTRAINT google_drive_grants_purpose_check,ADD CONSTRAINT google_drive_grants_purpose_check CHECK(purpose IN ('source','restore','storage','recovery','account'))`.execute(db)
}

export class GoogleDriveOAuth {
 constructor(readonly db:Kysely<Schema>,readonly options:{fetch?:Fetch;configuration?:()=>GoogleOAuthConfiguration|null;encryptionKey?:Buffer}={}){}
 private configuration(){const value=(this.options.configuration??googleOAuthConfiguration)();if(!value)throw new AppError('GOOGLE_OAUTH_NOT_CONFIGURED','The server owner must configure Google OAuth before connecting Drive.',503);return value}
 private seal(value:unknown){return seal(value,this.options.encryptionKey===undefined?undefined:Buffer.from(this.options.encryptionKey))}
 private unseal<T>(value:string){return unseal<T>(value,this.options.encryptionKey===undefined?undefined:Buffer.from(this.options.encryptionKey))}
 status(){const value=(this.options.configuration??googleOAuthConfiguration)();return {configured:!!value,redirectUri:value?.redirectUri??null,sourceScope:googleDriveScopes.source,restoreScope:googleDriveScopes.restore,storageScope:googleDriveScopes.storage,recoveryScope:googleDriveScopes.recovery,accountScope:googleDriveScopes.account,accountScopes:googleDriveScopes.account.split(' ')}}
 async start(initiator:string,requestedPurpose:GoogleDrivePurpose){
  actor(initiator);purpose(requestedPurpose)
  const authorization=googleAuthorization(this.configuration(),requestedPurpose),expiresAt=new Date(Date.now()+600000)
  await this.db.transaction().execute(async db=>{
   await sql`DELETE FROM google_drive_oauth_states WHERE expires_at<clock_timestamp()`.execute(db)
   await sql`DELETE FROM google_drive_grants WHERE status='pending' AND claim_expires_at<clock_timestamp()`.execute(db)
   const outstanding=await sql<{count:number}>`SELECT count(*)::integer AS count FROM google_drive_oauth_states WHERE actor=${initiator}`.execute(db)
   if(outstanding.rows[0].count>=10)throw new AppError('GOOGLE_OAUTH_RATE_LIMITED','Finish an existing Google authorization or wait for it to expire.',429)
   await sql`INSERT INTO google_drive_oauth_states(state_hash,actor,purpose,verifier_secret,expires_at) VALUES(${hash(authorization.state)},${initiator},${requestedPurpose},${this.seal({verifier:authorization.verifier})},clock_timestamp()+interval '10 minutes')`.execute(db)
   await audit(db,initiator,'google.authorization.started',null)
  })
  return {authorizationUrl:authorization.authorizationUrl,expiresAt:expiresAt.toISOString()}
 }
 async completeCallback(input:{state:string;code?:string;error?:string}){
  if(typeof input.state!=='string'||!/^gds_[a-f0-9]{64}$/.test(input.state))throw invalidState()
  const configuration=this.configuration()
  // Consume before the network exchange; replay must not repeat an authorization-code write.
  const state=(await sql<{actor:string;purpose:GoogleDrivePurpose;verifier_secret:string}>`DELETE FROM google_drive_oauth_states WHERE state_hash=${hash(input.state)} AND expires_at>clock_timestamp() RETURNING actor,purpose,verifier_secret`.execute(this.db)).rows[0]
  if(!state)throw invalidState()
  if(input.error!==undefined)throw new AppError('GOOGLE_OAUTH_DENIED','Google authorization was declined. No Drive connection was added.',409)
  if(typeof input.code!=='string'||input.code.length<1||input.code.length>4096||/[\r\n\0]/.test(input.code))throw new AppError('GOOGLE_OAUTH_FAILED','Google did not return a valid authorization code.',400)
  const {verifier}=this.unseal<{verifier:string}>(state.verifier_secret)
  const tokens=await requestGoogleTokens(configuration,state.purpose,{grant_type:'authorization_code',code:input.code,redirect_uri:configuration.redirectUri,code_verifier:verifier},{fetch:this.options.fetch})
  const id=randomUUID(),claimTicket=opaque('gdc_'),expiresAt=new Date(Date.now()+300000)
  await sql`INSERT INTO google_drive_grants(id,actor,purpose,scopes,status,secret,claim_hash,claim_expires_at) VALUES(${id},${state.actor},${state.purpose},${JSON.stringify(tokens.scopes)}::jsonb,'pending',${this.seal({refreshToken:tokens.refreshToken,accessToken:tokens.accessToken,expiresAt:tokens.expiresAt})},${hash(claimTicket)},clock_timestamp()+interval '5 minutes')`.execute(this.db)
  return {claimTicket,expiresAt:expiresAt.toISOString()}
 }
 async claim(initiator:string,ticket:string){
  actor(initiator)
  if(typeof ticket!=='string'||!/^gdc_[a-f0-9]{64}$/.test(ticket))throw invalidState()
  return this.db.transaction().execute(async db=>{
   const row=(await sql<GrantRow>`UPDATE google_drive_grants SET status='active',claim_hash=NULL,claim_expires_at=NULL,claimed_at=clock_timestamp() WHERE actor=${initiator} AND claim_hash=${hash(ticket)} AND status='pending' AND claim_expires_at>clock_timestamp() RETURNING *`.execute(db)).rows[0]
   if(!row)throw invalidState()
   await audit(db,initiator,'google.authorization.connected',row.id)
   return publicGrant(row)
  })
 }
 async listGrants(initiator:string){actor(initiator);return(await sql<GrantRow>`SELECT id,actor,purpose,scopes,revision,status,created_at,claimed_at,revoked_at FROM google_drive_grants WHERE actor=${initiator} AND status<>'pending' ORDER BY created_at DESC LIMIT 100`.execute(this.db)).rows.map(publicGrant)}
 async connectedAccounts(){return(await sql<GrantRow>`SELECT id,purpose,scopes,revision,status,created_at,claimed_at,revoked_at FROM google_drive_grants WHERE status IN ('active','reconnect_required') ORDER BY created_at DESC LIMIT 100`.execute(this.db)).rows.map(publicGrant)}
 async grant(id:string,requestedPurpose?:GoogleDrivePurpose){
  grantId(id)
  const row=(await sql<GrantRow>`SELECT id,actor,purpose,scopes,revision,status,created_at,claimed_at,revoked_at FROM google_drive_grants WHERE id=${id}`.execute(this.db)).rows[0]
  if(!row||row.status==='pending')throw new AppError('GOOGLE_GRANT_NOT_FOUND','Google authorization not found.',404)
  if(row.status!=='active')throw reconnect()
  if(requestedPurpose!==undefined&&!googleGrantSupports(row,purpose(requestedPurpose)))throw new AppError('GOOGLE_SCOPE_MISMATCH','This Google authorization is for a different operation.',409)
  return publicGrant(row)
 }
 async accessToken(id:string,requestedPurpose:GoogleDrivePurpose,signal?:AbortSignal,forceRefresh=false):Promise<string>{
  grantId(id);purpose(requestedPurpose)
  const configuration=this.configuration()
  const result=await this.db.transaction().execute(async db=>{
   const row=(await sql<GrantRow>`SELECT * FROM google_drive_grants WHERE id=${id} FOR UPDATE`.execute(db)).rows[0]
   if(!row||row.status!=='active')return {error:reconnect()}
   if(!googleGrantSupports(row,requestedPurpose))return {error:new AppError('GOOGLE_SCOPE_MISMATCH','This Google authorization is for a different operation.',409)}
   const current=this.unseal<Credentials>(row.secret)
   if(!forceRefresh&&token(current.accessToken)&&typeof current.expiresAt==='number'&&current.expiresAt>Date.now()+60000)return {token:current.accessToken as string}
   try{
    const updated=await requestGoogleTokens(configuration,row.purpose,{grant_type:'refresh_token',refresh_token:current.refreshToken},{fetch:this.options.fetch,signal,previousRefreshToken:current.refreshToken})
    // Grant identity/revision is stable across routine cache and refresh-token rotation.
    await sql`UPDATE google_drive_grants SET secret=${this.seal({refreshToken:updated.refreshToken,accessToken:updated.accessToken,expiresAt:updated.expiresAt})} WHERE id=${id}`.execute(db)
    return {token:updated.accessToken}
   }catch(error){
    if(error instanceof AppError&&error.code==='GOOGLE_RECONNECT_REQUIRED'){
     await sql`UPDATE google_drive_grants SET status='reconnect_required',secret=${this.seal({})},revision=revision+1 WHERE id=${id}`.execute(db)
     return {error}
    }
    throw error
   }
  })
  if(result.error)throw result.error
  return result.token!
 }
 async revoke(initiator:string,id:string){
  actor(initiator);grantId(id)
  const removed=await this.db.transaction().execute(async db=>{
   const row=(await sql<GrantRow>`SELECT * FROM google_drive_grants WHERE id=${id} AND actor=${initiator} FOR UPDATE`.execute(db)).rows[0]
   if(!row||row.status==='pending')throw new AppError('GOOGLE_GRANT_NOT_FOUND','Google authorization not found.',404)
   if(row.status==='revoked')return null
   const credentials=this.unseal<Partial<Credentials>>(row.secret)
   await sql`UPDATE google_drive_grants SET status='revoked',secret=${this.seal({})},revision=revision+1,revoked_at=clock_timestamp() WHERE id=${id}`.execute(db)
   await audit(db,initiator,'google.authorization.disconnected',id)
   return credentials.refreshToken??null
  })
  if(!removed)return {revoked:true,providerRevoked:false}
  let providerRevoked=false
  try{const response=await(this.options.fetch??fetch)(revokeEndpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:removed})});providerRevoked=response.ok;await response.body?.cancel()}catch{/* Local revocation already prevents all further Steelkeep access. */}
  return {revoked:true,providerRevoked}
 }
}
