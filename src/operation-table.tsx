import {Activity,Archive,ArrowDownToLine,ChevronRight} from 'lucide-react'
import type {Job} from './state'
import {active,Badge,date,duration} from './ui'
import './operations.css'

export type OperationRecord=Job&{source_name?:string;storage_name?:string;target_name?:string|null}

/** The recent window prioritizes active work; cursor history keeps the server's order. */
export function OperationTable({jobs,name,onSelect,activeFirst=false}:{jobs:OperationRecord[];name:(id:string|null|undefined)=>string;onSelect:(id:string)=>void;activeFirst?:boolean}){
  const rows=activeFirst?[...jobs].sort((a,b)=>Number(active(b))-Number(active(a))||b.created_at.localeCompare(a.created_at)):jobs
  return <div className="table-wrap"><table className="operation-table"><thead><tr><th>Operation / database</th><th>Status / phase</th><th>Duration</th><th>Created</th><th><span className="sr-only">Job details</span></th></tr></thead><tbody>{rows.map(job=>{
    const source=job.source_name??name(job.source_id),destination=job.type==='restore'?job.target_name??name(job.target_id):job.storage_name??name(job.storage_id),subject=job.type==='restore'?destination:source
    return <tr key={job.id}><td><div className="operation-subject"><span className={`operation-icon ${job.type}`} aria-hidden="true">{job.type==='backup'?<Archive size={17}/>:job.type==='restore'?<ArrowDownToLine size={17}/>:<Activity size={17}/>}</span><div><button type="button" className="operation-subject-link" onClick={()=>onSelect(job.id)}>{subject}</button><span className="operation-route">{job.type==='restore'?'Restore from':'Backup to'} <span title={job.type==='restore'?source:destination}>{job.type==='restore'?source:destination}</span></span><code className="operation-id" title={job.id}>{job.id.slice(0,12)}…</code></div></div></td><td className="operation-state"><Badge status={job.status}/><small>{job.phase.replaceAll('_',' ')}</small></td><td className="operation-duration numeric">{duration(job)}</td><td className="operation-created"><time dateTime={job.created_at}>{date(job.created_at)}</time>{job.started_at&&<small>Started {date(job.started_at)}</small>}</td><td className="operation-detail-action"><button type="button" className="icon-button" aria-label={`View ${job.type} job for ${subject}`} title="View job details and log" onClick={()=>onSelect(job.id)}><ChevronRight size={17}/></button></td></tr>
  })}</tbody></table></div>
}
