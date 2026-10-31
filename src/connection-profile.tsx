import {useState} from 'react'
import {Link} from '@tanstack/react-router'
import {Activity,Archive,ArrowDownToLine,ArrowLeft,ArrowRight,Check,ChevronRight,Clock,Copy,Database,HardDrive,LoaderCircle,Pencil,Play,Plus,RefreshCw,Shield} from 'lucide-react'
import type {Artifact,ArtifactCheck,Connection,Job,Overview,Plan} from './state'
import {Badge,bytes,date,Empty,JobTable} from './ui'
import {engineName} from '../shared/engines'
import {ArtifactRetentionLock,PlanRetention,RetentionHistory,type RetentionLock} from './retention'
import './connection-profile.css'

function CopyValue({value,label}:{value:string;label:string}){
  const [status,setStatus]=useState('')
  async function copy(){try{await navigator.clipboard.writeText(value);setStatus('Copied')}catch{setStatus('Could not copy')}}
  return <span className="profile-copy"><code>{value}</code><button type="button" className="icon-button" aria-label={`Copy ${label}`} onClick={()=>void copy()}>{status==='Copied'?<Check size={14}/>:<Copy size={14}/>}</button><span className="profile-copy-result" role="status">{status}</span></span>
}

type Props={
  connection:Connection;data:Overview;jobs:Job[];busy:boolean;testing:boolean;canConfigure:boolean;canRestore:boolean
  pendingPlans:Record<string,{key:string}>;canRunPlan:(plan:Plan)=>boolean
  artifactChecks:Record<string,ArtifactCheck>;checkingBackup:string|null;actor?:string;scopes:readonly string[];onArtifactChanged:(value:RetentionLock)=>void;onRefresh:()=>void
  name:(id:string|null|undefined)=>string;onTest:()=>void;onEdit:()=>void;onCreatePlan:()=>void
  onEditPlan:(plan:Plan)=>void;onRunPlan:(plan:Plan)=>void;onJob:(id:string)=>void
  onCheckBackup:(backup:Artifact)=>void;onRestore:(backup:Artifact)=>void
}

