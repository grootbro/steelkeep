import {Archive,ArrowDownToLine,ArrowRight,Clock,LoaderCircle} from 'lucide-react'
import type {Job} from './state'
import {active,Badge,date,duration,ValidationDetails} from './ui'
import './operations.css'

export type InspectedJob=Job&{events:{id:string;phase:string;message:string;created_at:string}[]}

export function JobInspection({job,serverTime,name,busy,canCancel,onCancel}:{job:InspectedJob;serverTime?:string;name:(id:string|null|undefined)=>string;busy:boolean;canCancel:boolean;onCancel:()=>void}){
  const restoring=job.type==='restore',source=name(job.source_id),destination=name(restoring?job.target_id:job.storage_id),subject=restoring?destination:source
  const stale=active(job)&&job.heartbeat_at&&Date.parse(serverTime??'')-Date.parse(job.heartbeat_at)>30000
  return <div className="job-inspection"><section className="job-inspection-summary" aria-label="Operation summary"><div className="job-inspection-heading"><span className={`operation-icon ${job.type}`} aria-hidden="true">{restoring?<ArrowDownToLine size={21}/>:<Archive size={21}/>}</span><div><span className="job-inspection-type">{restoring?'Restore':'Backup'}</span><h3>{subject}</h3></div><Badge status={job.status}/></div><div className="job-inspection-route"><span title={source}>{source}</span><ArrowRight size={13}/><span title={destination}>{destination}</span></div><dl className="job-inspection-facts"><div><dt>Current phase</dt><dd>{job.phase.replaceAll('_',' ')}</dd></div><div><dt><Clock size={12}/>Duration</dt><dd>{duration(job)}</dd></div><div><dt>Created</dt><dd>{date(job.created_at)}</dd></div></dl></section>
    {active(job)&&<div className="inline-info"><LoaderCircle size={16} className="spin"/><p>{job.status==='cancelling'?'Cancellation requested. Waiting for worker confirmation.':`Current phase: ${job.phase.replaceAll('_',' ')}. Progress is reported by stage.`}</p></div>}
    {stale&&<div className="notice warning">No heartbeat in over 30 seconds. The worker may be unavailable; the operation has not been marked successful.</div>}
    {job.status==='interrupted'&&<div className="notice warning">{restoring?'Execution outcome is unknown. The restore target stays blocked until reviewed.':'Execution outcome is unknown. Review the job log before starting another backup.'}</div>}
    {job.error_message&&<p role="alert" className="notice error">{job.error_message}</p>}
    {job.validation&&<ValidationDetails value={job.validation}/>}
    <details className="job-inspection-metadata"><summary>Operation metadata <code>{job.id.slice(0,12)}…</code></summary><dl><dt>Job ID</dt><dd><code>{job.id}</code></dd><dt>Source</dt><dd>{source}</dd><dt>Destination</dt><dd>{destination}</dd><dt>Started</dt><dd>{date(job.started_at)}</dd><dt>Finished</dt><dd>{date(job.finished_at)}</dd><dt>Last heartbeat</dt><dd>{date(job.heartbeat_at)}</dd><dt>Attempt</dt><dd>{job.attempt}</dd></dl></details>
    <div className="job-inspection-log-heading"><h3>Job log</h3><span>{job.events.length} events</span></div><div className="job-inspection-log">{job.events.length?<ol>{job.events.map(event=><li key={event.id}><div className="job-event-marker" aria-hidden="true"/><div className="job-event-heading"><span>{event.phase.replaceAll('_',' ')}</span><time dateTime={event.created_at}>{date(event.created_at)}</time></div><p>{event.message}</p></li>)}</ol>:<p className="panel-empty">Waiting for the first worker event.</p>}</div>
    {canCancel&&['queued','running'].includes(job.status)&&<div className="form-bottom job-inspection-cancel"><span>{restoring?'If writes have started, cancellation may leave partial data and a blocked target.':'Cancellation waits for the worker to stop.'}</span><button type="button" className="danger" disabled={busy} onClick={onCancel}>Cancel job</button></div>}
  </div>
}
