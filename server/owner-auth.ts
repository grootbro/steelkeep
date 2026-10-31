import {randomBytes,randomUUID} from 'node:crypto'
import {sql,type Kysely} from 'kysely'
import type {Schema} from './db'
import {allScopes,authenticateRequest,requestCredentials,tokenHash,type Principal,type Scope} from './auth'
import {AppError} from './security'
import {audit} from './agents'

export async function migrateOwnerAuth(db:Kysely<Schema>){
 await sql`CREATE TABLE owner_account(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),id uuid UNIQUE NOT NULL,name text NOT NULL,email text UNIQUE NOT NULL,password_hash text NOT NULL,auth_version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`.execute(db)
 await sql`CREATE TABLE browser_sessions(id uuid PRIMARY KEY,token_hash text UNIQUE NOT NULL,owner_id uuid REFERENCES owner_account(id),auth_version integer,issuer_kind text NOT NULL CHECK(issuer_kind IN ('owner','installation','legacy','agent')),issuer_hash text,agent_token_id uuid REFERENCES agent_tokens(id),actor text NOT NULL,scopes jsonb NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now())`.execute(db)
 await sql`CREATE INDEX browser_sessions_owner_idx ON browser_sessions(owner_id)`.execute(db)
}
type User={id:string;name:string;email:string}
const publicUser=(row:User):User=>({id:row.id,name:row.name,email:row.email})
export function normalizeOwnerEmail(value:string){
 if(typeof value!=='string'||value.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim()))throw new AppError('INVALID_INPUT','Enter a valid email address.',422)
 return value.trim().toLowerCase()
}
export function validateOwnerPassword(value:string){if(typeof value!=='string'||value.length<12||value.length>128)throw new AppError('INVALID_INPUT','Use a password between 12 and 128 characters.',422)}
const invalid=()=>new AppError('INVALID_CREDENTIALS','Email or password is incorrect.',401)
const limited=()=>new AppError('AUTH_RATE_LIMITED','Too many sign-in attempts. Wait a minute and try again.',429)
const windows=new Map<string,{count:number;until:number}>()
let hashSlots=0,dummyHash:Promise<string>|undefined
function throttle(email:string){
 const now=Date.now()
 for(const [key,value]of windows)if(value.until<=now)windows.delete(key)
 for(const [key,max]of [['global',30],[tokenHash(email),8]] as const){
  const window=windows.get(key)??{count:0,until:now+60000}
  if(window.count>=max||windows.size>1024)throw limited()
  window.count++;windows.set(key,window)
 }
}
async function passwordWork<T>(work:()=>Promise<T>){if(hashSlots>=2)throw limited();hashSlots++;try{return await work()}finally{hashSlots--}}
const hashPassword=(value:string)=>Bun.password.hash(value,{algorithm:'argon2id',memoryCost:65536,timeCost:2})