/** Databasement's server-profile composition, implemented with Steelkeep's existing services. */
export function ConnectionProfile({connection,data,jobs,busy,testing,canConfigure,canRestore,pendingPlans,canRunPlan,artifactChecks,checkingBackup,actor,scopes,onArtifactChanged,onRefresh,name,onTest,onEdit,onCreatePlan,onEditPlan,onRunPlan,onJob,onCheckBackup,onRestore}:Props){
  const storage=connection.kind==='s3',target=!storage&&connection.config.restoreTarget===true
  const plans=data.plans.filter(plan=>storage?plan.storage_id===connection.id:!target&&plan.source_id===connection.id)
  const snapshots=data.backups.filter(backup=>storage?backup.storage_id===connection.id:!target&&backup.source_id===connection.id)
  const operations=jobs.filter(job=>storage?job.storage_id===connection.id:target?job.target_id===connection.id:job.source_id===connection.id)
  const recentSnapshots=[...snapshots].sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,8)
  const config=connection.config,role=storage?'Backup storage':target?'Restore destination':'Backup source'
  const facts:ReadonlyArray<readonly[string,string]> = storage?
    [['Endpoint',String(config.endpoint??'—')],['Bucket',String(config.bucket??'—')],['Region',String(config.region??'—')],['Object prefix',String(config.prefix||'Bucket root')]]:
    connection.kind==='sqlite'?[['Database file',String(config.path??'—')]]:
    [['Host / port',`${String(config.host??'—')}:${String(config.port??'—')}`],[connection.kind==='redis'?'Logical database':'Database',String(connection.kind==='redis'?config.dbIndex:config.database??'—')],['Username',String(config.user??'—')],['TLS verification',config.tls===true?'Enabled':'Disabled'],...(connection.kind==='mongodb'?[['Authentication DB',String(config.authDatabase??'admin')] as const]:[])]
  return <div className="connection-profile">
    <Link to="/$section" params={{section:'connections'}} className="profile-back"><ArrowLeft size={15}/>All connections</Link>
    <section className="panel profile-heading">
      <div className="profile-heading-main"><span className={`profile-icon connection-icon ${storage?'blue':'violet'}`}>{storage?<HardDrive size={25}/>:<Database size={25}/>}</span><div><h1>{connection.name}</h1><p>{engineName(connection.kind)}<span aria-hidden="true"> · </span>{role}</p><CopyValue value={connection.id} label="connection ID"/></div></div>
      <div className="profile-heading-actions"><button className="secondary" disabled={busy||!canConfigure} onClick={onTest}>{testing?<LoaderCircle size={15} className="spin"/>:<RefreshCw size={15}/>} {testing?'Testing…':'Test connection'}</button><button className="primary" disabled={busy||!canConfigure} onClick={onEdit}><Pencil size={15}/>Edit connection</button></div>
    </section>
    <div className="profile-summary" aria-label="Connection summary">
      {!target&&<><a href="#connection-plans"><Clock size={18}/><span><strong>{plans.length}</strong> backup {plans.length===1?'plan':'plans'}</span><small>{plans.filter(plan=>plan.enabled).length} enabled</small><ChevronRight size={15}/></a><a href="#connection-snapshots"><Archive size={18}/><span><strong>{snapshots.length}</strong> recent {snapshots.length===1?'snapshot':'snapshots'}</span><small>{bytes(snapshots.reduce((total,backup)=>total+Number(backup.size),0))} recorded in latest 100 artifacts</small><ChevronRight size={15}/></a></>}
      {target&&<div><Shield size={18}/><span>{connection.blocked?'Destination protected':'No active reservation recorded'}</span><small>Emptiness is checked separately before a restore</small></div>}
      <a href="#connection-jobs"><Activity size={18}/><span><strong>{operations.length}</strong> recent {target?'restore ':''}{operations.length===1?'job':'jobs'}</span><small>From the latest 100 operations</small><ChevronRight size={15}/></a>
    </div>
    <div className="profile-columns">
      <div className="profile-primary">
        {!target&&<section className="panel" id="connection-plans"><div className="panel-heading"><div><h2>Backup plans</h2><p>{storage?'Databases that publish backups to this storage.':'What runs, where it is stored, and when.'}</p></div>{canConfigure&&<button className="secondary small" disabled={busy} onClick={onCreatePlan}><Plus size={14}/>Create plan</button>}</div>{plans.length?<div className="profile-plan-list">{plans.map(plan=><article className="profile-plan" key={plan.id}><div className="profile-plan-heading"><div><h3>{plan.name}</h3><p>{name(plan.source_id)}<ArrowRight size={12}/>{name(plan.storage_id)}</p></div><Badge status={plan.enabled?'enabled':'paused'}/></div><dl><dt>Schedule</dt><dd>{plan.cron?<code>{plan.cron}</code>:'Manual only'}</dd><dt>Timezone</dt><dd>{plan.timezone}</dd><dt>Next run</dt><dd>{plan.enabled?date(plan.next_due):'Paused'}</dd></dl><div className="profile-plan-actions"><button className="secondary small" disabled={busy||!canConfigure} onClick={()=>onEditPlan(plan)}>Edit plan</button><button className="primary small" disabled={!canRunPlan(plan)} onClick={()=>onRunPlan(plan)}><Play size={13}/>{pendingPlans[plan.id]?'Recover run result':'Run backup'}</button></div><PlanRetentionDetails plan={plan} actor={actor} scopes={scopes} onChanged={onRefresh}/></article>)}</div>:<Empty compact icon={<Clock size={24}/>} heading="No backup plans">{storage?'Choose this storage when creating a backup plan.':'Create a backup plan and choose this database as its source.'}</Empty>}</section>}
        {target&&<section className="panel profile-destination"><div className="panel-heading"><div><h2>Restore into this destination</h2><p>A separate target keeps the original database protected.</p></div><ArrowDownToLine size={20}/></div><p>{connection.blocked?'This destination is reserved or contains a previous restore. Open its owning job in Recovery protection before further work; use a separate empty destination for a new restore.':'Open a snapshot, choose Restore, and select this destination. Steelkeep verifies its identity, role and emptiness before showing a review.'}</p><Link to="/$section" params={{section:'backups'}} className="secondary">Open snapshots<ArrowRight size={14}/></Link></section>}
        {!target&&<section className="panel" id="connection-snapshots"><div className="panel-heading"><div><h2>Latest snapshots</h2><p>{recentSnapshots.length?`Showing ${recentSnapshots.length} of ${snapshots.length} matching snapshots in the latest 100 artifacts.`:'No matching snapshots in the latest 100 artifacts.'}</p></div><Link to="/$section" params={{section:'backups'}} className="profile-section-link">Open snapshots<ArrowRight size={13}/></Link></div>{recentSnapshots.length?<div className="table-wrap"><table className="profile-snapshots"><thead><tr><th>{storage?'Database / created':'Created / snapshot'}</th><th>Size</th><th>Availability</th><th><span className="sr-only">Snapshot actions</span></th></tr></thead><tbody>{recentSnapshots.map(backup=><tr key={backup.id}><td><button type="button" className="profile-snapshot-link" onClick={()=>onJob(backup.run_id)}>{storage?name(backup.source_id):date(backup.created_at)}</button><small>{storage?date(backup.created_at):backup.id.slice(0,12)+'…'}</small></td><td className="numeric">{bytes(backup.size)}</td><td><SnapshotAvailability backup={backup} check={artifactChecks[backup.id]}/></td><td><div className="snapshot-actions"><div className="actions"><button className="icon-button" disabled={busy||!!snapshotCleanupState(backup)} onClick={()=>onCheckBackup(backup)} aria-label={`Check availability of snapshot ${backup.id}`}><RefreshCw size={15} className={checkingBackup===backup.id?'spin':undefined}/></button><button className="secondary small" disabled={busy||!!snapshotCleanupState(backup)||backup.availability!=='present'||!canRestore} onClick={()=>onRestore(backup)}><ArrowDownToLine size={13}/>Restore</button></div><SnapshotRetentionControl backup={backup} scopes={scopes} onChanged={onArtifactChanged}/></div></td></tr>)}</tbody></table></div>:<Empty compact icon={<Archive size={24}/>} heading="No recent snapshots">A successful backup publishes its artifact here. Connection checks do not create a snapshot.</Empty>}</section>}
      </div>
      <aside className="profile-facts"><section className="panel"><div className="panel-heading"><div><h2>{storage?'Storage details':'Connection details'}</h2><p>Saved configuration</p></div>{storage?<HardDrive size={19}/>:<Database size={19}/>}</div><dl>{facts.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><p className="profile-credential-note">Credentials are encrypted. Saved passwords and keys are never returned.</p></section><section className="panel profile-check"><div className="panel-heading"><div><h2>Connection access</h2><p>Checked {date(connection.checked_at)}</p></div><Badge status={connection.check_status}/></div><p>{storage?'This checks bucket access, not object upload or full archive integrity.':'This checks access to the database, not a complete backup or restore.'} Backup and restore jobs provide their own execution evidence.</p>{connection.blocked&&<p className="profile-protection-note"><Shield size={15}/>{target?'Destination protection is retained.':'A protection hold is recorded; inspect Recovery protection and its owning job.'} Testing access does not clear protection.</p>}</section></aside>
    </div>
    <section className="panel profile-jobs" id="connection-jobs"><div className="panel-heading"><div><h2>Latest {target?'restore ':''}jobs</h2><p>Matching jobs from the latest 100 operations. Open a job for its phases, log and validation.</p></div><Activity size={18}/></div><JobTable jobs={operations.slice(0,12)} name={id=>name(id)} onSelect={onJob}/></section>
  </div>
}


