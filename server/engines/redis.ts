import {createClient,RESP_TYPES} from 'redis'
import {createHash} from 'node:crypto'
import {open} from 'node:fs/promises'
import {createReadStream} from 'node:fs'
import {createInterface} from 'node:readline'
import {AppError,allowedHost} from '../security'
import {digest} from './database'
import type {AdapterOptions,EngineAdapter,Identity,Manifest,EnginePhase,ValidationComparison} from './types'

const maxKeys=5000,maxSnapshotBytes=64*1024*1024,maxKeyBytes=1024
type RedisWire={connect():Promise<unknown>;sendCommand(args:Array<string|Buffer>):Promise<unknown>;on(event:string,listener:()=>void):unknown;destroy():void;close():Promise<unknown>}
type Entry={key:string;payload:string;expiresAt:number;type:string}
type KeyDigest={type:string;sha256:string;expiresAt:number}
const text=(value:unknown)=>Buffer.isBuffer(value)?value.toString('utf8'):String(value)
const bytes=(value:unknown)=>{if(!Buffer.isBuffer(value))throw new AppError('REDIS_PROTOCOL','Redis did not return binary-safe native serialization.');return value}

// EVAL_RO permits no writes and runs atomically. An error returns no partial archive.
// The source owner must explicitly accept its finite server-blocking capture cost.
const captureScript=`
local maximumKeys=5000
local maximumBytes=67108864
if redis.call('DBSIZE')>maximumKeys then return redis.error_reply('STEELKEEP_KEY_LIMIT') end
local stamp=redis.call('TIME')
local capturedAt=tonumber(stamp[1])*1000+math.floor(tonumber(stamp[2])/1000)
local cursor='0'
local seen={}
local rows={}
local total=0
local iterations=0
repeat
  local page=redis.call('SCAN',cursor,'COUNT','256')
  cursor=page[1]
  for _,key in ipairs(page[2]) do
    if not seen[key] then
      seen[key]=true
      if #key>1024 then return redis.error_reply('STEELKEEP_KEY_SIZE_LIMIT') end
      local kind=redis.call('TYPE',key).ok
      if kind~='none' then
        if kind~='string' and kind~='list' and kind~='hash' and kind~='set' and kind~='zset' and kind~='stream' then return redis.error_reply('STEELKEEP_MODULE_TYPE_UNSUPPORTED') end
        local estimate=redis.call('MEMORY','USAGE',key,'SAMPLES','5')
        if estimate and estimate>maximumBytes then return redis.error_reply('STEELKEEP_VALUE_SIZE_LIMIT') end
        local payload=redis.call('DUMP',key)
        if payload then
          local expiry=redis.call('PEXPIRETIME',key)
          total=total+#payload+#key
          if total>maximumBytes then return redis.error_reply('STEELKEEP_SNAPSHOT_SIZE_LIMIT') end
          if #rows>=maximumKeys then return redis.error_reply('STEELKEEP_KEY_LIMIT') end
          table.insert(rows,{key,payload,expiry,kind})
        end
      end
    end
  end
  iterations=iterations+1
  if iterations>50000 then return redis.error_reply('STEELKEEP_SCAN_LIMIT') end
until cursor=='0'
return {capturedAt,rows}
`

