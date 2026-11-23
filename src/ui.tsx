import {Fragment,useEffect,useId,useRef,type MouseEvent,type ReactNode} from 'react'
import {Activity,ArrowDownToLine,Archive,CheckCircle2,ChevronRight,CircleHelp,LoaderCircle,ShieldAlert,X} from 'lucide-react'
import type {Job} from './state'

export const date=(value:string|null|undefined)=>value?new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):'—'
export const bytes=(value:string|number)=>{const n=Number(value);if(!Number.isFinite(n))return '—';if(n<1024)return `${n} B`;const exponent=Math.min(Math.floor(Math.log(n)/Math.log(1024)),4);return `${(n/1024**exponent).toFixed(1)} ${['B','KB','MB','GB','TB'][exponent]}`}
export const active=(job:Job)=>['queued','running','cancelling'].includes(job.status)
export const duration=(job:Job)=>{if(!job.started_at)return '—';const seconds=Math.max(0,Math.floor((new Date(job.finished_at??Date.now()).getTime()-new Date(job.started_at).getTime())/1000));return seconds<60?`${seconds}s`:`${Math.floor(seconds/60)}m ${seconds%60}s`}
export function Badge({status}:{status:string}){return <span className={`badge ${status}`}><span aria-hidden="true"/>{status.replaceAll('_',' ')}</span>}
export function ValidationDetails({value}:{value:Record<string,unknown>}){
  const status=value.status==='passed'&&value.passed===true?'passed':value.status==='failed'||value.passed===false?'failed':value.status==='running'?'running':'unknown'
  const checks=value.checks&&typeof value.checks==='object'&&!Array.isArray(value.checks)?value.checks as Record<string,unknown>:{}
  const rows=[['Archive SHA-256',value.integrity==='sha256-matched'?true:undefined],['Schema',checks.schema],['Data',checks.data],['Sequences and identities',checks.sequences]] as const
  return <section className={`validation-result ${status}`}><h3>{status==='passed'?<CheckCircle2 size={17}/>:status==='failed'?<ShieldAlert size={17}/>:status==='running'?<LoaderCircle className="spin" size={17}/>:<CircleHelp size={17}/>}Restore validation <span>{status==='running'?'In progress':status==='unknown'?'Unconfirmed':status==='passed'?'Passed':'Failed'}</span></h3><dl className="validation-checks">{rows.map(([label,result])=><Fragment key={label}><dt>{label}</dt><dd className={result===true?'verified':result===false?'mismatch':''}>{result===true?'Verified':result===false?'Mismatch':'Not recorded yet'}</dd></Fragment>)}{typeof value.tableCount==='number'&&<><dt>Objects checked</dt><dd>{value.tableCount}</dd></>}</dl>{typeof value.note==='string'&&<p className="form-hint">{value.note}</p>}<details className="validation-evidence"><summary>Validation evidence</summary><pre>{JSON.stringify(value,null,2)}</pre></details></section>
}
export function Empty({icon,heading,children,action,compact=false}:{icon:ReactNode;heading:string;children:ReactNode;action?:ReactNode;compact?:boolean}){return <div className={`empty ${compact?'compact':''}`}><div className="empty-icon">{icon}</div><h3>{heading}</h3><p>{children}</p>{action}</div>}
export function Submit({busy,children,disabled=false}:{busy:boolean;children:ReactNode;disabled?:boolean}){return <button className="primary" disabled={busy||disabled}>{busy&&<LoaderCircle className="spin" size={15}/>} {children}</button>}
let modalLocks=0,restorePageScroll:(()=>void)|null=null
function lockPageScroll(){
 if(modalLocks++===0){
  const body=document.body,root=document.documentElement,x=window.scrollX,y=window.scrollY,properties=['overflow-x','overflow-y','position','top','left','width','padding-right'] as const,saved=properties.map(name=>[name,body.style.getPropertyValue(name),body.style.getPropertyPriority(name)] as const),rootSaved=['overflow-x','overflow-y'].map(name=>[name,root.style.getPropertyValue(name),root.style.getPropertyPriority(name)] as const),gap=window.innerWidth-root.clientWidth
  root.style.overflow='hidden';body.style.overflow='hidden';body.style.position='fixed';body.style.top=`${-y}px`;body.style.left=`${-x}px`;body.style.width='100%'
  if(gap>0)body.style.paddingRight=`${parseFloat(getComputedStyle(body).paddingRight)+gap}px`
  restorePageScroll=()=>{for(const [name,value,priority]of saved){if(value)body.style.setProperty(name,value,priority);else body.style.removeProperty(name)}for(const [name,value,priority]of rootSaved){if(value)root.style.setProperty(name,value,priority);else root.style.removeProperty(name)}window.scrollTo(x,y)}
 }
 let released=false
 return()=>{if(released)return;released=true;if(--modalLocks===0){restorePageScroll?.();restorePageScroll=null}}
}
export function Modal({title,onClose,children,wide=false}:{title:string;onClose:()=>void;children:ReactNode;wide?:boolean}){
 const ref=useRef<HTMLDialogElement>(null),titleId=useId()
 useEffect(()=>{const dialog=ref.current,previous=document.activeElement;if(!dialog)return;const unlock=lockPageScroll();if(!dialog.open){dialog.showModal();dialog.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]),select:not([disabled]),textarea:not([disabled])')?.focus({preventScroll:true})}return()=>{dialog.close();unlock();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus({preventScroll:true})}},[])
 function dismissBackdrop(event:MouseEvent<HTMLDialogElement>){
  if(event.target!==event.currentTarget)return
  const bounds=event.currentTarget.getBoundingClientRect()
  if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)onClose()
 }
 return <dialog ref={ref} className={`modal ${wide?'wide':''}`} onCancel={event=>{event.preventDefault();onClose()}} onClick={dismissBackdrop} aria-labelledby={titleId}><header className="modal-header"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={19}/></button></header><div className="modal-body">{children}</div></dialog>
}

export function JobTable({jobs,name,onSelect,compact=false}:{jobs:Job[];name:(id:string)=>string;onSelect:(id:string)=>void;compact?:boolean}){return jobs.length?<div className="table-wrap"><table className={compact?'compact-table':''}><thead><tr><th>Operation / database</th><th>Status</th>{!compact&&<th>Phase</th>}<th>Duration</th><th>Started</th><th><span className="sr-only">Details</span></th></tr></thead><tbody>{[...jobs].sort((a,b)=>Number(active(b))-Number(active(a))||b.created_at.localeCompare(a.created_at)).map(job=><tr key={job.id}><td><button className="job-name" onClick={()=>onSelect(job.id)}><span className={`operation-icon ${job.type}`}>{job.type==='backup'?<Archive size={15}/>:<ArrowDownToLine size={15}/>}</span><span>{name(job.source_id)}<small>{job.type==='backup'?'Backup':'Restore'}{compact?'':` · ${job.id.slice(0,8)}`}</small></span></button></td><td><Badge status={job.status}/></td>{!compact&&<td className="phase">{job.phase.replaceAll('_',' ')}</td>}<td className="numeric">{duration(job)}</td><td className="date-cell">{date(job.started_at??job.created_at)}</td><td><button className="icon-button" aria-label={`View ${job.type} job for ${name(job.source_id)}`} onClick={()=>onSelect(job.id)}><ChevronRight size={16}/></button></td></tr>)}</tbody></table></div>:<Empty icon={<Activity size={24}/>} heading="No operations yet" compact>Run a backup plan to start recording job history.</Empty>}
