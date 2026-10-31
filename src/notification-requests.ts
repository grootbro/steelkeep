export type NotificationCommand={kind:'test';id:string;key:string;revision:number}|{kind:'retry';id:string;key:string;confirmDuplicateRisk:boolean}
export type PendingNotifications=Record<string,NotificationCommand>
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const storageKey=(actor:string)=>'steelkeep.pending-notifications.v1.'+encodeURIComponent(actor)
export const notificationCommandId=(command:Pick<NotificationCommand,'kind'|'id'>)=>`${command.kind}:${command.id}`
/** Service refuses these only after checking for a previously accepted key. */
export function notificationRequestWasRejected(error:{status:number;code?:string}){
  const statuses:Record<string,number>={NOTIFICATION_CHANNEL_NOT_FOUND:404,NOTIFICATION_RETRY_NOT_READY:409,NOTIFICATION_DUPLICATE_CONFIRMATION_REQUIRED:409,REVISION_CONFLICT:409,NOTIFICATION_CHANNEL_DISABLED:409}
  return error.code!==undefined&&statuses[error.code]===error.status
}

/** Only operation IDs are saved. Destinations, tokens and message bodies stay out of browser storage. */
export function readPendingNotifications(storage:Storage,actor:string):PendingNotifications{
  const raw=storage.getItem(storageKey(actor));if(raw===null)return {}
  const invalid=()=>new Error('Saved notification requests are unreadable. Inspect delivery history before starting another test or retry.')
  if(raw.length>256*1024)throw invalid()
  let value:unknown;try{value=JSON.parse(raw)}catch{throw invalid()}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>1000)throw invalid()
  const result:PendingNotifications={}
  for(const [id,entry] of Object.entries(value)){
    if(!entry||typeof entry!=='object'||Array.isArray(entry))throw invalid()
    const record=entry as Record<string,unknown>
    if(Object.keys(record).length!==4||!['test','retry'].includes(String(record.kind))||typeof record.id!=='string'||!uuid.test(record.id)||typeof record.key!=='string'||!uuid.test(record.key)||id!==`${record.kind}:${record.id}`||record.kind==='test'&&(!Number.isSafeInteger(record.revision)||Number(record.revision)<1)||record.kind==='retry'&&typeof record.confirmDuplicateRisk!=='boolean')throw invalid()
    result[id]=record.kind==='test'?{kind:'test',id:record.id,key:record.key,revision:Number(record.revision)}:{kind:'retry',id:record.id,key:record.key,confirmDuplicateRisk:record.confirmDuplicateRisk===true}
  }
  return result
}
export function writePendingNotifications(storage:Storage,actor:string,pending:PendingNotifications){
  if(Object.keys(pending).length>1000)throw new Error('Resolve existing notification requests before creating another one.')
  try{if(Object.keys(pending).length)storage.setItem(storageKey(actor),JSON.stringify(pending));else storage.removeItem(storageKey(actor))}catch{throw new Error('The browser could not save this notification request. No new request was sent; allow session storage before trying again.')}
}
