import {useQuery,useQueryClient} from '@tanstack/react-query'
import {api} from './state'
import {notificationCommandId,readPendingNotifications,writePendingNotifications,type NotificationCommand,type PendingNotifications} from './notification-requests'

/** The caller supplies the owning service route; no test or retry is ever submitted by an effect. */
export function useNotificationRequests(actor:string,allowed:boolean){
  const client=useQueryClient(),queryKey=['pending-notifications',actor]
  const query=useQuery({queryKey,queryFn:()=>readPendingNotifications(window.sessionStorage,actor),staleTime:Infinity,gcTime:Infinity})
  function update(change:(previous:PendingNotifications)=>PendingNotifications){
    if(query.isPending||query.error)throw new Error('Load saved notification requests before starting another test or retry.')
    const next=change(client.getQueryData<PendingNotifications>(queryKey)??{})
    writePendingNotifications(window.sessionStorage,actor,next);client.setQueryData(queryKey,next)
  }
  async function submit<T>(command:NotificationCommand,path:string,isDefinitiveRefusal:(error:unknown)=>boolean=()=>false):Promise<{value:T;warning?:string}>{
    if(!allowed)throw new Error('Your session does not have permission to send or retry notifications. The original recovery key has been retained.')
    const id=notificationCommandId(command),saved=client.getQueryData<PendingNotifications>(queryKey)?.[id]??command
    update(previous=>({...previous,[id]:saved}))
    let value:T
    try{value=await api<T>(path,saved.kind==='test'?{revision:saved.revision,idempotencyKey:saved.key}:{idempotencyKey:saved.key,confirmDuplicateRisk:saved.confirmDuplicateRisk})}catch(error){
      // Permission, rate-limit and unknown/proxy errors never prove an earlier command was unaccepted.
      if(isDefinitiveRefusal(error))try{update(previous=>{const next={...previous};delete next[id];return next})}catch{}
      throw error
    }
    try{update(previous=>{const next={...previous};delete next[id];return next})}catch{return {value,warning:'The request was accepted, but its recovery bookmark could not be cleared. Inspect delivery history before another test or retry.'}}
    return {value}
  }
  return {pending:query.data??{},loading:query.isPending,error:query.error,submit}
}
