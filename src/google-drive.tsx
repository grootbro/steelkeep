import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react'
import {ArrowUpRight,CheckCircle2,Download,FolderOpen,LoaderCircle,RefreshCw,ShieldCheck} from 'lucide-react'
import {api,ApiError,type Connection} from './state'
import {bytes,date} from './ui'
import './google-drive.css'

type Purpose='source'|'storage'|'restore'|'recovery'
type GrantPurpose=Purpose|'account'
type DriveStatus={configured:boolean;redirectUri:string|null;sourceScope:string;restoreScope:string;ownerAccess:boolean}
type Grant={id:string;purpose:GrantPurpose;scopes?:string[];status:'active'|'revoked'|'reconnect_required'|'pending';revision:number;createdAt:string;claimedAt:string|null;accountLabel?:string}
type PortableArchive={fileId:string;name:string;size:string;sha256:string;engine:string;recoveryId:string;portable:true}
type Catalog={items:PortableArchive[];nextPageToken?:string|null;notice?:string}
type ImportRequest={storageId:string;fileId:string;idempotencyKey:string;confirmImport:true}
const message=(error:unknown)=>error instanceof Error?error.message:'The server did not return a result.'
const uncertain=(error:unknown)=>!(error instanceof ApiError)||error.status>=500||error.code?.includes('UNCERTAIN')===true
function folderId(value:string){
 const candidate=value.trim();if(/^[A-Za-z0-9_-]{10,200}$/.test(candidate))return candidate
 try{const url=new URL(candidate),match=url.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,200})\/?$/);if(url.origin==='https://drive.google.com'&&!url.username&&!url.password&&match)return match[1]}catch{/* An ID or the standard folder URL is required. */}
 throw new Error('Paste a My Drive folder ID or its drive.google.com folder link.')
}
function authorizationUrl(value:string,redirectUri:string|null){
 const url=new URL(value)
 if(url.origin!=='https://accounts.google.com'||url.pathname!=='/o/oauth2/v2/auth'||url.username||url.password||url.hash||!url.searchParams.get('state')||url.searchParams.get('redirect_uri')!==redirectUri)throw new Error('The server returned an invalid Google authorization link.')
 return url.href
}

