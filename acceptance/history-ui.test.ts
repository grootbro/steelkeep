import {test,expect} from 'bun:test'
import {chromium,type Browser} from '@playwright/test'
import {realpath} from 'node:fs/promises'

const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-ui-history'?test:test.skip
acceptance('intercepted full-history UI pages, resets cursors on filters and rechecks an old snapshot before restore',async()=>{
  if(await realpath(process.cwd())!=='/Users/dobrota/dev/steelkeep')throw new Error('Use the fixed Steelkeep checkout.')
  const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,now='2026-10-31T01:00:00Z',source=id(1),storage=id(2),artifactId=id(3),requests:string[]=[],unexpected:string[]=[],errors:string[]=[]
  const job=(n:number)=>({id:id(n),type:'backup',status:'succeeded',phase:'completed',plan_id:null,source_id:source,storage_id:storage,target_id:null,created_at:now,started_at:now,finished_at:now,heartbeat_at:null,error_message:null,attempt:1,source_name:'Synthetic history source',storage_name:'Synthetic storage',target_name:null})
  const artifact={id:artifactId,source_id:source,storage_id:storage,source_name:'Older snapshot',storage_name:'Synthetic storage',run_id:id(4),size:'128',sha256:'a'.repeat(64),created_at:now,checked_at:now,availability:'present',engine:'postgres',retention_locked:false,deletion_state:'active',deleted_at:null}
  let browser:Browser|undefined
  try{
    browser=await chromium.launch({headless:true})
    const context=await browser.newContext({viewport:{width:1280,height:900},baseURL:'http://127.0.0.1:4310',timezoneId:'America/New_York'}),page=await context.newPage()
    page.setDefaultTimeout(8000)
    page.on('pageerror',error=>errors.push(error.message))
    await context.route('**/api/v1/**',async route=>{
      const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/api/v1',''),reply=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)})
      if(path==='/auth/status')return reply({setupRequired:false,authenticated:true,bootstrapAuthorized:false,user:{id:id(8),name:'Synthetic owner',email:'synthetic@example.test'}})
      if(path==='/me')return reply({actor:'synthetic-history-owner',scopes:['read','restore:run']})
      if(path==='/capabilities')return reply({operations:['browse_history']})
      if(path==='/overview')return reply({serverTime:now,jobs:[],connections:[{id:source,name:'Synthetic history source',kind:'postgres',revision:1,config:{restoreTarget:false}},{id:storage,name:'Synthetic storage',kind:'s3',revision:1,config:{bucket:'synthetic-only'}}],plans:[],backups:[]})
      if(path==='/jobs')return reply([])
      if(path==='/history/jobs'){requests.push(url.search);return reply({items:[job(url.searchParams.has('cursor')?12:11)],nextCursor:url.searchParams.has('cursor')?null:'opaque-synthetic-cursor',limit:30,order:url.searchParams.get('order')})}
      if(path==='/history/snapshots')return reply({items:[artifact],nextCursor:null,limit:30,order:'newest'})
      if(path===`/backups/${artifactId}`)return reply({...artifact,deletion_state:'held'})
      unexpected.push(request.method()+' '+path);return reply({error:{message:'Unexpected synthetic request'}},418)
    })
    await page.goto('/jobs');await page.getByRole('button',{name:'Full history',exact:true}).click()
    await page.getByRole('heading',{name:'All operations'}).waitFor()
    await page.getByRole('button',{name:'Next',exact:true}).click()
    await page.getByText('Page 2 · 1 records').waitFor()
    expect(requests.some(query=>new URLSearchParams(query).get('cursor')==='opaque-synthetic-cursor')).toBe(true)
    await page.getByRole('button',{name:'Previous',exact:true}).click()
    await page.getByText('Page 1 · 1 records').waitFor()
    await page.getByLabel('From',{exact:true}).fill('2026-11-01')
    await page.getByLabel('Through',{exact:true}).fill('2026-11-01')
    await page.getByRole('combobox',{name:'History order',exact:true}).selectOption('oldest')
    await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/history/jobs'&&new URL(response.url()).searchParams.get('order')==='oldest'),page.getByRole('button',{name:'Apply filters',exact:true}).click()])
    const last=new URLSearchParams(requests.at(-1))
    expect(last.has('cursor')).toBe(false);expect(last.get('from')).toBe('2026-11-01T04:00:00.000Z');expect(last.get('until')).toBe('2026-11-02T04:59:59.999999Z')
    await page.goto('/backups');await page.getByRole('button',{name:'Full history',exact:true}).click()
    await page.getByRole('button',{name:'Restore',exact:true}).click()
    await page.getByText('This snapshot is unavailable for restore.').waitFor()
    expect(await page.getByRole('button',{name:'Check destination',exact:true}).count()).toBe(0)
    await page.getByRole('button',{name:'Close dialog'}).click()
    await page.setViewportSize({width:390,height:844})
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    expect(unexpected).toEqual([]);expect(errors).toEqual([])
  }finally{await browser?.close()}
},60000)