export class OwnerAuth {
 constructor(readonly db:Kysely<Schema>){}
 async status(request:Request){
  const owner=await this.db.selectFrom('owner_account').select(['id','name','email']).executeTakeFirst()
  let principal:Principal|undefined
  try{principal=await authenticateRequest(request,this.db)}catch(error){if(!(error instanceof AppError&&error.status===401))throw error}
  return {setupRequired:!owner,authenticated:!!principal,user:owner&&principal?.ownerId===owner.id?publicUser(owner):null,bootstrapAuthorized:principal?.credentialKind==='installation'}
 }
 private async mint(db:Kysely<Schema>,principal:Principal,user:User|null){
  if(!principal.credentialKind)throw new AppError('UNAUTHORIZED','An active credential is required.',401)
  const token='ss_'+randomBytes(32).toString('hex'),expiresAt=new Date(Math.min(Date.now()+7*86400000,principal.expiresAt?.getTime()??Infinity))
  await db.insertInto('browser_sessions').values({id:randomUUID(),token_hash:tokenHash(token),owner_id:principal.ownerId??null,auth_version:principal.authVersion??null,issuer_kind:principal.credentialKind,issuer_hash:principal.credentialHash??null,agent_token_id:principal.tokenId??null,actor:principal.actor,scopes:sql<Scope[]>`${JSON.stringify([...principal.scopes])}::jsonb`,expires_at:expiresAt,revoked_at:null}).execute()
  return {token,response:{user,actor:principal.actor,scopes:[...principal.scopes],expiresAt:expiresAt.toISOString()}}
 }
 async exchange(principal:Principal){return this.mint(this.db,principal,null)}
 async setup(request:Request,input:{name:string;email:string;password:string}){
  const principal=await authenticateRequest(request,this.db)
  if(principal.credentialKind!=='installation')throw new AppError('BOOTSTRAP_REQUIRED','Use the local installation setup key to claim this installation.',403)
  const email=normalizeOwnerEmail(input.email);validateOwnerPassword(input.password)
  if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>80)throw new AppError('INVALID_INPUT','Enter a name between 1 and 80 characters.',422)
  throttle(email)
  const passwordHash=await passwordWork(()=>hashPassword(input.password))
  return this.db.transaction().execute(async trx=>{
   await sql`SELECT pg_advisory_xact_lock(4356542,7)`.execute(trx)
   if(await trx.selectFrom('owner_account').select('id').executeTakeFirst())throw new AppError('SETUP_COMPLETE','This installation already has an owner. Sign in with email and password.',409)
   const owner=await trx.insertInto('owner_account').values({singleton:true,id:randomUUID(),name:input.name.trim(),email,password_hash:passwordHash,auth_version:1}).returningAll().executeTakeFirstOrThrow()
   const session=await this.mint(trx,{actor:'installation-owner',scopes:allScopes,credentialKind:'owner',ownerId:owner.id,authVersion:owner.auth_version},publicUser(owner))
   await audit(trx,'installation-owner','owner.created',owner.id);return session
  })
 }
 async login(input:{email:string;password:string}){
  const email=normalizeOwnerEmail(input.email)
  if(typeof input.password!=='string'||input.password.length>128)throw invalid()
  throttle(email)
  const owner=await this.db.selectFrom('owner_account').selectAll().where('email','=',email).executeTakeFirst()
  const valid=await passwordWork(async()=>{const hash=owner?.password_hash??await(dummyHash??=hashPassword(randomBytes(32).toString('hex')));return Bun.password.verify(input.password,hash)})
  if(!owner||!valid)throw invalid()
  return this.db.transaction().execute(async trx=>{
   const current=await trx.selectFrom('owner_account').selectAll().where('id','=',owner.id).forUpdate().executeTakeFirstOrThrow()
   if(current.password_hash!==owner.password_hash)throw invalid()
   const session=await this.mint(trx,{actor:'installation-owner',scopes:allScopes,credentialKind:'owner',ownerId:owner.id,authVersion:current.auth_version},publicUser(current))
   await audit(trx,'installation-owner','owner.signed_in',owner.id);return session
  })
 }
 async logout(request:Request){
  const {cookie}=requestCredentials(request)
  if(/^ss_[a-f0-9]{64}$/.test(cookie))await this.db.transaction().execute(async trx=>{
   const session=await trx.updateTable('browser_sessions').set({revoked_at:sql`now()`}).where('token_hash','=',tokenHash(cookie)).where('revoked_at','is',null).returning(['id','actor']).executeTakeFirst()
   if(session)await audit(trx,session.actor,'session.signed_out',session.id)
  })
 }
 async changePassword(principal:Principal,input:{currentPassword:string;newPassword:string}){
  if(principal.credentialKind!=='owner'||!principal.ownerId)throw new AppError('UNAUTHORIZED','Sign in with your owner account to change the password.',401)
  validateOwnerPassword(input.newPassword)
  if(typeof input.currentPassword!=='string'||input.currentPassword.length>128)throw invalid()
  throttle(principal.ownerId)
  const owner=await this.db.selectFrom('owner_account').selectAll().where('id','=',principal.ownerId).executeTakeFirstOrThrow()
  const passwordHash=await passwordWork(async()=>{if(!await Bun.password.verify(input.currentPassword,owner.password_hash))throw invalid();return hashPassword(input.newPassword)})
  await this.db.transaction().execute(async trx=>{
   const current=await trx.selectFrom('owner_account').selectAll().where('id','=',owner.id).forUpdate().executeTakeFirstOrThrow()
   if(current.auth_version!==principal.authVersion||current.password_hash!==owner.password_hash)throw invalid()
   await trx.updateTable('owner_account').set({password_hash:passwordHash,auth_version:current.auth_version+1,updated_at:sql`now()`}).where('id','=',owner.id).execute()
   await trx.updateTable('browser_sessions').set({revoked_at:sql`now()`}).where(eb=>eb.or([eb('owner_id','=',owner.id),eb('issuer_kind','=','installation')])).where('revoked_at','is',null).execute()
   await audit(trx,'installation-owner','owner.password_changed',owner.id)
  })
 }
}