/** OAuth claims stay in memory; raw Google credentials are never entered or stored here. */
export function GoogleDriveConnectionForm(props:DriveProps&{onDone:()=>void}){return <GoogleDriveFlow {...props} mode="connection"/>}
export function GoogleDriveRecoveryPanel(props:DriveProps){return <GoogleDriveFlow {...props} mode="recovery"/>}
type DriveProps={connections:Connection[];scopes:readonly string[];onChanged:()=>void|Promise<void>}
function supports(grant:Grant,purpose:Purpose){return grant.status==='active'&&(grant.purpose===purpose||grant.purpose==='account'&&grant.scopes?.includes('https://www.googleapis.com/auth/'+(purpose==='source'||purpose==='recovery'?'drive.readonly':'drive.file'))===true)}
function GoogleDriveFlow({connections,scopes,onChanged,onDone,mode}:{connections:Connection[];scopes:readonly string[];onChanged:()=>void|Promise<void>;onDone?:()=>void;mode:'connection'|'recovery'}){
 const canRead=scopes.includes('read'),canConfigure=scopes.includes('configure'),scopeKey=scopes.join(',')
 const [status,setStatus]=useState<DriveStatus|null>(null),[grants,setGrants]=useState<Grant[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('')
 const [source,setSource]=useState(true),[storage,setStorage]=useState(false),[advanced,setAdvanced]=useState<''|'restore'|'recovery'>(''),[grantId,setGrantId]=useState(''),[name,setName]=useState(''),[folder,setFolder]=useState('')
 const [completed,setCompleted]=useState<Partial<Record<Purpose,string>>>({}),[saveUnknown,setSaveUnknown]=useState<{purpose:Purpose;body:Record<string,unknown>;priorIds:string[]}|null>(null)
 const [storageId,setStorageId]=useState(''),[catalog,setCatalog]=useState<Catalog|null>(null),[catalogBusy,setCatalogBusy]=useState(false),[catalogError,setCatalogError]=useState(''),[trusted,setTrusted]=useState(false),[pageTokens,setPageTokens]=useState<Array<string|undefined>>([undefined]),[pendingImport,setPendingImport]=useState<ImportRequest|null>(null)
 const sequence=useRef(0),catalogSequence=useRef(0),writeLock=useRef(false),claim=useRef<{ticket:string;task:Promise<Grant>|null}|null>(null),onChangedRef=useRef(onChanged)
 onChangedRef.current=onChanged
 const changed=()=>{void Promise.resolve().then(()=>onChangedRef.current()).catch(()=>{})}
 const load=useCallback(async()=>{
  const current=++sequence.current;setLoading(true)
  try{
   if(!canRead){setStatus(null);setGrants([]);return}
   const next=await api<DriveStatus>('/google-drive/status');if(current!==sequence.current)return;setStatus(next)
   if(!next.ownerAccess||!canConfigure){setGrants([]);return}
   if(claim.current){
    setBusy('claim')
    if(!claim.current.task)claim.current.task=api<Grant>('/google-drive/oauth/claim',{ticket:claim.current.ticket}).then(result=>{changed();return result})
    const attached=await claim.current.task;if(current!==sequence.current)return
    setGrantId(attached.id);setNotice('Google account connected. Choose the folders to use below.');claim.current=null
   }
   const active=await api<Grant[]>('/google-drive/grants');if(current===sequence.current)setGrants(active)
  }catch(failure){if(current===sequence.current)setError(message(failure))}
  finally{if(current===sequence.current){setLoading(false);setBusy(previous=>previous==='claim'?null:previous)}}
 },[canRead,canConfigure,scopeKey])
 useEffect(()=>{
  const url=new URL(window.location.href),fragment=new URLSearchParams(url.hash.slice(1)),ticket=fragment.get('google-drive')
  const callbackError=fragment.get('google-drive-error');if(callbackError!==null){fragment.delete('google-drive-error');setError('Google authorization was not completed. Connect again.')}
  if(ticket!==null||callbackError!==null){fragment.delete('google-drive');url.hash=fragment.toString();window.history.replaceState(window.history.state,'',url.pathname+url.search+url.hash);if(ticket!==null&&/^gdc_[a-f0-9]{64}$/.test(ticket))claim.current={ticket,task:null};else if(ticket!==null)setError('This Google authorization link is invalid or expired. Connect again.')}
  void load();return()=>{sequence.current++;catalogSequence.current++}
 },[load])
 const roles:Purpose[]=advanced?[advanced]:[...(source?['source' as const]:[]),...(storage?['storage' as const]:[])]
 const owner=status?.ownerAccess===true&&canConfigure,available=grants.filter(grant=>grant.status==='active'&&roles.every(role=>supports(grant,role))).sort((a,b)=>Number(b.purpose==='account')-Number(a.purpose==='account')),selected=available.find(grant=>grant.id===grantId)??available[0]
 const driveStorage=connections.filter(connection=>connection.kind==='google_drive_storage'),selectedStorage=driveStorage.find(connection=>connection.id===storageId)
 const needsFolder=advanced==='recovery'||!advanced&&source,disabled=!owner||!!busy||loading||!!saveUnknown,locked=disabled||Object.keys(completed).length>0
 async function connect(){
  if(disabled||writeLock.current)return;writeLock.current=true;setBusy('authorize');setError('');setNotice('')
  try{const result=await api<{authorizationUrl:string;expiresAt:string}>('/google-drive/oauth/start',{purpose:'account'});window.location.assign(authorizationUrl(result.authorizationUrl,status?.redirectUri??null))}
  catch(failure){setError(message(failure));setBusy(null)}finally{writeLock.current=false}
 }
 async function reconcile(){
  if(!saveUnknown||writeLock.current)return;writeLock.current=true;setBusy('reconcile');setError('')
  try{const list=await api<Connection[]>('/connections'),request=saveUnknown.body,found=list.filter(connection=>!saveUnknown.priorIds.includes(connection.id)&&connection.name===request.name&&connection.kind===request.kind&&connection.config.grantId===request.grantId&&!!connection.config.restoreTarget===(request.restoreTarget===true)&&!!connection.config.readOnly===(request.readOnlyRecovery===true)&&(request.folderId==='new'||connection.config.folderId===request.folderId));if(found.length!==1){setError('The save result is still unconfirmed. Inspect Connections before creating another folder.');return}setCompleted(previous=>({...previous,[saveUnknown.purpose]:found[0]!.id}));setSaveUnknown(null);setNotice('Saved connection found. Continue to finish the remaining selection.');changed()}
  catch(failure){setError(message(failure))}finally{writeLock.current=false;setBusy(null)}
 }
 async function save(event:FormEvent){
  event.preventDefault();if(disabled||!selected||!roles.length||writeLock.current)return
  let chosen:string;try{chosen=needsFolder?folderId(folder):'new'}catch(failure){setError(message(failure));return}
  const connectionName=name.trim();if(!connectionName){setError('Give this connection a name.');return}
  writeLock.current=true;setBusy('save');setError('');setNotice('');let done={...completed}
  try{
   for(const purpose of roles){
    if(done[purpose])continue
    const suffix=roles.length>1?(purpose==='source'?' · source':' · storage'):'',body={name:connectionName.slice(0,80-suffix.length)+suffix,kind:purpose==='source'||purpose==='restore'?'google_drive':'google_drive_storage',grantId:selected.id,folderId:purpose==='source'||purpose==='recovery'?chosen:'new',...(purpose==='restore'?{restoreTarget:true}:{}),...(purpose==='recovery'?{readOnlyRecovery:true}:{})}
    try{const result=await api<{id:string}>('/connections',body);done={...done,[purpose]:result.id};setCompleted(done);changed()}
    catch(failure){if(uncertain(failure))setSaveUnknown({purpose,body,priorIds:connections.map(connection=>connection.id)});throw failure}
   }
   setNotice('Google Drive connections saved. Create a backup plan to choose your source and storage.');onDone?.()
  }catch(failure){setError(message(failure))}finally{writeLock.current=false;setBusy(null)}
 }
 async function browse(id:string,tokens:Array<string|undefined>=[undefined]){
  if(!id||pendingImport)return;const current=++catalogSequence.current;setCatalogBusy(true);setCatalogError('');setTrusted(false)
  try{const token=tokens.at(-1),result=await api<Catalog>(`/google-drive/storage/${encodeURIComponent(id)}/archives${token?'?pageToken='+encodeURIComponent(token):''}`);if(current===catalogSequence.current){setCatalog(result);setPageTokens(tokens)}}
  catch(failure){if(current===catalogSequence.current){setCatalog(null);setCatalogError(message(failure))}}
  finally{if(current===catalogSequence.current)setCatalogBusy(false)}
 }
 async function importArchive(file:PortableArchive){
  if(!owner||!trusted||!selectedStorage||writeLock.current||pendingImport&&pendingImport.fileId!==file.fileId)return
  const request=pendingImport??{storageId:selectedStorage.id,fileId:file.fileId,idempotencyKey:crypto.randomUUID(),confirmImport:true as const};setPendingImport(request);writeLock.current=true;setBusy('import:'+file.fileId);setCatalogError('');setNotice('')
  try{await api('/google-drive/archives/import',request);setPendingImport(null);setTrusted(false);setNotice('Snapshot imported. Open Snapshots to inspect it and prepare a separate recovery destination.');changed()}
  catch(failure){setCatalogError(uncertain(failure)?'The import result is not confirmed. Keep this page open and recover the same import result before choosing another archive.':message(failure));if(!uncertain(failure))setPendingImport(null)}
  finally{writeLock.current=false;setBusy(null)}
 }
 return <div className={`google-drive-panel google-drive-${mode}`} aria-busy={!!busy}>
  {error&&<p className="google-drive-error" role="alert">{error}</p>}{notice&&<p className="google-drive-notice" role="status"><CheckCircle2 size={16}/>{notice}{notice.startsWith('Snapshot imported.')&&<a href="/snapshots">Open snapshots<ArrowUpRight size={13}/></a>}</p>}
  {!canRead?<p className="form-hint">Viewing Google Drive requires read permission.</p>:loading&&!status?<p className="form-hint" role="status">Loading Google Drive…</p>:status&&!status.configured?<div className="google-drive-setup"><ShieldCheck size={19}/><p>The installation owner needs to configure Google authorization. <a href="https://github.com/grootbro/steelkeep/blob/main/docs/google-drive.md" target="_blank" rel="noreferrer">Setup guide<ArrowUpRight size={12}/></a></p></div>:status&&!owner?<p className="form-hint">Sign in with the owner account to connect Google Drive or import an archive.</p>:status&&<>
   {mode==='connection'?<form className="operation-form google-drive-form" onSubmit={save}>
    <div className="google-drive-authorize"><div><strong>{selected?'Connected Google account':'Connect your Google account'}</strong><p>{selected?'One authorization can be reused for sources, backup storage and recovery.':'Approve read access to Drive and access to files Steelkeep creates, then choose your folders.'}</p></div><button type="button" className={selected?'secondary small':'primary small'} disabled={disabled||locked} onClick={()=>void connect()}>{busy==='authorize'?<LoaderCircle size={14} className="spin"/>:<ArrowUpRight size={14}/>} {selected?'Connect another account':'Connect with Google'}</button></div>
    {available.length>1&&<label>Google account<select aria-label="Google account" value={selected?.id??''} disabled={locked} onChange={event=>setGrantId(event.target.value)}>{available.map(grant=><option key={grant.id} value={grant.id}>{grant.accountLabel??'Connected Google account'} · {date(grant.claimedAt??grant.createdAt)} · {grant.id.slice(0,6)}</option>)}</select></label>}
    <fieldset className="operation-fields" disabled={locked||!selected}><div className="form-section"><label>Connection name<input aria-label="Connection name" value={name} onChange={event=>setName(event.target.value)} required maxLength={80} placeholder="My Google Drive"/></label>
    {!advanced&&<div className="google-drive-roles" role="group" aria-label="Google Drive roles"><label className="checkbox"><input type="checkbox" checked={source} onChange={event=>setSource(event.target.checked)}/><span><strong>Back up a folder</strong><small>Read files from a folder in My Drive.</small></span></label><label className="checkbox"><input type="checkbox" checked={storage} onChange={event=>setStorage(event.target.checked)}/><span><strong>Store backups in Drive</strong><small>Create a dedicated folder for new backup archives.</small></span></label></div>}
    {needsFolder&&<label className="google-drive-folder">{advanced==='recovery'?'Archive folder':'Source folder'}<input aria-label={advanced==='recovery'?'Archive folder':'Source folder'} value={folder} onChange={event=>setFolder(event.target.value)} required maxLength={2048} placeholder="Paste a folder link or folder ID"/><span className="form-hint">Copy a folder link from My Drive. Shared drives are not supported.</span></label>}
    {!advanced&&source&&<p className="form-hint">Docs, Sheets and Slides use portable Office exports. Sharing permissions, comments and revision history are not captured.</p>}
    {!advanced&&source&&storage&&<p className="form-hint">Creates two connections under the same Google account: your source folder and a separate new storage folder.</p>}
    {advanced==='restore'&&<p className="form-hint">Creates a new empty folder for reviewed file recovery. Original files are never overwritten.</p>}{advanced==='recovery'&&<p className="form-hint">Attach an existing Steelkeep archive folder with read-only access, including archives from an earlier installation.</p>}
    <details className="google-drive-advanced"><summary>Recovery options</summary><label>Connection role<select aria-label="Recovery connection role" value={advanced} onChange={event=>setAdvanced(event.target.value as typeof advanced)}><option value="">Backup source and storage</option><option value="restore">New empty restore folder</option><option value="recovery">Existing archive folder (read-only)</option></select></label></details></div></fieldset>
    {Object.keys(completed).length>0&&<p className="google-drive-notice" role="status">{Object.keys(completed).length} connection saved. Continue to finish without creating it again.</p>}
    {saveUnknown&&<div className="google-drive-warning" role="status">The save result is not confirmed. Check the saved connections before another create request.<button type="button" className="secondary small" disabled={!!busy} onClick={()=>void reconcile()}>Check saved connections</button></div>}
    {!roles.length&&<p className="form-hint">Select at least one use for Google Drive.</p>}
    {!!roles.length&&!selected&&grants.some(grant=>grant.status==='active')&&<p className="form-hint">Connect with Google to approve access for this selection. Earlier authorizations remain available for their existing roles.</p>}
    <div className="form-bottom"><span><ShieldCheck size={13}/>Credentials managed by Google</span><button type="submit" className="primary" disabled={disabled||!selected||!roles.length}>{busy==='save'&&<LoaderCircle size={14} className="spin"/>}{Object.keys(completed).length?'Continue':roles.length>1?'Add connections':'Add connection'}</button></div>
   </form>:<div className="google-drive-recovery-content">   <div className="google-drive-key"><ShieldCheck size={17}/><div><strong>Keep a recovery key outside Drive</strong><p>Encrypted Drive snapshots need their original recovery key on a fresh server. Save it privately before relying on offsite archives.</p></div><a className="secondary small" href="/api/v1/google-drive/recovery-key" download><Download size={14}/>Save recovery key</a></div>
   <details className="google-drive-recovery"><summary><FolderOpen size={16}/>Recover an existing archive</summary><div className="google-drive-recovery-body"><p className="form-hint">Choose connected Drive archive storage. A folder from an older installation needs a read-only archive connection and its original recovery key. Add it through Add connection → Google Drive → Recovery options.</p><div className="google-drive-catalog-controls"><label>Archive storage<select value={storageId} disabled={!!busy||!!pendingImport} onChange={event=>{catalogSequence.current++;setStorageId(event.target.value);setCatalog(null);setCatalogError('');setTrusted(false);setPageTokens([undefined])}}><option value="">Choose Drive archive storage</option>{driveStorage.map(connection=><option key={connection.id} value={connection.id}>{connection.name}{connection.config.readOnly?' · read-only recovery':''}</option>)}</select></label><button type="button" className="secondary small" disabled={!storageId||catalogBusy||!!busy||!!pendingImport} onClick={()=>void browse(storageId)}><RefreshCw size={14} className={catalogBusy?'spin':undefined}/>Browse archives</button></div>
    {catalogBusy&&<p className="form-hint" role="status">Reading the selected archive folder…</p>}{catalogError&&<p className="google-drive-error" role="alert">{catalogError}</p>}{catalog?.notice&&<p className="form-hint">{catalog.notice}</p>}
    {catalog&&!catalogBusy&&(catalog.items.length?<><label className="google-drive-trust"><input type="checkbox" checked={trusted} disabled={!!busy||!!pendingImport} onChange={event=>setTrusted(event.target.checked)}/><span>I trust this archive folder and want to verify and import a selected snapshot. Restoring data requires a separate review.</span></label><div className="table-wrap"><table><thead><tr><th>Archive</th><th>Size / type</th><th><span className="sr-only">Import archive</span></th></tr></thead><tbody>{catalog.items.map(file=><tr key={file.fileId}><td><strong>{file.name}</strong><small title={file.sha256}>SHA-256 {file.sha256.slice(0,16)}…</small></td><td>{bytes(file.size)}<small>{file.engine}</small></td><td><button type="button" className="secondary small" disabled={!trusted||!!busy||!!pendingImport&&pendingImport.fileId!==file.fileId} onClick={()=>void importArchive(file)}>{busy==='import:'+file.fileId&&<LoaderCircle size={13} className="spin"/>}{pendingImport?.fileId===file.fileId?'Recover import result':'Verify and import'}</button></td></tr>)}</tbody></table></div></>:<p className="form-hint">No portable Steelkeep archives were found on this page.</p>)}
    {catalog&&(pageTokens.length>1||catalog.nextPageToken)&&<div className="google-drive-paging"><button type="button" className="secondary small" disabled={pageTokens.length<2||catalogBusy||!!busy||!!pendingImport} onClick={()=>void browse(storageId,pageTokens.slice(0,-1))}>Previous</button><span>Page {pageTokens.length}</span><button type="button" className="secondary small" disabled={!catalog.nextPageToken||catalogBusy||!!busy||!!pendingImport} onClick={()=>void browse(storageId,[...pageTokens,catalog.nextPageToken!])}>Next</button></div>}
   </div></details></div>}
  </>}
  <button type="button" className="google-drive-refresh secondary small" disabled={loading||!!busy} onClick={()=>{setError('');void load();changed()}}><RefreshCw size={13} className={loading?'spin':undefined}/>Refresh Google Drive connections</button>
 </div>
}
