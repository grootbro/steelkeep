import {S3Client,CreateBucketCommand,HeadBucketCommand} from '@aws-sdk/client-s3'
import {config} from '../server/config'

if(process.env.STEELKEEP_ACCEPTANCE!=='synthetic-local-clickhouse')throw new Error('Explicit synthetic-local-clickhouse opt-in required')
const token=config.token(),base='http://127.0.0.1:4311/api/v1'
async function request<T>(path:string,body?:unknown):Promise<T>{
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})
  if(!response.ok)throw new Error(`ClickHouse fixture API ${path} failed (${response.status})`)
  return response.json() as Promise<T>
}
const client=new S3Client({endpoint:'http://127.0.0.1:54373',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'steelkeep-local',secretAccessKey:'local-s3-fixture-only'}})
try{
  try{await client.send(new HeadBucketCommand({Bucket:'steelkeep-clickhouse-fixture'}))}catch(error){
    if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==404)throw new Error('Cannot establish fixture bucket absence; refusing blind create')
    await client.send(new CreateBucketCommand({Bucket:'steelkeep-clickhouse-fixture'}))
  }
}finally{client.destroy()}
const existing=await request<{id:string;name:string}[]>('/connections')
async function connection(name:string,input:Record<string,unknown>){
  // Do not silently reuse a same-name profile pointing elsewhere.
  if(existing.some(row=>row.name===name))throw new Error('ClickHouse fixture already registered; inspect existing connections rather than reseeding blindly')
  return request<{id:string}>('/connections',{name,...input})
}
const common={kind:'clickhouse',host:'clickhouse-fixture',port:8123,tls:false,backupDisk:'steelkeep_backup',sharedBackupRoot:'/steelkeep-clickhouse-backups'}
const source=await connection('ClickHouse · fixture',{...common,database:'fixture_ch_source',user:'backup_reader',password:'local-clickhouse-reader-only',quiescentSource:true})
const target=await connection('ClickHouse recovery · fixture',{...common,database:'fixture_ch_target',user:'restore_writer',password:'local-clickhouse-writer-only',restoreTarget:true})
const storage=await connection('ClickHouse S3 · fixture',{kind:'s3',endpoint:'http://s3:9000',bucket:'steelkeep-clickhouse-fixture',region:'us-east-1',prefix:'clickhouse',accessKey:'steelkeep-local',secretKey:'local-s3-fixture-only'})
for(const row of [source,target,storage])if((await request<{status:string}>(`/connections/${row.id}/test`,{})).status!=='available')throw new Error('ClickHouse fixture connection check failed; no acceptance claimed')
const plan=await request<{id:string}>('/plans',{name:'ClickHouse fixture',sourceId:source.id,storageId:storage.id,timezone:'UTC'})
console.log(JSON.stringify({sourceId:source.id,targetId:target.id,storageId:storage.id,planId:plan.id}))