export class RedisAdapter implements EngineAdapter {
  readonly engine='redis' as const
  readonly archiveExtension='.redis.ndjson'
  private failure=new AbortController()
  readonly failureSignal=this.failure.signal
  private client?:RedisWire
  private connected=false
  private closed=false
  private latestCaptureTime=0
  constructor(private options:AdapterOptions){}
  private check(){
    if(this.failureSignal.aborted)throw this.failureSignal.reason
    if(this.options.signal.aborted)throw new AppError('CANCELLED','Operation cancelled.')
  }
  private lost=()=>{
    if(this.closed)return
    this.failure.abort(new AppError('DATABASE_SESSION_LOST','Redis connection was lost; no further keys will be restored.'))
    try{this.client?.destroy()}catch{}
  }
  private abort=()=>{try{this.client?.destroy()}catch{}}
  private async command(args:Array<string|Buffer>,timeoutMs=15000):Promise<unknown>{
    this.check()
    if(!this.client||!this.connected)throw new AppError('DATABASE_UNAVAILABLE','The Redis connection is not open.')
    let timer:ReturnType<typeof setTimeout>|undefined
    try{
      return await Promise.race([this.client.sendCommand(args),new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{
          const error=new AppError('REDIS_TIMEOUT','Redis did not finish the bounded operation in time. The target remains reserved if writes may have begun.')
          this.failure.abort(error);this.abort();reject(error)
        },timeoutMs)
      })])
    }catch(error){
      if(error instanceof AppError)throw error
      // Keep driver text, AUTH details and key values out of responses and logs.
      throw new AppError('REDIS_COMMAND_FAILED','Redis refused the operation. Check the dedicated ACL, key limits, supported types and target emptiness.')
    }finally{clearTimeout(timer)}
  }
  async connect(){
    const c=this.options.config,host=String(c.host??''),index=Number(c.dbIndex)
    allowedHost(host)
    if(!Number.isInteger(index)||index<0||index>15)throw new AppError('INVALID_DATABASE','Redis database index must be between 0 and 15.')
    const socket=c.tls?{host,port:Number(c.port??6379),connectTimeout:5000,reconnectStrategy:false as const,tls:true as const,servername:host,rejectUnauthorized:true}:
      {host,port:Number(c.port??6379),connectTimeout:5000,reconnectStrategy:false as const}
    const client=createClient({socket,username:String(c.user??'default'),password:String(this.options.secret.password??''),database:index,disableOfflineQueue:true,commandsQueueMaxLength:32})
      .withTypeMapping({[RESP_TYPES.BLOB_STRING]:Buffer})
    this.client=client as unknown as RedisWire
    this.client.on('error',this.lost)
    this.options.signal.addEventListener('abort',this.abort,{once:true})
    this.check();await this.client.connect();this.connected=true
    return this.identity()
  }
  async identity():Promise<Identity>{
    const info=text(await this.command(['INFO'])),values=Object.fromEntries(info.split(/\r?\n/).filter(line=>line.includes(':')).map(line=>{const index=line.indexOf(':');return [line.slice(0,index),line.slice(index+1)]}))
    const version=String(values.redis_version??''),major=Number.parseInt(version)
    if(![7,8].includes(major)||values.redis_mode!=='standalone'||values.cluster_enabled==='1'||values.role!=='master')throw new AppError('UNSUPPORTED_TOPOLOGY','This release supports standalone primary Redis 7 or 8, with matching source and target major versions.')
    const client=text(await this.command(['CLIENT','INFO'])),selected=Number(client.match(/(?:^|\s)db=(\d+)(?:\s|$)/)?.[1])
    if(selected!==Number(this.options.config.dbIndex))throw new AppError('IDENTITY_UNCERTAIN','Redis did not confirm the configured database index.')
    return {engine:this.engine,database:`redis:${selected}`,serverVersion:version,binding:`${values.run_id}:${selected}`}
  }
  async empty(){return Number(await this.command(['DBSIZE']))===0}
  async restrictedRestoreRole(){
    if(!this.options.config.restoreTarget)throw new AppError('TARGET_NOT_DESIGNATED','Select a designated empty Redis database index.')
    await this.identity()
  }
  private async snapshot(){
    await this.options.checkpoint?.();this.check()
    const result=await this.command(['EVAL_RO',captureScript,'0'],60000)
    if(!Array.isArray(result)||result.length!==2||!Array.isArray(result[1]))throw new AppError('REDIS_PROTOCOL','Redis returned an invalid native snapshot.')
    const capturedAt=Number(result[0]),entries:Entry[]=[]
    if(!Number.isSafeInteger(capturedAt))throw new AppError('REDIS_PROTOCOL','Redis returned an invalid snapshot timestamp.')
    let total=0
    for(const raw of result[1]){
      if(!Array.isArray(raw)||raw.length!==4)throw new AppError('REDIS_PROTOCOL','Redis returned an invalid key record.')
      const key=bytes(raw[0]),payload=bytes(raw[1]),expiresAt=Number(raw[2]),type=text(raw[3])
      total+=key.length+payload.length
      if(key.length>maxKeyBytes||total>maxSnapshotBytes||entries.length>=maxKeys||!Number.isSafeInteger(expiresAt)||expiresAt< -1)throw new AppError('RESOURCE_LIMIT','Redis snapshot exceeds its key or size limit.')
      entries.push({key:key.toString('base64'),payload:payload.toString('base64'),expiresAt,type})
    }
    this.latestCaptureTime=capturedAt
    return {capturedAt,entries}
  }
  private async describe(snapshot:Awaited<ReturnType<RedisAdapter['snapshot']>>):Promise<Manifest>{
    const data:Record<string,KeyDigest>={}
    for(const entry of snapshot.entries.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)){
      if(data[entry.key])throw new AppError('REDIS_PROTOCOL','Redis snapshot contains a duplicate key.')
      data[entry.key]={type:entry.type,sha256:createHash('sha256').update(Buffer.from(entry.payload,'base64')).digest('hex'),expiresAt:entry.expiresAt}
    }
    return {format:1,...await this.identity(),objects:{serialization:'native-DUMP',scope:'selected-logical-database'},data,sequences:{}}
  }
  async manifest(){return this.describe(await this.snapshot())}
  async backup(file:string,_dir:string,_signal:AbortSignal,phase:EnginePhase){
    if(!this.options.config.allowGlobalReadLock)throw new AppError('SOURCE_LOCK_OPT_IN','Explicitly allow the bounded atomic Redis read script before backup.')
    await phase('dumping','Capturing native Redis DUMP values atomically with absolute expiry times (maximum 5,000 keys and 64 MiB).')
    const snapshot=await this.snapshot(),manifest=await this.describe(snapshot),output=await open(file,'wx',0o600)
    try{
      await output.writeFile(JSON.stringify({format:'steelkeep-redis-dump-v1',database:manifest.database,capturedAt:snapshot.capturedAt,serverVersion:manifest.serverVersion,records:snapshot.entries.length})+'\n')
      for(const entry of snapshot.entries){this.check();await output.writeFile(JSON.stringify(entry)+'\n')}
    }finally{await output.close()}
    return {manifest,toolVersion:`Redis ${manifest.serverVersion}: native EVAL_RO / DUMP`}
  }
  async restore(file:string,_dir:string,_signal:AbortSignal,expected:Manifest){
    const identity=await this.identity()
    if(Number.parseInt(identity.serverVersion)!==Number.parseInt(expected.serverVersion))throw new AppError('VERSION_MISMATCH','Redis source and target must use the same major version.')
    if(identity.database===expected.database||identity.binding===expected.binding)throw new AppError('SOURCE_TARGET_CONFLICT','Restore must use a different Redis database index from the source.')
    if(!await this.empty())throw new AppError('TARGET_NOT_EMPTY','The designated Redis target contains keys.')
    const input=createReadStream(file),lines=createInterface({input,crlfDelay:Infinity}),seen=new Set<string>()
    let header:Record<string,unknown>|undefined,total=0,records=0
    try{
      for await(const line of lines){
        this.check()
        if(line.length>maxSnapshotBytes*2)throw new AppError('RESOURCE_LIMIT','Redis archive record exceeds its size limit.')
        const record=JSON.parse(line) as Record<string,unknown>
        if(!header){
          header=record
          if(header.format!=='steelkeep-redis-dump-v1'||header.database!==expected.database||!Number.isInteger(header.records)||Number(header.records)>maxKeys)throw new AppError('INVALID_ARCHIVE','Redis archive header does not match its trusted manifest.')
          continue
        }
        const entry=record as unknown as Entry,source=expected.data[entry.key] as KeyDigest|undefined
        if(!source||seen.has(entry.key)||typeof entry.key!=='string'||typeof entry.payload!=='string'||entry.type!==source.type||entry.expiresAt!==source.expiresAt)throw new AppError('INVALID_ARCHIVE','Redis archive record differs from its trusted source manifest.')
        const key=Buffer.from(entry.key,'base64'),payload=Buffer.from(entry.payload,'base64')
        total+=key.length+payload.length;records++
        if(key.toString('base64')!==entry.key||payload.toString('base64')!==entry.payload||key.length>maxKeyBytes||total>maxSnapshotBytes||records>maxKeys||createHash('sha256').update(payload).digest('hex')!==source.sha256)throw new AppError('INVALID_ARCHIVE','Redis native value failed archive validation.')
        seen.add(entry.key)
        await this.options.checkpoint?.();this.check()
        const now=await this.command(['TIME'])
        if(!Array.isArray(now)||now.length!==2)throw new AppError('REDIS_PROTOCOL','Redis did not report its current time.')
        const milliseconds=Number(text(now[0]))*1000+Math.floor(Number(text(now[1]))/1000)
        if(entry.expiresAt>=0&&entry.expiresAt<=milliseconds)continue
        // No REPLACE and no FLUSH: a concurrent/preexisting key is an error.
        await this.command(['RESTORE',key,String(entry.expiresAt<0?0:entry.expiresAt),payload,'ABSTTL'])
      }
    }finally{lines.close();input.destroy()}
    if(!header||records!==Number(header.records)||seen.size!==Object.keys(expected.data).length)throw new AppError('INVALID_ARCHIVE','Redis archive is incomplete.')
    return {toolVersion:`Redis ${identity.serverVersion}: native RESTORE ABSTTL`}
  }
  compare(expected:Manifest,actual:Manifest):ValidationComparison{
    const cutoff=this.latestCaptureTime
    const remaining=(data:Record<string,unknown>)=>Object.fromEntries(Object.entries(data).filter(([,raw])=>{
      const key=raw as KeyDigest;return key.expiresAt<0||key.expiresAt>cutoff
    }).sort(([a],[b])=>a<b?-1:a>b?1:0))
    const checks={schema:digest(expected.objects)===digest(actual.objects),data:digest(remaining(expected.data))===digest(remaining(actual.data)),sequences:true}
    return {passed:Object.values(checks).every(Boolean),checks,tableCount:Object.keys(remaining(expected.data)).length,method:'native-redis-DUMP-sha256-and-absolute-expiry',note:'Keys naturally expired by the target atomic validation timestamp are excluded. Live keys must retain native serialization, type and exact absolute expiry. Redis functions/modules and other logical databases are outside this backup.'}
  }
  async close(){
    if(this.closed)return;this.closed=true
    this.options.signal.removeEventListener('abort',this.abort)
    try{await this.client?.close()}catch{try{this.client?.destroy()}catch{}}
    this.connected=false
  }
}

export const createRedisAdapter=(options:AdapterOptions):EngineAdapter=>new RedisAdapter(options)
