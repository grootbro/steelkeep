import {QueryClient} from '@tanstack/react-query'
import {DbClient,collectionOptions} from '@tanstack/react-db'
import {queryCollectionOptions} from '@tanstack/query-db-collection'
import type {DatabaseKind} from '../shared/engines'

export type JobStatus='queued'|'running'|'cancelling'|'succeeded'|'failed'|'cancelled'|'interrupted'
export type Job={id:string;type:string;status:JobStatus;phase:string;plan_id:string|null;source_id:string;storage_id:string;created_at:string;started_at:string|null;finished_at:string|null;heartbeat_at:string|null;error_message:string|null;attempt:number;target_id?:string|null;validation?:Record<string,unknown>|null}
export type Connection={id:string;name:string;kind:DatabaseKind|'s3';blocked?:boolean;config:Record<string,unknown>;check_status:string;checked_at:string|null}
export type Plan={id:string;name:string;source_id:string;storage_id:string;cron:string|null;timezone:string;next_due:string|null;enabled:boolean;upcoming?:string[]}
export type Artifact={id:string;source_id:string;run_id:string;size:string;sha256:string;created_at:string;availability:string;engine:string;storage_id:string;last_restore?:{status:string;validation:Record<string,unknown>|null;finished_at:string|null}|null}
export type ActivityDay={date:string;backup:number;restore:number;failed:number}
export type RestoreIntent={intentId:string;expiresAt:string;review:{artifactId:string;targetId:string;fingerprint:string;engine:string;sourceDatabase:string;targetDatabase:string;serverVersion?:string;sourceVersion?:string;targetVersion?:string;warnings?:string[];checks:unknown}}
export type Overview={jobs:Job[];connections:Connection[];plans:Plan[];backups:Artifact[];serverTime:string;activity?:ActivityDay[];activityWindow?:{from:string;to:string;timezone:string};jobSummary?:{windowDays:number;total:number;succeeded:number;failed:number;cancelled:number;interrupted:number;active:number;scope:string};storageSummary?:{bytes:string;count:number;scope:string}}
export class ApiError extends Error {constructor(message:string,public status:number){super(message)}}
export async function api<T>(path:string,body?:unknown,method?:'POST'|'PATCH'):Promise<T>{
  const response=await fetch('/api/v1'+path,{method:method??(body===undefined?'GET':'POST'),headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})
  if(!response.ok){const value=await response.json().catch(()=>null);throw new ApiError(value?.error?.message??'The server is unavailable. Try again.',response.status)}
  return response.status===204?undefined as T:response.json()
}
export const queryClient=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:true}}})
export const dbClient=new DbClient()
export const jobsCollection=collectionOptions('jobs',()=>queryCollectionOptions({
  queryKey:['jobs'],queryClient,queryFn:()=>api<Job[]>('/jobs'),getKey:(job:Job)=>job.id,
  refetchInterval:query=>query.state.error instanceof ApiError&&query.state.error.status===401?false:3000,retry:false
}))
