import {test,expect,spyOn} from 'bun:test'
import {createHash} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {GoogleDriveOAuth,googleAuthorization,googleDriveScopes,googleGrantSupports,parseGoogleTokens,requestGoogleTokens,validateGoogleOAuthConfiguration} from '../server/google-drive/oauth'
import {googleDriveCallbackInput} from '../server/google-drive/routes'
import {Services} from '../server/services'
import {createApp} from '../server/app'
import {AppError} from '../server/security'
import type {Schema} from '../server/db'
import type {Kysely} from 'kysely'

const configuration={clientId:'synthetic-web-client.apps.googleusercontent.com',clientSecret:'synthetic-client-secret-not-real',redirectUri:'https://backup.example.test/api/v1/google-drive/oauth/callback'}
const tokens=(scope:string)=>({access_token:'synthetic-google-access-token',refresh_token:'synthetic-google-refresh-token',token_type:'Bearer',expires_in:3600,scope})

test('Google OAuth callback is exact, approved-origin and HTTPS bound',()=>{
 expect(validateGoogleOAuthConfiguration(configuration,['https://backup.example.test'])).toEqual(configuration)
 for(const uri of ['https://evil.example.test/api/v1/google-drive/oauth/callback','https://backup.example.test/other','https://backup.example.test/api/v1/google-drive/oauth/callback?return=https://evil.test','https://backup.example.test/api/v1/google-drive/oauth/callback#token','https://name:secret@backup.example.test/api/v1/google-drive/oauth/callback','http://backup.example.test/api/v1/google-drive/oauth/callback'])expect(()=>validateGoogleOAuthConfiguration({...configuration,redirectUri:uri},['https://backup.example.test'])).toThrow()
 const local={...configuration,redirectUri:'http://127.0.0.1:4310/api/v1/google-drive/oauth/callback'}
 expect(validateGoogleOAuthConfiguration(local,['http://127.0.0.1:4310'])).toEqual(local)
 expect(()=>validateGoogleOAuthConfiguration({...configuration,clientSecret:'synthetic\nsecret'},['https://backup.example.test'])).toThrow()
})

