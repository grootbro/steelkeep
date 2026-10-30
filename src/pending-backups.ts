export type PendingBackups=Record<string,{key:string}>
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const storageKey=(actor:string)=>'steelkeep.pending-backups.v1.'+encodeURIComponent(actor)

/** Only operation identifiers are retained; credentials and connection details never enter browser storage. */
export function readPendingBackups(storage:Storage,actor:string):PendingBackups {
  const text=storage.getItem(storageKey(actor))
  if(text===null)return {}
  if(text.length>256*1024)throw new Error('Saved backup request state exceeds its limit. Review job history before resetting browser storage.')
  let value:unknown
  try{value=JSON.parse(text)}catch{throw new Error('Saved backup request state is unreadable. Review job history before resetting browser storage.')}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Saved backup request state is invalid. Review job history before another run.')
  const entries=Object.entries(value)
  if(entries.length>1000||entries.some(([plan,entry])=>!uuid.test(plan)||!entry||typeof entry!=='object'||!('key' in entry)||typeof entry.key!=='string'||!uuid.test(entry.key)))throw new Error('Saved backup request identifiers are invalid. Review job history before another run.')
  return Object.fromEntries(entries.map(([plan,entry])=>[plan,{key:(entry as {key:string}).key}]))
}

export function writePendingBackups(storage:Storage,actor:string,pending:PendingBackups){
  if(Object.keys(pending).length>1000)throw new Error('Too many unresolved backup requests. Resolve existing jobs before another run.')
  try{
    if(Object.keys(pending).length)storage.setItem(storageKey(actor),JSON.stringify(pending))
    else storage.removeItem(storageKey(actor))
  }catch{throw new Error('The browser could not save this request key. No new backup request was sent; allow session storage before retrying.')}
}
