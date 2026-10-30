import {test,expect} from 'bun:test'
import {randomBytes,randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import pg from 'pg'
import {S3Client,HeadBucketCommand} from '@aws-sdk/client-s3'

// Opt-in native negative acceptance; authoring/typechecking is not runtime proof.
const acceptance=process.env.STEELKEEP_ACCEPTANCE==='synthetic-local-storage-failures'?test:test.skip
const workspace=resolve(import.meta.dir,'..'),base='http://127.0.0.1:4311/api/v1'
type Connection={id:string;name:string;kind:string;config:Record<string,unknown>}
type Job={id:string;status:string;attempt:number;artifact_id:string|null;error_code:string|null;events?:Array<{phase:string;message:string}>}
const fixtureCredentials={accessKeyId:'steelkeep-local',secretAccessKey:'local-s3-fixture-only'}

acceptance('native PostgreSQL backups: missing bucket and denied credentials fail once without artifact publication',async()=>{
  const token=(await readFile(resolve(workspace,'.steelkeep/token'),'utf8')).trim()
  if(token.length<32)throw new Error('Prepare the isolated installation token first.')
  const suffix=randomBytes(10).toString('hex'),missingBucket='steelkeep-absent-'+suffix
  const invalidCredentials={accessKeyId:'invalid-'+suffix,secretAccessKey:randomBytes(32).toString('hex')}
  const secrets=[token,fixtureCredentials.secretAccessKey,invalidCredentials.accessKeyId,invalidCredentials.secretAccessKey,'local-reader-only']
  function safe(value:unknown){
    const serialized=JSON.stringify(value)
    expect(secrets.some(secret=>serialized.includes(secret))).toBe(false)
    expect(['NoSuchBucket','InvalidAccessKeyId','SignatureDoesNotMatch','AccessDenied','$metadata','RequestId','HostId','x-amz-'].some(raw=>serialized.includes(raw))).toBe(false)
  }
  async function api<T>(path:string,body?:unknown):Promise<T>{
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)})
    if(!response.ok)throw new Error(`Isolated storage acceptance API request failed (${response.status}); diagnostics withheld.`)
    const data=await response.json();safe(data);return data as T
  }
  async function headBucket(bucket:string,credentials=fixtureCredentials){
    const client=new S3Client({endpoint:'http://127.0.0.1:54373',region:'us-east-1',forcePathStyle:true,maxAttempts:1,credentials})
    try{await client.send(new HeadBucketCommand({Bucket:bucket}),{abortSignal:AbortSignal.timeout(10000)});return 200}
    catch(error){const status=(error as {$metadata?:{httpStatusCode?:unknown}}).$metadata?.httpStatusCode;return typeof status==='number'?status:0}
    finally{client.destroy()}
  }
  async function fixtureTotals(){
    const client=new pg.Client({host:'127.0.0.1',port:54372,database:'source',user:'backup_reader',password:'local-reader-only',connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000})
    try{await client.connect();const row=(await client.query<{n:string;total:string}>('SELECT count(*)::text AS n,sum(amount)::text AS total FROM entries')).rows[0];expect(row.n).toBe('1000');expect(row.total).toBe('625625.00');return row}
    catch{throw new Error('The fixed synthetic PostgreSQL source totals could not be verified; diagnostics withheld.')}
    finally{await client.end()}
  }
  // Fixed metadata endpoint only, ignoring DATABASE_URL; queries below are read-only.
  const metadata=new pg.Client({host:'127.0.0.1',port:54371,database:'steelkeep',user:'steelkeep',password:'local-metadata-only',connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000})
  try{
    const connections=await api<Connection[]>('/connections')
    const source=connections.find(row=>row.name==='Application · fixture'&&row.kind==='postgres'&&row.config.host==='fixture'&&row.config.port===5432&&row.config.database==='source'&&row.config.user==='backup_reader'&&row.config.tls===false&&!row.config.restoreTarget)
    const storage=connections.find(row=>row.name==='Local S3 · RustFS'&&row.kind==='s3'&&row.config.endpoint==='http://s3:9000'&&row.config.bucket==='steelkeep-fixture'&&row.config.region==='us-east-1')
    if(!source||!storage)throw new Error('Exact isolated PostgreSQL and RustFS profiles are required; arbitrary saved profiles are refused.')
    expect(await headBucket('steelkeep-fixture')).toBe(200)
    expect(await headBucket(missingBucket)).toBe(404)
    expect([401,403].includes(await headBucket('steelkeep-fixture',invalidCredentials))).toBe(true)
    const before=await fixtureTotals()
    await metadata.connect()
    const identity=await metadata.query<{database:string;role:string}>('SELECT current_database() AS database,current_user AS role')
    expect(identity.rows[0].database).toBe('steelkeep');expect(identity.rows[0].role).toBe('steelkeep')
    const cases=[
      {name:'missing bucket',bucket:missingBucket,credentials:fixtureCredentials,code:'STORAGE_BUCKET_MISSING'},
      {name:'denied credentials',bucket:'steelkeep-fixture',credentials:invalidCredentials,code:'STORAGE_ACCESS_DENIED'}
    ]
    const failed:Array<{id:string;code:string}>=[]
    for(const scenario of cases){
      const destination=await api<{id:string}>('/connections',{name:'Storage refusal '+scenario.name+' '+suffix,kind:'s3',endpoint:'http://s3:9000',bucket:scenario.bucket,region:'us-east-1',prefix:'acceptance-failures/'+suffix,accessKey:scenario.credentials.accessKeyId,secretKey:scenario.credentials.secretAccessKey})
      const plan=await api<{id:string}>('/plans',{name:'Storage refusal '+scenario.name+' '+suffix,sourceId:source.id,storageId:destination.id,cron:null,timezone:'UTC'})
      const idempotencyKey=randomUUID(),accepted=await api<Job>(`/plans/${plan.id}/run`,{idempotencyKey})
      expect(['queued','running'].includes(accepted.status)).toBe(true)
      expect((await api<Job>(`/plans/${plan.id}/run`,{idempotencyKey})).id).toBe(accepted.id)
      let terminal:Job|undefined
      const deadline=Date.now()+45000
      while(Date.now()<deadline){
        const job=await api<Job>(`/jobs/${accepted.id}`)
        if(['succeeded','failed','cancelled','interrupted'].includes(job.status)){terminal=job;break}
        await new Promise(resolve=>setTimeout(resolve,250))
      }
      if(!terminal)throw new Error('Storage refusal backup did not reach a terminal state within 45 seconds; retained for inspection.')
      expect(terminal.status).toBe('failed');expect(terminal.attempt).toBe(1)
      expect(terminal.error_code).toBe(scenario.code);expect(terminal.artifact_id).toBe(null)
      expect(terminal.events?.some(event=>event.phase==='uploading')).toBe(true)
      expect(terminal.events?.some(event=>['completed','publishing','retry_wait'].includes(event.phase))).toBe(false)
      failed.push({id:terminal.id,code:scenario.code})
    }
    // Observe BOTH terminal jobs for 12 seconds; this is a bounded no-retry window.
    const observeUntil=Date.now()+12000
    while(Date.now()<observeUntil){
      for(const expected of failed){
        const job=await api<Job>(`/jobs/${expected.id}`)
        expect(job.status).toBe('failed');expect(job.attempt).toBe(1);expect(job.error_code).toBe(expected.code);expect(job.artifact_id).toBe(null)
        expect(job.events?.some(event=>['completed','retry_wait'].includes(event.phase))).toBe(false)
        const counts=await metadata.query<{artifacts:string;outbox:string}>('SELECT (SELECT count(*) FROM artifacts WHERE run_id=$1)::text AS artifacts,(SELECT count(*) FROM outbox WHERE run_id=$1)::text AS outbox',[expected.id])
        expect(counts.rows[0].artifacts).toBe('0');expect(counts.rows[0].outbox).toBe('1')
      }
      await new Promise(resolve=>setTimeout(resolve,500))
    }
    expect(await fixtureTotals()).toEqual(before)
  }finally{await metadata.end()}
  // Retain new connections, manual plans, failed runs and any orphan object; no cleanup/reset.
},135000)
