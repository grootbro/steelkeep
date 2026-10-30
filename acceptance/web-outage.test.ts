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

outage('compiled web: unavailable metadata shows an error in every section without a loading loop',async()=>{
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
    await page.exposeBinding('__steelkeepOutageToken',({frame})=>{
      if(frame!==page.mainFrame()||new URL(frame.url()).origin!==origin)throw new Error('Credential binding denied.')
      return token
    })
    await page.goto(origin)
    await page.getByRole('textbox',{name:'Installation token'}).evaluate(async node=>{
      const provide=(window as unknown as {__steelkeepOutageToken:()=>Promise<string>}).__steelkeepOutageToken
      ;(node as HTMLInputElement).value=await provide()
      node.dispatchEvent(new Event('input',{bubbles:true}))
    })
    await page.getByRole('button',{name:'Connect',exact:true}).click()
    await page.getByRole('navigation',{name:'Main navigation'}).waitFor({timeout:10000})
    for(const name of ['Dashboard','Connections','Backup plans','Snapshots','Jobs','Configuration']){
      await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name,exact:true}).click()
      await page.getByRole('heading',{name,level:1,exact:true}).waitFor()
      const alert=page.getByRole('alert').first();await alert.waitFor()
      expect(await alert.innerText()).toMatch(/failed|unavailable/i)
      expect((await page.locator('body').innerText()).includes(token)).toBe(false)
      expect(await page.getByText('Connecting to Steelkeep…',{exact:true}).count()).toBe(0)
    }
    await page.getByRole('button',{name:'Add agent',exact:true}).click()
    const dialog=page.getByRole('dialog',{name:'Add AI agent',exact:true})
    const name=dialog.getByRole('textbox',{name:'Agent name',exact:true})
    expect(await name.evaluate(node=>node===document.activeElement)).toBe(true)
    await page.keyboard.press('Tab')
    expect(await dialog.getByRole('textbox',{name:'Description',exact:true}).evaluate(node=>node===document.activeElement)).toBe(true)
    for(let i=0;i<12;i++){
      await page.keyboard.press(i<6?'Tab':'Shift+Tab')
      // Native dialogs may move Tab into browser chrome (body placeholder), never a background control.
      expect(await dialog.evaluate(node=>document.activeElement===document.body||node.contains(document.activeElement))).toBe(true)
    }
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'})
    expect(await page.getByRole('button',{name:'Add agent',exact:true}).evaluate(node=>node===document.activeElement)).toBe(true)
    expect(errors).toEqual([])
  }finally{
    await browser?.close()
    await client?.close().catch(()=>{})
    child.kill('SIGTERM')
    const timer=setTimeout(()=>child.kill('SIGKILL'),5000)
    try{await exited}finally{clearTimeout(timer);await rm(directory,{recursive:true,force:true})}
  }
},60000)
