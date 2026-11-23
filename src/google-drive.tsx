import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react'
import {ArrowUpRight,CheckCircle2,Download,FolderOpen,HardDrive,LoaderCircle,RefreshCw,ShieldCheck} from 'lucide-react'
import {api,ApiError,type Connection} from './state'
import {bytes,date} from './ui'
import './google-drive.css'

type Purpose='source'|'storage'|'restore'|'recovery'
type DriveStatus={configured:boolean;redirectUri:string|null;sourceScope:string;restoreScope:string;ownerAccess:boolean}
type Grant={id:string;purpose:Purpose;status:'active'|'revoked'|'reconnect_required'|'pending';revision:number;createdAt:string;claimedAt:string|null;accountLabel?:string}
type PortableArchive={fileId:string;name:string;size:string;sha256:string;engine:string;recoveryId:string;portable:true}
type Catalog={items:PortableArchive[];nextPageToken?:string|null;notice?:string}
type ImportRequest={storageId:string;fileId:string;idempotencyKey:string;confirmImport:true}
const purposes:Record<Purpose,{label:string;description:string}>={
 source:{label:'Back up a Drive folder',description:'Authorize read access to Drive, then choose the My Drive folder to capture.'},
 storage:{label:'Store backups in Drive',description:'Create a dedicated folder for this installation’s new backup archives.'},
 restore:{label:'Restore files to Drive',description:'Create a separate empty folder for reviewed file recovery.'},
 recovery:{label:'Recover existing Drive backups',description:'Authorize read access to existing archives, including those from an earlier installation or OAuth project.'}
}
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
export function GoogleDrivePanel({connections,scopes,onChanged}:{connections:Connection[];scopes:readonly string[];onChanged:()=>void|Promise<void>}){
 const canRead=scopes.includes('read'),canConfigure=scopes.includes('configure'),scopeKey=scopes.join(',')
 const [status,setStatus]=useState<DriveStatus|null>(null),[grants,setGrants]=useState<Grant[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('')
 const [purpose,setPurpose]=useState<Purpose>('source'),[grantId,setGrantId]=useState(''),[name,setName]=useState(''),[folder,setFolder]=useState(''),[saved,setSaved]=useState<string|null>(null),[saveUnknown,setSaveUnknown]=useState<{name:string;grantId:string}|null>(null)
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
    setPurpose(attached.purpose);setGrantId(attached.id);setNotice('Google authorization connected. Choose how to use it below.');claim.current=null
   }
   const active=await api<Grant[]>('/google-drive/grants');if(current===sequence.current)setGrants(active)
  }catch(failure){if(current===sequence.current)setError(message(failure))}
  finally{if(current===sequence.current){setLoading(false);setBusy(previous=>previous==='claim'?null:previous)}}
 },[canRead,canConfigure,scopeKey])
 useEffect(()=>{
  const url=new URL(window.location.href),fragment=new URLSearchParams(url.hash.slice(1)),ticket=fragment.get('google-drive')
  if(ticket!==null){fragment.delete('google-drive');url.hash=fragment.toString();window.history.replaceState(window.history.state,'',url.pathname+url.search+url.hash);if(/^gdc_[a-f0-9]{64}$/.test(ticket))claim.current={ticket,task:null};else setError('This Google authorization link is invalid or expired. Connect again.')}
  void load();return()=>{sequence.current++;catalogSequence.current++}
 },[load])
 useEffect(()=>{if(saveUnknown){const found=connections.find(connection=>connection.name===saveUnknown.name&&connection.config.grantId===saveUnknown.grantId);if(found){setSaveUnknown(null);setSaved(found.id);setNotice('The connection was saved. You can inspect it in Connections.')}}},[connections,saveUnknown])
 const owner=status?.ownerAccess===true&&canConfigure,available=grants.filter(grant=>grant.status==='active'&&grant.purpose===purpose),selected=available.find(grant=>grant.id===grantId)??available[0]
 const driveStorage=connections.filter(connection=>connection.kind==='google_drive_storage'),selectedStorage=driveStorage.find(connection=>connection.id===storageId)
 const needsFolder=purpose==='source'||purpose==='recovery',disabled=!owner||!!busy||loading||!!saveUnknown
 function changePurpose(value:Purpose){if(disabled)return;setPurpose(value);setGrantId('');setSaved(null);setError('');setNotice('')}
 async function connect(){
  if(disabled||writeLock.current)return;writeLock.current=true;setBusy('authorize');setError('');setNotice('')
  try{const result=await api<{authorizationUrl:string;expiresAt:string}>('/google-drive/oauth/start',{purpose});window.location.assign(authorizationUrl(result.authorizationUrl,status?.redirectUri??null))}
  catch(failure){setError(message(failure));setBusy(null)}finally{writeLock.current=false}
 }
 async function save(event:FormEvent){
  event.preventDefault();if(disabled||!selected||writeLock.current)return
  let chosen:string;try{chosen=needsFolder?folderId(folder):'new'}catch(failure){setError(message(failure));return}
  const connectionName=name.trim();if(!connectionName){setError('Give this connection a name.');return}
  writeLock.current=true;setBusy('save');setError('');setNotice('')
  try{
   const result=await api<{id:string}>('/connections',{name:connectionName,kind:purpose==='source'||purpose==='restore'?'google_drive':'google_drive_storage',grantId:selected.id,folderId:chosen,...(purpose==='restore'?{restoreTarget:true}:{}),...(purpose==='recovery'?{readOnlyRecovery:true}:{})})
   setSaved(result.id);setNotice(purpose==='restore'?'Empty recovery folder created. Review a compatible snapshot before restoring.':purpose==='storage'?'Backup storage connected. Choose it in a backup plan.':purpose==='recovery'?'Existing archive folder connected with read-only access. Browse its recovery catalog below.':'Drive source connected. Choose a destination and create a backup plan.');changed()
  }catch(failure){setError(message(failure));if(uncertain(failure))setSaveUnknown({name:connectionName,grantId:selected.id})}
  finally{writeLock.current=false;setBusy(null)}
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
 return <section className="panel google-drive-panel" aria-labelledby="google-drive-heading"><div className="panel-heading"><div><h2 id="google-drive-heading"><HardDrive size={19}/>Google Drive</h2><p>Connect a folder, backup storage or a separate recovery destination.</p></div><button type="button" className="icon-button" aria-label="Refresh Google Drive connections" disabled={loading||!!busy} onClick={()=>{setError('');void load();changed()}}><RefreshCw size={16} className={loading?'spin':undefined}/></button></div>
  {error&&<p className="google-drive-error" role="alert">{error}</p>}{notice&&<p className="google-drive-notice" role="status"><CheckCircle2 size={16}/>{notice}{notice.startsWith('Snapshot imported.')&&<a href="/snapshots">Open snapshots<ArrowUpRight size={13}/></a>}</p>}
  {!canRead?<p className="panel-empty">Viewing Google Drive connections requires read permission.</p>:loading&&!status?<p className="panel-empty" role="status">Loading Google Drive…</p>:status&&!status.configured?<div className="google-drive-setup"><ShieldCheck size={19}/><p>A Google OAuth client needs to be configured by the installation owner before connecting an account. <a href="https://github.com/grootbro/steelkeep/blob/main/docs/google-drive.md" target="_blank" rel="noreferrer">Setup guide<ArrowUpRight size={12}/></a></p></div>:status&&!owner?<p className="panel-empty">Sign in with the owner account to connect Google Drive or import an archive. Existing backup plans remain available through their granted scopes.</p>:status&&<>
   <div className="google-drive-content"><form className="google-drive-form" onSubmit={save} aria-busy={!!busy}>
    <div className="google-drive-purpose"><label>Use Google Drive for<select value={purpose} disabled={disabled} onChange={event=>changePurpose(event.target.value as Purpose)}>{Object.entries(purposes).map(([value,option])=><option key={value} value={value}>{option.label}</option>)}</select></label><p className="form-hint">{purposes[purpose].description}</p></div>
    <div className="google-drive-authorize"><div><strong>{available.length?'Google authorization ready':'Connect your Google account'}</strong><p>{available.length?'Use an active authorization below, or connect another Google account.':'Google asks you to approve access. Your password and Google tokens stay out of Steelkeep’s forms.'}</p></div><button type="button" className={available.length?'secondary small':'primary small'} disabled={disabled} onClick={()=>void connect()}>{busy==='authorize'?<LoaderCircle size={14} className="spin"/>:<ArrowUpRight size={14}/>}Connect with Google</button></div>
    {!!available.length&&<><div className="google-drive-fields"><label>Authorization<select value={selected?.id??''} disabled={disabled} onChange={event=>{setGrantId(event.target.value);setSaved(null)}}>{available.map(grant=><option key={grant.id} value={grant.id}>{grant.accountLabel??`Google authorization ${grant.id.slice(0,8)}`} · {date(grant.claimedAt??grant.createdAt)}</option>)}</select></label><label>Connection name<input value={name} onChange={event=>{setName(event.target.value);setSaved(null)}} disabled={disabled} required maxLength={80} placeholder={purpose==='source'?'Work documents':purpose==='storage'?'Drive backup storage':purpose==='restore'?'Drive recovery folder':'Previous Drive archives'}/></label>{needsFolder&&<label className="google-drive-folder">{purpose==='recovery'?'Archive folder':'Source folder'}<input value={folder} onChange={event=>{setFolder(event.target.value);setSaved(null)}} disabled={disabled} required maxLength={2048} placeholder="Paste a folder link or folder ID"/><span className="form-hint">Copy the folder link from My Drive. Shared drives are outside this recovery profile.</span></label>}</div><div className="google-drive-save"><p className="form-hint">{purpose==='source'?'Docs, Sheets and Slides use portable Office exports. Sharing permissions, comments and revision history are not captured.':purpose==='restore'?'Steelkeep creates a new empty folder. Recovery never overwrites the original source.':purpose==='storage'?'A new dedicated folder keeps this installation’s archives separate. Existing files are not replaced.':'Archive access is read-only. Import verifies the selected archive before adding a snapshot.'}</p>{saved?<a className="secondary small" href={'/connections/'+encodeURIComponent(saved)}>View connection<ArrowUpRight size={13}/></a>:<button type="submit" className="primary small" disabled={disabled}>{busy==='save'&&<LoaderCircle size={14} className="spin"/>}{purpose==='restore'?'Create recovery folder':purpose==='storage'?'Create backup storage':'Save connection'}</button>}</div></>}
    {saveUnknown&&<p className="google-drive-warning" role="status">The save result could not be confirmed. Refresh Connections and inspect the saved list before creating another folder.</p>}
    {grants.some(grant=>grant.purpose===purpose&&grant.status==='reconnect_required')&&<p className="form-hint">An earlier Google authorization needs to be reconnected. Use Connect with Google to grant access again.</p>}
   </form>
   <div className="google-drive-key"><ShieldCheck size={17}/><div><strong>Keep a recovery key outside Drive</strong><p>Encrypted Drive snapshots need their original recovery key on a fresh server. Save it privately before relying on offsite archives.</p></div><a className="secondary small" href="/api/v1/google-drive/recovery-key" download><Download size={14}/>Save recovery key</a></div>
   <details className="google-drive-recovery"><summary><FolderOpen size={16}/>Recover an existing archive</summary><div className="google-drive-recovery-body"><p className="form-hint">Choose connected Drive archive storage. A folder from an older installation needs the read-only recovery authorization above and its original recovery key.</p><div className="google-drive-catalog-controls"><label>Archive storage<select value={storageId} disabled={!!busy||!!pendingImport} onChange={event=>{catalogSequence.current++;setStorageId(event.target.value);setCatalog(null);setCatalogError('');setTrusted(false);setPageTokens([undefined])}}><option value="">Choose Drive archive storage</option>{driveStorage.map(connection=><option key={connection.id} value={connection.id}>{connection.name}{connection.config.readOnlyRecovery?' · read-only recovery':''}</option>)}</select></label><button type="button" className="secondary small" disabled={!storageId||catalogBusy||!!busy||!!pendingImport} onClick={()=>void browse(storageId)}><RefreshCw size={14} className={catalogBusy?'spin':undefined}/>Browse archives</button></div>
    {catalogBusy&&<p className="form-hint" role="status">Reading the selected archive folder…</p>}{catalogError&&<p className="google-drive-error" role="alert">{catalogError}</p>}{catalog?.notice&&<p className="form-hint">{catalog.notice}</p>}
    {catalog&&!catalogBusy&&(catalog.items.length?<><label className="google-drive-trust"><input type="checkbox" checked={trusted} disabled={!!busy||!!pendingImport} onChange={event=>setTrusted(event.target.checked)}/><span>I trust this archive folder and want to verify and import a selected snapshot. Restoring data requires a separate review.</span></label><div className="table-wrap"><table><thead><tr><th>Archive</th><th>Size / type</th><th><span className="sr-only">Import archive</span></th></tr></thead><tbody>{catalog.items.map(file=><tr key={file.fileId}><td><strong>{file.name}</strong><small title={file.sha256}>SHA-256 {file.sha256.slice(0,16)}…</small></td><td>{bytes(file.size)}<small>{file.engine}</small></td><td><button type="button" className="secondary small" disabled={!trusted||!!busy||!!pendingImport&&pendingImport.fileId!==file.fileId} onClick={()=>void importArchive(file)}>{busy==='import:'+file.fileId&&<LoaderCircle size={13} className="spin"/>}{pendingImport?.fileId===file.fileId?'Recover import result':'Verify and import'}</button></td></tr>)}</tbody></table></div></>:<p className="form-hint">No portable Steelkeep archives were found on this page.</p>)}
    {catalog&&(pageTokens.length>1||catalog.nextPageToken)&&<div className="google-drive-paging"><button type="button" className="secondary small" disabled={pageTokens.length<2||catalogBusy||!!busy||!!pendingImport} onClick={()=>void browse(storageId,pageTokens.slice(0,-1))}>Previous</button><span>Page {pageTokens.length}</span><button type="button" className="secondary small" disabled={!catalog.nextPageToken||catalogBusy||!!busy||!!pendingImport} onClick={()=>void browse(storageId,[...pageTokens,catalog.nextPageToken!])}>Next</button></div>}
   </div></details></div>
  </>}
 </section>
}
