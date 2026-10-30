import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {sql,type Kysely} from 'kysely'
import type {Schema} from './db'
import {config} from './config'
import {AppError,tokenMatches} from './security'

export const allScopes=['read','configure','backup:run','restore:run','jobs:cancel','agents:manage'] as const
export type Scope=typeof allScopes[number]
const legacyScopes:readonly Scope[]=allScopes.filter(scope=>scope!=='agents:manage')
export type Principal={actor:string;scopes:readonly Scope[];tokenId?:string;expiresAt?:Date}
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
export async function authenticateRequest(request:Request,db?:Kysely<Schema>):Promise<Principal>{
 const bearer=request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1]
 const cookie=request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith('steelkeep_session='))?.slice('steelkeep_session='.length)
 let cookieToken='';try{cookieToken=decodeURIComponent(cookie??'')}catch{throw new AppError('UNAUTHORIZED','Invalid session credential.',401)}
 const value=bearer??cookieToken,tokens=validateScopedTokens(),owner=config.token()
 if(owner.length<32)throw new Error('Installation token must contain at least 32 characters')
 if(tokenMatches(value,owner))return {actor:'installation-owner',scopes:allScopes}
 for(const token of tokens)if(tokenMatches(value,token.token))return {actor:token.actor,scopes:token.scopes}
 if(db&&value.startsWith('sk_')&&value.length<=128){
  const row=await db.selectFrom('agent_tokens').innerJoin('agents','agents.id','agent_tokens.agent_id').select(['agent_tokens.id','agent_tokens.agent_id','agent_tokens.scopes','agent_tokens.expires_at']).where('token_hash','=',tokenHash(value)).where('agent_tokens.revoked_at','is',null).where('agents.revoked_at','is',null).where('expires_at','>',sql<Date>`now()`).executeTakeFirst()
  if(row){await db.updateTable('agent_tokens').set({last_used_at:sql`now()`}).where('id','=',row.id).execute();return {actor:'agent:'+row.agent_id,scopes:row.scopes,tokenId:row.id,expiresAt:new Date(row.expires_at)}}
 }
 throw new AppError('UNAUTHORIZED','Connect using an active installation or agent token.',401)
}
