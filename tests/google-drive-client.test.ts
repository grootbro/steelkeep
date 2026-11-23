import {test,expect} from 'bun:test'
import {GoogleDriveClient,driveFile,driveId,driveExportFormat,type DriveFile,type DriveClientOptions} from '../server/google-drive/client'
import {safeFailure} from '../server/security'

const id='syntheticFileId12345',parentId='syntheticFolder12345',sha256='a'.repeat(64)
const fixture=(input:Partial<DriveFile>={}):DriveFile=>({id,name:'sample.txt',mimeType:'text/plain',parents:[parentId],size:'3',version:'1',trashed:false,capabilities:{canDownload:true},...input})
const json=(value:unknown,status=200,headers:Record<string,string>={})=>Response.json(value,{status,headers})
function client(fetcher:(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>,options:Partial<DriveClientOptions>={}){
 return new GoogleDriveClient({signal:AbortSignal.timeout(10000),getAccessToken:async()=>'synthetic-access-token',fetch:fetcher as typeof fetch,...options})
}
async function bytes(file:{body:AsyncIterable<Uint8Array>;close():void}){try{const result:Uint8Array[]=[];for await(const chunk of file.body)result.push(chunk);return Buffer.concat(result)}finally{file.close()}}

test('Drive metadata remains typed and opaque; unsafe IDs and unsupported Workspace types refuse before HTTP',async()=>{
 expect(driveFile(fixture({size:'9007199254740993',version:'9007199254740994'})).size).toBe('9007199254740993')
 for(const value of ['root','../other','https://other.invalid/id','folder\nheader','x'.repeat(201)])expect(()=>driveId(value)).toThrow()
 for(const input of [{...fixture(),size:3},{...fixture(),size:'-1'},{...fixture(),version:'1.2'},{...fixture(),sha256Checksum:'bad'},{...fixture(),capabilities:{canDownload:'true'}}])expect(()=>driveFile(input)).toThrow()
 let calls=0;const drive=client(async()=>{calls++;throw new Error('must not call')})
 await expect(drive.download(fixture({mimeType:'application/vnd.google-apps.form'}))).rejects.toMatchObject({code:'GOOGLE_DRIVE_UNSUPPORTED_TYPE'})
 await expect(drive.export(fixture({mimeType:'application/vnd.google-apps.form'}),'application/pdf')).rejects.toMatchObject({code:'GOOGLE_DRIVE_UNSUPPORTED_TYPE'})
 await expect(drive.uploadFile({id,parentId,name:'doc',mimeType:'application/vnd.google-apps.document',body:new Blob(['x'])})).rejects.toMatchObject({code:'GOOGLE_DRIVE_UNSUPPORTED_TYPE'})
 expect(driveExportFormat('application/vnd.google-apps.document')?.extension).toBe('.docx')
 expect(driveExportFormat('__proto__')).toBeUndefined();expect(calls).toBe(0)
})

test('Drive requests use fixed hosts, no credential redirects, explicit fields and Shared Drive pagination',async()=>{
 const calls:Array<{url:URL;init?:RequestInit}>=[]
 const drive=client(async(input,init)=>{const url=new URL(String(input));calls.push({url,init});if(url.pathname.endsWith('/about'))return json({user:{permissionId:'1234567890123',emailAddress:'synthetic@example.test'}});if(url.pathname.endsWith('/'+id))return json(fixture());return json({files:[fixture()],nextPageToken:'opaque+/page='})})
 expect((await drive.account()).permissionId).toBe('1234567890123')
 expect((await drive.metadata(id)).id).toBe(id)
 const page=await drive.children(parentId,{driveId:'sharedDriveId12345',pageToken:'first+page='})
 expect(page.nextPageToken).toBe('opaque+/page=')
 const last=calls.at(-1)!.url
 expect(last.origin).toBe('https://www.googleapis.com');expect(last.searchParams.get('q')).toBe(`'${parentId}' in parents and trashed = false`)
 expect(last.searchParams.get('corpora')).toBe('drive');expect(last.searchParams.get('driveId')).toBe('sharedDriveId12345');expect(last.searchParams.get('pageToken')).toBe('first+page=')
 expect(last.searchParams.get('includeItemsFromAllDrives')).toBe('true');expect(last.searchParams.get('supportsAllDrives')).toBe('true');expect(last.searchParams.get('fields')).toContain('version')
 for(const {init} of calls){expect(init?.redirect).toBe('error');expect(init?.credentials).toBe('omit');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-access-token')}
 await expect(client(async()=>json({files:[],incompleteSearch:true})).children(parentId)).rejects.toMatchObject({code:'GOOGLE_DRIVE_INCOMPLETE_LIST'})
 await expect(client(async()=>json({files:[fixture({parents:['differentFolder12345']})]})).children(parentId)).rejects.toMatchObject({code:'GOOGLE_DRIVE_INVALID_RESPONSE'})
})

test('only GET reads retry or refresh; ambiguous writes and raw provider errors are never replayed or exposed',async()=>{
 const refreshed:boolean[]=[];let reads=0
 const drive=client(async()=>++reads===1?json({error:{message:'private provider payload'}},401):json(fixture()),{getAccessToken:async(_signal,force)=>{refreshed.push(force??false);return 'synthetic-token'}})
 await drive.metadata(id);expect(refreshed).toEqual([false,true]);expect(reads).toBe(2)
 let rate=0;await client(async()=>++rate<3?json({error:{errors:[{reason:'userRateLimitExceeded'}]}},403,{'retry-after':'0'}):json(fixture())).metadata(id);expect(rate).toBe(3)
 let posts=0
 try{await client(async()=>{posts++;return new Response('secret-access-token=never-expose',{status:503})}).createFolder({id,parentId,name:'new folder'});throw new Error('expected refusal')}
 catch(error){expect(safeFailure(error)).toMatchObject({code:'GOOGLE_DRIVE_WRITE_UNCERTAIN'});expect(JSON.stringify(safeFailure(error))).not.toContain('secret-access-token')}
 expect(posts).toBe(1)
 let redirects=0;await expect(client(async()=>{redirects++;throw new TypeError('redirect to https://private.invalid?token=secret')}).metadata(id)).rejects.toMatchObject({code:'GOOGLE_DRIVE_UNAVAILABLE'});expect(redirects).toBe(3)
})

test('Drive content streams enforce published length, absolute size limits and complete responses',async()=>{
 expect((await bytes(await client(async()=>new Response('abc',{headers:{'content-length':'3'}})).download(fixture()))).toString()).toBe('abc')
 await expect(bytes(await client(async()=>new Response('abcd')).download(fixture()))).rejects.toMatchObject({code:'GOOGLE_DRIVE_FILE_TOO_LARGE'})
 await expect(bytes(await client(async()=>new Response('ab')).download(fixture()))).rejects.toMatchObject({code:'GOOGLE_DRIVE_FILE_CHANGED'})
 await expect(client(async()=>new Response('abc',{status:206,headers:{'content-range':'bytes 0-2/3'}})).download(fixture())).rejects.toMatchObject({code:'GOOGLE_DRIVE_INVALID_RESPONSE'})
 await expect(client(async()=>new Response('abc',{headers:{'content-length':'4'}})).download(fixture())).rejects.toMatchObject({code:'GOOGLE_DRIVE_FILE_CHANGED'})
 let calls=0;await expect(client(async()=>{calls++;return new Response('x')},{maxFileBytes:2}).download(fixture())).rejects.toMatchObject({code:'GOOGLE_DRIVE_FILE_TOO_LARGE'});expect(calls).toBe(0)
 const controller=new AbortController();controller.abort();await expect(client(async()=>new Response('abc'),{signal:controller.signal}).download(fixture())).rejects.toBeDefined()
})

test('Workspace export is explicit, bounded and never follows arbitrary exportLinks',async()=>{
 let requested:URL|undefined;const native=fixture({mimeType:'application/vnd.google-apps.document',size:undefined})
 const drive=client(async input=>{requested=new URL(String(input));return new Response('doc')})
 const exported=await drive.export(native,driveExportFormat(native.mimeType)!.mimeType);expect((await bytes(exported)).toString()).toBe('doc');expect(requested!.pathname).toBe('/drive/v3/files/'+id+'/export')
 await expect(drive.export(native,'application/pdf')).rejects.toMatchObject({code:'GOOGLE_DRIVE_UNSUPPORTED_TYPE'})
 await expect(client(async()=>new Response('doc',{headers:{'content-length':String(10*1024*1024+1)}})).export(native,driveExportFormat(native.mimeType)!.mimeType)).rejects.toMatchObject({code:'GOOGLE_DRIVE_FILE_TOO_LARGE'})
})

test('Drive uploads use the generated ID, immutable ownership properties and bounded resumable chunks',async()=>{
 const total=4*1024*1024+3,body=new Blob([new Uint8Array(total)]),calls:Array<{url:URL;init?:RequestInit}>=[]
 const appProperties={steelkeepArtifact:'synthetic-artifact',sha256},properties={steelkeepArchive:'v1',artifactId:'synthetic-artifact'}
 const drive=client(async(input,init)=>{
  const url=new URL(String(input));calls.push({url,init})
  if(url.pathname.endsWith('/generateIds'))return json({ids:[id]})
  if(init?.method==='POST')return new Response(null,{headers:{location:'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=synthetic-session&fields=id%2Cname%2Csize&supportsAllDrives=true&session_crd=synthetic-session-capability'}})
  const range=new Headers(init?.headers).get('content-range');if(range===`bytes 0-${4*1024*1024-1}/${total}`)return new Response(null,{status:308,headers:{range:`bytes=0-${4*1024*1024-1}`}})
  return json(fixture({size:String(total),appProperties,properties,sha256Checksum:sha256}))
 })
 expect(await drive.generateIds()).toEqual([id])
 const uploaded=await drive.uploadFile({id,parentId,name:'sample.txt',mimeType:'text/plain',body,appProperties,properties});expect(uploaded.size).toBe(String(total))
 const post=calls.find(call=>call.init?.method==='POST')!
 expect(JSON.parse(String(post.init!.body))).toMatchObject({id,name:'sample.txt',parents:[parentId],appProperties,properties})
 const put=calls.filter(call=>call.init?.method==='PUT');expect(put).toHaveLength(2);expect((put[0].init?.body as Blob).size).toBe(4*1024*1024);expect((put[1].init?.body as Blob).size).toBe(3)
 expect(new Headers(put[1].init?.headers).get('content-range')).toBe(`bytes ${4*1024*1024}-${total-1}/${total}`)
 expect(put.every(call=>call.url.origin==='https://www.googleapis.com'&&call.init?.redirect==='error')).toBe(true)
 expect(put.every(call=>call.url.searchParams.get('session_crd')==='synthetic-session-capability'&&call.url.searchParams.get('fields')==='id,name,size')).toBe(true)
})

test('fresh My Drive folders omit the root alias and require a concrete single-parent response',async()=>{
 const properties={steelkeepRecovery:'v1'},created=fixture({mimeType:'application/vnd.google-apps.folder',parents:['canonicalMyDriveRoot12345'],size:undefined,properties})
 let calls=0
 const drive=client(async(input,init)=>{
  calls++;expect(new URL(String(input)).pathname).toBe('/drive/v3/files');expect(init?.method).toBe('POST')
  const metadata=JSON.parse(String(init?.body));expect(metadata.id).toBe(id);expect(metadata).not.toHaveProperty('parents');expect(metadata.properties).toEqual(properties)
  return json(created)
 })
 expect((await drive.createFolder({id,parentId:'root',name:'sample.txt',properties})).parents).toEqual(['canonicalMyDriveRoot12345']);expect(calls).toBe(1)
 for(const entry of [{...created,parents:[]},{...created,parents:[id]},{...created,driveId:'sharedDriveId12345'},{...created,name:'unexpected'},{...created,properties:{steelkeepRecovery:'other'}}]){
  await expect(client(async()=>json(entry)).createFolder({id,parentId:'root',name:'sample.txt',properties})).rejects.toMatchObject({code:'GOOGLE_DRIVE_WRITE_UNCERTAIN'})
 }
 await expect(client(async()=>json({...created,parents:['root']})).createFolder({id,parentId:'root',name:'sample.txt',properties})).rejects.toMatchObject({code:'GOOGLE_DRIVE_INVALID_ID'})
 let uploads=0;await expect(client(async()=>{uploads++;throw new Error('must not call')}).uploadFile({id,parentId:'root',name:'sample.txt',mimeType:'text/plain',body:new Blob(['abc'])})).rejects.toMatchObject({code:'GOOGLE_DRIVE_INVALID_ID'});expect(uploads).toBe(0)
 expect(()=>driveId('root')).toThrow()
})

test('upload sessions cannot redirect bearer credentials or advance past acknowledged bytes',async()=>{
 for(const location of ['https://other.invalid/upload?upload_id=secret','https://www.googleapis.com.evil.invalid/upload/drive/v3/files?upload_id=secret','https://user:pass@www.googleapis.com/upload/drive/v3/files?upload_id=secret','https://www.googleapis.com/other?upload_id=secret']){
  let calls=0;await expect(client(async()=>{calls++;return new Response(null,{headers:{location}})}).uploadFile({id,parentId,name:'sample.txt',mimeType:'text/plain',body:new Blob(['abc'])})).rejects.toMatchObject({code:'GOOGLE_DRIVE_INVALID_RESPONSE'});expect(calls).toBe(1)
 }
 let calls=0;await expect(client(async(_url,init)=>{calls++;return init?.method==='POST'?new Response(null,{headers:{location:'https://www.googleapis.com/upload/drive/v3/files?upload_id=synthetic'}}):new Response(null,{status:308,headers:{range:'bytes=0-9000000'}})}).uploadFile({id,parentId,name:'sample.txt',mimeType:'text/plain',body:new Blob(['abc'])})).rejects.toMatchObject({code:'GOOGLE_DRIVE_WRITE_UNCERTAIN'});expect(calls).toBe(2)
})

test('same-ID reconciliation requires actual content digest, parent and ownership and never modifies existing files',async()=>{
 const input={id,parentId,size:3,sha256,appProperties:{steelkeepArtifact:'synthetic-artifact'}}
 for(const record of [fixture({sha256Checksum:sha256,appProperties:input.appProperties}),fixture({md5Checksum:'b'.repeat(32),appProperties:input.appProperties})]){
  const methods:string[]=[];const found=await client(async(_url,init)=>{methods.push(init?.method??'GET');return json(record)}).resolveFile({...input,...(record.md5Checksum?{md5:record.md5Checksum}:{})});expect(found?.id).toBe(id);expect(methods).toEqual(['GET'])
 }
 await expect(client(async()=>json(fixture({appProperties:{...input.appProperties,sha256}}))).resolveFile(input)).rejects.toMatchObject({code:'GOOGLE_DRIVE_ID_CONFLICT'})
 await expect(client(async()=>json(fixture({sha256Checksum:sha256,appProperties:input.appProperties,parents:['differentFolder12345']}))).resolveFile(input)).rejects.toMatchObject({code:'GOOGLE_DRIVE_ID_CONFLICT'})
 const publicProperties={steelkeepArchive:'v1',artifactId:'synthetic-artifact'}
 expect((await client(async()=>json(fixture({sha256Checksum:sha256,properties:publicProperties}))).resolveFile({id,parentId,size:3,sha256,properties:publicProperties}))?.id).toBe(id)
 await expect(client(async()=>json(fixture({properties:publicProperties}))).resolveFile({id,parentId,size:3,sha256,properties:publicProperties})).rejects.toMatchObject({code:'GOOGLE_DRIVE_ID_CONFLICT'})
 await expect(client(async()=>json(fixture({sha256Checksum:'c'.repeat(64),md5Checksum:'b'.repeat(32),properties:publicProperties}))).resolveFile({id,parentId,size:3,sha256,md5:'b'.repeat(32),properties:publicProperties})).rejects.toMatchObject({code:'GOOGLE_DRIVE_ID_CONFLICT'})
 expect(await client(async()=>json({error:{}},404)).resolveFile(input)).toBeUndefined()
})
