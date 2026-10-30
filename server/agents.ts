import {randomUUID,randomBytes} from 'node:crypto'
import {sql,type Kysely} from 'kysely'
import type {Schema} from './db'
import {authorize,allScopes,tokenHash,type Principal,type Scope} from './auth'
import {AppError} from './security'

export async function audit(db:Kysely<Schema>,actor:string,action:string,subjectId:string|null){await db.insertInto('audit_events').values({actor,action,subject_id:subjectId}).execute()}
export class AgentServices {
 constructor(private db:Kysely<Schema>){}
 async list(principal:Principal){authorize(principal,'agents:manage');return this.db.selectFrom('agents').selectAll().orderBy('created_at','desc').limit(100).execute()}
 async create(principal:Principal,input:{name:string;description?:string}){
  authorize(principal,'agents:manage');if(!input.name.trim()||input.name.length>80||(input.description?.length??0)>500)throw new AppError('INVALID_AGENT','Enter an agent name and a short description.')
  const id=randomUUID()
  return this.db.transaction().execute(async trx=>{const agent=await trx.insertInto('agents').values({id,name:input.name.trim(),description:input.description??'',revoked_at:null}).returningAll().executeTakeFirstOrThrow();await audit(trx,principal.actor,'agent.created',id);return agent})
 }
 async tokens(principal:Principal,agentId:string){authorize(principal,'agents:manage');return this.db.selectFrom('agent_tokens').select(['id','agent_id','name','scopes','expires_at','created_at','revoked_at','last_used_at','issuer_actor']).where('agent_id','=',agentId).orderBy('created_at','desc').limit(100).execute()}
 async issue(principal:Principal,agentId:string,input:{name:string;scopes?:Scope[];expiresInHours?:number}){
  authorize(principal,'agents:manage')
  const scopes=[...new Set(input.scopes??['read'])] as Scope[],hours=input.expiresInHours??24
  if(!input.name.trim()||input.name.length>80||!scopes.length||scopes.some(s=>!allScopes.includes(s)||!principal.scopes.includes(s))||!Number.isInteger(hours)||hours<1||hours>720)throw new AppError('INVALID_TOKEN_GRANT','Grant only scopes you hold and a lifetime from 1 to 720 hours.')
  const token='sk_'+randomBytes(32).toString('base64url'),id=randomUUID()
  return this.db.transaction().execute(async trx=>{
   // Separate two-integer advisory namespace serializes grants and cascading revocations.
   await sql`SELECT pg_advisory_xact_lock(4356542,5)`.execute(trx)
   const agent=await trx.selectFrom('agents').selectAll().where('id','=',agentId).forUpdate().executeTakeFirst()
   if(!agent||agent.revoked_at)throw new AppError('NOT_FOUND','Active agent not found.',404)
   if(principal.tokenId){const issuer=await trx.selectFrom('agent_tokens').select('id').where('id','=',principal.tokenId).where('revoked_at','is',null).where('expires_at','>',sql<Date>`now()`).forUpdate().executeTakeFirst();if(!issuer)throw new AppError('UNAUTHORIZED','The issuing token is no longer active.',401)}
   const clock=await sql<{now:Date}>`SELECT now() AS now`.execute(trx),expiresAt=new Date(Math.min(clock.rows[0].now.getTime()+hours*3600000,principal.expiresAt?.getTime()??Infinity))
   if(expiresAt<=clock.rows[0].now)throw new AppError('UNAUTHORIZED','The issuing token has expired.',401)
   await trx.insertInto('agent_tokens').values({id,agent_id:agentId,name:input.name.trim(),token_hash:tokenHash(token),scopes:sql<Scope[]>`${JSON.stringify(scopes)}::jsonb`,expires_at:expiresAt,revoked_at:null,last_used_at:null,issuer_actor:principal.actor,parent_token_id:principal.tokenId??null}).execute()
   await audit(trx,principal.actor,'agent.token.issued',id)
   return {id,agentId,name:input.name.trim(),scopes,expiresAt:expiresAt.toISOString(),token,notice:'Copy this token now. Only its hash is stored; it will not be returned again.'}
  })
 }
 async revokeToken(principal:Principal,id:string){
  authorize(principal,'agents:manage')
  return this.db.transaction().execute(async trx=>{await sql`SELECT pg_advisory_xact_lock(4356542,5)`.execute(trx);const token=await trx.updateTable('agent_tokens').set({revoked_at:sql`now()`}).where('id','=',id).where('revoked_at','is',null).returning('id').executeTakeFirst();if(!token)throw new AppError('NOT_FOUND','Active token not found.',404);await sql`WITH RECURSIVE descendants AS (SELECT id FROM agent_tokens WHERE id=${id}::uuid UNION SELECT t.id FROM agent_tokens t JOIN descendants d ON t.parent_token_id=d.id) UPDATE agent_tokens SET revoked_at=now() WHERE id IN(SELECT id FROM descendants)`.execute(trx);await audit(trx,principal.actor,'agent.token.revoked',id);return {id,revoked:true}})
 }
 async revokeAgent(principal:Principal,id:string){
  authorize(principal,'agents:manage')
  return this.db.transaction().execute(async trx=>{await sql`SELECT pg_advisory_xact_lock(4356542,5)`.execute(trx);const agent=await trx.updateTable('agents').set({revoked_at:sql`now()`}).where('id','=',id).where('revoked_at','is',null).returning('id').executeTakeFirst();if(!agent)throw new AppError('NOT_FOUND','Active agent not found.',404);await trx.updateTable('agent_tokens').set({revoked_at:sql`now()`}).where('agent_id','=',id).where('revoked_at','is',null).execute();await sql`WITH RECURSIVE descendants AS (SELECT id FROM agent_tokens WHERE agent_id=${id}::uuid UNION SELECT t.id FROM agent_tokens t JOIN descendants d ON t.parent_token_id=d.id) UPDATE agent_tokens SET revoked_at=now() WHERE id IN(SELECT id FROM descendants)`.execute(trx);await audit(trx,principal.actor,'agent.revoked',id);return {id,revoked:true}})
 }
 async history(principal:Principal){authorize(principal,'agents:manage');return this.db.selectFrom('audit_events').selectAll().orderBy('id','desc').limit(200).execute()}
}
