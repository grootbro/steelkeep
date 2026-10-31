import {Fragment,useState,type FormEvent} from 'react'
import {Archive,ArrowDownToLine,ArrowRight,CheckCircle2,Clock,Database,HardDrive,LockKeyhole,ShieldAlert} from 'lucide-react'
import {api,ApiError,type Artifact,type Connection,type Job,type Plan,type RestoreIntent} from './state'
import {Badge,bytes,date,Submit} from './ui'
import {engineName,engineProfiles} from '../shared/engines'
import './forms.css'

const sourceRequirements:Record<string,string>={
  postgres:'Use a read-only source role and PostgreSQL 17 worker tools. Changing sequence state during capture is refused.',
  mysql:'MySQL 8 clients, InnoDB tables and RELOAD permission are required. Views and stored programs are not supported by this profile.',
  mariadb:'Use MariaDB 11 clients, InnoDB tables and RELOAD permission. Views and stored programs are not supported by this profile.',
  mongodb:'MongoDB 8.0 standalone and MongoDB tools are required. The role needs permission for a server-wide fsync lock; replica sets and shards need another profile.',
  sqlite:'The existing source file must be inside an allowed source directory mounted into the worker. Hard links and virtual tables are refused.',
  redis:'Standalone Redis only: up to 5,000 keys / 64 MiB, without modules or cluster. Capture briefly blocks commands across the server.',
  clickhouse:'Plain single-node Atomic / MergeTree tables only. Configure a shared backup disk and keep the source idle for the backup window.',
  mssql:'Requires an owner-prepared read-only source and separately provisioned Linux x64 .NET / DacFx tools. BACPAC portability is not native .bak or log-chain recovery.'
}
function destinationRequirement(kind:Connection['kind']){
  if(kind==='sqlite')return 'Use a separate initialized empty SQLite file inside the allowed target directory.'
  if(kind==='mongodb')return 'An owner must create an empty __steelkeep_empty_target collection with its ordinary _id index in a separate database. Use a dedicated target-only restore role.'
  if(kind==='redis')return 'Use a separate empty logical database with dedicated restore credentials. The source database cannot be a restore destination.'
  return 'Use a separate precreated empty database and a dedicated restricted restore role. The original source stays protected.'
}

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
  return <form onSubmit={submit} className="operation-form connection-form" aria-busy={busy}><fieldset className="operation-fields" disabled={busy}>
    <div className="form-section">
      <label>Connection type<select value={kind} disabled={editing} onChange={event=>{setKind(event.target.value as Connection['kind']);setTarget(false)}}>{engineProfiles.map(profile=><option key={profile.kind} value={profile.kind}>{profile.name}</option>)}<option value="s3">S3-compatible storage</option></select></label>
      <label>Name<input name="name" required maxLength={80} defaultValue={connection?.name} placeholder={kind==='s3'?'Backup storage':'Application database'}/></label>
      {editing&&<p className="form-hint">Address, database and destination role identify this connection’s history. Credentials and display name can be updated here.</p>}
      {kind!=='s3'&&<div className="connection-purpose"><div className="form-context"><Database size={17}/><div><strong>{target?'Restore destination':'Backup source'}</strong><p>{target?'Receives a restore after a separate safety review.':'The database Steelkeep will read when running a backup.'}</p></div></div><label className="checkbox"><input type="checkbox" checked={target} disabled={editing} onChange={event=>setTarget(event.target.checked)}/>Use only as a restore destination</label></div>}
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
          <label className="checkbox"><input type="checkbox" name="tls" defaultChecked={editing?c.tls===true:true}/>Verify TLS certificate</label><p className="form-hint">Use the address reachable from the Steelkeep server and worker. It must be included in the installation’s allowed hosts.</p>
        </>}
        {target&&<p className="form-hint">{destinationRequirement(kind)}</p>}
      </div>
      {profile&&<div className="form-section"><h3>{profile.profile}</h3>
        {kind==='clickhouse'&&<><label>Backup disk<input name="backupDisk" maxLength={80} required disabled={editing} defaultValue={String(c.backupDisk??'')} placeholder="backups"/></label><label>Shared backup directory<input name="sharedBackupRoot" maxLength={4096} required disabled={editing} defaultValue={String(c.sharedBackupRoot??'')} placeholder="/var/lib/clickhouse/backups"/><span className="form-hint">The configured backup disk must be mounted at this same path for ClickHouse and the worker.</span></label>{!target&&<label className="checkbox"><input name="quiescentSource" type="checkbox" required={!editing} defaultChecked={c.quiescentSource===true}/>The source will remain idle for the entire backup window.</label>}</>}
        {!target&&locking&&<label className="checkbox"><input name="allowGlobalReadLock" type="checkbox" required={!editing} defaultChecked={c.allowGlobalReadLock===true}/>{kind==='redis'?'Allow an atomic capture that briefly blocks other Redis commands.':'Allow this backup to temporarily block writes across the source server.'}</label>}
        <p className="form-hint">{target?'Native restore tools must be provisioned on the worker. Destination identity, permissions and emptiness are checked before recovery.':sourceRequirements[kind]}</p>
      </div>}
    </Fragment>}
    {editing&&kind!=='sqlite'&&<p className="form-hint">Saved secrets are never shown. Credential changes require the connection to be idle and reset its connection check.</p>}
    <p className="connection-check-note">{kind==='s3'?'After saving, test bucket access in Connections. This checks bucket metadata access. Upload and download permissions are exercised when those operations run.':'After saving, test availability in Connections. A successful connection check does not verify every permission required for a backup or restore.'}</p>
    {error&&<p className="form-error" role="alert">{error}</p>}
    {stale&&onReload&&<div className="form-section"><p className="form-hint">Load the latest settings to continue. Unsaved fields will be cleared.</p><button type="button" className="secondary" disabled={busy} onClick={async()=>{setBusy(true);try{await onReload()}catch(error){setError(error instanceof Error?error.message:'Could not reload settings.')}finally{setBusy(false)}}}>Load latest settings</button></div>}
    <div className="form-bottom"><span><LockKeyhole size={12}/>{kind==='sqlite'?'Restricted local file access':'Encrypted credentials'}</span><Submit busy={busy}>{editing?'Save changes':'Save connection'}</Submit></div>
  </fieldset></form>
}
export function PlanForm({connections,plan,initialConnection,onDone}:{connections:Connection[];plan?:Plan;initialConnection?:Connection;onDone:()=>void}){
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[source,setSource]=useState(plan?.source_id??(initialConnection&&initialConnection.kind!=='s3'&&!initialConnection.config.restoreTarget?initialConnection.id:'')),[storage,setStorage]=useState(plan?.storage_id??(initialConnection?.kind==='s3'?initialConnection.id:'')),[scheduled,setScheduled]=useState(!!plan?.cron)
  const [cron,setCron]=useState(plan?.cron??'0 2 * * *'),[timezone,setTimezone]=useState(plan?.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone)
  const sources=connections.filter(c=>c.kind!=='s3'&&!c.config.restoreTarget),volumes=connections.filter(c=>c.kind==='s3')
  const sourceConnection=connections.find(connection=>connection.id===source),storageConnection=connections.find(connection=>connection.id===storage)
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return
    setBusy(true);setError('')
    const form=new FormData(event.currentTarget)
    try{
      const body={name:String(form.get('name')),cron:scheduled?cron:null,timezone,enabled:form.has('enabled')}
      if(plan)await api(`/plans/${plan.id}`,body,'PATCH')
      else {const {enabled:_,...create}=body;await api('/plans',{...create,sourceId:source,storageId:storage})}
      onDone()
    }catch(err){setError(err instanceof Error?err.message:'Could not save the backup plan.')}finally{setBusy(false)}
  }
  return <form onSubmit={submit} className="operation-form plan-form" aria-busy={busy}><fieldset className="operation-fields" disabled={busy}>
    <div className="form-section"><label>Plan name<input name="name" required maxLength={80} defaultValue={plan?.name} placeholder="Daily application backup"/></label></div>
    <div className="form-section"><h3><Database size={16}/>What to back up</h3>
      {plan?<div className="plan-fixed-connection"><strong>{sourceConnection?.name??'Source connection unavailable'}</strong><span>{sourceConnection?engineName(sourceConnection.kind):'The plan keeps its original source.'}</span></div>:<><label>Source database<select value={source} onChange={event=>setSource(event.target.value)} required><option value="">Choose a database</option>{sources.map(connection=><option key={connection.id} value={connection.id} disabled={connection.blocked}>{connection.name} · {engineName(connection.kind)}{connection.blocked?' · blocked':''}</option>)}</select></label>{!sources.length&&<p className="form-hint">Add a source database in <a href="/connections">Connections</a> first.</p>}</>}
      {sourceConnection&&<p className="form-hint">{sourceConnection.blocked?'This source is blocked pending operator review. New backups cannot run.':sourceConnection.check_status==='available'?'Connection was reachable at its last check. Backup permissions are verified during execution.':sourceConnection.check_status==='failed'?'Its last availability check failed. Review the connection before running a backup.':'This source has not passed an availability check. You can test it in Connections.'}</p>}
    </div>
    <div className="form-section"><h3><HardDrive size={16}/>Where to store</h3>
      {plan?<div className="plan-fixed-connection"><strong>{storageConnection?.name??'Storage connection unavailable'}</strong><span>{storageConnection?String(storageConnection.config.bucket):'The plan keeps its original storage.'}</span></div>:<><label>Storage volume<select value={storage} onChange={event=>setStorage(event.target.value)} required><option value="">Choose S3 storage</option>{volumes.map(connection=><option key={connection.id} value={connection.id}>{connection.name}</option>)}</select></label>{!volumes.length&&<p className="form-hint">Add S3-compatible storage in <a href="/connections">Connections</a> first.</p>}</>}
      {storageConnection&&<p className="form-hint">Bucket: <span className="mono">{String(storageConnection.config.bucket)}</span>{storageConnection.config.prefix?<> · prefix: <span className="mono">{String(storageConnection.config.prefix)}</span></>:null}</p>}
    </div>
    <div className="form-section"><h3><Clock size={16}/>When to run</h3>
      <label className="checkbox"><input type="checkbox" checked={scheduled} onChange={event=>setScheduled(event.target.checked)}/>Run on a schedule</label>
      {scheduled&&<><div className="schedule-presets" role="group" aria-label="Schedule presets">{[['Every hour','0 * * * *'],['Daily at 02:00','0 2 * * *'],['Sunday at 03:00','0 3 * * 0']].map(([label,value])=><button key={value} type="button" aria-pressed={cron===value} onClick={()=>setCron(value)}>{label}</button>)}</div><label>Cron expression<input name="cron" maxLength={80} required value={cron} onChange={event=>setCron(event.target.value)} placeholder="0 2 * * *"/></label><p className="form-hint">Five fields: minute, hour, day, month, weekday. Preset times use the timezone below.</p></>}
      <label>Timezone<input name="timezone" maxLength={80} required value={timezone} onChange={event=>setTimezone(event.target.value)} placeholder="Europe/Berlin"/></label>
      {plan&&<label className="checkbox"><input type="checkbox" name="enabled" defaultChecked={plan.enabled}/>Plan enabled</label>}
      <p className="form-hint">{scheduled?'Missed scheduled times and overlapping runs are skipped.':'The plan runs only when you choose Run backup.'} Creating a plan does not start a backup immediately.</p>
    </div>
    {sourceConnection&&storageConnection&&<div className="plan-route-summary" aria-label="Backup plan summary"><div><Database size={16}/><strong>{sourceConnection.name}</strong></div><ArrowRight size={15} aria-hidden="true"/><div><HardDrive size={16}/><strong>{storageConnection.name}</strong></div><p>{scheduled?`${cron} · ${timezone}`:'Manual backup'}{plan&&!plan.enabled?' · currently paused':''}</p></div>}
    {error&&<p role="alert" className="form-error">{error}</p>}
    <div className="form-bottom"><span>{scheduled?'Schedule uses the selected timezone':'Manual runs only'}</span><Submit busy={busy} disabled={!plan&&(!source||!storage)}>{plan?'Save plan':'Create plan'}</Submit></div>
  </fieldset></form>
}
export function RestoreForm({artifact,connections,onStarted}:{artifact:Artifact;connections:Connection[];onStarted:(job:Job)=>void}){
  const [target,setTarget]=useState(''),[request,setRequest]=useState<{intent:RestoreIntent;idempotencyKey:string}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false),[uncertain,setUncertain]=useState(false)
  const intent=request?.intent??null
  const targets=connections.filter(c=>c.kind===artifact.engine&&c.config.restoreTarget===true)
  async function prepare(){if(busy||!target)return;setBusy(true);setError('');try{const prepared=await api<RestoreIntent>('/restores/prepare',{artifactId:artifact.id,targetId:target});setRequest({intent:prepared,idempotencyKey:crypto.randomUUID()});setConfirmed(false);setUncertain(false)}catch(err){setError((err as Error).message)}finally{setBusy(false)}}
  async function start(){if(busy||!request||!confirmed)return;setBusy(true);setError('');try{onStarted(await api<Job>('/restores/start',{intentId:request.intent.intentId,idempotencyKey:request.idempotencyKey}))}catch(err){const ambiguous=!(err instanceof ApiError)||err.status>=500;setUncertain(ambiguous);setError(ambiguous?'The start result is unknown. Retry using this review to retrieve the same operation; no new restore request will be created.':(err as Error).message)}finally{setBusy(false)}}
  return <div className="operation-form restore-form" aria-busy={busy}><div className="restore-steps" aria-label="Restore progress"><span className="done"><Archive size={15}/>Backup</span><ArrowRight size={13}/><span className={!intent?'current':'done'} aria-current={!intent?'step':undefined}><Database size={15}/>Destination</span><ArrowRight size={13}/><span className={intent?'current':''} aria-current={intent?'step':undefined}><CheckCircle2 size={15}/>Review</span></div><div className="restore-source"><Archive size={19}/><div><strong>{connections.find(c=>c.id===artifact.source_id)?.name??'Source database'}</strong><span>{date(artifact.created_at)} · {bytes(artifact.size)} · {artifact.engine}</span></div><Badge status={artifact.availability}/></div>{!intent?<><label>Restore destination<select value={target} disabled={busy} onChange={e=>setTarget(e.target.value)}><option value="">Choose a separate empty database</option>{targets.map(c=><option key={c.id} value={c.id} disabled={c.blocked}>{c.name} · {String(c.config.database)}{c.blocked?' · blocked':''}</option>)}</select></label>{!targets.length&&<div className="inline-info"><Database size={18}/><p>Add a separate {engineName(artifact.engine)} connection marked as a restore destination in <a href="/connections">Connections</a>.</p></div>}<p className="form-hint">The server checks destination identity, engine compatibility, emptiness, and backup availability before starting.</p></>:<><h3>Review restore</h3><dl className="review-details"><dt>Source database</dt><dd>{intent.review.sourceDatabase}</dd><dt>Target database</dt><dd>{intent.review.targetDatabase}</dd><dt>Engine / server</dt><dd>{intent.review.engine} · {(intent.review.targetVersion??intent.review.serverVersion??'—')}</dd><dt>Review expires</dt><dd>{date(intent.expiresAt)}</dd></dl>{(intent.review.warnings?.length??0)>0&&<div className="notice warning"><ShieldAlert size={17}/><div>{intent.review.warnings?.map((warning,i)=><p key={i}>{warning}</p>)}</div></div>}<div className="inline-info"><CheckCircle2 size={17}/><p>Preflight passed. Destination identity and safety are checked again at execution.</p></div><label className="checkbox confirm-restore"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>Restore this backup into the target database shown above.</label><p className="form-hint">A cancelled or interrupted restore can leave partial data. It is never retried automatically after writes.</p></>}{error&&<p className="form-error" role="alert">{error}</p>}<div className="form-bottom">{intent?<><button className="secondary" disabled={busy||uncertain} onClick={()=>{setRequest(null);setConfirmed(false)}}>Change destination</button><button className="primary" disabled={busy||!confirmed} onClick={()=>void start()}><ArrowDownToLine size={15}/>{busy?'Starting…':uncertain?'Recover start result':'Start restore'}</button></>:<><span>Source database stays protected</span><button className="primary" disabled={busy||!target} onClick={()=>void prepare()}>{busy?'Checking destination…':'Check destination'}<ArrowRight size={15}/></button></>}</div></div>
}
