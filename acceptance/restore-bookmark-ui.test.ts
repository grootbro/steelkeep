import {test,expect} from 'bun:test'
import {chromium,type Browser} from '@playwright/test'
import {realpath} from 'node:fs/promises'

const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-ui-restore-bookmark'?test:test.skip
acceptance('intercepted UI preserves a confirmed restore across close/reload and recovers only its original command',async()=>{
  if(await realpath(process.cwd())!=='/Users/dobrota/dev/steelkeep')throw new Error('Use the fixed Steelkeep checkout.')
  const origin='http://127.0.0.1:4310',id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,now=new Date().toISOString()
  const source=id(1),storage=id(2),target=id(3),artifactId=id(4),intentId=id(5),runId=id(6)
  const connection=(identity:string,name:string,restoreTarget=false)=>({id:identity,name,kind:'postgres',revision:1,updated_at:now,config:{host:'synthetic.invalid',port:5432,database:name,tls:true,restoreTarget},check_status:'available',checked_at:now})
  const artifact={id:artifactId,source_id:source,storage_id:storage,run_id:id(7),size:'128',sha256:'a'.repeat(64),created_at:now,checked_at:now,availability:'present',engine:'postgres'}
  const job={id:runId,type:'restore',status:'interrupted',phase:'interrupted',plan_id:null,source_id:source,storage_id:storage,target_id:target,created_at:now,started_at:now,finished_at:now,heartbeat_at:now,error_message:'Synthetic interrupted outcome; recovery never replays writes.',attempt:1,events:[]}
  const starts:unknown[]=[],unexpected:string[]=[],errors:string[]=[]
  let actor='owner:synthetic-bookmark',outcome:'ambiguous'|'accepted'|'expired'|'limited'='ambiguous',browser:Browser|undefined
  try{
    browser=await chromium.launch({headless:true})
    const context=await browser.newContext({viewport:{width:1280,height:900},baseURL:origin}),page=await context.newPage()
    page.on('pageerror',error=>errors.push(error.message))
    await context.route('**/api/v1/**',async route=>{
      const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1','')
      const reply=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)})
      if(path==='/auth/status')return reply({setupRequired:false,authenticated:true,bootstrapAuthorized:false,user:{id:id(8),name:'Synthetic owner',email:'synthetic@example.test'}})
      if(path==='/capabilities')return reply({operations:[]})
      if(path==='/me')return reply({actor,scopes:['read','restore:run']})
      if(path==='/overview')return reply({serverTime:now,jobs:[],connections:[connection(source,'Source'),connection(target,'Empty target',true),{...connection(storage,'Storage'),kind:'s3',config:{bucket:'synthetic-only',endpoint:'http://synthetic.invalid'}}],plans:[],backups:[artifact]})
      if(path==='/jobs')return reply([])
      if(path===`/jobs/${runId}`)return reply(job)
      if(path==='/restores/prepare'&&request.method()==='POST')return reply({intentId,expiresAt:new Date(Date.now()+600000).toISOString(),review:{artifactId,targetId:target,fingerprint:'synthetic',engine:'postgres',sourceDatabase:'Source',targetDatabase:'Empty target',serverVersion:'17',warnings:[],checks:{}}})
      if(path==='/restores/start'&&request.method()==='POST'){
        starts.push(request.postDataJSON())
        if(outcome==='ambiguous')return reply({error:{code:'SYNTHETIC_UNKNOWN',message:'Synthetic lost response'}},503)
        if(outcome==='limited')return reply({error:{code:'RATE_LIMITED',message:'Synthetic rate limit'}},429)
        if(outcome==='expired')return reply({error:{code:'RESTORE_REVIEW_EXPIRED',message:'Prepare and review this restore again.'}},409)
        return reply(job,202)
      }
      unexpected.push(request.method()+' '+path);return reply({error:{message:'Unexpected synthetic request'}},418)
    })
    await page.goto('/backups')
    await page.getByRole('button',{name:'Restore',exact:true}).click()
    await page.getByRole('combobox').last().selectOption(target)
    await page.getByRole('button',{name:'Check destination',exact:true}).click()
    await page.getByRole('checkbox',{name:'Restore this backup into the target database shown above.'}).check()
    await page.getByRole('button',{name:'Start restore',exact:true}).click()
    await page.getByRole('heading',{name:'Recover your confirmed restore'}).waitFor()
    expect(starts.length).toBe(1)
    const first=starts[0] as {intentId:string;idempotencyKey:string}
    expect(first.intentId).toBe(intentId)
    const saved=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('steelkeep.pending-restores.')))
    expect(saved).toHaveLength(1)
    expect(Object.keys(JSON.parse(saved[0][1])[artifactId]).sort()).toEqual(['artifactId','idempotencyKey','intentId','targetId'])
    await page.getByRole('button',{name:'Close dialog'}).click()
    await page.reload()
    await page.getByRole('heading',{name:'Unresolved restore requests'}).waitFor()
    expect(starts.length).toBe(1) // Reload never submits the saved command.
    outcome='limited';await page.getByRole('button',{name:'Recover restore result',exact:true}).click()
    await page.getByRole('alert').filter({hasText:'Synthetic rate limit'}).waitFor()
    expect(await page.getByRole('heading',{name:'Unresolved restore requests'}).count()).toBe(1)
    actor='agent:someone-else';await page.reload()
    await page.getByRole('button',{name:'Restore',exact:true}).waitFor()
    expect(await page.getByRole('heading',{name:'Unresolved restore requests'}).count()).toBe(0)
    actor='owner:synthetic-bookmark';outcome='accepted';await page.reload()
    await page.getByRole('button',{name:'Recover restore result',exact:true}).click()
    await page.getByRole('dialog').getByText('Synthetic interrupted outcome; recovery never replays writes.').waitFor()
    expect(starts).toEqual([first,first,first])
    expect(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('steelkeep.pending-restores.')))).toEqual([])
    await page.getByRole('button',{name:'Close dialog'}).click()
    // An expired unconsumed request is explicitly refused and releases only its browser bookmark.
    await page.evaluate(({saved})=>sessionStorage.setItem(saved[0][0],saved[0][1]),{saved})
    outcome='expired';await page.reload()
    await page.getByRole('button',{name:'Recover restore result',exact:true}).click()
    await page.getByRole('heading',{name:'Unresolved restore requests'}).waitFor({state:'hidden'})
    expect(starts).toEqual([first,first,first,first])
    expect(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('steelkeep.pending-restores.')))).toEqual([])
    expect(unexpected).toEqual([]);expect(errors).toEqual([])
  }finally{await browser?.close()}
},60000)
