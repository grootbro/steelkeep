import {test,expect} from 'bun:test'
import {createHash} from 'node:crypto'
import {GoogleDriveOAuth,googleAuthorization,googleDriveScopes,parseGoogleTokens,requestGoogleTokens,validateGoogleOAuthConfiguration} from '../server/google-drive/oauth'
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
 for(const purpose of ['source','restore','storage','recovery'] as const){
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
 expect(states.size).toBe(4);expect(verifiers.size).toBe(4)
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
 const result=await requestGoogleTokens(configuration,'source',{grant_type:'authorization_code',code:'synthetic-code',code_verifier:'synthetic-verifier',redirect_uri:configuration.redirectUri},{fetch:fetch as typeof globalThis.fetch})
 expect(result.refreshToken).toBe('synthetic-google-refresh-token');expect(calls).toBe(1)
})

test('Google provider errors and redirects never expose returned tokens or error descriptions',async()=>{
 for(const response of [Response.json({error:'invalid_grant',error_description:'do-not-leak-private-token'},{status:400}),Response.json({error:'permission_denied',error_description:'do-not-leak-private-token'},{status:403}),new Response('do-not-leak-private-token',{status:302,headers:{location:'https://evil.example.test/'}}),new Response('x'.repeat(65537))]){
  const fetch=async()=>response
  try{await requestGoogleTokens(configuration,'source',{grant_type:'refresh_token',refresh_token:'synthetic-previous-token'},{fetch:fetch as typeof globalThis.fetch,previousRefreshToken:'synthetic-previous-token'});throw new Error('expected refusal')}
  catch(error){expect(error).toBeInstanceOf(AppError);expect(String(error)).not.toContain('do-not-leak-private-token')}
 }
 const fetch=async()=>Response.json({error:'invalid_grant'},{status:400})
 await expect(requestGoogleTokens(configuration,'source',{grant_type:'refresh_token',refresh_token:'synthetic-previous-token'},{fetch:fetch as typeof globalThis.fetch,previousRefreshToken:'synthetic-previous-token'})).rejects.toMatchObject({code:'GOOGLE_RECONNECT_REQUIRED'})
})

test('invalid callback state and claim tickets fail before database or Google access',async()=>{
 const db=new Proxy({},{get(){throw new Error('Database must not be reached')}}) as Kysely<Schema>
 const oauth=new GoogleDriveOAuth(db,{configuration:()=>configuration})
 for(const state of ['', 'gds_short','https://evil.example.test/','gds_'+'a'.repeat(65)])await expect(oauth.completeCallback({state,code:'synthetic-code'})).rejects.toMatchObject({code:'GOOGLE_OAUTH_STATE'})
 for(const ticket of ['', 'gdc_short','gdc_'+'a'.repeat(65)])await expect(oauth.claim('synthetic-owner',ticket)).rejects.toMatchObject({code:'GOOGLE_OAUTH_STATE'})
 expect(new GoogleDriveOAuth(db,{configuration:()=>null}).status().configured).toBe(false)
})
