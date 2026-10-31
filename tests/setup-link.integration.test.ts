import {test,expect} from 'bun:test'
import {randomBytes,randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {connectDb} from '../server/db'
import {config} from '../server/config'
import {Services} from '../server/services'
import {createApp} from '../server/app'
import {tokenHash} from '../server/auth'

const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-setup-link'?test:test.skip
acceptance('setup links are installation-issued, hash-only, short-lived, single-use and grant only owner setup',async()=>{
 const target=new URL(config.databaseUrl())
 if(target.hostname!=='127.0.0.1'||target.port!=='54371'||target.pathname!=='/steelkeep_setup_link_test'||target.username!=='steelkeep')throw new Error('Use only dedicated loopback steelkeep_setup_link_test metadata.')
 const {db}=connectDb(),directory=await mkdtemp(join(tmpdir(),'steelkeep-setup-link-')),oldTokenFile=process.env.STEELKEEP_TOKEN_FILE,oldScopedFile=process.env.STEELKEEP_SCOPED_TOKENS_FILE
 let installationKey=randomBytes(32).toString('hex')
 const spoof=randomBytes(32).toString('hex'),tokenFile=join(directory,'token'),scopedFile=join(directory,'scoped.json'),password='Synthetic link owner '+randomBytes(20).toString('hex')
 const input={name:'Synthetic setup link owner',email:'setup-link-'+randomUUID()+'@example.test',password}
 try{
  for(const table of ['owner_account','browser_sessions','connections','runs','artifacts'] as const){if(await db.selectFrom(table).selectAll().executeTakeFirst())throw new Error('The dedicated setup-link fixture must be empty.')}
  await writeFile(tokenFile,installationKey,{mode:0o600});await writeFile(scopedFile,JSON.stringify([{token:spoof,actor:'installation-owner',scopes:['read','configure']}]),{mode:0o600})
  process.env.STEELKEEP_TOKEN_FILE=tokenFile;process.env.STEELKEEP_SCOPED_TOKENS_FILE=scopedFile
  const app=createApp(new Services(db))
  const request=(path:string,body?:unknown,credential?:{bearer?:string;cookie?:string})=>app.handle(new Request('http://localhost/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(credential?.bearer?{authorization:'Bearer '+credential.bearer}:{}),...(credential?.cookie?{cookie:credential.cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)}))
  const cookie=(response:Response)=>response.headers.get('set-cookie')!.split(';')[0]
  async function issue(){
   const response=await request('/auth/setup-link',{}, {bearer:installationKey});expect(response.status).toBe(201)
   expect(response.headers.get('set-cookie')).toBeNull();expect(response.headers.get('cache-control')).toBe('no-store')
   const body=await response.json() as {code:string;expiresAt:string}
   expect(/^ss_[a-f0-9]{64}$/.test(body.code)).toBe(true);expect(body.code.includes(installationKey)).toBe(false)
   expect(Date.parse(body.expiresAt)-Date.now()).toBeGreaterThan(290000);expect(Date.parse(body.expiresAt)-Date.now()).toBeLessThanOrEqual(300000)
   return body
  }
  expect((await request('/auth/setup-link',{})).status).toBe(401)
  expect((await request('/auth/setup-link',{}, {cookie:'steelkeep_session='+installationKey})).status).toBe(403)
  expect((await request('/auth/setup-link',{}, {bearer:spoof})).status).toBe(403)
  const exchange=await request('/session',{}, {bearer:installationKey});expect(exchange.status).toBe(204)
  expect((await request('/auth/setup-link',{}, {cookie:cookie(exchange)})).status).toBe(403)
  const agent=await(await request('/agents',{name:'Synthetic setup link denial'},{bearer:installationKey})).json() as {id:string}
  const issuedAgent=await(await request('/agents/'+agent.id+'/tokens',{name:'Synthetic setup link denial',scopes:['read','configure','agents:manage']},{bearer:installationKey})).json() as {token:string}
  expect((await request('/auth/setup-link',{}, {bearer:issuedAgent.token})).status).toBe(403)
  const first=await issue(),rawCookie='steelkeep_session='+first.code
  const stored=await db.selectFrom('browser_sessions').selectAll().where('token_hash','=',tokenHash(first.code)).executeTakeFirstOrThrow()
  expect(JSON.stringify(stored).includes(first.code)).toBe(false);expect(stored.scopes).toEqual([]);expect(stored.issuer_kind).toBe('installation')
  const rawStatus=await(await request('/auth/status',undefined,{cookie:rawCookie})).json() as {authenticated:boolean;bootstrapAuthorized:boolean}
  expect(rawStatus.authenticated).toBe(false);expect(rawStatus.bootstrapAuthorized).toBe(false)
  expect((await request('/auth/setup',input,{cookie:rawCookie})).status).toBe(403)
  expect((await request('/me',undefined,{cookie:rawCookie})).status).toBe(403)
  const claims=await Promise.all([request('/auth/setup-link/claim',{code:first.code}),request('/auth/setup-link/claim',{code:first.code})])
  expect(claims.map(response=>response.status).sort()).toEqual([200,401])
  const claimed=claims.find(response=>response.status===200)!,setupCookie=cookie(claimed),claimBody=await claimed.json() as {expiresAt:string}
  expect(Object.keys(claimBody)).toEqual(['expiresAt']);expect(setupCookie.includes(first.code)).toBe(false);expect(setupCookie.includes(installationKey)).toBe(false)
  expect(claimed.headers.get('set-cookie')!.includes('HttpOnly')).toBe(true);expect(/SameSite=Strict/i.test(claimed.headers.get('set-cookie')!)).toBe(true);expect(claimed.headers.get('set-cookie')!.includes('Max-Age=300')).toBe(true)
  expect((await db.selectFrom('browser_sessions').select('revoked_at').where('id','=',stored.id).executeTakeFirstOrThrow()).revoked_at).not.toBeNull()
  const setupStatus=await(await request('/auth/status',undefined,{cookie:setupCookie})).json() as {setupRequired:boolean;bootstrapAuthorized:boolean}
  expect(setupStatus.setupRequired).toBe(true);expect(setupStatus.bootstrapAuthorized).toBe(true)
  expect((await request('/me',undefined,{cookie:setupCookie})).status).toBe(403)
  expect((await request('/connections',undefined,{cookie:setupCookie})).status).toBe(403)
  expect((await request('/auth/setup-link',{}, {cookie:setupCookie})).status).toBe(403)
  const replay=await request('/auth/setup-link/claim',{code:first.code});expect(replay.status).toBe(401);const refusal=await replay.json()
  for(const code of ['invalid','ss_'+randomBytes(32).toString('hex')]){const response=await request('/auth/setup-link/claim',{code});expect(response.status).toBe(401);expect(await response.json()).toEqual(refusal);expect(response.headers.get('set-cookie')).toBeNull()}
  const expired=await issue();await db.updateTable('browser_sessions').set({expires_at:new Date(0)}).where('token_hash','=',tokenHash(expired.code)).execute()
  const expiredResponse=await request('/auth/setup-link/claim',{code:expired.code});expect(expiredResponse.status).toBe(401);expect(await expiredResponse.json()).toEqual(refusal)
  const rotated=await issue();installationKey=randomBytes(32).toString('hex');await writeFile(tokenFile,installationKey,{mode:0o600})
  const rotatedResponse=await request('/auth/setup-link/claim',{code:rotated.code});expect(rotatedResponse.status).toBe(401);expect(await rotatedResponse.json()).toEqual(refusal)
  expect((await request('/auth/status',undefined,{cookie:setupCookie})).status).toBe(200)
  const current=await issue(),redeemed=await request('/auth/setup-link/claim',{code:current.code});expect(redeemed.status).toBe(200)
  const ownerSetupCookie=cookie(redeemed),pending=await issue()
  const created=await request('/auth/setup',input,{cookie:ownerSetupCookie});expect(created.status).toBe(201)
  expect((await request('/me',undefined,{cookie:cookie(created)})).status).toBe(200)
  expect((await request('/auth/setup-link',{}, {bearer:installationKey})).status).toBe(409)
  const completed=await request('/auth/setup-link/claim',{code:pending.code});expect(completed.status).toBe(401);expect(await completed.json()).toEqual(refusal)
  const staleStatus=await(await request('/auth/status',undefined,{cookie:ownerSetupCookie})).json() as {authenticated:boolean;bootstrapAuthorized:boolean;setupRequired:boolean}
  expect(staleStatus).toMatchObject({authenticated:false,bootstrapAuthorized:false,setupRequired:false})
  expect(await db.selectFrom('owner_account').select('id').execute()).toHaveLength(1)
  const audit=JSON.stringify(await db.selectFrom('audit_events').selectAll().execute())
  expect([installationKey,first.code,current.code,pending.code,password].some(secret=>audit.includes(secret))).toBe(false)
 }finally{
  if(oldTokenFile===undefined)delete process.env.STEELKEEP_TOKEN_FILE;else process.env.STEELKEEP_TOKEN_FILE=oldTokenFile
  if(oldScopedFile===undefined)delete process.env.STEELKEEP_SCOPED_TOKENS_FILE;else process.env.STEELKEEP_SCOPED_TOKENS_FILE=oldScopedFile
  await db.destroy();await rm(directory,{recursive:true,force:true})
 }
 // This dedicated fixture retains its synthetic owner for externally guarded cleanup.
},30000)
