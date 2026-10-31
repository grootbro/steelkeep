import {useState,type FormEvent} from 'react'
import {useQuery} from '@tanstack/react-query'
import {Archive,ArrowLeft,ArrowRight,Filter,RefreshCw,Search} from 'lucide-react'
import {api,ApiError,type Connection,type ArtifactCheck,type Artifact} from './state'
import {Empty} from './ui'
import {OperationTable,type OperationRecord} from './operation-table'
import {SnapshotTable,type SnapshotRecord} from './snapshot-table'
import type {RetentionLock} from './retention-types'
import {engineProfiles} from '../shared/engines'
import {historyDateBoundary} from './history-dates'
import './history.css'

type Page<T>={items:T[];nextCursor:string|null;limit:number;order:'newest'|'oldest'}
type Filters={search:string;sourceId:string;storageId:string;status:string;type:string;engine:string;availability:string;deletionState:string;from:string;until:string;order:string}
const initial:Filters={search:'',sourceId:'',storageId:'',status:'',type:'',engine:'',availability:'',deletionState:'',from:'',until:'',order:'newest'}
const additionalKeys=['sourceId','storageId','type','engine','deletionState','from','until'] as const

export function HistoryBrowser({kind,actor,connections,scopes,busy,checks,checkingBackup,onJob,onCheck,onRestore,onArtifactChanged,downloadAvailable=false}:{kind:'jobs'|'snapshots';actor:string;connections:Connection[];scopes:readonly string[];busy:boolean;checks:Record<string,ArtifactCheck>;checkingBackup:string|null;onJob:(id:string)=>void;onCheck:(artifact:Artifact)=>void;onRestore:(artifact:Artifact)=>void;onArtifactChanged:(value:RetentionLock)=>void;downloadAvailable?:boolean}){
  const [draft,setDraft]=useState(initial),[filters,setFilters]=useState(initial),[cursors,setCursors]=useState<(string|undefined)[]>([undefined]),[error,setError]=useState('')
  const cursor=cursors.at(-1),params=new URLSearchParams({limit:'30'})
  for(const [key,value]of Object.entries(filters))if(value)params.set(key,key==='from'||key==='until'?historyDateBoundary(value,key):value)
  if(cursor)params.set('cursor',cursor)
  const history=useQuery({queryKey:['history',actor,kind,params.toString()],queryFn:()=>api<Page<OperationRecord|SnapshotRecord>>(`/history/${kind}?${params}`)})
  function apply(event:FormEvent){
    event.preventDefault()
    if(draft.from&&draft.until&&Date.parse(draft.from)>Date.parse(draft.until)){setError('The start of the date range must not follow its end.');return}
    try{if(draft.from)historyDateBoundary(draft.from,'from');if(draft.until)historyDateBoundary(draft.until,'until')}catch(error){setError(error instanceof Error?error.message:'Choose valid history dates.');return}
    const next={...draft,search:draft.search.trim()}
    setError('');setDraft(next);setFilters(next);setCursors([undefined])
  }
  function field(name:keyof Filters,value:string){setDraft(previous=>({...previous,[name]:value}))}
  function clear(){setDraft(initial);setFilters(initial);setCursors([undefined]);setError('')}
  const sources=connections.filter(connection=>connection.kind!=='s3'&&!connection.config.restoreTarget),volumes=connections.filter(connection=>connection.kind==='s3')
  const name=(id:string|null|undefined)=>connections.find(connection=>connection.id===id)?.name??'Unknown connection'
  const additionalCount=additionalKeys.filter(key=>filters[key]).length,dirty=JSON.stringify(draft)!==JSON.stringify(filters)
  const invalidCursor=history.error instanceof ApiError&&history.error.code==='INVALID_HISTORY_CURSOR'
  return <section className="panel history-browser"><div className="panel-heading"><div><h2>{kind==='jobs'?'All operations':'All snapshots'}</h2><p>Full stored history · 30 records per page</p></div><button type="button" className="icon-button" aria-label="Refresh history page" disabled={history.isFetching} onClick={()=>void history.refetch()}><RefreshCw size={16} className={history.isFetching?'spin':undefined}/></button></div>
    <form onSubmit={apply} className="history-filters"><div className="history-primary-filters"><label className="history-search">Search<input type="search" maxLength={100} value={draft.search} onChange={event=>field('search',event.target.value)} placeholder="Database, storage or record ID"/></label>{kind==='jobs'?<label>Status<select value={draft.status} onChange={event=>field('status',event.target.value)}><option value="">All statuses</option>{['queued','running','cancelling','succeeded','failed','cancelled','interrupted'].map(status=><option key={status}>{status}</option>)}</select></label>:<label>Availability<select value={draft.availability} onChange={event=>field('availability',event.target.value)}><option value="">All availability</option>{['present','missing','changed','unknown'].map(status=><option key={status}>{status}</option>)}</select></label>}<label>Order<select aria-label="History order" value={draft.order} onChange={event=>field('order',event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label></div>
      <details className="history-additional-filters"><summary><Filter size={13}/>More filters{additionalCount>0&&<span>{additionalCount} applied</span>}</summary><div className="history-additional-grid"><label>Database<select value={draft.sourceId} onChange={event=>field('sourceId',event.target.value)}><option value="">All databases</option>{sources.map(source=><option key={source.id} value={source.id}>{source.name}</option>)}</select></label><label>Storage<select value={draft.storageId} onChange={event=>field('storageId',event.target.value)}><option value="">All storage</option>{volumes.map(volume=><option key={volume.id} value={volume.id}>{volume.name}</option>)}</select></label>{kind==='jobs'?<label>Operation<select value={draft.type} onChange={event=>field('type',event.target.value)}><option value="">Backup and restore</option><option value="backup">Backup</option><option value="restore">Restore</option></select></label>:<><label>Engine<select value={draft.engine} onChange={event=>field('engine',event.target.value)}><option value="">All engines</option>{engineProfiles.map(engine=><option key={engine.kind} value={engine.kind}>{engine.name}</option>)}</select></label><label>Cleanup<select value={draft.deletionState} onChange={event=>field('deletionState',event.target.value)}><option value="">All cleanup states</option>{['active','queued','deleting','held','deleted'].map(status=><option key={status}>{status}</option>)}</select></label></>}<label>From<input type="date" min="0001-01-01" max="9999-12-31" value={draft.from} onChange={event=>field('from',event.target.value)}/></label><label>Through<input type="date" min="0001-01-01" max="9999-12-31" value={draft.until} onChange={event=>field('until',event.target.value)}/></label></div></details>
      <div className="history-filter-actions"><button className="secondary small" type="submit" disabled={history.isFetching}><Search size={14}/>Apply filters</button><button className="text-button" type="button" onClick={clear}>Clear</button>{dirty&&<span role="status">Filters have not been applied</span>}</div>
    </form><p className="history-date-scope">Dates include the whole selected day in {Intl.DateTimeFormat().resolvedOptions().timeZone}. Earlier pages can change as jobs finish.</p>
    {error&&<p className="form-error" role="alert">{error}</p>}
    {history.error&&<div className="history-read-error" role="alert"><p>{invalidCursor?'This page cursor is no longer valid. Return to the first page for the current filters.':history.error.message}</p><button type="button" className="secondary small" disabled={history.isFetching} onClick={()=>invalidCursor?setCursors([undefined]):void history.refetch()}>{invalidCursor?'Return to first page':'Retry loading history'}</button></div>}
    {history.isPending?<p className="panel-empty" role="status">Loading full history…</p>:history.data?.items.length?kind==='jobs'?<OperationTable jobs={history.data.items as OperationRecord[]} name={name} onSelect={onJob}/>:<SnapshotTable downloadAvailable={downloadAvailable} backups={history.data.items as SnapshotRecord[]} name={name} actor={actor} scopes={scopes} busy={busy} checks={checks} checkingBackup={checkingBackup} onJob={onJob} onCheck={onCheck} onRestore={onRestore} onArtifactChanged={value=>{onArtifactChanged(value);void history.refetch()}} onCommentChanged={()=>void history.refetch()}/>:!history.error&&<Empty compact icon={<Archive size={24}/>} heading="No matching records">Change the filters to browse another part of the history.</Empty>}
    <div className="history-pagination"><button type="button" className="secondary small" disabled={cursors.length===1||history.isFetching} onClick={()=>setCursors(previous=>previous.slice(0,-1))}><ArrowLeft size={14}/>Previous</button><span>Page {cursors.length}{history.data?` · ${history.data.items.length} records`:''}</span><button type="button" className="secondary small" disabled={!history.data?.nextCursor||history.isFetching||!!history.error} onClick={()=>setCursors(previous=>[...previous,history.data!.nextCursor!])}>Next<ArrowRight size={14}/></button></div>
  </section>
}
