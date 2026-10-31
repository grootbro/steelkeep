import {useState} from 'react'
import {useQuery,useQueryClient} from '@tanstack/react-query'
import {ShieldAlert,Trash2} from 'lucide-react'
import {Link} from '@tanstack/react-router'
import type {DeletionPreview,DeletionAccepted} from '../server/artifact-deletions'
import {api,ApiError} from './state'
import type {Artifact} from './state'
import {Badge,bytes,date,Modal} from './ui'
import {readDeletionRequests,writeDeletionRequests,deletionRequestRejected,type DeletionCommand,type PendingDeletions} from './deletion-requests'
import './snapshot-deletion.css'

function useDeletionRequests(actor:string){
 const client=useQueryClient(),key=['pending-snapshot-deletions',actor]
 const query=useQuery({queryKey:key,queryFn:()=>readDeletionRequests(window.sessionStorage,actor),staleTime:Infinity,gcTime:Infinity})
 function change(update:(current:PendingDeletions)=>PendingDeletions){
  if(query.isPending||query.error)throw new Error('Saved deletion requests must load before another deletion can be submitted.')
  const next=update(client.getQueryData<PendingDeletions>(key)??{})
  writeDeletionRequests(window.sessionStorage,actor,next);client.setQueryData(key,next)
 }
 return {query,save:(command:DeletionCommand)=>change(current=>({...current,[command.reviewId]:command})),remove:(id:string)=>change(current=>{const next={...current};delete next[id];return next})}
}

export function PendingSnapshotDeletions({actor,onChanged}:{actor:string;onChanged:()=>void}){
 const requests=useDeletionRequests(actor),[reviewId,setReviewId]=useState<string|null>(null),pending=Object.values(requests.query.data??{})
 return <>{requests.query.error&&<p className="form-error" role="alert">{requests.query.error.message}</p>}{pending.length>0&&<div className="snapshot-deletion-pending"><ShieldAlert size={16}/><div><strong>Deletion requests need a result check</strong><p>Reloading never resubmits a deletion. Recover the saved request before starting again.</p>{pending.map(command=><button type="button" className="secondary small" key={command.reviewId} onClick={()=>setReviewId(command.reviewId)}>Check request {command.reviewId.slice(0,8)}…</button>)}</div></div>}{reviewId&&<SnapshotDeletionDialog key={actor+reviewId} actor={actor} reviewId={reviewId} onClose={()=>setReviewId(null)} onChanged={onChanged}/>}</>
}