test('Google authorization creates independent one-use state and S256 verifier for each minimal purpose',()=>{
 const states=new Set<string>(),verifiers=new Set<string>()
 for(const purpose of ['account','source','restore','storage','recovery'] as const){
  const value=googleAuthorization(configuration,purpose),url=new URL(value.authorizationUrl)
  expect(url.origin+url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
  expect(url.searchParams.get('scope')).toBe(googleDriveScopes[purpose])
  expect(url.searchParams.get('state')).toBe(value.state)
  expect(value.state).toMatch(/^gds_[a-f0-9]{64}$/)
  expect(value.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(value.verifier).digest('base64url'))
  expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  expect(url.searchParams.get('access_type')).toBe('offline')
  expect(url.searchParams.get('include_granted_scopes')).toBe('false')
  expect(value.authorizationUrl).not.toContain(configuration.clientSecret)
  expect(value.authorizationUrl).not.toContain(value.verifier)
  states.add(value.state);verifiers.add(value.verifier)
 }
 expect(states.size).toBe(5);expect(verifiers.size).toBe(5)
})

test('one Google account authorization covers both roles only with both explicitly granted scopes',()=>{
 const scopes=googleDriveScopes.account.split(' '),grant={purpose:'account' as const,status:'active' as const,scopes}
 expect(googleGrantSupports(grant,'source')).toBe(true)
 expect(googleGrantSupports(grant,'storage')).toBe(true)
 expect(googleGrantSupports(grant,'restore')).toBe(true)
 expect(googleGrantSupports(grant,'recovery')).toBe(true)
 expect(googleGrantSupports({...grant,scopes:[googleDriveScopes.source]},'storage')).toBe(false)
 expect(googleGrantSupports({...grant,status:'revoked'},'source')).toBe(false)
 expect(googleGrantSupports({purpose:'source',status:'active',scopes:[googleDriveScopes.source]},'storage')).toBe(false)
 const combined=parseGoogleTokens(tokens([...scopes].reverse().join(' ')),'account')
 expect(new Set(combined.scopes)).toEqual(new Set(scopes))
 const {scope:_,refresh_token:__,...refresh}=tokens(googleDriveScopes.account)
 expect(parseGoogleTokens(refresh,'account','synthetic-old-refresh-token').scopes).toEqual(scopes)
 expect(()=>parseGoogleTokens(tokens(googleDriveScopes.source),'account')).toThrow()
 expect(()=>parseGoogleTokens(tokens(googleDriveScopes.account+' openid'),'account')).toThrow()
})

test('Google callback accepts bounded response metadata and verifies its optional issuer',()=>{
 const request=(query:string)=>new Request(configuration.redirectUri+'?'+query)
 expect(googleDriveCallbackInput(request('state=synthetic-state&code=synthetic-code&iss=https%3A%2F%2Faccounts.google.com&hd=example.test&future_google_metadata=v1'))).toEqual({state:'synthetic-state',code:'synthetic-code',error:undefined})
 expect(googleDriveCallbackInput(request('state=synthetic-state&error=access_denied&error_description=synthetic-denial&error_subtype=access_denied'))).toMatchObject({state:'synthetic-state',error:'access_denied'})
 for(const query of ['state=first&state=second','state=first&iss=https://evil.example.test','state=first&iss=','state=first&code='+ 'a'.repeat(4097),'state=first&metadata='+'a'.repeat(32769)])expect(()=>googleDriveCallbackInput(request(query))).toThrow()
})

test('actual public callback route handles Google iss/hd/error metadata without raw validation JSON',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'steelkeep-google-callback-')),secretPath=join(directory,'client-secret'),keyPath=join(directory,'metadata-key')
 const settings=['STEELKEEP_GOOGLE_CLIENT_ID','STEELKEEP_GOOGLE_CLIENT_SECRET_FILE','STEELKEEP_GOOGLE_REDIRECT_URI','STEELKEEP_ALLOWED_ORIGINS','STEELKEEP_PUBLIC_HOSTS','STEELKEEP_SCOPED_TOKENS_FILE','STEELKEEP_KEY_FILE'] as const
 const previous=Object.fromEntries(settings.map(name=>[name,process.env[name]]))
 const ticket='gdc_'+'a'.repeat(64),calls:Array<{state:string;code?:string;error?:string}>=[]
 const callback=spyOn(GoogleDriveOAuth.prototype,'completeCallback').mockImplementation(async input=>{calls.push(input);if(input.error)throw new AppError('GOOGLE_OAUTH_DENIED','Synthetic denial.');return {claimTicket:ticket,expiresAt:new Date(Date.now()+300000).toISOString()}})
 try{
  await writeFile(secretPath,configuration.clientSecret,{mode:0o600})
  await writeFile(keyPath,Buffer.alloc(32,7),{mode:0o600});process.env.STEELKEEP_KEY_FILE=keyPath
  process.env.STEELKEEP_GOOGLE_CLIENT_ID=configuration.clientId;process.env.STEELKEEP_GOOGLE_CLIENT_SECRET_FILE=secretPath;process.env.STEELKEEP_GOOGLE_REDIRECT_URI=configuration.redirectUri;process.env.STEELKEEP_ALLOWED_ORIGINS='https://backup.example.test';process.env.STEELKEEP_PUBLIC_HOSTS='backup.example.test';delete process.env.STEELKEEP_SCOPED_TOKENS_FILE
  const db=new Proxy({},{get(){throw new Error('The callback route must not query owner sessions.')}}) as Kysely<Schema>
  const app=createApp(new Services(db))
  for(const metadata of ['iss=https%3A%2F%2Faccounts.google.com&scope=synthetic-scope','iss=https%3A%2F%2Faccounts.google.com&hd=example.test&authuser=0&prompt=consent','future_google_metadata=accepted']){
   const response=await app.handle(new Request(configuration.redirectUri+'?state=synthetic-state&code=synthetic-code&'+metadata))
   expect(response.status).toBe(303);expect(await response.text()).toBe('')
   expect(response.headers.get('location')).toBe('https://backup.example.test/connections#google-drive='+ticket)
   expect(response.headers.get('referrer-policy')).toBe('no-referrer');expect(response.headers.get('cache-control')).toBe('no-store')
  }
  expect(calls).toHaveLength(3);expect(calls.every(value=>value.state==='synthetic-state'&&value.code==='synthetic-code')).toBe(true)
  const denied=await app.handle(new Request(configuration.redirectUri+'?state=synthetic-state&error=access_denied&error_description=synthetic-private-text&error_subtype=access_denied&iss=https%3A%2F%2Faccounts.google.com'))
  expect(denied.status).toBe(303);expect(await denied.text()).toBe('');expect(denied.headers.get('location')).toBe('https://backup.example.test/connections#google-drive-error=authorization_failed')
  const count=calls.length
  for(const metadata of ['iss=https%3A%2F%2Fevil.example.test','iss=','state=duplicate','future_metadata='+'a'.repeat(32769)]){
   const response=await app.handle(new Request(configuration.redirectUri+'?state=synthetic-state&code=synthetic-code&'+metadata))
   expect(response.status).toBe(303);expect(await response.text()).toBe('');expect(response.headers.get('location')).toBe('https://backup.example.test/connections#google-drive-error=authorization_failed')
  }
  expect(calls).toHaveLength(count)
 }finally{callback.mockRestore();for(const name of settings){const value=previous[name];if(value===undefined)delete process.env[name];else process.env[name]=value}await rm(directory,{recursive:true,force:true})}
})

