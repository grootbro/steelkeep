import {AppError} from '../security'

const api='https://www.googleapis.com/drive/v3'
const uploads='https://www.googleapis.com/upload/drive/v3/files'
const folderMime='application/vnd.google-apps.folder'
const maxJsonBytes=1024*1024,maxBytes=2*1024*1024*1024,chunkBytes=4*1024*1024
const fields='id,name,mimeType,parents,size,version,modifiedTime,trashed,driveId,sha256Checksum,md5Checksum,appProperties,properties,capabilities(canDownload,canAddChildren)'
export type DriveFile={id:string;name:string;mimeType:string;parents:string[];version:string;trashed:boolean;size?:string;modifiedTime?:string;driveId?:string;sha256Checksum?:string;md5Checksum?:string;appProperties?:Record<string,string>;properties?:Record<string,string>;capabilities:{canDownload?:boolean;canAddChildren?:boolean}}
export type DriveAccount={permissionId:string;emailAddress?:string;displayName?:string}
export type DriveContent={body:AsyncIterable<Uint8Array>;size?:number;close():void}
export type DriveClientOptions={getAccessToken:(signal:AbortSignal,forceRefresh?:boolean)=>Promise<string>;signal:AbortSignal;fetch?:typeof globalThis.fetch;maxFileBytes?:number}
type NewFile={id:string;parentId:string;name:string;appProperties?:Record<string,string>;properties?:Record<string,string>}
const formats:Record<string,{mimeType:string;extension:string}>={
 'application/vnd.google-apps.document':{mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',extension:'.docx'},
 'application/vnd.google-apps.spreadsheet':{mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',extension:'.xlsx'},
 'application/vnd.google-apps.presentation':{mimeType:'application/vnd.openxmlformats-officedocument.presentationml.presentation',extension:'.pptx'},
 'application/vnd.google-apps.drawing':{mimeType:'image/png',extension:'.png'}
}
export function driveExportFormat(mimeType:string){const format=Object.hasOwn(formats,mimeType)?formats[mimeType]:undefined;return format?{...format}:undefined}
export function driveId(value:string){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{10,200}$/.test(value))throw new AppError('GOOGLE_DRIVE_INVALID_ID','Choose a concrete Google Drive file or folder identifier.');return value}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();return value as Record<string,unknown>}
function invalid(){return new AppError('GOOGLE_DRIVE_INVALID_RESPONSE','Google Drive returned incomplete or invalid metadata.',502)}
function text(value:unknown,max=1024){if(typeof value!=='string'||!value.length||value.length>max||/[\0\r\n]/.test(value))throw invalid();return value}
function integer(value:unknown){if(typeof value!=='string'||!/^(0|[1-9]\d{0,19})$/.test(value)||BigInt(value)>9223372036854775807n)throw invalid();return value}
function mime(value:string){if(typeof value!=='string'||value.length>255||!/^[-\w!#$&^_.+]+\/[-\w!#$&^_.+]+$/.test(value))throw new AppError('GOOGLE_DRIVE_INVALID_MIME','Use a valid file content type.');return value}
function properties(value:unknown){
 const record=object(value);if(Object.keys(record).length>30)throw invalid()
 const result:Record<string,string>={}
 for(const [key,item] of Object.entries(record)){const entry=text(item,124);if(!key||/[\0\r\n]/.test(key)||Buffer.byteLength(key)+Buffer.byteLength(entry)>124)throw invalid();Object.defineProperty(result,key,{value:entry,enumerable:true,writable:true,configurable:true})}
 return result
}
export function driveFile(value:unknown):DriveFile{
 const file=object(value),capabilities=file.capabilities===undefined?{}:object(file.capabilities)
 if(file.trashed!==undefined&&typeof file.trashed!=='boolean'||!Array.isArray(file.parents)&&file.parents!==undefined||Array.isArray(file.parents)&&file.parents.length>100)throw invalid()
 const result:DriveFile={id:driveId(text(file.id,200)),name:text(file.name),mimeType:mime(text(file.mimeType,255)),parents:((file.parents??[]) as unknown[]).map(parent=>driveId(text(parent,200))),version:integer(file.version),trashed:file.trashed===true,capabilities:{}}
 for(const key of ['canDownload','canAddChildren'] as const){if(capabilities[key]!==undefined){if(typeof capabilities[key]!=='boolean')throw invalid();result.capabilities[key]=capabilities[key]}}
 if(file.size!==undefined)result.size=integer(file.size)
 if(file.modifiedTime!==undefined){const time=text(file.modifiedTime,80);if(!Number.isFinite(Date.parse(time)))throw invalid();result.modifiedTime=time}
 if(file.driveId!==undefined)result.driveId=driveId(text(file.driveId,200))
 for(const [key,length] of [['sha256Checksum',64],['md5Checksum',32]] as const)if(file[key]!==undefined){const hash=text(file[key],length);if(!new RegExp(`^[a-f0-9]{${length}}$`,'i').test(hash))throw invalid();result[key]=hash.toLowerCase()}
 if(file.appProperties!==undefined)result.appProperties=properties(file.appProperties)
 if(file.properties!==undefined)result.properties=properties(file.properties)
 return result
}
async function json(response:Response):Promise<unknown>{
 if(!response.body)throw invalid();const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>maxJsonBytes)throw invalid();parts.push(part.value)}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown}catch{throw invalid()}
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
}
function pause(ms:number,signal:AbortSignal){return new Promise<void>((resolve,reject)=>{
 if(signal.aborted){reject(signal.reason);return}const done=()=>{signal.removeEventListener('abort',abort);resolve()},timer=setTimeout(done,ms),abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason)};signal.addEventListener('abort',abort,{once:true})
})}
function requestFailure(status:number,write:boolean){
 if(status===401)return new AppError('GOOGLE_DRIVE_AUTH_REQUIRED','Reconnect the Google Drive account before continuing.',401)
 if(status===403)return new AppError('GOOGLE_DRIVE_ACCESS_DENIED','Google Drive refused this operation. Check the granted permissions.',403)
 if(status===404)return new AppError('GOOGLE_DRIVE_NOT_FOUND','The selected Google Drive resource is unavailable.',404)
 if(status===409)return new AppError('GOOGLE_DRIVE_ID_CONFLICT','The requested Google Drive identifier already exists. Reconcile that exact identifier before continuing.',409)
 if(write&&status>=500)return new AppError('GOOGLE_DRIVE_WRITE_UNCERTAIN','Google Drive did not confirm the write. Reconcile its existing identifier before another operation.',409)
 if(status===429||status>=500)return new AppError('GOOGLE_DRIVE_UNAVAILABLE','Google Drive is temporarily unavailable. Try again later.',503)
 return new AppError('GOOGLE_DRIVE_REQUEST_REFUSED','Google Drive refused the request.',400)
}
function sessionUrl(value:string){
 let url:URL;try{url=new URL(value)}catch{throw invalid()}
 if(url.origin!=='https://www.googleapis.com'||url.username||url.password||url.hash||url.pathname!=='/upload/drive/v3/files'||!url.searchParams.get('upload_id')||url.searchParams.has('uploadType')&&url.searchParams.get('uploadType')!=='resumable'||[...url.searchParams.keys()].some(key=>!['uploadType','upload_id','supportsAllDrives','fields'].includes(key))||value.length>8192)throw invalid()
 return url
}