export function SnapshotDeletionDialog({actor,artifactIds,reviewId,onClose,onChanged}:{actor:string;artifactIds?:string[];reviewId?:string;onClose:()=>void;onChanged:()=>void}){
 return <Modal title={reviewId?'Recover deletion request':'Review permanent deletion'} wide onClose={onClose}><DeletionReview actor={actor} artifactIds={artifactIds} reviewId={reviewId} onClose={onClose} onChanged={onChanged}/></Modal>
}
export function SnapshotDeleteAction({artifact,actor,scopes,available,busy,onChanged}:{artifact:Artifact;actor?:string;scopes:readonly string[];available:boolean;busy:boolean;onChanged:()=>void}){
 const [open,setOpen]=useState(false)
 if(!actor||!available||!scopes.includes('backup:delete'))return null
 return <><button type="button" className="icon-button" disabled={busy||artifact.deletion_state!=='active'||artifact.retention_locked} aria-label={`Review deletion of snapshot ${artifact.id}`} title={artifact.retention_locked?'Locked snapshots cannot be deleted.':'Review permanent deletion'} onClick={()=>setOpen(true)}><Trash2 size={15}/></button>{open&&<SnapshotDeletionDialog key={actor+artifact.id} actor={actor} artifactIds={[artifact.id]} onClose={()=>setOpen(false)} onChanged={onChanged}/>}</>
}
function DeletionReview({actor,artifactIds,reviewId,onClose,onChanged}:{actor:string;artifactIds?:string[];reviewId?:string;onClose:()=>void;onChanged:()=>void}){
 const requests=useDeletionRequests(actor),[acknowledged,setAcknowledged]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[accepted,setAccepted]=useState<DeletionAccepted|null>(null),[rejected,setRejected]=useState(false),[checked,setChecked]=useState<{review:DeletionPreview;result:DeletionAccepted|null}|null>(null)
 const query=useQuery({queryKey:['snapshot-deletion-review',actor,reviewId??artifactIds],queryFn:async()=>reviewId?api<{review:DeletionPreview;result:DeletionAccepted|null}>(`/backups/deletion-reviews/${reviewId}`):{review:await api<DeletionPreview>('/backups/deletion-review',{artifactIds}),result:null},staleTime:Infinity,gcTime:0,refetchOnWindowFocus:false,retry:false})
 const data=checked??query.data,preview=data?.review,result=accepted??data?.result,command=preview?requests.query.data?.[preview.reviewId]:undefined
 async function submit(){
  if(!preview||busy||result||rejected||!command&&!acknowledged)return
  const next=command??{reviewId:preview.reviewId,idempotencyKey:crypto.randomUUID(),confirmDeletion:true as const}
  setBusy(true);setError('')
  try{requests.save(next)}catch(value){setError(value instanceof Error?value.message:'The request key could not be saved.');setBusy(false);return}
  try{
   const value=await api<DeletionAccepted>('/backups/deletion-requests',next);setAccepted(value);onChanged()
   try{requests.remove(next.reviewId)}catch{setError('The request was accepted, but its browser bookmark remains. You can check this same receipt again after reloading.')}
  }catch(value){
   const known=value instanceof ApiError&&deletionRequestRejected(value)
   if(known){setRejected(true);try{requests.remove(next.reviewId)}catch{}}
   setError(known?(value as Error).message:'The result could not be confirmed. Your saved request key is preserved. Check its receipt or explicitly recover this same request; do not create a replacement deletion.')
  }finally{setBusy(false)}
 }
 async function checkReceipt(){
  if(!preview||busy)return;setBusy(true);setError('')
  try{setChecked(await api<{review:DeletionPreview;result:DeletionAccepted|null}>(`/backups/deletion-reviews/${preview.reviewId}`))}catch(value){setError(value instanceof Error?value.message:'The saved receipt could not be checked.')}finally{setBusy(false)}
 }
 function acknowledgeReceipt(){
  if(!result||!preview)return
  if(command&&command.idempotencyKey!==result.idempotencyKey){setError('This review was accepted with a different request key. Inspect the listed cleanup jobs before resolving the saved request.');return}
  try{requests.remove(preview.reviewId);onChanged();onClose()}catch(value){setError(value instanceof Error?value.message:'The receipt bookmark could not be cleared.')}
 }
 return <div className="snapshot-deletion-review">{query.isPending&&<p className="form-hint" role="status">Loading the exact snapshot selection…</p>}{query.error&&<div><p className="form-error" role="alert">{query.error.message}</p><button type="button" className="secondary small" onClick={()=>void query.refetch()}>Retry review</button></div>}{preview&&<><div className="snapshot-deletion-warning"><ShieldAlert size={20}/><div><strong>These backup files will be permanently deleted</strong><p>Restore locks, active reviews and uncertain outcomes stay protected. Accepted means queued; only a succeeded cleanup job confirms deletion.</p></div></div><div className="snapshot-deletion-summary"><span>{preview.artifactIds.length} selected</span><span>{bytes(preview.bytes)} eligible</span><span>{preview.blockedCount} protected</span></div><ul className="snapshot-deletion-items">{preview.items.map(item=><li key={item.id}><div><strong>{item.sourceName}</strong><span>{item.storageName} · {date(item.createdAt)}</span><code>{item.id}</code></div><span>{bytes(item.size)}</span>{item.eligible?<Badge status="eligible"/>:<span className="snapshot-deletion-reason">{item.reason?.replaceAll('_',' ')}</span>}</li>)}</ul>{result?<div className="snapshot-deletion-receipt" role="status"><h3>Accepted deletion jobs: {result.queued}</h3><p>Inspect Cleanup history for their actual outcomes. The snapshot records and notes remain after stored files are removed.</p><ul>{result.jobIds.map(id=><li key={id}><code>{id}</code></li>)}</ul><Link className="secondary small" to="/$section" params={{section:'backups'}} hash="snapshot-cleanup-history" onClick={()=>{onClose();const history=document.getElementById('snapshot-cleanup-history');if(history instanceof HTMLDetailsElement)history.open=true}}>Open cleanup history</Link><button type="button" className="secondary" disabled={requests.query.isPending||!!requests.query.error} onClick={acknowledgeReceipt}>I have checked this receipt</button></div>:<><p className="form-hint">Review expires {date(preview.expiresAt)}. The entire selection must remain eligible; no partial batch is admitted.</p>{preview.blockedCount>0&&<p className="form-error" role="alert">Nothing can be submitted with protected snapshots in this selection. Close this review and select eligible snapshots.</p>}{!command&&!reviewId&&<label className="checkbox snapshot-deletion-ack"><input type="checkbox" checked={acknowledged} disabled={busy||preview.blockedCount>0||rejected} onChange={event=>setAcknowledged(event.target.checked)}/><span>I understand that these selected backup files will be permanently deleted.</span></label>}{reviewId&&!command&&<p className="form-hint">No unresolved command is saved in this browser. Checking this review did not submit work.</p>}</>}{error&&<p className="form-error" role="alert">{error}</p>}{requests.query.error&&<p className="form-error" role="alert">{requests.query.error.message}</p>}<div className="form-bottom"><button type="button" className="secondary" onClick={onClose}>Close</button>{!result&&<div className="actions">{command&&<button type="button" className="secondary" disabled={busy} onClick={()=>void checkReceipt()}>Check receipt</button>}<button type="button" className="danger" disabled={busy||rejected||preview.blockedCount>0||requests.query.isPending||!!requests.query.error||!command&&(!acknowledged||!!reviewId)} onClick={()=>void submit()}><Trash2 size={14}/>{busy?'Submitting…':command?'Recover same deletion request':`Permanently delete ${preview.artifactIds.length}`}</button></div>}</div></>}</div>
}
