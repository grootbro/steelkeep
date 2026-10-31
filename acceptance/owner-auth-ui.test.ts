import {test,expect} from 'bun:test'
import {randomBytes} from 'node:crypto'
import {spawn,type ChildProcess} from 'node:child_process'
import {mkdtemp,writeFile,rm,chmod,realpath,access} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import pg from 'pg'
import {chromium,type Browser,type Page} from '@playwright/test'

const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-local-auth-ui'?test:test.skip
const origin='http://127.0.0.1:4321',api='http://127.0.0.1:4322'
acceptance('isolated owner UI: claim, daily login, session revocation and account navigation',async()=>{
 if(await realpath(process.cwd())!=='/Users/dobrota/dev/steelkeep')throw new Error('Use the fixed Steelkeep checkout.')
 if(['DEBUG','PWDEBUG','NODE_DEBUG','PW_TEST_TRACE','PLAYWRIGHT_TRACE_DIR','PLAYWRIGHT_VIDEO_DIR'].some(key=>!!process.env[key]))throw new Error('Disable debug/recording variables before this credential-bearing check.')
 const databaseUrl=process.env.DATABASE_URL??'postgres://steelkeep:local-metadata-only@127.0.0.1:54371/steelkeep_auth_ui_test',target=new URL(databaseUrl)
 if(target.hostname!=='127.0.0.1'||target.port!=='54371'||target.pathname!=='/steelkeep_auth_ui_test'||target.username!=='steelkeep')throw new Error('Require dedicated migrated steelkeep_auth_ui_test on loopback 54371; never the main metadata database.')
 await access('node_modules/.bin/vite')
 for(const address of [origin,api]){
  let listening=false;try{await fetch(address,{signal:AbortSignal.timeout(1000)});listening=true}catch{}
  if(listening)throw new Error('An isolated proof port is already in use; no existing process will be stopped.')
 }
 const metadata=new pg.Client({connectionString:databaseUrl,connectionTimeoutMillis:5000,statement_timeout:5000,query_timeout:6000})
 try{await metadata.connect();const owner=await metadata.query<{n:string}>('SELECT count(*)::text AS n FROM owner_account');if(owner.rows[0].n!=='0')throw new Error('Dedicated auth UI database already has an owner; retain it and prepare a fresh dedicated fixture explicitly.')}
 finally{await metadata.end()}
 const directory=await mkdtemp(join(tmpdir(),'steelkeep-owner-ui-'));await chmod(directory,0o700)
 const installationKey=randomBytes(32).toString('hex'),password='UI owner '+randomBytes(20).toString('hex'),replacement='UI changed '+randomBytes(20).toString('hex')
 const email='ui-owner-'+randomBytes(6).toString('hex')+'@example.test',name='Synthetic UI owner'
 const values:Record<string,string>={name,email,password,confirmPassword:password,installationKey,invalidSetupKey:randomBytes(32).toString('hex'),wrongPassword:'deliberately-wrong',currentPassword:password,newPassword:replacement,confirmNewPassword:replacement,replacement}
 const children:Array<{child:ChildProcess;exited:Promise<void>}>=[]
 let browser:Browser|undefined
 const env={...process.env,DATABASE_URL:databaseUrl,STEELKEEP_DATABASE_PASSWORD_FILE:'',STEELKEEP_SCOPED_TOKENS_FILE:'',STEELKEEP_KEY_FILE:join(directory,'key'),STEELKEEP_TOKEN_FILE:join(directory,'token'),STEELKEEP_ALLOWED_HOSTS:'fixture,mysql-fixture,s3',STEELKEEP_ALLOWED_ORIGINS:origin,STEELKEEP_PUBLIC_HOSTS:'127.0.0.1',STEELKEEP_SECURE_COOKIE:'false',STEELKEEP_DEV_API_PORT:'4322',HOST:'127.0.0.1',PORT:'4322'}
 function start(args:string[]){
  const child=spawn(process.execPath,args,{cwd:process.cwd(),env,detached:true,stdio:'ignore'})
  const exited=new Promise<void>(resolve=>{child.once('close',()=>resolve());child.once('error',()=>resolve())});children.push({child,exited})
 }
 async function ready(address:string,deadline:number){
  while(Date.now()<deadline){
   if(children.some(({child})=>child.exitCode!==null||child.signalCode!==null))throw new Error('An owned auth UI server exited before readiness; raw diagnostics withheld.')
   try{if((await fetch(address,{signal:AbortSignal.timeout(1500)})).ok)return}catch{}
   await new Promise(resolve=>setTimeout(resolve,200))
  }
  throw new Error('Owned API/Vite readiness exceeded 40 seconds.')
 }
 async function privateFill(page:Page,field:string,key=field){
  await page.locator(`input[name="${field}"]`).evaluate(async(node,key)=>{
   const provide=(window as unknown as {__steelkeepAuthProof:(key:string)=>Promise<string>}).__steelkeepAuthProof
   ;(node as HTMLInputElement).value=await provide(key);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}))
  },key)
 }
 async function openSetupLink(page:Page){
  await page.evaluate(async()=>{
   const provide=(window as unknown as {__steelkeepAuthProof:(key:string)=>Promise<string>}).__steelkeepAuthProof
   window.history.replaceState(null,'',await provide('setupLinkUrl'));window.location.reload()
  })
 }
 try{
  await writeFile(join(directory,'key'),randomBytes(32),{mode:0o600});await writeFile(join(directory,'token'),installationKey,{mode:0o600})
  start(['server/index.ts']);start(['run','vite','--port','4321','--strictPort'])
  const deadline=Date.now()+40000;await ready(api+'/api/v1/health',deadline);await ready(origin,deadline)
  browser=await chromium.launch({headless:true,timeout:10000})
  const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:'dark'}),page=await context.newPage(),errors:string[]=[]
  page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(10000)
  page.on('pageerror',error=>errors.push(error.name))
  await page.exposeBinding('__steelkeepAuthProof',({frame},key:unknown)=>{
   if(frame!==page.mainFrame()||new URL(frame.url()).origin!==origin||typeof key!=='string'||!Object.hasOwn(values,key))throw new Error('Private credential binding refused.')
   return values[key]
  })
  await page.goto(origin);await page.getByRole('heading',{name:'Set up your installation'}).waitFor()
  expect(await page.locator('form input').count()).toBe(1)
  expect(await page.getByLabel('Setup key',{exact:true}).evaluate(node=>node===document.activeElement)).toBe(true)
  // Old "system" preferences and OS dark mode must not select a third mode.
  await page.evaluate(()=>localStorage.setItem('steelkeep-auth-theme','system'));await page.reload()
  await page.getByRole('heading',{name:'Set up your installation'}).waitFor()
  expect(await page.locator('.auth-screen').getAttribute('data-theme')).toBe('light')
  await page.setViewportSize({width:390,height:844})
  for(const theme of ['dark','light']){
   await page.getByRole('button',{name:`Switch to ${theme} theme`,exact:true}).click()
   expect(await page.locator('.auth-screen').getAttribute('data-theme')).toBe(theme)
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true)
  }
  expect(await page.getByRole('combobox').count()).toBe(0)
  await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Welcome back'}).waitFor()
  expect(await page.locator('input[name="installationKey"]').count()).toBe(0)
  await page.getByRole('button',{name:'Set up installation',exact:true}).click();await page.getByRole('heading',{name:'Set up your installation'}).waitFor()
  await privateFill(page,'installationKey','invalidSetupKey');await page.getByRole('button',{name:'Continue',exact:true}).click()
  await page.getByText('This setup key is invalid. Check the key and try again.',{exact:true}).waitFor();expect(await page.getByRole('alert').innerText()).toBe('This setup key is invalid. Check the key and try again.')
  expect(await page.locator('input[name="installationKey"]').inputValue()).toBe('')
  // A real read-scoped agent key can open a limited session but must never
  // claim the installation. The UI must revoke that accidental session.
  const agentResponse=await fetch(api+'/api/v1/agents',{method:'POST',headers:{authorization:'Bearer '+installationKey,'content-type':'application/json'},body:JSON.stringify({name:'Setup claim denial fixture'})})
  if(!agentResponse.ok)throw new Error('Isolated claim-denial agent provisioning failed; credentials withheld.')
  const agent=await agentResponse.json() as {id:string}
  const issuedResponse=await fetch(api+`/api/v1/agents/${agent.id}/tokens`,{method:'POST',headers:{authorization:'Bearer '+installationKey,'content-type':'application/json'},body:JSON.stringify({name:'Read-only claim denial',scopes:['read'],expiresInHours:1})})
  if(!issuedResponse.ok)throw new Error('Isolated claim-denial token provisioning failed; credentials withheld.')
  const issued=await issuedResponse.json() as {token:string};values.agentSetupKey=issued.token
  await privateFill(page,'installationKey','agentSetupKey');await page.getByRole('button',{name:'Continue',exact:true}).click()
  await page.getByText('This key cannot authorize installation setup. Use the installation setup key.',{exact:true}).waitFor();expect(await page.getByRole('alert').innerText()).toBe('This key cannot authorize installation setup. Use the installation setup key.')
  expect((await context.cookies()).some(cookie=>cookie.name==='steelkeep_session')).toBe(false)
  expect(await page.locator('input[name="name"]').count()).toBe(0)
  values.setupLinkUrl=origin+'/#setup=invalid-synthetic-setup-link'
  await openSetupLink(page)
  await page.getByText('This setup link is invalid, expired or already used. Run “bun run setup:owner” on your server for a new link.',{exact:true}).waitFor()
  expect(await page.evaluate(()=>window.location.hash==='')).toBe(true)
  expect(await page.locator('input[name="installationKey"]').count()).toBe(1)
  const setupLinkResponse=await fetch(api+'/api/v1/auth/setup-link',{method:'POST',headers:{authorization:'Bearer '+installationKey}})
  expect(setupLinkResponse.status).toBe(201)
  if(!setupLinkResponse.ok)throw new Error('Synthetic setup-link issuance failed; credentials withheld.')
  const setupLink=await setupLinkResponse.json() as {code:string;expiresAt:string}
  expect(/^ss_[a-f0-9]{64}$/.test(setupLink.code)).toBe(true)
  expect(Date.parse(setupLink.expiresAt)>Date.now()&&Date.parse(setupLink.expiresAt)<=Date.now()+300000).toBe(true)
  values.setupLinkUrl=origin+'/#setup='+setupLink.code
  let setupCodeInRequestUrl=false
  page.on('request',request=>{if(request.url().includes(setupLink.code))setupCodeInRequestUrl=true})
  await openSetupLink(page)
  await page.getByRole('heading',{name:'Create your owner account'}).waitFor()
  expect(await page.evaluate(()=>window.location.hash==='')).toBe(true)
  expect(await page.locator('input[name="installationKey"]').count()).toBe(0)
  const limitedSetupCookie=(await context.cookies()).find(cookie=>cookie.name==='steelkeep_session')?.value
  if(!limitedSetupCookie)throw new Error('Synthetic setup-link claim did not create a session; credentials withheld.')
  expect((await fetch(api+'/api/v1/me',{headers:{cookie:'steelkeep_session='+limitedSetupCookie}})).status).toBe(403)
  expect((await fetch(api+'/api/v1/auth/setup-link/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:setupLink.code})})).status).toBe(401)
  expect(setupCodeInRequestUrl).toBe(false)
  expect(await page.getByLabel('Your name',{exact:true}).evaluate(node=>node===document.activeElement)).toBe(true)
  await page.keyboard.press('Tab');expect(await page.getByLabel('Email',{exact:true}).evaluate(node=>node===document.activeElement)).toBe(true)
  await page.setViewportSize({width:1440,height:1000})
  for(const field of ['name','email','password','confirmPassword'])await privateFill(page,field)
  await page.getByRole('button',{name:'Create account',exact:true}).click()
  const navigation=page.getByRole('navigation',{name:'Main navigation'});await navigation.waitFor({timeout:15000})
  expect((await fetch(api+'/api/v1/me',{headers:{cookie:'steelkeep_session='+installationKey}})).status).toBe(401)
  expect((await fetch(api+'/api/v1/me',{headers:{authorization:'Bearer '+installationKey}})).status).toBe(200)
  for(const section of ['Dashboard','Connections','Backup plans','Snapshots','Jobs','Configuration']){
   await navigation.getByRole('link',{name:section,exact:true}).click();await page.getByRole('heading',{name:section,level:1,exact:true}).waitFor()
   expect(await page.getByRole('alert').count()).toBe(0)
  }
  const account=page.locator('.account-panel');expect(await account.getByText(email,{exact:true}).count()).toBe(1);expect(await account.getByText(name,{exact:true}).count()).toBe(1)
  const setupCookie=(await context.cookies()).find(cookie=>cookie.name==='steelkeep_session')!.value
  expect(/^ss_[a-f0-9]{64}$/.test(setupCookie)).toBe(true)
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('heading',{name:'Welcome back'}).waitFor()
  expect((await fetch(api+'/api/v1/me',{headers:{cookie:'steelkeep_session='+setupCookie}})).status).toBe(401)
  expect(await page.locator('input[name="installationKey"]').count()).toBe(0)
  await privateFill(page,'email');await privateFill(page,'password','wrongPassword');await page.getByRole('button',{name:'Sign in',exact:true}).click()
  await page.getByRole('alert').waitFor();expect(await page.getByRole('alert').innerText()).toBe('Email or password is incorrect.')
  await privateFill(page,'password');await page.getByRole('button',{name:'Sign in',exact:true}).click();await navigation.waitFor({timeout:15000})
  const oldCookie=(await context.cookies()).find(cookie=>cookie.name==='steelkeep_session')!.value
  await navigation.getByRole('link',{name:'Configuration',exact:true}).click();await page.getByRole('button',{name:'Change password',exact:true}).click()
  for(const [field,key]of [['currentPassword','currentPassword'],['newPassword','newPassword'],['confirmPassword','confirmNewPassword']])await privateFill(page,field,key)
  await page.getByRole('button',{name:'Update password & sign out',exact:true}).click();await page.getByRole('heading',{name:'Welcome back'}).waitFor()
  expect((await fetch(api+'/api/v1/me',{headers:{cookie:'steelkeep_session='+oldCookie}})).status).toBe(401)
  expect(await page.getByRole('status').innerText()).toBe('Password updated. Sign in with your new password.')
  await privateFill(page,'email');await privateFill(page,'password','replacement');await page.getByRole('button',{name:'Sign in',exact:true}).click();await navigation.waitFor({timeout:15000})
  const text=await page.locator('body').innerText();expect([installationKey,password,replacement,setupLink.code].some(secret=>text.includes(secret))).toBe(false);expect(errors).toEqual([])
  console.info(JSON.stringify({proof:'owner-auth-ui',sections:6,themes:2,mobileWidth:390,opaqueSessions:true,logoutRevoked:true,passwordRevoked:true,singleUseSetupLink:true,setupSessionHasNoWorkspaceScopes:true}))
 }finally{
  await browser?.close().catch(()=>{})
  for(const {child}of children)if(child.pid)try{process.kill(-child.pid,'SIGTERM')}catch{}
  const timer=setTimeout(()=>{for(const {child}of children)if(child.pid)try{process.kill(-child.pid,'SIGKILL')}catch{}},3000)
  try{await Promise.all(children.map(({exited})=>exited))}finally{
   clearTimeout(timer)
   // A leader can exit before its descendants; terminate any remaining owned process group.
   for(const {child}of children)if(child.pid)try{process.kill(-child.pid,'SIGKILL')}catch{}
   await rm(directory,{recursive:true,force:true})
  }
 }
 // The dedicated owner/database/session history is retained; no DB create/drop/reset.
},120000)
