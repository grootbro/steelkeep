import {test,expect} from 'bun:test'
import {randomBytes,randomUUID,createHash} from 'node:crypto'
import {spawn} from 'node:child_process'
import {readFile,lstat,realpath} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium,type Browser,type BrowserContext} from '@playwright/test'
import pg from 'pg'
import mysql,{type RowDataPacket} from 'mysql2/promise'
import {S3Client,CreateBucketCommand,GetObjectCommand} from '@aws-sdk/client-s3'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'

// No image/service lifecycle here. Root builds and launches the proof separately.
const proof=process.env.STEELKEEP_ACCEPTANCE==='synthetic-local-selfhost'?test:test.skip
const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'..'),privateRoot=join(workspace,'.steelkeep','selfhost-proof'),origin='http://127.0.0.1:4312'
type Job={id:string;status:string;artifact_id:string|null;error_code:string|null;validation:Record<string,unknown>|null}
type Artifact={id:string;object_key:string;size:string;sha256:string;engine:string}
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))
async function privateFile(name:string){
  const path=join(privateRoot,name),info=await lstat(path)
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||(info.mode&0o777)!==0o600||info.size>4096||await realpath(path)!==path)throw new Error('Proof secrets must be private regular files at the exact prepared path.')
  return readFile(path)
}
async function docker(args:string[]){
  return new Promise<string>((resolve,reject)=>{
    const child=spawn('docker',args,{cwd:workspace,env:{PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','ignore']})
    let output='',done=false
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(false)},15000)
    function finish(ok:boolean){if(done)return;done=true;clearTimeout(timer);ok?resolve(output.trim()):reject(new Error('Read-only local package inspection failed; raw Docker output is omitted.'))}
    child.stdout.on('data',(chunk:Buffer)=>{if(output.length+chunk.length>128*1024){child.kill('SIGKILL');finish(false)}else output+=chunk.toString('utf8')})
    child.once('error',()=>finish(false));child.once('close',code=>finish(code===0))
  })
}
async function packagedContainers(){
  if(process.env.DOCKER_HOST||process.env.DOCKER_CONTEXT)throw new Error('Unset Docker endpoint overrides before inspecting this fixed local proof.')
  const endpoint=JSON.parse(await docker(['context','inspect','--format','{{json .Endpoints.docker.Host}}'])) as unknown
  if(typeof endpoint!=='string'||!endpoint.startsWith('unix:///'))throw new Error('Packaged acceptance requires a local Docker Unix socket.')
  for(const service of ['web','worker','database']){
    const id=await docker(['--host',endpoint,'ps','--quiet','--filter','label=com.docker.compose.project=steelkeep-proof','--filter','label=com.docker.compose.service='+service])
    if(!/^[a-f0-9]{12,64}$/.test(id))throw new Error('Exactly one running packaged proof container is required for each service.')
    const row=JSON.parse(await docker(['--host',endpoint,'inspect','--format','{"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"image":{{json .Config.Image}},"ports":{{json .NetworkSettings.Ports}}}',id])) as {labels:Record<string,string>;mounts:Array<{Type:string;Source:string;Destination:string;RW:boolean;Name?:string}>;image:string;ports:Record<string,Array<{HostIp:string;HostPort:string}>|null>}
    if(await realpath(row.labels['com.docker.compose.project.working_dir']??'/')!==await realpath(workspace))throw new Error('The proof container belongs to another checkout.')
    if(service==='database'){
      if(row.mounts.length!==2||!row.mounts.some(m=>m.Type==='volume'&&m.Name==='steelkeep-proof_metadata'&&m.Destination==='/var/lib/postgresql/data')||!row.mounts.some(m=>m.Type==='bind'&&m.Source===join(privateRoot,'metadata-password')&&m.Destination==='/run/steelkeep/metadata-password'&&!m.RW))throw new Error('Proof metadata must use its own volume and private password file.')
    }else if(row.image!==`steelkeep-proof-${service==='web'?'web':'worker'}:local`||row.mounts.length!==1||row.mounts[0].Type!=='bind'||row.mounts[0].Source!==privateRoot||row.mounts[0].Destination!=='/run/steelkeep'||row.mounts[0].RW)throw new Error('Application proof requires packaged images and only the private read-only secret mount; source mounts are forbidden.')
    if(service!=='worker'){
      const port=service==='web'?'4312':'54381',target=service==='web'?'4312/tcp':'5432/tcp',bindings=row.ports[target]
      if(!bindings||bindings.length!==1||bindings[0].HostIp!=='127.0.0.1'||bindings[0].HostPort!==port)throw new Error('Proof ports must be fixed loopback bindings distinct from the preview.')
      if(Object.entries(row.ports).some(([name,entries])=>name!==target&&entries&&entries.length>0))throw new Error('An unexpected published proof port would exceed the isolated package boundary.')
    }
  }
}

proof('packaged selfhost: compiled UI login and same-origin REST/MCP native PostgreSQL/MariaDB recovery',async()=>{
  let browser:Browser|undefined,context:BrowserContext|undefined,metadata:pg.Client|undefined,client:Client|undefined
  if(await realpath(workspace)!=='/Users/dobrota/dev/steelkeep')throw new Error('Packaged acceptance is restricted to the exact local checkout.')
  if(process.env.DEBUG||process.env.PWDEBUG||process.env.NODE_DEBUG)throw new Error('Disable debug/protocol logging for this credential-bearing proof.')
  process.env.PLAYWRIGHT_NO_COPY_PROMPT='1'
  await packagedContainers()
  const token=(await privateFile('token')).toString('utf8'),password=(await privateFile('metadata-password')).toString('utf8')
  if(!/^[a-f0-9]{64}$/.test(token)||!/^[a-f0-9]{64}$/.test(password)||(await privateFile('key')).length!==32)throw new Error('Run guarded proof preparation first; existing secrets were not changed.')
  async function rest<T>(path:string,body?:unknown,expected=200):Promise<T>{
    let response:Response
    try{response=await fetch(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)})}
    catch{throw new Error('The fixed packaged API could not be reached; credentials are omitted.')}
    if(response.status!==expected)throw new Error(`Packaged API returned ${response.status}; expected ${expected}. Response bodies are omitted.`)
    const value=await response.json() as T
    expect(JSON.stringify(value).includes(token)).toBe(false)
    return value
  }
  async function metadataRows(text:string,values:unknown[]=[]){
    try{return (await metadata!.query(text,values)).rows as Array<Record<string,unknown>>}
    catch{throw new Error('Private loopback proof metadata inspection failed; SQL credentials are omitted.')}
  }
  async function tool<T>(name:string,args:Record<string,unknown>={}):Promise<T>{
    const result=await client!.callTool({name,arguments:args})
    if(result.isError)throw new Error('A packaged MCP operation returned a safe tool error; inspect its job separately.')
    const structured=result.structuredContent as {data?:unknown}|undefined
    const block=result.content.find(item=>item.type==='text')
    const value=structured&&'data' in structured?structured.data:block?.type==='text'?JSON.parse(block.text):undefined
    if(value===undefined)throw new Error('The official MCP client did not receive structured output.')
    expect(JSON.stringify(value).includes(token)).toBe(false)
    return value as T
  }
  async function finished(id:string){
    const deadline=Date.now()+120000
    while(Date.now()<deadline){const job=await tool<Job>('get_job',{id});if(['succeeded','failed','cancelled','interrupted'].includes(job.status)){if(job.status!=='succeeded')throw new Error(`Packaged operation ended ${job.status} (${job.error_code??'no-code'}). This is not accepted recovery.`);return job}await delay(250)}
    throw new Error('Packaged operation did not finish within the bounded deadline; history and target remain retained.')
  }
  async function pgFixture(database:string,user:string,pwd:string){
    const connection=new pg.Client({host:'127.0.0.1',port:54372,database,user,password:pwd,connectionTimeoutMillis:5000,statement_timeout:15000,query_timeout:17000});connection.on('error',()=>{})
    try{await connection.connect();return connection}catch{await connection.end().catch(()=>{});throw new Error('The fixed PostgreSQL fixture is unavailable; credentials are omitted.')}
  }
  const mariaFixture=async()=>{try{return await mysql.createConnection({host:'127.0.0.1',port:54375,user:'root',password:'local-mariadb-fixture-only',connectTimeout:5000,multipleStatements:false})}catch{throw new Error('The fixed MariaDB fixture is unavailable; credentials are omitted.')}}
  try{
    metadata=new pg.Client({host:'127.0.0.1',port:54381,database:'steelkeep',user:'steelkeep',password,connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000,options:'-c default_transaction_read_only=on'});metadata.on('error',()=>{})
    try{await metadata.connect()}catch{throw new Error('The private proof metadata database is unavailable; its password is omitted.')}
    const [identity]=await metadataRows("SELECT current_database() AS name,current_user AS actor,current_setting('server_version_num')::int AS version,to_regclass('public.runs')::text AS runs")
    if(identity?.name!=='steelkeep'||identity.actor!=='steelkeep'||Math.floor(Number(identity.version)/10000)!==17||!identity.runs)throw new Error('The private PostgreSQL 17 proof metadata is not migrated.')
    for(const row of await metadataRows('SELECT kind,config FROM connections')){
      const config=row.config as Record<string,unknown>
      if(row.kind==='s3'?config.endpoint!=='http://s3:9000':!(row.kind==='postgres'&&config.host==='fixture'&&config.port===5432||row.kind==='mariadb'&&config.host==='mysql-fixture'&&config.port===3306))throw new Error('Proof metadata contains a non-fixture profile; no recovery mutation is allowed.')
    }
    expect((await rest<{actor:string}>('/me')).actor).toBe('installation-owner')
    client=new Client({name:'steelkeep-packaged-proof',version:'0.1.0'})
    await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}}))
    const tools=await client.listTools();for(const name of ['run_backup','prepare_restore','start_restore','get_job'])expect(tools.tools.some(tool=>tool.name===name)).toBe(true)

    // Direct library launch: no trace/video/HAR/storageState, test-runner DOM dumps, or visible UI.
    browser=await chromium.launch({headless:true});context=await browser.newContext({baseURL:origin,viewport:{width:1440,height:1000}})
    const page=await context.newPage()
    await page.exposeBinding('__steelkeepProofToken',({frame})=>{if(frame!==page.mainFrame()||new URL(frame.url()).origin!==origin)throw new Error('Unexpected credential binding origin.');return token})
    await page.goto('/')
    await page.getByRole('heading',{name:'Connect to your installation',exact:true}).waitFor({state:'visible'})
    // The credential stays out of locator action arguments and failure call logs.
    await page.getByLabel('Installation token',{exact:true}).evaluate(async node=>{
      if(!(node instanceof HTMLInputElement))throw new Error('Expected a credential input.')
      const value=await (window as unknown as {__steelkeepProofToken:()=>Promise<string>}).__steelkeepProofToken(),setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set
      if(!setter)throw new Error('Native input setter unavailable.')
      setter.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}))
    })
    await page.getByRole('button',{name:'Connect',exact:true}).click()
    await page.getByRole('heading',{name:'Dashboard',level:1,exact:true}).waitFor({state:'visible'})
    for(const label of ['Connections','Backup plans','Snapshots','Jobs','Configuration']){await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:label,exact:true}).click();await page.getByRole('heading',{name:label,level:1,exact:true}).waitFor({state:'visible'})}

    const s3=new S3Client({endpoint:'http://127.0.0.1:54373',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'steelkeep-local',secretAccessKey:'local-s3-fixture-only'}})
    try{
      for(const engine of ['postgres','mariadb'] as const){
        const suffix=randomBytes(6).toString('hex'),database='proof_'+(engine==='postgres'?'pg':'maria')+'_'+suffix,user='proof_writer_'+suffix,pwd=randomBytes(24).toString('hex'),bucket='steelkeep-proof-'+engine+'-'+suffix
        if(engine==='postgres'){
          const admin=await pgFixture('source','fixture_admin','local-fixture-only')
          try{const version=(await admin.query("SELECT current_setting('server_version_num')::int AS version")).rows[0].version,source=(await admin.query('SELECT count(*)::int AS n,sum(amount)::text AS total FROM entries')).rows[0];if(Math.floor(version/10000)!==17||source.n!==1000||source.total!=='625625.00')throw new Error();await admin.query(`CREATE ROLE ${user} LOGIN PASSWORD '${pwd}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);await admin.query(`CREATE DATABASE ${database} OWNER ${user}`)}catch{throw new Error('Known PostgreSQL fixture or generated empty target provisioning failed; credentials are omitted.')}finally{await admin.end()}
        }else{
          const admin=await mariaFixture()
          try{const [version]=await admin.query<RowDataPacket[]>('SELECT VERSION() AS version'),[source]=await admin.query<RowDataPacket[]>('SELECT count(*) AS n,sum(amount) AS total FROM source_mysql.entries');if(!/^11\..*mariadb/i.test(String(version[0].version))||Number(source[0].n)!==3||Number(source[0].total)!==7.5)throw new Error();await admin.query(`CREATE DATABASE \`${database}\``);await admin.query(`CREATE USER '${user}'@'%' IDENTIFIED BY '${pwd}'`);await admin.query(`GRANT SELECT,INSERT,CREATE,ALTER,INDEX,REFERENCES,SHOW VIEW,TRIGGER,EVENT,EXECUTE,LOCK TABLES ON \`${database.replace(/[%_]/g,'\\$&')}\`.* TO '${user}'@'%'`)}catch{throw new Error('Known MariaDB fixture or generated empty target provisioning failed; credentials are omitted.')}finally{await admin.end()}
        }
        await s3.send(new CreateBucketCommand({Bucket:bucket}),{abortSignal:AbortSignal.timeout(30000)})
        const sourceConfig=engine==='postgres'?{host:'fixture',port:5432,database:'source',password:'local-reader-only'}:{host:'mysql-fixture',port:3306,database:'source_mysql',password:'local-mysql-reader-only',allowGlobalReadLock:true}
        const source=await rest<{id:string}>('/connections',{name:'Packaged '+engine+' source '+suffix,kind:engine,...sourceConfig,user:'backup_reader',tls:false,restoreTarget:false})
        const target=await rest<{id:string}>('/connections',{name:'Packaged '+engine+' target '+suffix,kind:engine,host:sourceConfig.host,port:sourceConfig.port,database,user,password:pwd,tls:false,restoreTarget:true})
        const storage=await rest<{id:string}>('/connections',{name:'Packaged '+engine+' storage '+suffix,kind:'s3',endpoint:'http://s3:9000',region:'us-east-1',bucket,prefix:'proof',accessKey:'steelkeep-local',secretKey:'local-s3-fixture-only'})
        for(const id of [source.id,target.id,storage.id])expect((await rest<{status:string}>('/connections/'+id+'/test',{})).status).toBe('available')
        // Prove this packaged API writes to the separately inspected metadata database.
        expect((await metadataRows('SELECT id FROM connections WHERE id=$1',[source.id])).length).toBe(1)
        const plan=await rest<{id:string}>('/plans',{name:'Packaged '+engine+' plan '+suffix,sourceId:source.id,storageId:storage.id,cron:null,timezone:'UTC'})
        const backupKey=randomUUID(),accepted=await tool<Job>('run_backup',{planId:plan.id,idempotencyKey:backupKey})
        expect((await tool<Job>('run_backup',{planId:plan.id,idempotencyKey:backupKey})).id).toBe(accepted.id)
        const backup=await finished(accepted.id),artifact=(await tool<Artifact[]>('list_backups')).find(row=>row.id===backup.artifact_id)
        if(!artifact||artifact.engine!==engine||Number(artifact.size)<=0||Number(artifact.size)>4*1024*1024)throw new Error('The small packaged native fixture artifact is missing or outside bounds.')
        const object=await s3.send(new GetObjectCommand({Bucket:bucket,Key:artifact.object_key}),{abortSignal:AbortSignal.timeout(30000)})
        if(!object.Body||object.ContentLength!==Number(artifact.size))throw new Error('The real proof object size does not match metadata.')
        const bytes=await object.Body.transformToByteArray();expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256)
        expect(engine==='postgres'?Buffer.from(bytes.subarray(0,5)).toString()==='PGDMP':/-- (?:MariaDB|MySQL) dump/.test(Buffer.from(bytes).toString('utf8'))).toBe(true)
        const review=await tool<{intentId:string}>('prepare_restore',{artifactId:artifact.id,targetId:target.id}),key=randomUUID(),restore=await tool<Job>('start_restore',{intentId:review.intentId,idempotencyKey:key})
        expect((await tool<Job>('start_restore',{intentId:review.intentId,idempotencyKey:key})).id).toBe(restore.id)
        const restored=await finished(restore.id);expect(restored.validation?.status).toBe('passed');expect(restored.validation?.integrity).toBe('sha256-matched')
        if(engine==='postgres'){
          const recovered=await pgFixture(database,user,pwd),sourceAgain=await pgFixture('source','backup_reader','local-reader-only')
          try{for(const db of [recovered,sourceAgain]){const row=(await db.query('SELECT count(*)::int AS n,sum(amount)::text AS total FROM entries')).rows[0];expect(row.n).toBe(1000);expect(row.total).toBe('625625.00')}}catch{throw new Error('Independent PostgreSQL proof data verification failed.')}finally{await recovered.end();await sourceAgain.end()}
        }else{
          const admin=await mariaFixture()
          try{for(const db of [database,'source_mysql']){const [rows]=await admin.query<RowDataPacket[]>(`SELECT count(*) AS n,sum(amount) AS total FROM \`${db}\`.entries`);expect(Number(rows[0].n)).toBe(3);expect(Number(rows[0].total)).toBe(7.5)}}catch{throw new Error('Independent MariaDB proof data verification failed.')}finally{await admin.end()}
        }
        await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Snapshots',exact:true}).click();await page.reload()
        await page.getByRole('heading',{name:'Snapshots',level:1,exact:true}).waitFor({state:'visible'})
        await page.getByText('Packaged '+engine+' source '+suffix,{exact:true}).first().waitFor({state:'visible'})
        console.info(JSON.stringify({suite:'packaged-selfhost',engine,backupRunId:backup.id,restoreRunId:restored.id,status:'passed',origin,resources:'retained'}))
      }
    }finally{s3.destroy()}
  }finally{await context?.close().catch(()=>{});await browser?.close().catch(()=>{});await client?.close().catch(()=>{});await metadata?.end().catch(()=>{})}
},360000)
