import {Elysia,t} from 'elysia'
import type {Services,Principal} from '../services'
import {authorize} from '../auth'
import {AppError} from '../security'
import {GoogleDriveOAuth,googleOAuthConfiguration} from './oauth'
import {GoogleDriveRecovery} from './recovery'
import {deriveDriveRecoveryKey} from './source'

/** Google may add response metadata; only bounded, unambiguous OAuth fields drive state. */
export function googleDriveCallbackInput(request:Request){
 if(Buffer.byteLength(request.url)>32768)throw new AppError('GOOGLE_OAUTH_RESPONSE','The Google authorization response is too large.')
 const url=new URL(request.url),entries=[...url.searchParams.entries()]
 if(entries.length>32||entries.some(([key,value])=>key.length>128||value.length>8192||/[\0\r\n]/.test(key)))throw new AppError('GOOGLE_OAUTH_RESPONSE','The Google authorization response is invalid.')
 const field=(name:string,max:number):string|undefined=>{
  const values=url.searchParams.getAll(name)
  if(values.length>1||values[0]!==undefined&&(values[0].length>max||/[\0\r\n]/.test(values[0])))throw new AppError('GOOGLE_OAUTH_RESPONSE','The Google authorization response is ambiguous or invalid.')
  return values[0]
 }
 const issuer=field('iss',256)
 if(issuer!==undefined&&issuer!=='https://accounts.google.com')throw new AppError('GOOGLE_OAUTH_ISSUER','Google authorization came from an unexpected issuer.')
 return {state:field('state',512)??'',code:field('code',4096),error:field('error',256)}
}

export function googleDriveRoutes(services:Services,authenticate:(request:Request)=>Promise<Principal>){
 const oauth=new GoogleDriveOAuth(services.db),recovery=new GoogleDriveRecovery(services.db)
 const owner=async(request:Request)=>{
  const principal=await authenticate(request);authorize(principal,'configure')
  if(!['owner','installation'].includes(principal.credentialKind??''))throw new AppError('OWNER_REQUIRED','Sign in as the installation owner to connect or disconnect Google accounts.',403)
  return principal
 }
 const purpose=t.UnionEnum(['account','source','storage','restore','recovery'])
 return new Elysia()
 .get('/api/v1/google-drive/status',async({request})=>{
  const principal=await authenticate(request)
  return {...oauth.status(),ownerAccess:principal.scopes.includes('configure')&&['owner','installation'].includes(principal.credentialKind??'')}
 },{detail:{operationId:'getGoogleDriveStatus'}})
 .get('/api/v1/google-drive/grants',async({request})=>oauth.listGrants((await owner(request)).actor),{detail:{operationId:'listGoogleDriveAuthorizations'}})
 .get('/api/v1/google-drive/accounts',async({request})=>services.googleDriveAccounts(await authenticate(request)),{detail:{operationId:'listConnectedGoogleDriveAccounts',description:'Configure-scoped clients may discover reusable connected Drive authorizations. Never returns OAuth credentials or permits new consent.'}})
 .post('/api/v1/google-drive/oauth/start',async({request,body})=>oauth.start((await owner(request)).actor,body.purpose),{body:t.Object({purpose},{additionalProperties:false}),detail:{operationId:'authorizeGoogleDrive'}})
 .get('/api/v1/google-drive/oauth/callback',async({request})=>{
  const configuration=googleOAuthConfiguration()
  if(!configuration)throw new AppError('GOOGLE_OAUTH_UNCONFIGURED','Google Drive is not configured.',503)
  const origin=new URL(configuration.redirectUri).origin
  try{
   const result=await oauth.completeCallback(googleDriveCallbackInput(request))
   return new Response(null,{status:303,headers:{location:origin+'/connections#google-drive='+encodeURIComponent(result.claimTicket),'cache-control':'no-store','referrer-policy':'no-referrer'}})
  }catch{return new Response(null,{status:303,headers:{location:origin+'/connections#google-drive-error=authorization_failed','cache-control':'no-store','referrer-policy':'no-referrer'}})}
 },{detail:{operationId:'googleDriveOAuthCallback',security:[],description:'Single-use state/PKCE callback with Google issuer validation. Bounded additional Google metadata is ignored; credentials are never returned to the browser.'}})
 .post('/api/v1/google-drive/oauth/claim',async({request,body})=>oauth.claim((await owner(request)).actor,body.ticket),{body:t.Object({ticket:t.String({minLength:1,maxLength:512})},{additionalProperties:false}),detail:{operationId:'claimGoogleDriveAuthorization'}})
 .delete('/api/v1/google-drive/grants/:id',async({request,params})=>oauth.revoke((await owner(request)).actor,params.id),{params:t.Object({id:t.String({format:'uuid'})}),detail:{operationId:'disconnectGoogleDrive'}})
 .get('/api/v1/google-drive/recovery-key',async({request})=>{
  await owner(request)
  return new Response(new Uint8Array(deriveDriveRecoveryKey()),{headers:{'content-type':'application/octet-stream','content-disposition':'attachment; filename="steelkeep-drive-recovery.key"','cache-control':'no-store','referrer-policy':'no-referrer'}})
 },{detail:{operationId:'downloadDriveRecoveryKey',description:'Explicit owner-only export of the dedicated Drive archive recovery key, never the metadata encryption key. Keep separately from archives.'}})
 .get('/api/v1/google-drive/storage/:id/archives',async({request,params,query})=>{
  authorize(await authenticate(request),'read');return recovery.browse(params.id,query.pageToken)
 },{params:t.Object({id:t.String({format:'uuid'})}),query:t.Object({pageToken:t.Optional(t.String({maxLength:4096}))}),detail:{operationId:'browsePortableDriveArchives'}})
 .post('/api/v1/google-drive/archives/import',async({request,body})=>{
  const principal=await authenticate(request);authorize(principal,'configure');authorize(principal,'restore:run')
  return recovery.import(body,principal.actor)
 },{body:t.Object({storageId:t.String({format:'uuid'}),fileId:t.String({minLength:10,maxLength:200}),idempotencyKey:t.String({minLength:16,maxLength:160}),confirmImport:t.Literal(true)},{additionalProperties:false}),detail:{operationId:'importPortableDriveArchive',description:'Adopt an explicitly trusted archive after complete SHA-256 verification. Never writes a restore target; normal target review remains required.'}})
}
