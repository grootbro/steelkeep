import {Fragment,useState,type FormEvent,type ReactNode} from 'react'
import {useQuery} from '@tanstack/react-query'
import {ArrowLeft,ArrowRight,Clock,Filter,LoaderCircle,RefreshCw,Search} from 'lucide-react'
import {api,ApiError,type Connection} from './state'
import {Empty} from './ui'
import {engineProfiles} from '../shared/engines'
import type {BrowsedPlan,PlanOrder,PlanPage} from './plan-browser-types'
import './plan-browser.css'

type Filters={search:string;sourceId:string;storageId:string;kind:string;status:string;schedule:string;retentionMode:string;order:PlanOrder}
type Props={actor:string;scopes:readonly string[];connections:readonly Connection[];renderPlan:(plan:BrowsedPlan)=>ReactNode;onCreate?:()=>void}
const initial:Filters={search:'',sourceId:'',storageId:'',kind:'',status:'',schedule:'',retentionMode:'',order:'newest'}
const extraKeys=['sourceId','storageId','kind','schedule','retentionMode'] as const
const orders:ReadonlyArray<readonly[PlanOrder,string]>=[['newest','Newest added'],['oldest','Oldest added'],['name_asc','Name A–Z'],['name_desc','Name Z–A'],['next_due','Next run first']]

/** A changed actor or grant set starts a fresh cursor chain and cannot reuse another session's page. */
export function PlanBrowser(props:Props){
  const scopeKey=[...new Set(props.scopes)].sort().join(',')
  return <PlanBrowserSession key={JSON.stringify([props.actor,scopeKey])} {...props} scopeKey={scopeKey}/>
}

