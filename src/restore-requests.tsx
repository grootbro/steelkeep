import {useState} from 'react'
import {useQuery,useQueryClient} from '@tanstack/react-query'
import {ArrowDownToLine} from 'lucide-react'
import {api,ApiError,type Job} from './state'
import {readPendingRestores,writePendingRestores,type PendingRestore,type PendingRestores} from './pending-restores'

export function useRestoreRequests(actor:string|undefined){
  const client=useQueryClient(),queryKey=['pending-restores',actor]
  const query=useQuery({queryKey,queryFn:()=>readPendingRestores(window.sessionStorage,actor!),enabled:!!actor,staleTime:Infinity,gcTime:Infinity})
  function update(change:(previous:PendingRestores)=>PendingRestores){
    if(!actor||query.isPending||query.error)throw new Error('Wait for your saved restore requests to load before continuing.')
    const next=change(client.getQueryData<PendingRestores>(queryKey)??{})
    writePendingRestores(window.sessionStorage,actor,next);client.setQueryData(queryKey,next)
  }
  const clear=(artifactId:string)=>update(previous=>{const next={...previous};delete next[artifactId];return next})
  async function submit(request:PendingRestore){
    update(previous=>{
      const pending=previous[request.artifactId]
      if(pending&&(pending.intentId!==request.intentId||pending.idempotencyKey!==request.idempotencyKey))throw new Error('Recover the unresolved restore request before preparing another one for this snapshot.')
      return {...previous,[request.artifactId]:request}
    })
    let job:Job
    try{job=await api<Job>('/restores/start',{intentId:request.intentId,idempotencyKey:request.idempotencyKey})}
    catch(error){
      // Only service-level refusals establish that this review was not consumed.
      // Authentication, proxy refusals and rate limits cannot resolve a previous unknown result.
      if(error instanceof ApiError&&['NOT_FOUND','RESTORE_REVIEW_EXPIRED','RESTORE_REVIEW_CHANGED','TARGET_BLOCKED','ARTIFACT_DELETION_RESERVED'].includes(error.code??'')){try{clear(request.artifactId)}catch{}}
      throw error
    }
    let warning:string|undefined
    try{clear(request.artifactId)}catch{warning='The restore was accepted, but its recovery bookmark could not be cleared. Open this job before submitting another restore.'}
    return {job,warning}
  }
  return {pending:query.data??{},loading:!actor||query.isPending,error:query.error,submit}
}

export function PendingRestoreRequests({actor,scopes,onStarted}:{actor:string;scopes:readonly string[];onStarted:(job:Job)=>void}){
  const commands=useRestoreRequests(actor),[busy,setBusy]=useState<string|null>(null),[error,setError]=useState('')
  async function recover(request:PendingRestore){
    if(busy||!scopes.includes('restore:run'))return;setBusy(request.artifactId);setError('')
    try{const result=await commands.submit(request);if(result.warning)setError(result.warning);onStarted(result.job)}catch(error){setError(error instanceof Error?error.message:'The restore result is still unknown. Recover this same request again.')}finally{setBusy(null)}
  }
  if(!commands.error&&!Object.keys(commands.pending).length)return null
  return <section className="panel" aria-label="Unresolved restore requests"><div className="panel-heading"><div><h2>Unresolved restore requests</h2><p>Retry the original confirmed command to retrieve its job. If it was never accepted, this can start that same reviewed restore.</p></div><ArrowDownToLine size={19}/></div>{commands.error&&<p className="form-error" role="alert">{commands.error.message}</p>}{!scopes.includes('restore:run')&&<p className="form-hint">Restore permission is required to recover these requests. Their original keys remain saved.</p>}{Object.values(commands.pending).map(request=><div className="form-bottom" key={request.artifactId}><span>Snapshot <code>{request.artifactId.slice(0,12)}…</code> · target <code>{request.targetId.slice(0,12)}…</code></span><button className="secondary small" disabled={!!busy||commands.loading||!!commands.error||!scopes.includes('restore:run')} onClick={()=>void recover(request)}>{busy===request.artifactId?'Recovering…':'Recover restore result'}</button></div>)}{error&&<p className="form-error" role="alert">{error}</p>}</section>
}
