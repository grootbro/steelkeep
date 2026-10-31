import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {sql,type Kysely} from 'kysely'
import type {Schema} from './db'
import {config} from './config'
import {AppError,tokenMatches} from './security'

export const allScopes=['read','configure','backup:run','restore:run','jobs:cancel','agents:manage'] as const
export type Scope=typeof allScopes[number]
const legacyScopes:readonly Scope[]=allScopes.filter(scope=>scope!=='agents:manage')
export type Principal={actor:string;scopes:readonly Scope[];tokenId?:string;expiresAt?:Date;credentialKind?:"installation"|"legacy"|"agent"|"owner";credentialHash?:string;sessionId?:string;ownerId?:string;authVersion?:number}
export function authorize(principal:Principal,scope:Scope){if(!principal.scopes.includes(scope))throw new AppError('FORBIDDEN','This token is not permitted to perform this operation.',403)}
export const tokenHash=(token:string)=>createHash('sha256').update(token).digest('hex')
export function validateScopedTokens():Array<{token:string;actor:string;scopes:Scope[]}>{
 const file=process.env.STEELKEEP_SCOPED_TOKENS_FILE
 if(!file)return []
 let tokens:unknown
 try{tokens=JSON.parse(readFileSync(file,'utf8'))}catch{throw new Error('Invalid scoped token configuration')}
 if(!Array.isArray(tokens)||tokens.some(t=>!t||typeof t.token!=='string'||t.token.length<32||typeof t.actor!=='string'||!t.actor||!Array.isArray(t.scopes)||t.scopes.some((s:unknown)=>!legacyScopes.includes(s as Scope))))throw new Error('Invalid scoped token configuration')
 if(new Set(tokens.map(t=>t.token)).size!==tokens.length)throw new Error('Duplicate scoped token configuration')
 return tokens
}
export function requestCredentials(request:Request){
 const bearer=request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1]
 const raw=request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith('steelkeep_session='))?.slice('steelkeep_session='.length)
 let cookie='';try{cookie=decodeURIComponent(raw??'')}catch{throw new AppError('UNAUTHORIZED','Invalid session credential.',401)}
 return {bearer,cookie}
}
export async function authenticateRequest(request:Request,db?:Kysely<Schema>):Promise<Principal>{
 const {bearer,cookie}=requestCredentials(request),value=bearer??cookie,tokens=validateScopedTokens(),owner=config.token()
 if(owner.length<32)throw new Error('Installation token must contain at least 32 characters')
 // Old bearer cookies may bootstrap an unclaimed install, never bypass owner-session revocation.
 if(db&&!bearer&&cookie&&!/^ss_[a-f0-9]{64}$/.test(cookie)&&await db.selectFrom('owner_account').select('id').executeTakeFirst())throw new AppError('UNAUTHORIZED','Sign in with your owner account.',401)
 if(tokenMatches(value,owner))return {actor:'installation-owner',scopes:allScopes,credentialKind:'installation',credentialHash:tokenHash(owner)}
 for(const token of tokens)if(tokenMatches(value,token.token))return {actor:token.actor,scopes:token.scopes,credentialKind:'legacy',credentialHash:tokenHash(token.token)}
 if(db&&value.startsWith('sk_')&&value.length<=128){
  const row=await db.selectFrom('agent_tokens').innerJoin('agents','agents.id','agent_tokens.agent_id').select(['agent_tokens.id','agent_tokens.agent_id','agent_tokens.scopes','agent_tokens.expires_at']).where('token_hash','=',tokenHash(value)).where('agent_tokens.revoked_at','is',null).where('agents.revoked_at','is',null).where('expires_at','>',sql<Date>`now()`).executeTakeFirst()
  if(row){await db.updateTable('agent_tokens').set({last_used_at:sql`now()`}).where('id','=',row.id).execute();return {actor:'agent:'+row.agent_id,scopes:row.scopes,tokenId:row.id,expiresAt:new Date(row.expires_at),credentialKind:'agent',credentialHash:tokenHash(value)}}
 }
 if(db&&!bearer&&/^ss_[a-f0-9]{64}$/.test(value)){
  const session=await db.selectFrom('browser_sessions').selectAll().where('token_hash','=',tokenHash(value)).where('revoked_at','is',null).where('expires_at','>',sql<Date>`now()`).executeTakeFirst()
  if(session){
   const principal:Principal={actor:session.actor,scopes:session.scopes,sessionId:session.id,expiresAt:new Date(session.expires_at),credentialKind:session.issuer_kind,credentialHash:session.issuer_hash??undefined}
   if(session.issuer_kind==='owner'){
    const account=await db.selectFrom('owner_account').select(['id','auth_version']).where('id','=',session.owner_id!).executeTakeFirst()
    if(account&&account.auth_version===session.auth_version)return {...principal,ownerId:account.id,authVersion:account.auth_version}
   }else if(session.issuer_kind==='installation'&&session.issuer_hash===tokenHash(owner))return {...principal,scopes:session.scopes.filter(scope=>allScopes.includes(scope))}
   else if(session.issuer_kind==='legacy'){
    const issuer=tokens.find(token=>tokenHash(token.token)===session.issuer_hash&&token.actor===session.actor)
    if(issuer)return {...principal,scopes:session.scopes.filter(scope=>issuer.scopes.includes(scope))}
   }else if(session.issuer_kind==='agent'){
    const issuer=await db.selectFrom('agent_tokens').innerJoin('agents','agents.id','agent_tokens.agent_id').select(['agent_tokens.id','agent_tokens.scopes','agent_tokens.expires_at']).where('agent_tokens.id','=',session.agent_token_id!).where('agent_tokens.revoked_at','is',null).where('agents.revoked_at','is',null).where('expires_at','>',sql<Date>`now()`).executeTakeFirst()
    if(issuer)return {...principal,tokenId:issuer.id,scopes:session.scopes.filter(scope=>issuer.scopes.includes(scope)),expiresAt:new Date(Math.min(new Date(session.expires_at).getTime(),new Date(issuer.expires_at).getTime()))}
   }
  }
 }
 throw new AppError('UNAUTHORIZED','Sign in or connect using an active API token.',401)
}