function PlanBrowserSession({actor,scopes,scopeKey,connections,renderPlan,onCreate}:Props&{scopeKey:string}){
  const [draft,setDraft]=useState(initial),[filters,setFilters]=useState(initial),[cursors,setCursors]=useState<(string|undefined)[]>([undefined])
  const params=new URLSearchParams({limit:'30',order:filters.order})
  for(const key of ['search','sourceId','storageId','kind','status','schedule','retentionMode'] as const)if(filters[key])params.set(key,filters[key])
  const cursor=cursors.at(-1)
  if(cursor)params.set('cursor',cursor)
  const readable=!!actor&&scopes.includes('read')
  const page=useQuery({queryKey:['plan-browser',actor,scopeKey,params.toString()],queryFn:()=>api<PlanPage>(`/history/plans?${params}`),enabled:readable,retry:false,refetchInterval:query=>query.state.error?false:15000})
  const sources=connections.filter(connection=>connection.kind!=='s3'&&!connection.config.restoreTarget),volumes=connections.filter(connection=>connection.kind==='s3')
  const invalidCursor=page.error instanceof ApiError&&page.error.code==='INVALID_PLAN_CURSOR',dirty=JSON.stringify(draft)!==JSON.stringify(filters),extraCount=extraKeys.filter(key=>filters[key]).length
  function field(name:keyof Filters,value:string){setDraft(previous=>({...previous,[name]:value}))}
  function apply(event:FormEvent){event.preventDefault();const next={...draft,search:draft.search.trim()};setDraft(next);setFilters(next);setCursors([undefined])}
  function clear(){setDraft(initial);setFilters(initial);setCursors([undefined])}
  function firstPage(){setCursors([undefined])}
  if(!readable)return <section className="panel"><p className="panel-empty plan-browser-permission">Viewing backup plans requires read permission.</p></section>
  return <div className="plan-browser"><section className="panel plan-browser-controls"><div className="panel-heading"><div><h2>All backup plans</h2><p>Installation totals · unaffected by the filters below</p></div><button type="button" className="icon-button" aria-label="Refresh plans page" disabled={page.isFetching} onClick={()=>void page.refetch()}><RefreshCw size={16} className={page.isFetching?'spin':undefined}/></button></div>
    {page.data&&<dl className="plan-browser-summary" aria-label="Installation plan totals">{([['total','All plans'],['enabled','Enabled'],['paused','Paused'],['scheduled','Scheduled'],['manual','Manual']] as const).map(([key,label])=><div key={key}><dt>{label}</dt><dd>{page.data.summary[key].toLocaleString()}</dd></div>)}</dl>}
    <form className="plan-browser-filters" onSubmit={apply} aria-busy={page.isFetching}><div className="plan-browser-primary"><label className="plan-browser-search">Search plans<input type="search" maxLength={100} value={draft.search} onChange={event=>field('search',event.target.value)} placeholder="Plan, database or storage name"/></label><label>Status<select value={draft.status} onChange={event=>field('status',event.target.value)}><option value="">All statuses</option><option value="enabled">Enabled</option><option value="paused">Paused</option></select></label><label>Order<select aria-label="Plan order" value={draft.order} onChange={event=>field('order',event.target.value)}>{orders.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div>
      <details className="plan-browser-more"><summary><Filter size={13}/>More filters{extraCount>0&&<span>{extraCount} applied</span>}</summary><div className="plan-browser-extra"><label>Source database<select value={draft.sourceId} onChange={event=>field('sourceId',event.target.value)}><option value="">All source databases</option>{draft.sourceId&&!sources.some(source=>source.id===draft.sourceId)&&<option value={draft.sourceId}>Previously selected source</option>}{sources.map(source=><option key={source.id} value={source.id}>{source.name}</option>)}</select></label><label>Storage<select value={draft.storageId} onChange={event=>field('storageId',event.target.value)}><option value="">All storage</option>{draft.storageId&&!volumes.some(volume=>volume.id===draft.storageId)&&<option value={draft.storageId}>Previously selected storage</option>}{volumes.map(volume=><option key={volume.id} value={volume.id}>{volume.name}</option>)}</select></label><label>Engine<select value={draft.kind} onChange={event=>field('kind',event.target.value)}><option value="">All engines</option>{engineProfiles.map(engine=><option key={engine.kind} value={engine.kind}>{engine.name}</option>)}</select></label><label>Schedule<select value={draft.schedule} onChange={event=>field('schedule',event.target.value)}><option value="">All schedules</option><option value="scheduled">Scheduled</option><option value="manual">Manual only</option></select></label><label>Retention<select value={draft.retentionMode} onChange={event=>field('retentionMode',event.target.value)}><option value="">All retention policies</option><option value="keep_all">Keep everything</option><option value="days">Keep for a period</option><option value="gfs">Recent, weekly & monthly</option></select></label></div></details>
      <div className="plan-browser-filter-actions"><button type="submit" className="secondary small" disabled={page.isFetching}><Search size={14}/>Apply filters</button><button type="button" className="text-button" onClick={clear}>Clear</button>{dirty&&<span role="status">Filters have not been applied</span>}</div>
    </form></section>
    {page.error&&<div className="notice error plan-browser-error" role="alert"><p>{invalidCursor?'This plan cursor is no longer valid. Return to the first page for the current filters.':`${page.data?'Displayed plans and counts may be stale. ':''}${page.error.message}`}</p><button type="button" className="secondary small" disabled={page.isFetching} onClick={()=>invalidCursor?firstPage():void page.refetch()}>{invalidCursor?'Return to first page':'Retry loading plans'}</button></div>}
    {page.isPending?<section className="panel"><p className="plan-browser-loading" role="status"><LoaderCircle size={17} className="spin"/>Loading backup plans…</p></section>:page.data&&<><div className="plan-browser-results" aria-live="polite"><span><strong>{page.data.total.toLocaleString()}</strong> matching {page.data.total===1?'plan':'plans'} · {page.data.items.length} shown on this page</span><span>Page {cursors.length} · {orders.find(([value])=>value===filters.order)?.[1]}{page.isFetching?' · updating':''}</span></div>{page.data.items.length?<div className="plans-list">{page.data.items.map(plan=><Fragment key={plan.id}>{renderPlan(plan)}</Fragment>)}</div>:<section className="panel">{page.data.total>0?<Empty icon={<Clock size={25}/>} heading="No plans on this page" action={<button type="button" className="secondary" onClick={firstPage}>Return to first page</button>}>Plans changed while browsing. Return to the first page with the current filters.</Empty>:page.data.summary.total>0?<Empty icon={<Search size={25}/>} heading="No plans match" action={<button type="button" className="secondary" onClick={clear}>Clear filters</button>}>Change the name, source, storage or policy filters.</Empty>:<Empty icon={<Clock size={25}/>} heading="No backup plans yet" action={onCreate&&<button type="button" className="primary" onClick={onCreate}>Create plan</button>}>Choose what to back up, where to store it, and when to run.</Empty>}</section>}
      <div className="plan-browser-pagination"><button type="button" className="secondary small" disabled={cursors.length===1||page.isFetching} onClick={()=>setCursors(previous=>previous.slice(0,-1))}><ArrowLeft size={14}/>Previous</button><span>Page {cursors.length}</span><button type="button" className="secondary small" disabled={!page.data.nextCursor||page.isFetching||!!page.error} onClick={()=>setCursors(previous=>[...previous,page.data!.nextCursor!])}>Next<ArrowRight size={14}/></button></div></>}
    <p className="plan-browser-scope">Matching totals cover all saved plans, not only this page. Plans and next-run times can change while you browse.</p>
  </div>
}
