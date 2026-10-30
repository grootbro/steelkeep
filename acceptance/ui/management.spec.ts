import {test,expect,type Page,type Locator,type Response} from '@playwright/test'
import {randomBytes,randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import pg from 'pg'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'

// No fixture SQL mutations, browser mocks, owner API configuration shortcuts,
// job starts or arbitrary existing plans. All management writes use real forms.
const metadataUrl='postgres://steelkeep:local-metadata-only@127.0.0.1:54371/steelkeep'
const origin='http://127.0.0.1:4310',apiOrigin='http://127.0.0.1:4311'
const tokenPath=fileURLToPath(new URL('../../.steelkeep/token',import.meta.url))
type SafeConnection={id:string;name:string;revision:number;check_status:string;checked_at:string|null}
function optIn(){
  if(process.env.STEELKEEP_ACCEPTANCE!=='synthetic-local-ui'||process.env.DATABASE_URL!==metadataUrl||process.env.STEELKEEP_DATABASE_PASSWORD_FILE)throw new Error('Management UI acceptance requires the exact isolated synthetic-local-ui metadata configuration.')
}
async function guardMetadata(){
  optIn()
  const db=new pg.Client({connectionString:metadataUrl,connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000,options:'-c default_transaction_read_only=on'})
  db.on('error',()=>{})
  try{
    await db.connect()
    const {rows:[identity]}=await db.query("SELECT current_database() AS name,current_user AS actor,current_setting('server_version_num')::int AS version,to_regclass('public.agent_tokens')::text AS tokens")
    if(identity?.name!=='steelkeep'||identity.actor!=='steelkeep'||Math.floor(Number(identity.version)/10000)!==17||!identity.tokens)throw new Error()
    const hosts=new Set(['fixture','mysql-fixture','mysql8-fixture','mongodb-fixture','redis-fixture','clickhouse-fixture','mssql-fixture'])
    for(const row of (await db.query('SELECT kind,config FROM connections')).rows){
      const c=row.config as Record<string,unknown>
      if(row.kind==='s3'?c.endpoint!=='http://s3:9000':row.kind==='sqlite'?!String(c.path).startsWith('/var/lib/steelkeep-fixtures/sqlite/'):!hosts.has(String(c.host)))throw new Error()
    }
  }catch{throw new Error('The expected migrated isolated PostgreSQL 17 metadata and fixture-only connections were not established.')}
  finally{await db.end().catch(()=>{})}
}
async function confirmCreatedRecord(table:'agents'|'connections',id:string,name:string){
  optIn()
  const db=new pg.Client({connectionString:metadataUrl,connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000,options:'-c default_transaction_read_only=on'})
  db.on('error',()=>{})
  try{
    await db.connect()
    const {rows}=await db.query(`SELECT name FROM ${table} WHERE id=$1`,[id])
    if(rows.length!==1||rows[0].name!==name)throw new Error()
  }catch{throw new Error('The UI-created record was not found in the guarded fixture metadata database; further management writes are refused.')}
  finally{await db.end().catch(()=>{})}
}
async function secretInput(locator:Locator,key:string){
  await locator.evaluate(async(node,key)=>{
    if(!(node instanceof HTMLInputElement))throw new Error('Expected credential input.')
    const binding=(window as unknown as {__managementSecret:(key:string)=>Promise<string>}).__managementSecret
    const value=await binding(key),setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set
    if(!setter)throw new Error('Native input setter unavailable.')
    setter.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}))
  },key)
}
async function login(page:Page,secrets:Map<string,string>){
  await guardMetadata() // Must precede session, credential or configuration mutations.
  const token=(await readFile(tokenPath,'utf8')).trim()
  if(token.length<32)throw new Error('The local installation token is unavailable.')
  secrets.set('installation',token)
  await page.exposeBinding('__managementSecret',({frame},key:string)=>{
    if(frame!==page.mainFrame()||new URL(frame.url()).origin!==origin||!secrets.has(key))throw new Error('Credential binding denied outside the fixed main frame.')
    return secrets.get(key)!
  })
  await page.goto('/')
  await expect(page.getByRole('heading',{name:'Connect to your installation',exact:true})).toBeVisible()
  await expect(page.getByLabel('Installation token',{exact:true})).toHaveAttribute('type','password')
  await secretInput(page.getByLabel('Installation token',{exact:true}),'installation')
  await command(page,'/api/v1/session','POST',()=>page.getByRole('button',{name:'Connect',exact:true}).click(),204)
  await expect(page.getByRole('navigation',{name:'Main navigation'})).toBeVisible()
}
async function navigate(page:Page,label:string){
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:label,exact:true}).click()
  await expect(page.getByRole('heading',{name:label,exact:true,level:1})).toBeVisible()
}
async function command(page:Page,path:string,method:string,action:()=>Promise<unknown>,status=200):Promise<Response>{
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()===method)
  try{await action();const reply=await pending;expect(reply.status()).toBe(status);return reply}
  catch(error){void pending.catch(()=>{});throw error}
}
// Native fetch keeps Authorization out of Playwright's recorded action arguments.
// Never attach response bodies or SDK errors containing credential context.
async function request(token:string,path:string,method='GET',body?:unknown){
  try{return await fetch(apiOrigin+path,{method,headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)})}
  catch{throw new Error('The fixed local API request failed; credential context omitted.')}
}
async function mcpReadAndDeny(token:string){
  const client=new Client({name:'steelkeep-ui-management',version:'0.1.0'})
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL(apiOrigin+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}}))
    const read=await client.callTool({name:'list_connections',arguments:{}})
    if(read.isError)throw new Error()
    const data=(read.structuredContent as {data?:unknown}|undefined)?.data
    if(!Array.isArray(data))throw new Error()
    for(const [name,args] of [
      ['run_backup',{planId:randomUUID(),idempotencyKey:'denied-ui-'+randomUUID()}],
      ['update_connection',{id:randomUUID(),revision:1,name:'Denied synthetic edit'}],
    ] as const){
      const denied=await client.callTool({name,arguments:args})
      const value=(denied.structuredContent as {data?:{error?:{code?:string}}}|undefined)?.data
      if(!denied.isError||value?.error?.code!=='FORBIDDEN')throw new Error()
    }
  }catch{throw new Error('The scoped MCP read/permission-denial checks failed; transport and token details omitted.')}
  finally{await client.close().catch(()=>{})}
}
async function sourceConnection(page:Page,name:string){
  await navigate(page,'Connections')
  await page.locator('.page-header').getByRole('button',{name:'Add connection',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'Add connection',exact:true})
  await dialog.getByRole('combobox',{name:'Connection type',exact:true}).selectOption('postgres')
  for(const [label,value] of [['Name',name],['Host','fixture'],['Port','5432'],['Database','source'],['Username','backup_reader']])await dialog.getByLabel(label,{exact:true}).fill(value)
  await secretInput(dialog.getByLabel('Password',{exact:true}),'reader')
  await dialog.getByRole('checkbox',{name:'Verify TLS certificate',exact:true}).uncheck()
  const reply=await command(page,'/api/v1/connections','POST',()=>dialog.getByRole('button',{name:'Save connection',exact:true}).click())
  const {id}=await reply.json() as {id:string}
  await expect(dialog).not.toBeVisible();await confirmCreatedRecord('connections',id,name);return id
}
function connectionRow(page:Page,name:string){return page.getByRole('row').filter({has:page.getByText(name,{exact:true})})}
async function editor(page:Page,name:string){
  await connectionRow(page,name).getByRole('button',{name:'Edit '+name,exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'Edit connection',exact:true})
  await expect(dialog.getByLabel('New password',{exact:true})).toBeEmpty()
  for(const label of ['Host','Port','Database'])await expect(dialog.getByLabel(label,{exact:true})).toBeDisabled()
  await expect(dialog.getByRole('combobox',{name:'Connection type',exact:true})).toBeDisabled()
  await expect(dialog.getByRole('checkbox',{name:'Use only as a restore destination',exact:true})).toBeDisabled()
  return dialog
}
async function save(page:Page,dialog:Locator,id:string){
  const reply=await command(page,`/api/v1/connections/${id}`,'PATCH',()=>dialog.getByRole('button',{name:'Save changes',exact:true}).click())
  const value=await reply.json() as SafeConnection
  await expect(dialog).not.toBeVisible();return value
}
test.beforeAll(guardMetadata)
test.afterEach(async({context},info)=>{
  for(const page of context.pages()){
    await page.locator('input,textarea').evaluateAll(nodes=>{for(const node of nodes)if(node instanceof HTMLInputElement||node instanceof HTMLTextAreaElement)node.value=''}).catch(()=>{})
    if(info.status!==info.expectedStatus&&!page.isClosed())try{
      const path=info.outputPath('management-'+context.pages().indexOf(page)+'-masked.png')
      await page.screenshot({path,fullPage:true,mask:[page.locator('input,textarea,.issued-token')],maskColor:'#1a1f2a',timeout:5000})
      await info.attach('Masked management failure',{path,contentType:'image/png'})
    }catch{}
  }
})

