import {S3Client,CreateBucketCommand,HeadBucketCommand} from '@aws-sdk/client-s3'
import {config} from '../server/config'
const token=config.token(),base='http://127.0.0.1:4311/api/v1'
async function request<T>(path:string,body?:unknown):Promise<T>{
  const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})
  if(!r.ok)throw new Error(`Fixture setup failed: ${path} (${r.status})`)
  return r.json() as Promise<T>
}
const client=new S3Client({endpoint:'http://127.0.0.1:54373',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'steelkeep-local',secretAccessKey:'local-s3-fixture-only'}})
try{await client.send(new HeadBucketCommand({Bucket:'steelkeep-fixture'}))}catch{await client.send(new CreateBucketCommand({Bucket:'steelkeep-fixture'}))}finally{client.destroy()}
const existing=await request<{id:string;name:string}[]>('/connections')
async function connection(name:string,input:Record<string,unknown>){return existing.find(x=>x.name===name)??request<{id:string;name:string}>('/connections',{name,...input})}
const source=await connection('Application · fixture',{kind:'postgres',host:'fixture',port:5432,database:'source',user:'backup_reader',password:'local-reader-only',tls:false})
const target=await connection('Recovery · fixture',{kind:'postgres',host:'fixture',port:5432,database:'restore_target',user:'restore_writer',password:'local-writer-only',tls:false,restoreTarget:true})
const storage=await connection('Local S3 · RustFS',{kind:'s3',endpoint:'http://s3:9000',bucket:'steelkeep-fixture',region:'us-east-1',prefix:'steelkeep',accessKey:'steelkeep-local',secretKey:'local-s3-fixture-only'})
for(const row of [source,target,storage]){
  const result=await request<{status:string}>(`/connections/${row.id}/test`,{})
  if(result.status!=='available')throw new Error('Fixture connection check did not pass')
}
const plans=await request<{id:string;name:string}[]>('/plans')
const plan=plans.find(x=>x.name==='PostgreSQL fixture')??await request<{id:string}>('/plans',{name:'PostgreSQL fixture',sourceId:source.id,storageId:storage.id,timezone:'Asia/Bangkok'})
const mariaSource=await connection('MariaDB · fixture',{kind:'mariadb',host:'mysql-fixture',port:3306,database:'source_mysql',user:'backup_reader',password:'local-mysql-reader-only',tls:false,allowGlobalReadLock:true})
const mariaTarget=await connection('MariaDB recovery · fixture',{kind:'mariadb',host:'mysql-fixture',port:3306,database:'restore_mysql',user:'restore_writer',password:'local-mysql-writer-only',tls:false,restoreTarget:true})
for(const row of [mariaSource,mariaTarget]){
  const result=await request<{status:string}>(`/connections/${row.id}/test`,{})
  if(result.status!=='available')throw new Error('MariaDB fixture connection check did not pass')
}
const mariaPlan=plans.find(x=>x.name==='MariaDB fixture')??await request<{id:string}>('/plans',{name:'MariaDB fixture',sourceId:mariaSource.id,storageId:storage.id,timezone:'Asia/Bangkok'})
console.log(JSON.stringify({postgres:{sourceId:source.id,targetId:target.id,planId:plan.id},mariadb:{sourceId:mariaSource.id,targetId:mariaTarget.id,planId:mariaPlan.id},storageId:storage.id}))
