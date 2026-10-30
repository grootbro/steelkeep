import {Fragment,useState,type FormEvent} from 'react'
import {Archive,ArrowDownToLine,ArrowRight,CheckCircle2,Database,LockKeyhole,ShieldAlert} from 'lucide-react'
import {api,ApiError,type Artifact,type Connection,type Job,type Plan,type RestoreIntent} from './state'
import {Badge,bytes,date,Submit} from './ui'
import {engineProfiles} from '../shared/engines'

export function ConnectionForm({connection,onDone,onReload}:{connection?:Connection;onDone:()=>void;onReload?:()=>Promise<void>}){
  const editing=!!connection,c=connection?.config??{}
  const [kind,setKind]=useState<Connection['kind']>(connection?.kind??'postgres')
  const [target,setTarget]=useState(c.restoreTarget===true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[stale,setStale]=useState(false)
  const profile=engineProfiles.find(profile=>profile.kind===kind)
  const defaults:Record<string,number>={postgres:5432,mysql:3306,mariadb:3306,mongodb:27017,redis:6379,clickhouse:8443,mssql:1433}
  const locking=['mysql','mariadb','mongodb','redis'].includes(kind)
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return
    setBusy(true);setError('');setStale(false)
    const form=new FormData(event.currentTarget)
    let body:Record<string,unknown>
    if(connection){
      body={name:String(form.get('name')),revision:connection.revision}
      if(kind!=='s3'&&kind!=='sqlite'){
        body.user=String(form.get('user'));body.tls=form.has('tls')
        const password=String(form.get('password')??'');if(password)body.password=password
      }
      if(kind==='s3')for(const field of ['accessKey','secretKey']){const value=String(form.get(field)??'');if(value)body[field]=value}
      if(locking&&!target)body.allowGlobalReadLock=form.has('allowGlobalReadLock')
      if(kind==='clickhouse'&&!target)body.quiescentSource=form.has('quiescentSource')
    }else{
      body={...Object.fromEntries(form),kind}
      if(kind!=='s3'){
        body.restoreTarget=target
        if(kind!=='sqlite'){body.port=Number(form.get('port'));body.tls=form.has('tls')}
        if(locking)body.allowGlobalReadLock=form.has('allowGlobalReadLock')
        if(kind==='redis')body.dbIndex=Number(form.get('dbIndex'))
        if(kind==='clickhouse')body.quiescentSource=form.has('quiescentSource')
      }
    }
    try{await api(connection?`/connections/${connection.id}`:'/connections',body,connection?'PATCH':'POST');onDone()}
    catch(err){setError(err instanceof Error?err.message:'Could not save the connection.');setStale(err instanceof ApiError&&err.code==='REVISION_CONFLICT')}finally{setBusy(false)}
  }
  return <form onSubmit={submit}>
    <div className="form-section">
      <label>Connection type<select value={kind} disabled={editing} onChange={event=>{setKind(event.target.value as Connection['kind']);setTarget(false)}}>{engineProfiles.map(profile=><option key={profile.kind} value={profile.kind}>{profile.name}</option>)}<option value="s3">S3-compatible storage</option></select></label>
      <label>Name<input name="name" required maxLength={80} defaultValue={connection?.name} placeholder={kind==='s3'?'Backup storage':'Application database'}/></label>
      {editing&&<p className="form-hint">Address, database and destination role identify this connection’s history. Credentials and display name can be updated here.</p>}
    </div>
    {kind==='s3'?<div className="form-section">
      <h3>Storage details</h3>
      <label>Endpoint<input name="endpoint" maxLength={2048} type="url" required disabled={editing} defaultValue={String(c.endpoint??'')} placeholder="https://s3.example.com"/></label>
      <div className="field-pair"><label>Bucket<input name="bucket" maxLength={63} required disabled={editing} defaultValue={String(c.bucket??'')}/></label><label>Region<input name="region" maxLength={80} defaultValue={String(c.region??'us-east-1')} disabled={editing} required/></label></div>
      <label>Object prefix<input name="prefix" maxLength={200} defaultValue={String(c.prefix??'steelkeep')} disabled={editing}/></label>
      <label>{editing?'New access key':'Access key'}<input name="accessKey" maxLength={1024} required={!editing} autoComplete="off" placeholder={editing?'Leave blank to keep the saved key':undefined}/></label>
      <label>{editing?'New secret key':'Secret key'}<input name="secretKey" maxLength={1024} type="password" required={!editing} autoComplete="new-password" placeholder={editing?'Leave blank to keep the saved secret':undefined}/></label>
    </div>:<Fragment key={kind}>
      <div className="form-section"><h3>Connection details</h3>
        {kind==='sqlite'?<label>Database file<input name="path" required maxLength={4096} disabled={editing} defaultValue={String(c.path??'')} placeholder="/data/sources/application.sqlite"/><span className="form-hint">An existing SQLite file inside the installation’s allowed source or target directory.</span></label>:<>
          <div className="field-pair"><label>Host<input name="host" maxLength={253} required disabled={editing} defaultValue={String(c.host??'')} placeholder="database.internal"/></label><label>Port<input name="port" type="number" defaultValue={Number(c.port??defaults[kind])} disabled={editing} min={1} max={65535} required/></label></div>
          {kind==='redis'?<label>Logical database<input name="dbIndex" type="number" min={0} max={15} defaultValue={Number(c.dbIndex??0)} disabled={editing} required/></label>:<label>Database<input name="database" maxLength={63} required disabled={editing} defaultValue={String(c.database??'')} placeholder="app"/></label>}
          <div className="field-pair"><label>Username<input name="user" maxLength={80} defaultValue={String(c.user??(kind==='redis'?'default':''))} required autoComplete="off"/></label><label>{editing?'New password':'Password'}<input name="password" maxLength={1024} type="password" required={!editing} autoComplete="new-password" placeholder={editing?'Leave blank to keep the saved password':undefined}/></label></div>
          {kind==='mongodb'&&<label>Authentication database<input name="authDatabase" defaultValue={String(c.authDatabase??'admin')} disabled={editing} maxLength={63} required/></label>}
          <label className="checkbox"><input type="checkbox" name="tls" defaultChecked={editing?c.tls===true:true}/>Verify TLS certificate</label>
        </>}
        <label className="checkbox"><input type="checkbox" checked={target} disabled={editing} onChange={event=>setTarget(event.target.checked)}/>Use only as a restore destination</label>
        {target&&<p className="form-hint">{kind==='sqlite'?'Prepare a separate initialized empty SQLite file for recovery.':kind==='mongodb'?'An owner must create an empty __steelkeep_empty_target collection with its ordinary _id index in a separate database. Use a dedicated target-only restore role.':'Prepare a separate empty destination with dedicated restore credentials.'}</p>}
      </div>
      {profile&&<div className="form-section"><h3>{profile.profile}</h3>
        {kind==='clickhouse'&&<><label>Backup disk<input name="backupDisk" maxLength={80} required disabled={editing} defaultValue={String(c.backupDisk??'')} placeholder="backups"/></label><label>Shared backup directory<input name="sharedBackupRoot" maxLength={4096} required disabled={editing} defaultValue={String(c.sharedBackupRoot??'')} placeholder="/var/lib/clickhouse/backups"/><span className="form-hint">The configured backup disk must be mounted at this same path for ClickHouse and the worker.</span></label>{!target&&<label className="checkbox"><input name="quiescentSource" type="checkbox" required={!editing} defaultChecked={c.quiescentSource===true}/>The source will remain idle for the entire backup window.</label>}</>}
        {!target&&locking&&<label className="checkbox"><input name="allowGlobalReadLock" type="checkbox" required={!editing} defaultChecked={c.allowGlobalReadLock===true}/>{kind==='redis'?'Allow an atomic capture that briefly blocks other Redis commands.':'Allow this backup to temporarily block writes across the source server.'}</label>}
        <p className="form-hint">{profile.prerequisites}</p>
      </div>}
    </Fragment>}
    {editing&&kind!=='sqlite'&&<p className="form-hint">Saved secrets are never shown. Credential changes require the connection to be idle and reset its connection check.</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    {stale&&onReload&&<div className="form-section"><p className="form-hint">Load the latest settings to continue. Unsaved fields will be cleared.</p><button type="button" className="secondary" disabled={busy} onClick={async()=>{setBusy(true);try{await onReload()}catch(error){setError(error instanceof Error?error.message:'Could not reload settings.')}finally{setBusy(false)}}}>Load latest settings</button></div>}
    <div className="form-bottom"><span><LockKeyhole size={12}/>{kind==='sqlite'?'Restricted local file access':'Encrypted credentials'}</span><Submit busy={busy}>{editing?'Save changes':'Save connection'}</Submit></div>
  </form>
}
export function PlanForm({connections,plan,onDone}:{connections:Connection[];plan?:Plan;onDone:()=>void}){
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[source,setSource]=useState(plan?.source_id??''),[storage,setStorage]=useState(plan?.storage_id??''),[scheduled,setScheduled]=useState(!!plan?.cron)
  const sources=connections.filter(c=>c.kind!=='s3'&&!c.config.restoreTarget),volumes=connections.filter(c=>c.kind==='s3')
  return <form onSubmit={async event=>{event.preventDefault();setBusy(true);setError('');const form=new FormData(event.currentTarget);try{const body={name:String(form.get('name')),cron:scheduled?String(form.get('cron')):null,timezone:String(form.get('timezone')),enabled:form.has('enabled')};if(plan)await api(`/plans/${plan.id}`,body,'PATCH');else {const {enabled:_,...create}=body;await api('/plans',{...create,sourceId:source,storageId:storage})};onDone()}catch(err){setError((err as Error).message)}finally{setBusy(false)}}}><div className="form-section"><label>Plan name<input name="name" required maxLength={80} defaultValue={plan?.name} placeholder="Daily application backup"/></label>{!plan&&<><h3>What to back up</h3><label>Source database<select value={source} onChange={e=>setSource(e.target.value)} required><option value="">Choose a database</option>{sources.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>{!sources.length&&<p className="form-hint">Add a source database in Connections first.</p>}<h3>Where to store</h3><label>Storage volume<select value={storage} onChange={e=>setStorage(e.target.value)} required><option value="">Choose S3 storage</option>{volumes.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>{!volumes.length&&<p className="form-hint">Add S3 storage in Connections first.</p>}</>}</div><div className="form-section"><h3>When to run</h3><label className="checkbox"><input type="checkbox" checked={scheduled} onChange={e=>setScheduled(e.target.checked)}/>Run on a schedule</label>{scheduled&&<label>Cron expression<input name="cron" maxLength={80} required defaultValue={plan?.cron??'0 2 * * *'} placeholder="0 2 * * *"/><span className="form-hint">Five fields: minute, hour, day, month, weekday.</span></label>}<label>Timezone<input name="timezone" maxLength={80} required defaultValue={plan?.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone}/></label>{plan&&<label className="checkbox"><input type="checkbox" name="enabled" defaultChecked={plan.enabled}/>Plan enabled</label>}<p className="form-hint">Missed scheduled times and overlapping runs are skipped. Manual runs remain available.</p></div>{error&&<p role="alert" className="form-error">{error}</p>}<div className="form-bottom"><span>{scheduled?'Schedule uses the selected timezone':'Manual runs only'}</span><Submit busy={busy} disabled={!plan&&(!source||!storage)}>{plan?'Save plan':'Create plan'}</Submit></div></form>
}
export function RestoreForm({artifact,connections,onStarted}:{artifact:Artifact;connections:Connection[];onStarted:(job:Job)=>void}){
  const [target,setTarget]=useState(''),[request,setRequest]=useState<{intent:RestoreIntent;idempotencyKey:string}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false),[uncertain,setUncertain]=useState(false)
  const intent=request?.intent??null
  const targets=connections.filter(c=>c.kind===artifact.engine&&c.config.restoreTarget===true)
  async function prepare(){setBusy(true);setError('');try{const prepared=await api<RestoreIntent>('/restores/prepare',{artifactId:artifact.id,targetId:target});setRequest({intent:prepared,idempotencyKey:crypto.randomUUID()});setConfirmed(false);setUncertain(false)}catch(err){setError((err as Error).message)}finally{setBusy(false)}}
  async function start(){if(!request)return;setBusy(true);setError('');try{onStarted(await api<Job>('/restores/start',{intentId:request.intent.intentId,idempotencyKey:request.idempotencyKey}))}catch(err){const ambiguous=!(err instanceof ApiError)||err.status>=500;setUncertain(ambiguous);setError(ambiguous?'The start result is unknown. Retry using this review to retrieve the same operation; no new restore request will be created.':(err as Error).message)}finally{setBusy(false)}}
  return <><div className="restore-steps"><span className={!intent?'current':'done'}><Archive size={15}/>Backup</span><ArrowRight size={13}/><span className={!intent?'current':'done'}><Database size={15}/>Destination</span><ArrowRight size={13}/><span className={intent?'current':''}><CheckCircle2 size={15}/>Review</span></div><div className="restore-source"><Archive size={19}/><div><strong>{connections.find(c=>c.id===artifact.source_id)?.name??'Source database'}</strong><span>{date(artifact.created_at)} · {bytes(artifact.size)} · {artifact.engine}</span></div><Badge status={artifact.availability}/></div>{!intent?<><label>Restore destination<select value={target} onChange={e=>setTarget(e.target.value)}><option value="">Choose a separate empty database</option>{targets.map(c=><option key={c.id} value={c.id} disabled={c.blocked}>{c.name} · {String(c.config.database)}{c.blocked?' · blocked':''}</option>)}</select></label>{!targets.length&&<div className="inline-info"><Database size={18}/><p>Add a separate {artifact.engine} connection marked as a restore destination in Connections.</p></div>}<p className="form-hint">The server checks destination identity, engine compatibility, emptiness, and backup availability before starting.</p></>:<><h3>Review restore</h3><dl className="review-details"><dt>Source database</dt><dd>{intent.review.sourceDatabase}</dd><dt>Target database</dt><dd>{intent.review.targetDatabase}</dd><dt>Engine / server</dt><dd>{intent.review.engine} · {(intent.review.targetVersion??intent.review.serverVersion??'—')}</dd><dt>Review expires</dt><dd>{date(intent.expiresAt)}</dd></dl>{(intent.review.warnings?.length??0)>0&&<div className="notice warning"><ShieldAlert size={17}/><div>{intent.review.warnings?.map((warning,i)=><p key={i}>{warning}</p>)}</div></div>}<div className="inline-info"><CheckCircle2 size={17}/><p>Preflight passed. Destination identity and safety are checked again at execution.</p></div><label className="checkbox confirm-restore"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>Restore this backup into the target database shown above.</label><p className="form-hint">A cancelled or interrupted restore can leave partial data. It is never retried automatically after writes.</p></>}{error&&<p className="form-error" role="alert">{error}</p>}<div className="form-bottom">{intent?<><button className="secondary" disabled={busy||uncertain} onClick={()=>{setRequest(null);setConfirmed(false)}}>Change destination</button><button className="primary" disabled={busy||!confirmed} onClick={()=>void start()}><ArrowDownToLine size={15}/>{busy?'Starting…':uncertain?'Recover start result':'Start restore'}</button></>:<><span>Source database stays protected</span><button className="primary" disabled={busy||!target} onClick={()=>void prepare()}>{busy?'Checking destination…':'Check destination'}<ArrowRight size={15}/></button></>}</div></>
}
