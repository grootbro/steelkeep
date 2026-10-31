import {test,expect} from 'bun:test'
import {randomBytes} from 'node:crypto'
import {spawn} from 'node:child_process'
import {mkdtemp,writeFile,rm,access,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {resolve,join} from 'node:path'
import {chromium,type Browser} from '@playwright/test'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'

const outage=process.env.STEELKEEP_ACCEPTANCE==='synthetic-local-web'?test:test.skip
const origin='http://127.0.0.1:4320'

outage('compiled owner auth: unavailable metadata shows a real safe error without a login or loading loop',async()=>{
  if(await realpath(process.cwd())!=='/Users/dobrota/dev/steelkeep')throw new Error('Run this guarded web check only in the Steelkeep checkout.')
  if(process.env.DEBUG||process.env.PWDEBUG||process.env.NODE_DEBUG)throw new Error('Disable debug recording for the web check.')
  await access('dist/server/server.js') // Build separately; this check never installs or builds.
  const directory=await mkdtemp(join(tmpdir(),'steelkeep-web-outage-')),token=randomBytes(32).toString('hex')
  let browser:Browser|undefined,client:Client|undefined
  await writeFile(join(directory,'key'),randomBytes(32),{mode:0o600})
  await writeFile(join(directory,'token'),token,{mode:0o600})
  const child=spawn(process.execPath,['server/serve.ts'],{cwd:resolve('.'),stdio:['ignore','pipe','ignore'],env:{
    ...process.env,HOST:'127.0.0.1',PORT:'4320',
    DATABASE_URL:'postgres://unavailable_fixture:synthetic-only@127.0.0.1:9/steelkeep',
    STEELKEEP_DATABASE_PASSWORD_FILE:'',STEELKEEP_SCOPED_TOKENS_FILE:'',
    STEELKEEP_KEY_FILE:join(directory,'key'),STEELKEEP_TOKEN_FILE:join(directory,'token'),
    STEELKEEP_ALLOWED_HOSTS:'fixture,s3',STEELKEEP_ALLOWED_ORIGINS:origin,
    STEELKEEP_PUBLIC_HOSTS:'127.0.0.1',STEELKEEP_SECURE_COOKIE:'false'
  }})
  const exited=new Promise<void>(resolve=>child.once('close',()=>resolve()))
  try{
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('The isolated compiled web server did not start.')),10000)
      child.once('error',()=>{clearTimeout(timer);reject(new Error('The isolated compiled web server could not start.'))})
      void exited.then(()=>{clearTimeout(timer);reject(new Error('The isolated web server exited before readiness.'))})
      let output=''
      child.stdout.on('data',(chunk:Buffer)=>{
        output+=chunk.toString('utf8')
        if(output.length>4096){clearTimeout(timer);reject(new Error('Unexpected web startup output.'));return}
        if(output.includes('Steelkeep web, API and MCP ready')){clearTimeout(timer);resolve()}
      })
    })
    const headers={authorization:'Bearer '+token}
    const response=await fetch(origin+'/api/v1/overview',{headers,signal:AbortSignal.timeout(10000)})
    expect(response.status).toBe(500)
    const message=await response.text()
    expect(message).toContain('OPERATION_FAILED');expect(message).not.toContain(token);expect(message).not.toContain('synthetic-only')
    expect((await fetch(origin+'/openapi/json',{headers})).status).toBe(200)
    expect((await fetch(origin+'/api/v1/me')).status).toBe(401)
    const auth=await fetch(origin+'/api/v1/auth/status',{signal:AbortSignal.timeout(10000)})
    expect(auth.status).toBe(500)
    const authError=await auth.text();expect(authError.includes('OPERATION_FAILED')).toBe(true)
    expect([token,'synthetic-only'].some(secret=>authError.includes(secret))).toBe(false)
    client=new Client({name:'steelkeep-web-outage',version:'0.1.0'})
    await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers}}))
    expect((await client.listTools()).tools.map(tool=>tool.name)).toContain('list_connections')
    const unavailable=await client.callTool({name:'list_connections',arguments:{}})
    expect(unavailable.isError).toBe(true)
    expect(JSON.stringify(unavailable)).toContain('OPERATION_FAILED')
    expect(JSON.stringify(unavailable)).not.toContain(token)
    expect(JSON.stringify(unavailable)).not.toContain('synthetic-only')
    expect((await client.callTool({name:'get_capabilities',arguments:{}})).isError).not.toBe(true)
    browser=await chromium.launch({headless:true})
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[]
    page.on('pageerror',error=>errors.push(error.name))
    // Requires rebuilding the compiled client after owner-auth changes; no fallback to old token UI.
    await page.goto(origin)
    await page.getByRole('heading',{name:'Could not connect',exact:true}).waitFor({timeout:10000})
    for(const path of ['/','/settings']){
      if(path!=='/')await page.goto(origin+path)
      await page.getByRole('heading',{name:'Could not connect',exact:true}).waitFor({timeout:10000})
      expect(await page.getByRole('alert').count()).toBe(1)
      expect(/failed|unavailable/i.test(await page.getByRole('alert').innerText())).toBe(true)
      expect(await page.getByRole('navigation',{name:'Main navigation'}).count()).toBe(0)
      expect(await page.locator('input[type="password"]').count()).toBe(0)
      expect(await page.getByText('Connecting to your installation…',{exact:true}).count()).toBe(0)
      const visible=await page.locator('body').innerText()
      expect([token,'synthetic-only'].some(secret=>visible.includes(secret))).toBe(false)
    }
    const retry=page.waitForResponse(response=>response.url()===origin+'/api/v1/auth/status')
    await page.getByRole('button',{name:'Try again',exact:true}).click()
    expect((await retry).status()).toBe(500)
    await page.getByRole('heading',{name:'Could not connect',exact:true}).waitFor()
    expect(errors).toEqual([])
  }finally{
    await browser?.close()
    await client?.close().catch(()=>{})
    child.kill('SIGTERM')
    const timer=setTimeout(()=>child.kill('SIGKILL'),5000)
    try{await exited}finally{clearTimeout(timer);await rm(directory,{recursive:true,force:true})}
  }
},60000)