/** Fixed Google endpoints only; injected transport is for isolated synthetic tests. */
export class GoogleDriveClient{
 private fetch:typeof globalThis.fetch
 private limit:number
 constructor(private options:DriveClientOptions){
  this.fetch=options.fetch??globalThis.fetch;this.limit=options.maxFileBytes??maxBytes
  if(!Number.isSafeInteger(this.limit)||this.limit<1||this.limit>maxBytes)throw new AppError('GOOGLE_DRIVE_INVALID_LIMIT','Use a file limit between one byte and 2 GiB.')
 }
 private url(path:string,query:Record<string,string>={}){const url=new URL(api+path);for(const [key,value] of Object.entries(query))url.searchParams.set(key,value);return url}
 private async request(url:URL,init:RequestInit={},accept:number[]=[],timeout=30000){
  const method=init.method??'GET',read=method==='GET',signal=AbortSignal.any([this.options.signal,AbortSignal.timeout(timeout)])
  let forceRefresh=false
  for(let attempt=0;attempt<3;attempt++){
   signal.throwIfAborted();const token=await this.options.getAccessToken(signal,forceRefresh)
   if(typeof token!=='string'||!token||token.length>8192||/[\r\n\0]/.test(token))throw new AppError('GOOGLE_DRIVE_AUTH_REQUIRED','Reconnect the Google Drive account before continuing.',401)
   let response:Response
   try{const headers=new Headers(init.headers);headers.set('authorization','Bearer '+token);response=await this.fetch(url,{...init,method,headers,signal,redirect:'error',credentials:'omit',cache:'no-store'})}
   catch{
    if(signal.aborted){if(signal.reason instanceof AppError)throw signal.reason;throw new AppError('GOOGLE_DRIVE_CANCELLED','The Google Drive request was cancelled or timed out.',408)}
    if(read&&attempt<2){await pause(250*2**attempt,signal);continue}
    throw new AppError(read?'GOOGLE_DRIVE_UNAVAILABLE':'GOOGLE_DRIVE_WRITE_UNCERTAIN',read?'Google Drive could not complete this read.':'Google Drive did not confirm the write. Reconcile its existing identifier before another operation.',read?503:409)
   }
   if(response.ok||accept.includes(response.status))return response
   let rateLimited=response.status===429
   if(read&&response.status===403){try{const data=object(await json(response)),error=object(data.error);rateLimited=Array.isArray(error.errors)&&error.errors.some(item=>{const reason=object(item).reason;return reason==='rateLimitExceeded'||reason==='userRateLimitExceeded'})}catch{/* Provider error bodies are never exposed. */}}
   const refresh=read&&response.status===401&&!forceRefresh,again=read&&attempt<2&&(refresh||rateLimited||response.status>=500)
   await response.body?.cancel().catch(()=>{})
   if(!again)throw requestFailure(response.status,!read)
   if(refresh)forceRefresh=true
   else{const retryAfter=response.headers.get('retry-after'),after=retryAfter===null?NaN:Number(retryAfter);await pause(Number.isFinite(after)&&after>=0?Math.min(2000,after*1000):250*2**attempt,signal)}
  }
  throw new AppError('GOOGLE_DRIVE_UNAVAILABLE','Google Drive could not complete this request.',503)
 }
 async account():Promise<DriveAccount>{
  const result=object(await json(await this.request(this.url('/about',{fields:'user(permissionId,emailAddress,displayName)'})))),user=object(result.user)
  const permissionId=text(user.permissionId,200);if(!/^[A-Za-z0-9_-]+$/.test(permissionId))throw invalid()
  return {permissionId,...(user.emailAddress===undefined?{}:{emailAddress:text(user.emailAddress,320)}),...(user.displayName===undefined?{}:{displayName:text(user.displayName,200)})}
 }
 async metadata(id:string){const file=driveFile(await json(await this.request(this.url('/files/'+driveId(id),{fields,supportsAllDrives:'true'}))));if(file.id!==id)throw invalid();return file}
 async children(folderId:string,options:{driveId?:string;pageToken?:string}={}):Promise<{files:DriveFile[];nextPageToken?:string}>{
  const query:Record<string,string>={q:`'${driveId(folderId)}' in parents and trashed = false`,pageSize:'100',fields:`files(${fields}),nextPageToken,incompleteSearch`,supportsAllDrives:'true',includeItemsFromAllDrives:'true',spaces:'drive'}
  if(options.driveId){query.corpora='drive';query.driveId=driveId(options.driveId)}else query.corpora='user'
  if(options.pageToken)query.pageToken=text(options.pageToken,4096)
  const result=object(await json(await this.request(this.url('/files',query))))
  if(result.incompleteSearch===true)throw new AppError('GOOGLE_DRIVE_INCOMPLETE_LIST','Google Drive could not enumerate the entire selected folder. The backup was not completed.',409)
  if(!Array.isArray(result.files)||result.files.length>100)throw invalid()
  const files=result.files.map(driveFile);if(files.some(file=>file.trashed||!file.parents.includes(folderId)))throw invalid()
  return {files,...(result.nextPageToken===undefined?{}:{nextPageToken:text(result.nextPageToken,4096)})}
 }
 private content(response:Response,limit:number,expected?:number):DriveContent{
  if(response.status!==200||response.headers.has('content-range')){void response.body?.cancel().catch(()=>{});throw invalid()}
  const header=response.headers.get('content-length');let length:number|undefined
  if(header!==null){if(!/^\d+$/.test(header)||!Number.isSafeInteger(Number(header))||Number(header)>limit){void response.body?.cancel().catch(()=>{});throw new AppError('GOOGLE_DRIVE_FILE_TOO_LARGE','The Google Drive file exceeds the capture limit.',409)}length=Number(header)}
  if(expected!==undefined&&length!==undefined&&length!==expected){void response.body?.cancel().catch(()=>{});throw new AppError('GOOGLE_DRIVE_FILE_CHANGED','The Google Drive file size changed during download.',409)}
  const signal=this.options.signal;let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,closed=false
  const close=()=>{if(closed)return;closed=true;if(reader)void reader.cancel().catch(()=>{});else void response.body?.cancel().catch(()=>{})}
  async function* body(){let seen=0;try{if(!response.body){if(expected===0)return;throw invalid()}reader=response.body.getReader()
   for(;;){signal.throwIfAborted();if(closed)throw new AppError('GOOGLE_DRIVE_CANCELLED','The Google Drive download was closed.',408);const part=await reader.read();if(part.done)break;seen+=part.value.byteLength;if(seen>limit||expected!==undefined&&seen>expected)throw new AppError('GOOGLE_DRIVE_FILE_TOO_LARGE','The Google Drive content exceeded its published size or capture limit.',409);yield part.value}
   if(expected!==undefined&&seen!==expected||length!==undefined&&seen!==length)throw new AppError('GOOGLE_DRIVE_FILE_CHANGED','The Google Drive content length changed during download.',409)
  }finally{close();reader?.releaseLock()}}
  return {body:body(),size:expected??length,close}
 }
 async download(file:DriveFile){
  if(file.trashed||file.mimeType.startsWith('application/vnd.google-apps.'))throw new AppError('GOOGLE_DRIVE_UNSUPPORTED_TYPE','This Google Drive item cannot be captured as an ordinary file.',409)
  if(file.capabilities.canDownload!==true)throw new AppError('GOOGLE_DRIVE_DOWNLOAD_DENIED','The Google Drive item does not permit content download.',403)
  if(file.size===undefined||BigInt(file.size)>BigInt(this.limit))throw new AppError('GOOGLE_DRIVE_FILE_TOO_LARGE','The Google Drive file has no bounded size or exceeds the capture limit.',409)
  return this.content(await this.request(this.url('/files/'+driveId(file.id),{alt:'media',supportsAllDrives:'true'}),{},[],2*60*60*1000),this.limit,Number(file.size))
 }
 async export(file:DriveFile,mimeType:string){
  if(file.trashed||file.capabilities.canDownload!==true)throw new AppError('GOOGLE_DRIVE_DOWNLOAD_DENIED','The Google Drive item does not permit content export.',403)
  if(driveExportFormat(file.mimeType)?.mimeType!==mimeType)throw new AppError('GOOGLE_DRIVE_UNSUPPORTED_TYPE','This Google Workspace file or export format is not supported by the capture profile.',409)
  return this.content(await this.request(this.url('/files/'+driveId(file.id)+'/export',{mimeType}),{},[],2*60*60*1000),Math.min(this.limit,10*1024*1024))
 }
 async generateIds(count=1){
  if(!Number.isInteger(count)||count<1||count>1000)throw new AppError('GOOGLE_DRIVE_INVALID_COUNT','Request between one and 1,000 file identifiers.')
  const result=object(await json(await this.request(this.url('/files/generateIds',{count:String(count),space:'drive',type:'files'}))))
  if(!Array.isArray(result.ids)||result.ids.length!==count)throw invalid();const ids=result.ids.map(value=>driveId(text(value,200)));if(new Set(ids).size!==ids.length)throw invalid();return ids
 }
 private newFile(input:NewFile,mimeType:string,allowMyDriveRoot=false){
  const root=allowMyDriveRoot&&mimeType===folderMime&&input.parentId==='root'
  driveId(input.id);if(!root)driveId(input.parentId);if(input.id===input.parentId)throw new AppError('GOOGLE_DRIVE_INVALID_ID','A new file must have a separate parent folder.')
  // Omitting parents creates a new folder in My Drive without requiring drive.file to read the root resource.
  const name=text(input.name);return {id:input.id,name,mimeType:mime(mimeType),...(root?{}:{parents:[input.parentId]}),...(input.appProperties===undefined?{}:{appProperties:properties(input.appProperties)}),...(input.properties===undefined?{}:{properties:properties(input.properties)})}
 }
 private created(file:DriveFile,input:NewFile,mimeType:string,size?:number,allowMyDriveRoot=false){
  const parentMatches=file.parents.length===1&&(allowMyDriveRoot&&mimeType===folderMime&&input.parentId==='root'?!file.driveId&&file.parents[0]!==file.id:file.parents[0]===input.parentId)
  if(file.id!==input.id||file.name!==input.name||file.mimeType!==mimeType||file.trashed||!parentMatches||size!==undefined&&file.size!==String(size)||Object.entries(input.appProperties??{}).some(([key,value])=>file.appProperties?.[key]!==value)||Object.entries(input.properties??{}).some(([key,value])=>file.properties?.[key]!==value))throw new AppError('GOOGLE_DRIVE_WRITE_UNCERTAIN','The created Google Drive resource did not confirm its intended identity. Reconcile that exact identifier.',409)
  return file
 }
 async createFolder(input:NewFile){const metadata=this.newFile(input,folderMime,true);return this.created(driveFile(await json(await this.request(this.url('/files',{fields,supportsAllDrives:'true'}),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(metadata)}))),input,folderMime,undefined,true)}
 async uploadFile(input:NewFile&{mimeType:string;body:Blob|Uint8Array;modifiedTime?:string}){
  if(input.mimeType.startsWith('application/vnd.google-apps.'))throw new AppError('GOOGLE_DRIVE_UNSUPPORTED_TYPE','Pre-generated identifiers cannot create or convert Google Workspace documents. Restore their exported file formats instead.',409)
  const metadata=this.newFile(input,input.mimeType),body=input.body instanceof Uint8Array?new Blob([new Uint8Array(input.body)]):input.body
  if(!(body instanceof Blob)||!Number.isSafeInteger(body.size)||body.size>this.limit)throw new AppError('GOOGLE_DRIVE_FILE_TOO_LARGE','The upload exceeds the bounded file limit.',409)
  if(input.modifiedTime!==undefined){if(!Number.isFinite(Date.parse(input.modifiedTime)))throw new AppError('GOOGLE_DRIVE_INVALID_TIME','Use a valid original modification time.');Object.assign(metadata,{modifiedTime:new Date(input.modifiedTime).toISOString()})}
  const url=new URL(uploads);url.searchParams.set('uploadType','resumable');url.searchParams.set('supportsAllDrives','true');url.searchParams.set('fields',fields)
  const started=await this.request(url,{method:'POST',headers:{'content-type':'application/json','x-upload-content-type':input.mimeType,'x-upload-content-length':String(body.size)},body:JSON.stringify(metadata)})
  const location=started.headers.get('location');await started.body?.cancel().catch(()=>{});if(!location)throw invalid();const session=sessionUrl(location)
  let offset=0
  do{
   this.options.signal.throwIfAborted();const end=Math.min(offset+chunkBytes,body.size),chunk=body.slice(offset,end),range=body.size?`bytes ${offset}-${end-1}/${body.size}`:'bytes */0'
   const response=await this.request(session,{method:'PUT',headers:{'content-type':input.mimeType,'content-length':String(chunk.size),'content-range':range},body:chunk},[308])
   if(response.status!==308)return this.created(driveFile(await json(response)),input,input.mimeType,body.size)
   const received=response.headers.get('range');await response.body?.cancel().catch(()=>{});const match=received?.match(/^bytes=0-(\d+)$/),next=match?Number(match[1])+1:0
   if(!Number.isSafeInteger(next)||next<=offset||next>end||next>=body.size)throw new AppError('GOOGLE_DRIVE_WRITE_UNCERTAIN','Google Drive did not confirm a safe upload offset. Reconcile the existing identifier before continuing.',409)
   offset=next
  }while(offset<body.size)
  throw invalid()
 }
 async resolveFile(input:{id:string;parentId:string;size:number;sha256:string;md5?:string;appProperties?:Record<string,string>;properties?:Record<string,string>;name?:string}){
  if(!Number.isSafeInteger(input.size)||input.size<0||input.size>this.limit||!/^[a-f0-9]{64}$/.test(input.sha256)||input.md5!==undefined&&!/^[a-f0-9]{32}$/.test(input.md5))throw new AppError('GOOGLE_DRIVE_INVALID_IDENTITY','Supply a bounded size and a verified content checksum.')
  driveId(input.parentId);if(input.appProperties!==undefined)properties(input.appProperties);if(input.properties!==undefined)properties(input.properties)
  let file:DriveFile;try{file=await this.metadata(input.id)}catch(error){if(error instanceof AppError&&error.code==='GOOGLE_DRIVE_NOT_FOUND')return;throw error}
  const digestMatches=file.sha256Checksum!==undefined?file.sha256Checksum===input.sha256:input.md5!==undefined&&file.md5Checksum===input.md5
  if(file.trashed||file.size!==String(input.size)||file.parents.length!==1||file.parents[0]!==input.parentId||input.name!==undefined&&file.name!==input.name||!digestMatches||!Object.keys(input.appProperties??{}).length&&!Object.keys(input.properties??{}).length||Object.entries(input.appProperties??{}).some(([key,value])=>file.appProperties?.[key]!==value)||Object.entries(input.properties??{}).some(([key,value])=>file.properties?.[key]!==value))throw new AppError('GOOGLE_DRIVE_ID_CONFLICT','The existing Google Drive file does not match its recorded ownership and bytes. It was not changed.',409)
  return file
 }
}
