import {test,expect} from 'bun:test'
import {randomUUID,createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFile,lstat,realpath,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import pg from 'pg'
import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3'
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client'

const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-ui-scoped-agent'?test:test.skip
const workspace='/Users/dobrota/dev/steelkeep',privateRoot=join(workspace,'.steelkeep/ui-proof'),base='http://127.0.0.1:4322',origin='http://127.0.0.1:4321'
const metadataUrl='postgres://steelkeep:local-metadata-only@127.0.0.1:54371/steelkeep_ui_proof',recordPath=join(privateRoot,'scoped-agent-result.json')
const inspect=promisify(execFile),uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
type Proof={suite:string;status:string;engine:string;sourceDatabase:string;targetDatabase:string;reader:string;writer:string;bucket:string;prefix:string;sourceId:string;targetId:string;storageId:string;planId:string;backupRunId:string;artifactId:string;restoreRunId:string}
type Job={id:string;status:string;attempt:number;artifact_id:string|null}

async function privateFile(path:string,maximum:number){
 const info=await lstat(path)
 if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||(info.mode&0o777)!==0o600||info.size>maximum||await realpath(path)!==path)throw new Error('The dedicated proof requires private regular files without links.')
 return readFile(path,'utf8')
}
async function guardRuntime(){
 if(await realpath(process.cwd())!==workspace||process.env.DATABASE_URL!==metadataUrl||process.env.STEELKEEP_DATABASE_PASSWORD_FILE||process.env.DOCKER_HOST||process.env.DOCKER_CONTEXT)throw new Error('Refusing a scoped native proof outside the fixed checkout, metadata and local Docker context.')
 if(['DEBUG','PWDEBUG','NODE_DEBUG','PW_TEST_TRACE','PLAYWRIGHT_TRACE_DIR','PLAYWRIGHT_VIDEO_DIR'].some(key=>!!process.env[key]))throw new Error('Disable debug and credential recording before the scoped native proof.')
 const directory=await lstat(privateRoot)
 if(!directory.isDirectory()||directory.isSymbolicLink()||(directory.mode&0o777)!==0o700||await realpath(privateRoot)!==privateRoot)throw new Error('Dedicated UI proof private directory identity differs.')
 try{await lstat(recordPath);throw new Error('A scoped-agent proof record already exists; do not repeat this native operation.')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 async function docker(args:string[]){try{return(await inspect('docker',args,{env:{PATH:process.env.PATH,HOME:process.env.HOME},timeout:10000,maxBuffer:128*1024})).stdout.trim()}catch{throw new Error('Dedicated Docker inspection failed; raw diagnostics are omitted.')}}
 const endpoint=JSON.parse(await docker(['context','inspect','--format','{{json .Endpoints.docker.Host}}'])) as unknown
 if(typeof endpoint!=='string'||!endpoint.startsWith('unix:///'))throw new Error('Require a local Docker Unix socket.')
 const format='{"running":{{json .State.Running}},"labels":{{json .Config.Labels}},"env":{{json .Config.Env}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}},"networks":{{json .NetworkSettings.Networks}},"image":{{json .Image}}}'
 for(const service of ['api','worker']){
  const row=JSON.parse(await docker(['--host',endpoint,'inspect','--format',format,'steelkeep-ui-proof-'+service])) as {running:boolean;labels:Record<string,string>;env:string[];mounts:Array<{Type:string;Source:string;Destination:string;RW:boolean}>;ports:Record<string,Array<{HostIp:string;HostPort:string}>|null>;networks:Record<string,unknown>;image:string}
  if(!row.running||row.labels['com.docker.compose.project']!=='steelkeep-ui-proof'||row.labels['com.docker.compose.service']!==service||row.labels.purpose!=='steelkeep-native-ui-proof'||row.labels['com.docker.compose.project.working_dir']!==workspace||row.labels['com.docker.compose.project.config_files']!==join(workspace,'compose.ui-proof.yaml')||row.image!=='sha256:ed6ac2132f62451299ed661eca043592883431fa11b42ecb5cc62e19cdacce99'||!row.networks.steelkeep_default)throw new Error('Dedicated API/worker identity differs from the prepared proof runtime.')
  for(const value of ['DATABASE_URL=postgres://steelkeep:local-metadata-only@metadata:5432/steelkeep_ui_proof','STEELKEEP_DATABASE_PASSWORD_FILE=','STEELKEEP_KEY_FILE=/run/steelkeep/key','STEELKEEP_TOKEN_FILE=/run/steelkeep/token','STEELKEEP_ALLOWED_HOSTS=fixture,mysql-fixture,s3','STEELKEEP_ALLOWED_ORIGINS='+origin,'STEELKEEP_PUBLIC_HOSTS=127.0.0.1','STEELKEEP_SECURE_COOKIE=false','PORT=4322'])if(!row.env.includes(value))throw new Error('Dedicated runtime environment differs from its fixed fixture boundary.')
  const mounts=new Map([['/app/server',join(workspace,'server')],['/app/shared',join(workspace,'shared')],['/run/steelkeep',privateRoot]])
  if(row.mounts.length!==mounts.size||row.mounts.some(m=>m.Type!=='bind'||m.RW||!mounts.has(m.Destination)||!(m.Source===mounts.get(m.Destination)||process.platform==='darwin'&&m.Source==='/host_mnt'+mounts.get(m.Destination))))throw new Error('Dedicated runtime mounts exceed the read-only source/private-file boundary.')
  const ports=Object.entries(row.ports).filter(([,bindings])=>bindings?.length)
  if(service==='api'?(ports.length!==1||ports[0][0]!=='4322/tcp'||ports[0][1]?.length!==1||ports[0][1]?.[0].HostIp!=='127.0.0.1'||ports[0][1]?.[0].HostPort!=='4322'):ports.length!==0)throw new Error('Dedicated runtime port bindings differ from the fixed loopback API and private worker.')
 }
 for(const address of [base,origin]){const response=await fetch(address+'/api/v1/health',{redirect:'error',signal:AbortSignal.timeout(5000)});if(!response.ok||(await response.json() as {version?:string}).version!=='0.1.0')throw new Error('The fixed API/Vite proof ports are not healthy.')}
 const proof=JSON.parse(await privateFile(join(privateRoot,'native-ui-result.json'),16384)) as Proof
 const suffix=proof.sourceDatabase?.match(/^ui-postgres-src-([a-f0-9]{12})$/)?.[1]
 if(proof.suite!=='synthetic-ui-firstbackup'||proof.status!=='passed'||proof.engine!=='postgres'||!suffix||proof.targetDatabase!=='123ui_pg_dst_'+suffix||proof.reader!=='ui_reader_'+suffix||proof.writer!=='ui_writer_'+suffix||proof.bucket!=='steelkeep-ui-postgres-'+suffix||proof.prefix!=='ui/postgres/'+suffix||[proof.sourceId,proof.targetId,proof.storageId,proof.planId,proof.backupRunId,proof.artifactId,proof.restoreRunId].some(id=>!uuid(id)))throw new Error('Require the completed generated PostgreSQL UI proof record, never arbitrary saved profiles.')
 return proof
}
async function metadata(query:string,values:unknown[]=[]){
 const db=new pg.Client({connectionString:metadataUrl,connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000,options:'-c default_transaction_read_only=on'})
 db.on('error',()=>{})
 try{await db.connect();return(await db.query(query,values)).rows as Array<Record<string,unknown>>}catch{throw new Error('Dedicated read-only metadata inspection failed; URL and credentials omitted.')}finally{await db.end().catch(()=>{})}
}
async function sourceTotals(proof:Proof){
 const db=new pg.Client({host:'127.0.0.1',port:54372,database:proof.sourceDatabase,user:'fixture_admin',password:'local-fixture-only',connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000,options:'-c default_transaction_read_only=on'})
 db.on('error',()=>{})
 try{
  await db.connect();const identity=(await db.query("SELECT current_database() AS name,current_user AS actor,current_setting('server_version_num')::int AS version")).rows[0]
  if(identity.name!==proof.sourceDatabase||identity.actor!=='fixture_admin'||Math.floor(Number(identity.version)/10000)!==17)throw new Error()
  const marker=(await db.query('SELECT name FROM projects WHERE id=1')).rows[0]?.name,totals=(await db.query('SELECT count(*)::int AS count,sum(amount)::text AS total FROM entries')).rows[0]
  if(marker!=='Synthetic UI recovery fixture'||totals.count!==1000||totals.total!=='625625.00')throw new Error()
  return {count:totals.count as number,total:totals.total as string}
 }catch{throw new Error('The fixed generated PostgreSQL source did not confirm its synthetic identity and totals.')}finally{await db.end().catch(()=>{})}
}

acceptance('scoped AI agent runs a native MCP backup, verifies S3 bytes and loses access after revocation',async()=>{
 const proof=await guardRuntime(),rootKey=(await privateFile(join(privateRoot,'token'),256)).trim()
 if(!/^[a-f0-9]{64}$/.test(rootKey))throw new Error('Dedicated installation key has an invalid format.')
 const originalRecord=await readFile(join(privateRoot,'native-ui-result.json'),'utf8')
 const [identity]=await metadata("SELECT current_database() AS name,current_user AS actor,current_setting('server_version_num')::int AS version")
 const owners=await metadata('SELECT name,email FROM owner_account'),connections=await metadata('SELECT id,kind,config FROM connections'),plans=await metadata('SELECT id,source_id,storage_id,cron,enabled FROM plans'),active=await metadata("SELECT id FROM runs WHERE status IN ('queued','running','cancelling')")
 if(identity?.name!=='steelkeep_ui_proof'||identity.actor!=='steelkeep'||Math.floor(Number(identity.version)/10000)!==17||owners.length!==1||owners[0].name!=='Synthetic platform proof owner'||!/^platform-proof-[a-f0-9]+@example\.test$/.test(String(owners[0].email))||connections.length!==3||plans.length!==1||active.length)throw new Error('Dedicated metadata identity or idle synthetic ownership boundary differs.')
 const source=connections.find(row=>row.id===proof.sourceId),target=connections.find(row=>row.id===proof.targetId),storage=connections.find(row=>row.id===proof.storageId),sourceConfig=source?.config as Record<string,unknown>|undefined,targetConfig=target?.config as Record<string,unknown>|undefined,storageConfig=storage?.config as Record<string,unknown>|undefined
 if(source?.kind!=='postgres'||sourceConfig?.host!=='fixture'||sourceConfig.port!==5432||sourceConfig.database!==proof.sourceDatabase||sourceConfig.user!==proof.reader||sourceConfig.tls!==false||sourceConfig.restoreTarget!==false||target?.kind!=='postgres'||targetConfig?.host!=='fixture'||targetConfig.port!==5432||targetConfig.database!==proof.targetDatabase||targetConfig.user!==proof.writer||targetConfig.restoreTarget!==true||storage?.kind!=='s3'||storageConfig?.endpoint!=='http://s3:9000'||storageConfig.bucket!==proof.bucket||storageConfig.prefix!==proof.prefix||plans[0].id!==proof.planId||plans[0].source_id!==proof.sourceId||plans[0].storage_id!==proof.storageId||plans[0].cron!==null)throw new Error('Dedicated UI proof profiles differ from their exact generated source, target, storage or manual plan.')
 async function rest<T>(path:string,body?:unknown):Promise<T>{
  let response:Response;try{response=await fetch(base+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+rootKey,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(10000)})}catch{throw new Error('The dedicated proof API request failed; credential diagnostics omitted.')}
  if(!response.ok)throw new Error('The dedicated proof API refused an authorized fixture command ('+response.status+').')
  return response.json() as Promise<T>
 }
 const initialHolds=await rest<Array<{target_id:string;run_id:string;run_status:string;validation_status:string|null}>>('/target-blocks')
 if(!initialHolds.some(hold=>hold.target_id===proof.targetId&&hold.run_id===proof.restoreRunId&&hold.run_status==='succeeded'&&hold.validation_status==='passed'))throw new Error('The live API must expose the completed UI restore reservation before agent mutation; do not restart or substitute it.')
 const before=await sourceTotals(proof),planCount=plans.length,agent=await rest<{id:string}>('/agents',{name:'Synthetic native MCP scoped proof',description:'Read and native backup only; dedicated UI proof fixture.'})
 if(!uuid(agent.id))throw new Error('Agent creation returned an invalid public ID.')
 let revoked=false,client:Client|undefined,lastMcpStatus=0
 try{
  const issued=await rest<{id:string;agentId:string;token:string;scopes:string[];expiresAt:string}>('/agents/'+agent.id+'/tokens',{name:'Synthetic native backup proof',scopes:['read','backup:run'],expiresInHours:1})
  if(!uuid(issued.id)||issued.agentId!==agent.id||typeof issued.token!=='string'||!issued.token.startsWith('sk_'))throw new Error('Scoped token issuance returned an invalid credential contract.')
  expect(issued.scopes).toEqual(['read','backup:run']);expect(Date.parse(issued.expiresAt)-Date.now()).toBeGreaterThan(3500000);expect(Date.parse(issued.expiresAt)-Date.now()).toBeLessThanOrEqual(3600000)
  client=new Client({name:'steelkeep-scoped-native-proof',version:'0.1.0'});client.onerror=()=>{}
  const transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'),{
   requestInit:{headers:{authorization:'Bearer '+issued.token}},
   fetch:async(input,init)=>{try{const response=await fetch(input,{...init,redirect:'error'});lastMcpStatus=response.status;return response}catch{throw new Error('Dedicated MCP transport failed; credential diagnostics omitted.')}}
  })
  try{await client.connect(transport)}catch{throw new Error('The scoped native MCP client could not connect; credentials omitted.')}
  async function tool<T>(name:string,args:Record<string,unknown>={}):Promise<T>{
   let response;try{response=await client!.callTool({name,arguments:args})}catch{throw new Error('The scoped MCP command failed at transport; credentials omitted.')}
   if(response.isError)throw new Error('The scoped MCP fixture command was refused.')
   const value=response.structuredContent as {data?:T}|undefined
   if(!value||!Object.hasOwn(value,'data'))throw new Error('Expected official MCP structured result.')
   expect(JSON.stringify(value).includes(issued.token)).toBe(false);expect(JSON.stringify(value).includes(rootKey)).toBe(false)
   return value.data as T
  }
  const denied=await client.callTool({name:'create_plan',arguments:{name:'Forbidden scoped native plan',sourceId:proof.sourceId,storageId:proof.storageId,timezone:'UTC'}})
  expect(denied.isError).toBe(true);expect((denied.structuredContent as {data:{error:{code:string}}}).data.error.code).toBe('FORBIDDEN')
  expect((await metadata('SELECT id FROM plans')).length).toBe(planCount)
  const key=randomUUID(),accepted=await tool<Job>('run_backup',{planId:proof.planId,idempotencyKey:key})
  expect(uuid(accepted.id)).toBe(true);expect((await tool<Job>('run_backup',{planId:proof.planId,idempotencyKey:key})).id).toBe(accepted.id)
  let completed:Job|undefined
  const deadline=Date.now()+120000
  while(Date.now()<deadline){const job=await tool<Job>('get_job',{id:accepted.id});if(['succeeded','failed','cancelled','interrupted'].includes(job.status)){completed=job;break}await new Promise(resolve=>setTimeout(resolve,500))}
  if(!completed||completed.status!=='succeeded'||!uuid(completed.artifact_id))throw new Error('The real scoped-agent native backup did not publish a successful artifact within its deadline. Resources are retained; no automatic cancellation or retry is requested.')
  expect(completed.attempt).toBe(1)
  const [artifact]=await metadata('SELECT id,run_id,source_id,storage_id,engine,object_key,size::text AS size,sha256 FROM artifacts WHERE run_id=$1',[completed.id])
  if(!artifact||artifact.id!==completed.artifact_id||artifact.run_id!==completed.id||artifact.source_id!==proof.sourceId||artifact.storage_id!==proof.storageId||artifact.engine!=='postgres'||typeof artifact.object_key!=='string'||!artifact.object_key.startsWith(proof.prefix+'/'+completed.id+'/')||typeof artifact.sha256!=='string'||!/^[a-f0-9]{64}$/.test(artifact.sha256)||!Number.isSafeInteger(Number(artifact.size))||Number(artifact.size)<=0||Number(artifact.size)>16*1024*1024)throw new Error('Read-only metadata did not correlate the scoped-agent native artifact with the fixed proof source and storage.')
  const s3=new S3Client({endpoint:'http://127.0.0.1:54373',region:'us-east-1',forcePathStyle:true,maxAttempts:1,credentials:{accessKeyId:'steelkeep-local',secretAccessKey:'local-s3-fixture-only'}})
  let bytes=0,sha256='',magic=Buffer.alloc(0)
  try{
   const object=await s3.send(new GetObjectCommand({Bucket:proof.bucket,Key:artifact.object_key}),{abortSignal:AbortSignal.timeout(15000)})
   if(!object.Body||object.ContentLength!==Number(artifact.size))throw new Error()
   const reader=object.Body.transformToWebStream().getReader(),hash=createHash('sha256')
   try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>Number(artifact.size)||bytes>16*1024*1024)throw new Error();hash.update(chunk.value);if(magic.byteLength<5)magic=Buffer.concat([magic,Buffer.from(chunk.value).subarray(0,5-magic.byteLength)])}}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
   sha256=hash.digest('hex')
  }catch{throw new Error('Independent bounded S3 GET failed; provider and credential diagnostics omitted.')}finally{s3.destroy()}
  expect(bytes).toBe(Number(artifact.size));expect(sha256).toBe(artifact.sha256);expect(magic.toString()).toBe('PGDMP')
  expect(await sourceTotals(proof)).toEqual(before)
  const holds=await tool<Array<{target_id:string;run_id:string;run_status:string;validation_status:string|null}>>('list_target_blocks')
  expect(holds.some(hold=>hold.target_id===proof.targetId&&hold.run_id===proof.restoreRunId&&hold.run_status==='succeeded'&&hold.validation_status==='passed')).toBe(true)
  await rest('/agent-tokens/'+issued.id+'/revoke',{});await rest('/agents/'+agent.id+'/revoke',{});revoked=true
  const refused=await fetch(base+'/api/v1/me',{headers:{authorization:'Bearer '+issued.token},redirect:'error',signal:AbortSignal.timeout(5000)});expect(refused.status).toBe(401)
  lastMcpStatus=0;let mcpRefused=false;try{await client.callTool({name:'get_job',arguments:{id:completed.id}})}catch{mcpRefused=true}
  expect(mcpRefused).toBe(true);expect(lastMcpStatus).toBe(401)
  const [retained]=await metadata('SELECT status,attempt FROM runs WHERE id=$1',[completed.id]);expect(retained).toEqual({status:'succeeded',attempt:1})
  const [one]=await metadata('SELECT count(*)::int AS count FROM runs WHERE idempotency_key=$1',[key]);expect(one.count).toBe(1)
  expect(await readFile(join(privateRoot,'native-ui-result.json'),'utf8')).toBe(originalRecord)
  const result={suite:'synthetic-ui-scoped-agent',status:'passed',agentId:agent.id,tokenId:issued.id,planId:proof.planId,sourceId:proof.sourceId,targetId:proof.targetId,backupRunId:completed.id,artifactId:completed.artifact_id,restoreRunId:proof.restoreRunId,sha256,bytes}
  await writeFile(recordPath,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});console.info(JSON.stringify(result))
 }finally{
  if(!revoked)await rest('/agents/'+agent.id+'/revoke',{}).catch(()=>{})
  await client?.close().catch(()=>{})
  // Retain all jobs/artifacts/holds; revocation never cancels native operations.
 }
},150000)
