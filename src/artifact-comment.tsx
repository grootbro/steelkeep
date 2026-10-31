import {useState,type FormEvent} from 'react'
import {useQuery,useQueryClient} from '@tanstack/react-query'
import {MessageSquare} from 'lucide-react'
import {api,ApiError,type Artifact} from './state'
import {date,Modal} from './ui'
import './artifact-comment.css'

type Comment={id:string;comment:string|null;comment_revision:number;commented_at:string|null}

export function SnapshotCommentControl({artifact,actor,scopes,onChanged}:{artifact:Artifact;actor?:string;scopes:readonly string[];onChanged:()=>void}){
  const [open,setOpen]=useState(false)
  if(!actor||typeof artifact.comment_revision!=='number'||!scopes.includes('read'))return null
  return <><button type="button" className="icon-button snapshot-comment-button" title={artifact.comment?'View snapshot note':'Add a snapshot note'} aria-label={`${artifact.comment?'View':'Open'} note for snapshot ${artifact.id}`} onClick={()=>setOpen(true)}><MessageSquare size={15} fill={artifact.comment?'currentColor':'none'} fillOpacity={artifact.comment?.length?0.15:0}/></button>{open&&<Modal title="Snapshot note" onClose={()=>setOpen(false)}><SnapshotComment artifactId={artifact.id} actor={actor} editable={scopes.includes('configure')} onChanged={onChanged} onClose={()=>setOpen(false)}/></Modal>}</>
}

function SnapshotComment({artifactId,actor,editable,onChanged,onClose}:{artifactId:string;actor:string;editable:boolean;onChanged:()=>void;onClose:()=>void}){
  const query=useQuery({queryKey:['artifact-comment',actor,artifactId],queryFn:()=>api<Comment>(`/backups/${artifactId}/comment`),retry:false})
  if(query.isPending)return <p className="form-hint" role="status">Loading snapshot note…</p>
  if(query.error)return <div><p className="form-error" role="alert">{query.error.message}</p><button className="secondary small" onClick={()=>void query.refetch()}>Retry</button></div>
  if(!editable)return <div className="snapshot-note-read"><p>{query.data.comment??'No note has been added to this snapshot.'}</p><small>Updated {date(query.data.commented_at)}</small></div>
  return <CommentEditor initial={query.data} actor={actor} onChanged={onChanged} onClose={onClose}/>
}

function CommentEditor({initial,actor,onChanged,onClose}:{initial:Comment;actor:string;onChanged:()=>void;onClose:()=>void}){
  const client=useQueryClient(),[draft,setDraft]=useState(initial.comment??''),[revision,setRevision]=useState(initial.comment_revision),[latest,setLatest]=useState<Comment|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[needsReload,setNeedsReload]=useState(false)
  async function save(event:FormEvent){
    event.preventDefault();if(busy||needsReload||draft.length>2000)return
    setBusy(true);setError('')
    try{const result=await api<Comment>(`/backups/${initial.id}/comment`,{revision,comment:draft},'PATCH');client.setQueryData(['artifact-comment',actor,initial.id],result);onChanged();onClose()}
    catch(error){
      const conflict=error instanceof ApiError&&error.code==='REVISION_CONFLICT',unknown=!(error instanceof ApiError)||error.status>=500
      setNeedsReload(conflict||unknown)
      setError(conflict?'This note changed elsewhere. Your draft is preserved. Load the latest saved note before saving again.':unknown?'The save result is unknown. Your draft is preserved. Load the saved note before another edit.':error instanceof Error?error.message:'The note could not be saved.')
    }finally{setBusy(false)}
  }
  async function reload(){
    if(busy)return;setBusy(true);setError('')
    try{const value=await api<Comment>(`/backups/${initial.id}/comment`);setLatest(value);client.setQueryData(['artifact-comment',actor,initial.id],value)}catch(error){setError(error instanceof Error?error.message:'The latest note could not be loaded.')}finally{setBusy(false)}
  }
  return <form onSubmit={event=>void save(event)} className="snapshot-note-editor"><label>Note<textarea value={draft} rows={5} maxLength={2000} disabled={busy} onChange={event=>setDraft(event.target.value)} placeholder="Context about this snapshot"/></label><div className="snapshot-note-meta"><span>{draft.length} / 2,000 characters</span><span>Revision {revision}</span></div><p className="form-hint">Leave empty to remove the note. Notes stay with snapshot history after cleanup.</p>{error&&<p className="form-error" role="alert">{error}</p>}{needsReload&&<button type="button" className="secondary small" disabled={busy} onClick={()=>void reload()}>Load latest saved note</button>}{latest&&<section className="snapshot-note-comparison"><h3>Latest saved note · revision {latest.comment_revision}</h3><p>{latest.comment??'No saved note'}</p><small>Updated {date(latest.commented_at)}</small>{needsReload&&<button type="button" className="secondary small" disabled={busy} onClick={()=>{setRevision(latest.comment_revision);setNeedsReload(false);setError('Latest revision selected. Review your preserved draft before saving.')}}>Use this revision and keep my draft</button>}</section>}<div className="form-bottom"><button type="button" className="secondary" disabled={busy} onClick={onClose}>Close</button><button type="submit" className="primary" disabled={busy||needsReload||draft.length>2000}>{busy?'Saving…':'Save note'}</button></div></form>
}
