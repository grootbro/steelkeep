import {useEffect,useRef,useState} from 'react'
import {useLocation} from '@tanstack/react-router'
import {useQuery} from '@tanstack/react-query'
import {RetentionHistory} from './retention'
import {api} from './state'
import type {RetentionJob} from './retention-types'

/** Unplanned snapshots need the same inspectable cleanup outcomes as plan-owned snapshots. */
export function SnapshotCleanupHistory({actor,scopes,onChanged}:{actor:string;scopes:readonly string[];onChanged:()=>void}){
 const [open,setOpen]=useState(false),target=useRef<HTMLDetailsElement>(null),scrolled=useRef(false),hash=useLocation({select:location=>location.hash})
 const history=useQuery({queryKey:['retention-jobs',actor],queryFn:()=>api<RetentionJob[]>('/retention-jobs'),enabled:false})
 useEffect(()=>{scrolled.current=false;if(hash.replace(/^#/,'')==='snapshot-cleanup-history')setOpen(true)},[hash])
 // Wait for the mounted history's rows before scrolling; otherwise document-height clamping leaves the outcomes below the fold.
 useEffect(()=>{if(!open){scrolled.current=false;return}if(scrolled.current||hash.replace(/^#/,'')!=='snapshot-cleanup-history'||history.isFetching||history.isPending)return;const frame=requestAnimationFrame(()=>{target.current?.scrollIntoView({block:'start'});scrolled.current=true});return()=>cancelAnimationFrame(frame)},[open,hash,history.isFetching,history.isPending])
 return <section className="panel snapshot-cleanup-history"><details ref={target} id="snapshot-cleanup-history" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>Cleanup history <span>Explicit deletion and retention outcomes</span></summary>{open&&<RetentionHistory actor={actor} scopes={scopes} onChanged={onChanged}/>}</details></section>
}
