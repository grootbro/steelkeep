import {useQuery} from '@tanstack/react-query'
import {ArrowUpRight,LoaderCircle,ShieldCheck} from 'lucide-react'
import {api,ApiError} from './state'
import {Badge,date} from './ui'
import {engineName} from '../shared/engines'
import './recovery-holds.css'

type OwningJob={run_id:string;run_status:string;run_phase:string;run_error_code:string|null;run_finished_at:string|null}
type SourceHold=OwningJob&{resource_key:string;server_identity:string;state:string;reason_code:string|null;created_at:string;updated_at:string;source_id:string;source_name:string;source_kind:string}
type TargetHold=OwningJob&{target_id:string;target_name:string;target_kind:string;resource_key:string;reason:string;created_at:string;validation_status:'passed'|'failed'|'running'|null}
type HoldRow=OwningJob&{key:string;name:string;kind:string;role:'Source'|'Destination';created_at:string;status:string;explanation:string}
const running=(status:string)=>['queued','running','cancelling'].includes(status)
const poll=(query:{state:{error:Error|null}})=>query.state.error instanceof ApiError&&[401,403].includes(query.state.error.status)?false:10000

function sourceRow(hold:SourceHold):HoldRow{
  const inUse=hold.state==='acquiring'&&running(hold.run_status)
  const unconfirmed=hold.state==='acquiring'&&!running(hold.run_status)
  return {...hold,key:'source:'+hold.resource_key,name:hold.source_name,kind:hold.source_kind,role:'Source',
    status:inUse?'source_in_use':unconfirmed?'acquisition_unconfirmed':'review_required',
    explanation:inUse?'A backup owns this source hold. New backups are blocked until the worker confirms lock release.':unconfirmed?'The job ended with source lock acquisition or release unconfirmed. Review the owning job and the server’s lock state.':'Source lock release is unconfirmed. New backups stay blocked pending operator review.'}
}
function targetRow(hold:TargetHold):HoldRow{
  const protectedDestination=hold.run_status==='succeeded'&&hold.validation_status==='passed'
  const inUse=running(hold.run_status)
  return {...hold,key:'target:'+hold.target_id,name:hold.target_name,kind:hold.target_kind,role:'Destination',
    status:protectedDestination?'protected_destination':inUse?'destination_reserved':'review_required',
    explanation:protectedDestination?'Restore and validation passed. This nonempty destination stays protected. Use a separate empty destination for another restore.':inUse?'Reserved for the owning restore job. A second restore cannot use this destination while that job is active.':'The restore has no confirmed successful validation. This destination may contain partial data and stays protected.'}
}

export function RecoveryHolds({onSelectJob}:{onSelectJob:(id:string)=>void}){
  const sources=useQuery({queryKey:['source-blocks'],queryFn:()=>api<SourceHold[]>('/source-blocks'),retry:false,refetchInterval:poll})
  const targets=useQuery({queryKey:['target-blocks'],queryFn:()=>api<TargetHold[]>('/target-blocks'),retry:false,refetchInterval:poll})
  const rows=[...(sources.data??[]).map(sourceRow),...(targets.data??[]).map(targetRow)]
  const errors=[sources.error&&{label:'Source holds',error:sources.error},targets.error&&{label:'Destination protection',error:targets.error}].filter(value=>!!value)
  const checking=sources.isFetching||targets.isFetching
  if(!rows.length&&!errors.length)return null
  return <section className="panel recovery-holds" aria-label="Recovery protection" aria-busy={checking}>
    <div className="panel-heading recovery-holds-heading"><div><h2><ShieldCheck size={18}/>Recovery protection</h2><p>Source holds and restore destinations retained by their owning jobs.</p></div>{checking&&<span className="recovery-holds-checking"><LoaderCircle size={14} className="spin"/>Checking…</span>}</div>
    {!!errors.length&&<div className="recovery-holds-error" role="alert"><div>{errors.map(value=><p key={value.label}><strong>{value.label} could not be loaded.</strong> {value.error.message}</p>)}</div><button type="button" className="secondary small" disabled={checking} onClick={()=>{void sources.refetch();void targets.refetch()}}>Try again</button></div>}
    {!!rows.length&&<><div className="table-wrap"><table className="recovery-holds-table"><thead><tr><th>Connection</th><th>Protection</th><th>Owning job</th><th>Since</th><th><span className="sr-only">View owning job</span></th></tr></thead><tbody>{rows.map(hold=><tr key={hold.key}>
      <td className="recovery-hold-connection"><strong>{hold.name}</strong><span>{engineName(hold.kind)} · {hold.role}</span></td>
      <td className="recovery-hold-protection"><Badge status={hold.status}/><p>{hold.explanation}</p></td>
      <td className="recovery-hold-job"><Badge status={hold.run_status}/><span>{hold.run_phase.replaceAll('_',' ').replaceAll('-',' ')}</span>{hold.run_error_code&&<code>{hold.run_error_code}</code>}</td>
      <td className="recovery-hold-time"><time dateTime={hold.created_at}>{date(hold.created_at)}</time></td>
      <td className="recovery-hold-action"><button type="button" className="secondary small" onClick={()=>onSelectJob(hold.run_id)} aria-label={`View owning job for ${hold.name}`}>View job<ArrowUpRight size={13}/></button></td>
    </tr>)}</tbody></table></div><p className="recovery-holds-note">A successful connection test does not clear a source hold or destination protection. Restores require a separate empty destination.</p></>}
  </section>
}
