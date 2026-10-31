export type RetentionCommand={kind:'run';id:string;revision:number;key:string}|{kind:'retry';id:string;key:string}
export type PendingRetention=Record<string,RetentionCommand>
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const storageKey=(actor:string)=>'steelkeep.pending-retention.v1.'+encodeURIComponent(actor)
export const retentionCommandId=(command:Pick<RetentionCommand,'kind'|'id'>)=>`${command.kind}:${command.id}`

/** These service refusals are checked only after the original key lookup, so they prove no matching command was accepted. */
export function retentionRequestWasRejected(error:{status:number;code?:string}){
  const statuses:Record<string,number>={NOT_FOUND:404,REVISION_CONFLICT:409,RETENTION_DISABLED:409,RETENTION_NOT_ELIGIBLE:409,RETENTION_RETRY_NOT_READY:409,RETENTION_SCAN_LIMIT:409,MANUAL_DELETION_RETRY_FORBIDDEN:409}
  return error.code!==undefined&&statuses[error.code]===error.status
}

/** Store only operation identities, never policies, object names or credentials. */
export function readPendingRetention(storage:Storage,actor:string):PendingRetention{
  const raw=storage.getItem(storageKey(actor));if(raw===null)return {}
  if(raw.length>256*1024)throw new Error('Saved cleanup requests exceed their limit. Review cleanup history before resetting browser storage.')
  let value:unknown;try{value=JSON.parse(raw)}catch{throw new Error('Saved cleanup requests are unreadable. Review cleanup history before resetting browser storage.')}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Saved cleanup requests are invalid. Review cleanup history before another run.')
  const entries=Object.entries(value)
  if(entries.length>1000)throw new Error('Too many unresolved cleanup requests. Resolve their results before another run.')
  const result:PendingRetention={}
  for(const [id,entry] of entries){
    if(!entry||typeof entry!=='object'||!('kind' in entry)||!('id' in entry)||!('key' in entry)||!['run','retry'].includes(String(entry.kind))||typeof entry.id!=='string'||!uuid.test(entry.id)||typeof entry.key!=='string'||!uuid.test(entry.key)||id!==`${entry.kind}:${entry.id}`||entry.kind==='run'&&(!('revision' in entry)||!Number.isSafeInteger(entry.revision)||Number(entry.revision)<1))throw new Error('Saved cleanup identifiers are invalid. Review cleanup history before another run.')
    result[id]=entry.kind==='run'?{kind:'run',id:entry.id,key:entry.key,revision:Number((entry as {revision:number}).revision)}:{kind:'retry',id:entry.id,key:entry.key}
  }
  return result
}
export function writePendingRetention(storage:Storage,actor:string,pending:PendingRetention){
  if(Object.keys(pending).length>1000)throw new Error('Too many unresolved cleanup requests. Resolve their results before another run.')
  try{if(Object.keys(pending).length)storage.setItem(storageKey(actor),JSON.stringify(pending));else storage.removeItem(storageKey(actor))}catch{throw new Error('The browser could not save the cleanup request key. No new cleanup request was sent; allow session storage before retrying.')}
}