test('Google token parser preserves omitted refresh tokens, rotates provided tokens and rejects scope widening',()=>{
 const first=parseGoogleTokens(tokens(googleDriveScopes.source),'source',undefined,1000)
 expect(first.expiresAt).toBe(3601000)
 const {refresh_token:_,scope:__,...refresh}=tokens(googleDriveScopes.source)
 expect(parseGoogleTokens(refresh,'source',first.refreshToken).refreshToken).toBe(first.refreshToken)
 expect(parseGoogleTokens({...refresh,refresh_token:'synthetic-rotated-refresh-token'},'source',first.refreshToken).refreshToken).toBe('synthetic-rotated-refresh-token')
 for(const value of [{...tokens(googleDriveScopes.source),scope:googleDriveScopes.restore},{...tokens(googleDriveScopes.source),scope:googleDriveScopes.source+' https://www.googleapis.com/auth/drive'}, {...tokens(googleDriveScopes.source),scope:undefined}, {...tokens(googleDriveScopes.source),refresh_token:''},{...tokens(googleDriveScopes.source),access_token:'secret\nheader'},{...tokens(googleDriveScopes.source),expires_in:Infinity}])expect(()=>parseGoogleTokens(value,'source')).toThrow()
})

test('Google code exchange uses one fixed POST endpoint, no redirect and private form body',async()=>{
 let calls=0
 const fetch=async(input:Parameters<typeof globalThis.fetch>[0],init?:RequestInit)=>{
  calls++;expect(String(input)).toBe('https://oauth2.googleapis.com/token')
  expect(init?.method).toBe('POST');expect(init?.redirect).toBe('error')
  const form=new URLSearchParams(String(init?.body))
  expect(form.get('code')).toBe('synthetic-code')
  expect(form.get('client_secret')).toBe(configuration.clientSecret)
  expect(form.get('code_verifier')).toBe('synthetic-verifier')
  expect(init?.headers).not.toHaveProperty('Authorization')
  return Response.json(tokens(googleDriveScopes.source))
 }
 const result=await requestGoogleTokens(configuration,'source',{grant_type:'authorization_code',code:'synthetic-code',code_verifier:'synthetic-verifier',redirect_uri:configuration.redirectUri},{fetch})
 expect(result.refreshToken).toBe('synthetic-google-refresh-token');expect(calls).toBe(1)
})

test('Google provider errors and redirects never expose returned tokens or error descriptions',async()=>{
 for(const response of [Response.json({error:'invalid_grant',error_description:'do-not-leak-private-token'},{status:400}),Response.json({error:'permission_denied',error_description:'do-not-leak-private-token'},{status:403}),new Response('do-not-leak-private-token',{status:302,headers:{location:'https://evil.example.test/'}}),new Response('x'.repeat(65537))]){
  const fetch=async()=>response
  try{await requestGoogleTokens(configuration,'source',{grant_type:'refresh_token',refresh_token:'synthetic-previous-token'},{fetch,previousRefreshToken:'synthetic-previous-token'});throw new Error('expected refusal')}
  catch(error){expect(error).toBeInstanceOf(AppError);expect(String(error)).not.toContain('do-not-leak-private-token')}
 }
 const fetch=async()=>Response.json({error:'invalid_grant'},{status:400})
 await expect(requestGoogleTokens(configuration,'source',{grant_type:'refresh_token',refresh_token:'synthetic-previous-token'},{fetch,previousRefreshToken:'synthetic-previous-token'})).rejects.toMatchObject({code:'GOOGLE_RECONNECT_REQUIRED'})
})

test('invalid callback state and claim tickets fail before database or Google access',async()=>{
 const db=new Proxy({},{get(){throw new Error('Database must not be reached')}}) as Kysely<Schema>
 const oauth=new GoogleDriveOAuth(db,{configuration:()=>configuration})
 for(const state of ['', 'gds_short','https://evil.example.test/','gds_'+'a'.repeat(65)])await expect(oauth.completeCallback({state,code:'synthetic-code'})).rejects.toMatchObject({code:'GOOGLE_OAUTH_STATE'})
 for(const ticket of ['', 'gdc_short','gdc_'+'a'.repeat(65)])await expect(oauth.claim('synthetic-owner',ticket)).rejects.toMatchObject({code:'GOOGLE_OAUTH_STATE'})
 expect(new GoogleDriveOAuth(db,{configuration:()=>null}).status().configured).toBe(false)
})