test('named AI agent: one-time read token, real MCP/API scope enforcement and UI revocation',async({page})=>{
  const suffix=randomBytes(6).toString('hex'),agentName='UI inspection agent '+suffix,secrets=new Map<string,string>()
  let firstToken='',secondToken=''
  try{
    await login(page,secrets);await navigate(page,'Configuration')
    const add=page.getByRole('button',{name:'Add agent',exact:true})
    await add.focus();await page.keyboard.press('Enter')
    const create=page.getByRole('dialog',{name:'Add AI agent',exact:true})
    await expect(create.getByLabel('Agent name',{exact:true})).toBeFocused()
    await create.getByLabel('Agent name',{exact:true}).fill(agentName)
    await page.keyboard.press('Tab');await expect(create.getByLabel('Description',{exact:true})).toBeFocused()
    await create.getByLabel('Description',{exact:true}).fill('Synthetic browser acceptance; inspection only')
    const made=await command(page,'/api/v1/agents','POST',()=>create.getByRole('button',{name:'Create agent',exact:true}).click())
    const agent=await made.json() as {id:string}
    await confirmCreatedRecord('agents',agent.id,agentName)
    const title=agentName+' · access tokens',dialog=page.getByRole('dialog',{name:title,exact:true})
    await expect(dialog).toBeVisible()
    // Native modal focus containment, including forward/backward keyboard traversal.
    await dialog.getByLabel('Token name',{exact:true}).focus()
    for(const key of ['Tab','Shift+Tab'])for(let n=0;n<14;n++){
      await page.keyboard.press(key)
      expect(await dialog.evaluate(node=>node.contains(document.activeElement))).toBe(true)
    }
    const checkboxes=dialog.getByRole('checkbox')
    await expect(checkboxes).toHaveCount(6)
    for(let n=0;n<6;n++)expect(await checkboxes.nth(n).isChecked()).toBe(n===0)
    await expect(dialog.getByRole('combobox',{name:'Expires after',exact:true})).toHaveValue('24')
    async function issue(name:string){
      await dialog.getByLabel('Token name',{exact:true}).fill(name)
      const reply=await command(page,`/api/v1/agents/${agent.id}/tokens`,'POST',()=>dialog.getByRole('button',{name:'Issue token',exact:true}).click())
      const issued=await reply.json() as {id:string;token:string;scopes:string[]}
      expect(issued.scopes).toEqual(['read'])
      if(!issued.token.startsWith('sk_')||issued.token.length<32)throw new Error('A one-time agent credential was not issued.')
      await expect(dialog.getByRole('heading',{name:'Copy this token now',exact:true})).toBeVisible()
      // Return only a boolean through the instrumented browser action.
      expect(await dialog.getByLabel('Agent token',{exact:true}).evaluate(node=>node instanceof HTMLInputElement&&node.readOnly&&node.value.startsWith('sk_')&&node.value.length>32)).toBe(true)
      return issued
    }
    const first=await issue('Read inspection '+suffix);firstToken=first.token
    await mcpReadAndDeny(firstToken)
    expect((await request(firstToken,'/api/v1/connections')).status).toBe(200)
    for(const [path,method,body] of [
      [`/api/v1/plans/${randomUUID()}/run`,'POST',{idempotencyKey:'denied-ui-'+randomUUID()}],
      [`/api/v1/connections/${randomUUID()}`,'PATCH',{revision:1,name:'Denied synthetic rename'}],
    ] as const){const denied=await request(firstToken,path,method,body);expect(denied.status).toBe(403);expect((await denied.json() as {error:{code:string}}).error.code).toBe('FORBIDDEN')}
    await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible()
    const agentRow=page.getByRole('row').filter({has:page.getByText(agentName,{exact:true})})
    await agentRow.getByRole('button',{name:'Tokens',exact:true}).click()
    await expect(dialog.getByLabel('Agent token',{exact:true})).toHaveCount(0)
    const listed=await request(secrets.get('installation')!,`/api/v1/agents/${agent.id}/tokens`)
    const tokenRows=await listed.json() as Array<Record<string,unknown>>
    expect(tokenRows.some(row=>row.id===first.id)).toBe(true)
    expect(tokenRows.every(row=>!('token' in row)&&!('token_hash' in row))).toBe(true)
    page.once('dialog',d=>void d.accept())
    await command(page,`/api/v1/agent-tokens/${first.id}/revoke`,'POST',()=>dialog.getByRole('button',{name:'Revoke token Read inspection '+suffix,exact:true}).click())
    expect((await request(firstToken,'/api/v1/connections')).status).toBe(401)
    await expect(dialog.getByRole('row').filter({has:page.getByText('Read inspection '+suffix,{exact:true})})).toContainText('Revoked')
    const second=await issue('Agent revocation '+suffix);secondToken=second.token
    expect((await request(secondToken,'/api/v1/connections')).status).toBe(200)
    await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible()
    page.once('dialog',d=>void d.accept())
    await command(page,`/api/v1/agents/${agent.id}/revoke`,'POST',()=>agentRow.getByRole('button',{name:'Revoke '+agentName,exact:true}).click())
    await expect(agentRow.locator('.badge')).toHaveText('revoked')
    await expect(agentRow.getByRole('button',{name:'Tokens',exact:true})).toBeDisabled()
    expect((await request(secondToken,'/api/v1/connections')).status).toBe(401)
    // Re-authentication is checked at the MCP HTTP boundary after revocation.
    const revokedMcp=await request(secondToken,'/mcp','POST',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'revoked-ui-check',version:'1'}}})
    expect(revokedMcp.status).toBe(401)
  }finally{firstToken='';secondToken='';secrets.clear()}
})

