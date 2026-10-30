import mysql,{type RowDataPacket} from 'mysql2/promise'
import {readFile} from 'node:fs/promises'
import {dirname,resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'

// Manual, opt-in configuration only. No server/image is started by this script.
if(process.env.STEELKEEP_ACCEPTANCE!=='synthetic-local-mysql')throw new Error('Set STEELKEEP_ACCEPTANCE=synthetic-local-mysql only for the isolated MySQL 8 fixture.')
const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'..'),base='http://127.0.0.1:4311/api/v1'
const token=(await readFile(join(workspace,'.steelkeep','token'),'utf8')).trim()
if(token.length<32)throw new Error('Prepare the local fixture installation token first.')
const admin=await mysql.createConnection({host:'127.0.0.1',port:54379,user:'root',password:'local-mysql8-admin-only',connectTimeout:5000,supportBigNumbers:true,bigNumberStrings:true})
let version='',seedTargetEmpty=false
try{
  const [server]=await admin.query<RowDataPacket[]>('SELECT VERSION() AS version,@@version_comment AS vendor')
  version=String(server[0].version)
  if(!/^8\.0\.46(?:\D|$)/.test(version)||/mariadb/i.test(version+' '+String(server[0].vendor)))throw new Error('The independent fixture must be actual MySQL 8.0.46, not MariaDB or another server profile.')
  const [marker]=await admin.query<RowDataPacket[]>('SELECT name FROM source_mysql8.projects WHERE id=1')
  const [jsonType]=await admin.query<RowDataPacket[]>("SELECT DATA_TYPE AS kind FROM information_schema.columns WHERE table_schema='source_mysql8' AND table_name='entries' AND column_name='payload'")
  if(marker[0]?.name!=='Synthetic MySQL 8 fixture'||jsonType[0]?.kind!=='json')throw new Error('The loopback database is not the expected synthetic MySQL 8 fixture; no source data was changed.')
  const [target]=await admin.query<RowDataPacket[]>("SELECT count(*) AS objects FROM information_schema.tables WHERE table_schema='restore_mysql8'")
  seedTargetEmpty=Number(target[0].objects)===0
}finally{await admin.end()}
async function request<T>(path:string,body?:unknown):Promise<T>{
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)})
  if(!response.ok)throw new Error(`MySQL 8 fixture API ${path} failed (${response.status}); credentials are omitted.`)
  return response.json() as Promise<T>
}
type Connection={id:string;name:string;kind:string;config:Record<string,unknown>}
const existing=await request<Connection[]>('/connections')
const storage=existing.find(row=>row.name==='Local S3 · RustFS'&&row.kind==='s3'&&row.config.endpoint==='http://s3:9000'&&row.config.bucket==='steelkeep-fixture')
if(!storage)throw new Error('Seed the base local fixture S3 connection first. No replacement or remote storage is created here.')
async function connection(name:string,input:Record<string,unknown>){
  const found=existing.find(row=>row.name===name)
  if(found){
    if(found.kind!=='mysql'||['host','port','database','user','tls','restoreTarget','allowGlobalReadLock'].some(key=>input[key]!==undefined&&found.config[key]!==input[key]))throw new Error('Existing MySQL 8 fixture name has different configuration; it was not overwritten.')
    return found
  }
  return request<{id:string}>('/connections',{name,...input})
}
const source=await connection('MySQL 8 · independent fixture',{kind:'mysql',host:'mysql8-fixture',port:3306,database:'source_mysql8',user:'backup_reader',password:'local-mysql8-reader-only',tls:false,restoreTarget:false,allowGlobalReadLock:true})
const target=await connection('MySQL 8 recovery · independent fixture',{kind:'mysql',host:'mysql8-fixture',port:3306,database:'restore_mysql8',user:'restore_writer',password:'local-mysql8-writer-only',tls:false,restoreTarget:true})
for(const row of [source,target]){
  const result=await request<{status:string}>(`/connections/${row.id}/test`,{})
  if(result.status!=='available')throw new Error('MySQL 8 read-only connection inspection failed. Native recovery has not been accepted.')
}
const plans=await request<Array<{id:string;name:string;source_id:string;storage_id:string}>>('/plans'),name='MySQL 8 independent fixture'
const found=plans.find(plan=>plan.name===name)
if(found&&(found.source_id!==source.id||found.storage_id!==storage.id))throw new Error('Existing fixture plan points elsewhere; it was not replaced.')
const plan=found??await request<{id:string}>('/plans',{name,sourceId:source.id,storageId:storage.id,timezone:'Asia/Bangkok'})
console.log(JSON.stringify({serverVersion:version,sourceId:source.id,targetId:target.id,planId:plan.id,storageId:storage.id,seedTargetEmpty,recoveryAcceptance:'not-run',notice:'Prior target data is retained. The acceptance suite provisions a fresh empty target for each run.'}))