export const snapshotCleanupState=(backup:Artifact)=>backup.deletion_state&&backup.deletion_state!=='active'?backup.deletion_state:null

export function SnapshotAvailability({backup,check}:{backup:Artifact;check?:ArtifactCheck}){
  const cleanup=snapshotCleanupState(backup)
  const label=cleanup?({queued:'cleanup_queued',deleting:'cleanup_in_progress',held:'cleanup_on_hold',deleted:'object_deleted'} as const)[cleanup]:backup.availability
  return <><Badge status={label}/>{cleanup?<small className="cell-note snapshot-cleanup-note">{cleanup==='deleted'?`Deleted ${date(backup.deleted_at)}. History retained; stored object cannot be restored.`:cleanup==='held'?'Deletion outcome is uncertain. This object remains reserved; inspect cleanup history.':'Reserved for cleanup. Availability checks and restore are disabled.'}</small>:<><small className="cell-note">Checked {date(backup.checked_at)}</small>{check&&<small className="cell-note availability-note">{check.message}</small>}</>}</>
}

export function SnapshotRetentionControl({backup,scopes,onChanged}:{backup:Artifact;scopes:readonly string[];onChanged:(value:RetentionLock)=>void}){
  if(typeof backup.retention_locked!=='boolean'||!backup.deletion_state)return null
  return <div className="snapshot-lock-control" aria-label={`Retention protection for snapshot ${backup.id}`}><ArtifactRetentionLock artifactId={backup.id} locked={backup.retention_locked} deletionState={backup.deletion_state} scopes={scopes} onChanged={onChanged}/></div>
}

export function PlanRetentionDetails({plan,actor,scopes,onChanged}:{plan:Plan;actor?:string;scopes:readonly string[];onChanged:()=>void}){
  const [open,setOpen]=useState(false)
  if(!plan.retention||!actor)return null
  const retention=plan.retention
  return <details className="plan-retention-details" onToggle={event=>setOpen(event.currentTarget.open)}><summary><span>Snapshot retention</span><small>{retention.policy.mode==='keep_all'?'Keep everything':retention.policy.mode==='days'?`${retention.policy.days} days`:'Recent, weekly & monthly'} · {retention.enabled?'cleanup enabled':'cleanup disabled'}</small></summary>{open&&<div className="plan-retention-body"><PlanRetention key={plan.id} planId={plan.id} planName={plan.name} retention={retention} actor={actor} scopes={scopes} onChanged={onChanged}/><RetentionHistory planId={plan.id} actor={actor} scopes={scopes} onChanged={onChanged}/></div>}</details>
}