test('connection lifecycle: retained secret, rotation, stale editor reload and safe removal',async({page,context})=>{
  const suffix=randomBytes(6).toString('hex'),base='UI managed source '+suffix,renamed='UI renamed source '+suffix,latest='UI latest source '+suffix,finalName='UI reloaded source '+suffix
  const secrets=new Map([['reader','local-reader-only'],['wrong-reader',randomBytes(24).toString('hex')],['s3-access','steelkeep-local'],['s3-secret','local-s3-fixture-only']])
  try{
    await login(page,secrets)
    const id=await sourceConnection(page,base)
    const tested=await command(page,`/api/v1/connections/${id}/test`,'POST',()=>connectionRow(page,base).getByRole('button',{name:'Test connection',exact:true}).click())
    expect((await tested.json() as {status:string}).status).toBe('available')
    await expect(connectionRow(page,base).locator('.badge')).toHaveText('available')
    const beforeReply=await request(secrets.get('installation')!,'/api/v1/connections')
    const before=(await beforeReply.json() as SafeConnection[]).find(row=>row.id===id)!
    const edit=await editor(page,base)
    await edit.getByLabel('Name',{exact:true}).fill(renamed)
    const kept=await save(page,edit,id)
    expect(kept.revision).toBe(before.revision+1);expect(kept.check_status).toBe('available');expect(kept.checked_at).toBe(before.checked_at)
    // Wrong synthetic credential is a real encrypted rotation, not a UI mock.
    await editor(page,renamed);await secretInput(edit.getByLabel('New password',{exact:true}),'wrong-reader')
    const changed=await save(page,edit,id)
    expect(changed.check_status).toBe('untested');expect(changed.checked_at).toBeNull()
    const refused=await command(page,`/api/v1/connections/${id}/test`,'POST',()=>connectionRow(page,renamed).getByRole('button',{name:'Test connection',exact:true}).click())
    expect((await refused.json() as {status:string}).status).toBe('failed')
    await expect(connectionRow(page,renamed).locator('.badge')).toHaveText('failed')
    await editor(page,renamed);await secretInput(edit.getByLabel('New password',{exact:true}),'reader')
    await save(page,edit,id)
    const recovered=await command(page,`/api/v1/connections/${id}/test`,'POST',()=>connectionRow(page,renamed).getByRole('button',{name:'Test connection',exact:true}).click())
    expect((await recovered.json() as {status:string}).status).toBe('available')
    // Two real browser documents open the same revision before either saves.
    await editor(page,renamed)
    const other=await context.newPage()
    await other.goto('/connections');await expect(other.getByRole('heading',{name:'Connections',exact:true,level:1})).toBeVisible()
    const otherEdit=await editor(other,renamed)
    await otherEdit.getByLabel('Name',{exact:true}).fill(latest);await save(other,otherEdit,id)
    await edit.getByLabel('Name',{exact:true}).fill('Stale discarded '+suffix)
    const conflict=await command(page,`/api/v1/connections/${id}`,'PATCH',()=>edit.getByRole('button',{name:'Save changes',exact:true}).click(),409)
    expect((await conflict.json() as {error:{code:string}}).error.code).toBe('REVISION_CONFLICT')
    await expect(edit.getByRole('alert')).toHaveText('This connection changed. Reload it before saving.')
    await edit.getByRole('button',{name:'Load latest settings',exact:true}).click()
    await expect(edit.getByLabel('Name',{exact:true})).toHaveValue(latest)
    await expect(edit.getByLabel('New password',{exact:true})).toBeEmpty()
    await edit.getByLabel('Name',{exact:true}).fill(finalName);await save(page,edit,id);await other.close()
    // Create a manual-only plan through the UI; never press Run backup.
    const storageName='UI management storage '+suffix
    await page.locator('.page-header').getByRole('button',{name:'Add connection',exact:true}).click()
    const add=page.getByRole('dialog',{name:'Add connection',exact:true})
    await add.getByRole('combobox',{name:'Connection type',exact:true}).selectOption('s3')
    for(const [label,value] of [['Name',storageName],['Endpoint','http://s3:9000'],['Bucket','steelkeep-management-'+suffix],['Region','us-east-1'],['Object prefix','management/'+suffix]])await add.getByLabel(label,{exact:true}).fill(value)
    await secretInput(add.getByLabel('Access key',{exact:true}),'s3-access');await secretInput(add.getByLabel('Secret key',{exact:true}),'s3-secret')
    const stored=await command(page,'/api/v1/connections','POST',()=>add.getByRole('button',{name:'Save connection',exact:true}).click())
    const storageId=(await stored.json() as {id:string}).id
    await expect(add).not.toBeVisible();await navigate(page,'Backup plans')
    await page.locator('.page-header').getByRole('button',{name:'Create plan',exact:true}).click()
    const plan=page.getByRole('dialog',{name:'Create backup plan',exact:true})
    await plan.getByLabel('Plan name',{exact:true}).fill('UI retained reference '+suffix)
    await plan.getByRole('combobox',{name:'Source database',exact:true}).selectOption(id)
    await plan.getByRole('combobox',{name:'Storage volume',exact:true}).selectOption(storageId)
    await plan.getByRole('checkbox',{name:'Run on a schedule',exact:true}).uncheck()
    await plan.getByLabel('Timezone',{exact:true}).fill('Asia/Bangkok')
    await command(page,'/api/v1/plans','POST',()=>plan.getByRole('button',{name:'Create plan',exact:true}).click())
    await expect(plan).not.toBeVisible();await navigate(page,'Connections')
    page.once('dialog',d=>void d.accept())
    const retained=await command(page,`/api/v1/connections/${id}`,'DELETE',()=>connectionRow(page,finalName).getByRole('button',{name:'Remove unused '+finalName,exact:true}).click(),409)
    expect((await retained.json() as {error:{code:string}}).error.code).toBe('CONNECTION_IN_USE')
    await expect(connectionRow(page,finalName)).toBeVisible()
    const unusedName='UI unused source '+suffix,unusedId=await sourceConnection(page,unusedName)
    page.once('dialog',d=>void d.accept())
    await command(page,`/api/v1/connections/${unusedId}`,'DELETE',()=>connectionRow(page,unusedName).getByRole('button',{name:'Remove unused '+unusedName,exact:true}).click())
    await expect(connectionRow(page,unusedName)).toHaveCount(0)
    const safeList=await request(secrets.get('installation')!,'/api/v1/connections'),rows=await safeList.json() as Array<Record<string,unknown>>
    expect(rows.some(row=>row.id===id)).toBe(true);expect(rows.some(row=>row.id===unusedId)).toBe(false)
    expect(rows.every(row=>!('secret' in row)&&!('password' in row))).toBe(true)
  }finally{secrets.clear()}
  // Retain the plan, source/storage records and audit history. Removal above is
  // exclusively the deliberately unused metadata record, never fixture data.
})
