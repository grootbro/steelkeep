import {test,expect} from 'bun:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomBytes,randomUUID} from 'node:crypto'
import {connectDb} from '../server/db'
import {config} from '../server/config'
import {Services} from '../server/services'
import {createApp} from '../server/app'
import {tokenHash} from '../server/auth'

// Never touches the main metadata database or creates an owner there.
const authTest=process.env.STEELKEEP_ACCEPTANCE==='synthetic-local-auth'?test:test.skip
authTest('owner claim, opaque sessions, password revocation and live scoped bearer compatibility',async()=>{
 const target=new URL(config.databaseUrl())
 if(target.hostname!=='127.0.0.1'||target.port!=='54371'||target.pathname!=='/steelkeep_auth_test'||target.username!=='steelkeep')throw new Error('Owner auth acceptance requires the dedicated loopback steelkeep_auth_test metadata database, migrated through version 7.')
 const {db}=connectDb(),app=createApp(new Services(db)),token=config.token(),suffix=randomUUID()
 const directory=await mkdtemp(join(tmpdir(),'steelkeep-auth-test-')),oldFile=process.env.STEELKEEP_SCOPED_TOKENS_FILE
 const password='Synthetic only '+randomBytes(20).toString('hex'),replacement='Replacement only '+randomBytes(20).toString('hex'),spoof=randomBytes(32).toString('hex')
 const email='owner-'+suffix+'@example.test',name='Synthetic owner'
 const request=(path:string,body?:unknown,credential?:{bearer?:string;cookie?:string})=>app.handle(new Request('http://localhost/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(credential?.bearer?{authorization:'Bearer '+credential.bearer}:{}),...(credential?.cookie?{cookie:credential.cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)}))
 const cookie=(response:Response)=>response.headers.get('set-cookie')!.split(';')[0]
 const body=async(response:Response)=>{
  const text=await response.text();expect([password,replacement,token,spoof].some(secret=>text.includes(secret))).toBe(false)
  return JSON.parse(text) as {setupRequired?:boolean;bootstrapAuthorized?:boolean;authenticated?:boolean;user?:{id:string;name:string;email:string};actor?:string;scopes?:string[];id?:string;token?:string;error?:{code:string;message:string}}
 }
 try{
  if(await db.selectFrom('owner_account').select('id').executeTakeFirst())throw new Error('Dedicated auth fixture already has an owner; retain it and explicitly prepare a fresh dedicated database before this test, never reset the main installation.')
  expect((await body(await request('/auth/status'))).setupRequired).toBe(true)
  expect((await body(await request('/auth/status'))).bootstrapAuthorized).toBe(false)
  expect((await request('/auth/setup',{name,email,password})).status).toBe(401)
  const file=join(directory,'scoped.json');await writeFile(file,JSON.stringify([{token:spoof,actor:'installation-owner',scopes:['read','configure']}]),{mode:0o600});process.env.STEELKEEP_SCOPED_TOKENS_FILE=file
  expect((await body(await request('/auth/status',undefined,{bearer:spoof}))).bootstrapAuthorized).toBe(false)
  expect((await request('/auth/setup',{name,email,password},{bearer:spoof})).status).toBe(403)
  expect((await body(await request('/auth/status',undefined,{cookie:'steelkeep_session='+token}))).bootstrapAuthorized).toBe(true)
  const claims=await Promise.all([request('/auth/setup',{name,email,password},{cookie:'steelkeep_session='+token}),request('/auth/setup',{name,email,password},{bearer:token})])
  expect(claims.map(response=>response.status).sort()).toEqual([201,409])
  const claimed=claims.find(response=>response.status===201)!,session=cookie(claimed),owner=await body(claimed)
  expect((await request('/me',undefined,{cookie:'steelkeep_session='+token})).status).toBe(401)
  expect(owner.user?.email).toBe(email);expect(owner.scopes?.includes('agents:manage')).toBe(true)
  const setCookie=claimed.headers.get('set-cookie')!;expect(setCookie.includes('HttpOnly')).toBe(true);expect(/SameSite=Strict/i.test(setCookie)).toBe(true);expect(setCookie.includes('Max-Age=604800')).toBe(true);expect(setCookie.includes(token)).toBe(false)
  expect(/^steelkeep_session=ss_[a-f0-9]{64}$/.test(session)).toBe(true)
  const stored=await db.selectFrom('owner_account').selectAll().executeTakeFirstOrThrow()
  expect(stored.password_hash.startsWith('$argon2id$')).toBe(true);expect(stored.password_hash.includes(password)).toBe(false)
  const storedSession=await db.selectFrom('browser_sessions').selectAll().where('token_hash','=',tokenHash(session.slice('steelkeep_session='.length))).executeTakeFirstOrThrow()
  expect(JSON.stringify(storedSession).includes(session.slice('steelkeep_session='.length))).toBe(false)
  expect((await body(await request('/auth/status',undefined,{cookie:session}))).user?.id).toBe(stored.id)
  const wrong=await request('/auth/login',{email,password:'wrong'}),unknown=await request('/auth/login',{email:'missing-'+suffix+'@example.test',password:'wrong'})
  expect(wrong.status).toBe(401);expect(unknown.status).toBe(401);expect((await body(wrong)).error).toEqual((await body(unknown)).error)
  const login=await request('/auth/login',{email:email.toUpperCase(),password});expect(login.status).toBe(200);const second=cookie(login);await body(login)
  expect((await request('/auth/logout',{}, {cookie:session})).status).toBe(204)
  expect((await request('/me',undefined,{cookie:session})).status).toBe(401)
  expect((await request('/me',undefined,{cookie:second})).status).toBe(200)
  // Legacy token exchange is opaque, scope-limited and bound to the current issuer file.
  const exchanged=await request('/session',{}, {bearer:spoof});expect(exchanged.status).toBe(204);const scoped=cookie(exchanged)
  expect((await request('/agents',undefined,{cookie:scoped})).status).toBe(403)
  await writeFile(file,'[]',{mode:0o600});expect((await request('/me',undefined,{cookie:scoped})).status).toBe(401)
  // Agent bearer and cookie retain live revocation and read-only scopes.
  const agent=await(await request('/agents',{name:'Auth test '+suffix},{bearer:token})).json() as {id:string}
  const issued=await(await request('/agents/'+agent.id+'/tokens',{name:'Auth read',scopes:['read']},{bearer:token})).json() as {id:string;token:string}
  const agentSession=await request('/session',{}, {bearer:issued.token});expect(agentSession.status).toBe(204);const agentCookie=cookie(agentSession)
  expect((await request('/me',undefined,{cookie:agentCookie})).status).toBe(200)
  expect((await request('/agents',undefined,{cookie:agentCookie})).status).toBe(403)
  expect((await request('/agent-tokens/'+issued.id+'/revoke',{}, {bearer:token})).status).toBe(200)
  expect((await request('/me',undefined,{cookie:agentCookie})).status).toBe(401)
  expect((await request('/me',undefined,{bearer:issued.token})).status).toBe(401)
  expect((await request('/auth/password',{currentPassword:'wrong',newPassword:replacement},{cookie:second})).status).toBe(401)
  expect((await request('/auth/password',{currentPassword:password,newPassword:replacement},{cookie:second})).status).toBe(204)
  expect((await request('/me',undefined,{cookie:second})).status).toBe(401)
  expect((await request('/auth/login',{email,password})).status).toBe(401)
  const relogin=await request('/auth/login',{email,password:replacement});expect(relogin.status).toBe(200)
  const current=cookie(relogin);expect((await body(relogin)).user?.email).toBe(email)
  await db.updateTable('browser_sessions').set({expires_at:new Date(0)}).where('token_hash','=',tokenHash(current.slice('steelkeep_session='.length))).execute()
  expect((await request('/me',undefined,{cookie:current})).status).toBe(401)
  expect((await request('/me',undefined,{bearer:token})).status).toBe(200)
 }finally{if(oldFile===undefined)delete process.env.STEELKEEP_SCOPED_TOKENS_FILE;else process.env.STEELKEEP_SCOPED_TOKENS_FILE=oldFile;await rm(directory,{recursive:true,force:true});await db.destroy()}
 // Dedicated fixture owner, sessions, agents and audit history are retained; no cleanup SQL.
},45000)
