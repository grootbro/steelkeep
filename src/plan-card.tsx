import type {ReactNode} from 'react'
import {Link} from '@tanstack/react-router'
import {Archive,Clock,Database,HardDrive,Play,Shield} from 'lucide-react'
import type {Connection,Plan} from './state'
import {Badge,date} from './ui'
import {engineName} from '../shared/engines'
import './workspace-sections.css'

export function PlanCard({plan,source,storage,blocked,pending,canEdit,canRun,onEdit,onRun,children}:{plan:Plan;source?:Connection;storage?:Connection;blocked:boolean;pending:boolean;canEdit:boolean;canRun:boolean;onEdit:()=>void;onRun:()=>void;children:ReactNode}){
  return <section className="panel plan plan-card"><header className="plan-card-heading"><span className="plan-card-icon" aria-hidden="true"><Archive size={19}/></span><div><h2>{plan.name}</h2></div><Badge status={plan.enabled?'enabled':'paused'}/><div className="plan-card-actions"><button type="button" className="secondary small" disabled={!canEdit} onClick={onEdit}>Edit plan</button><button type="button" className="primary small" disabled={!canRun} title={blocked&&!pending?'The source requires operator review before another backup.':undefined} onClick={onRun}><Play size={13}/>{pending?'Recover run result':blocked?'Source blocked':'Run backup'}</button></div></header>
    {blocked&&<p className="plan-blocked-note"><Shield size={14}/>This source requires operator review. A connection check cannot clear its safety block.</p>}
    <dl className="plan-card-summary"><div><dt><Database size={14}/>What to back up</dt><dd>{source?<Link to="/connections/$connectionId" params={{connectionId:source.id}}>{source.name}</Link>:'Source unavailable'}</dd><small>{source?engineName(source.kind):'The original source stays assigned.'}</small></div><div><dt><HardDrive size={14}/>Where to store</dt><dd>{storage?<Link to="/connections/$connectionId" params={{connectionId:storage.id}}>{storage.name}</Link>:'Storage unavailable'}</dd><small>{storage?String(storage.config.bucket??'S3-compatible storage'):'The original storage stays assigned.'}</small></div><div><dt><Clock size={14}/>When to run</dt><dd className={plan.cron?'mono':''}>{plan.cron??'Manual only'}</dd><small>{plan.timezone} · {plan.cron?(plan.enabled?`Next ${date(plan.next_due)}`:'Scheduled runs paused'):'Run from this plan'}</small></div></dl><div className="plan-card-policy"><Shield size={13}/>Missed and overlapping scheduled runs are skipped.</div>{children}</section>
}
