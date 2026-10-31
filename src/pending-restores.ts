export type PendingRestore={artifactId:string;targetId:string;intentId:string;idempotencyKey:string}
export type PendingRestores=Record<string,PendingRestore>
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const storageKey=(actor:string)=>'steelkeep.pending-restores.v1.'+encodeURIComponent(actor)

/** Save only the identifiers of an explicitly confirmed command, never credentials or review contents. */
export function readPendingRestores(storage:Storage,actor:string):PendingRestores{
  const text=storage.getItem(storageKey(actor))
  if(text===null)return {}
  const invalid=()=>new Error('Saved restore requests are unreadable. Review job history before starting another restore.')
  if(text.length>256*1024)throw invalid()
  let value:unknown
  try{value=JSON.parse(text)}catch{throw invalid()}
  if(!value||typeof value!=='object'||Array.isArray(value))throw invalid()
  const entries=Object.entries(value)
  if(entries.length>1000)throw invalid()
  const result:PendingRestores={}
  for(const [artifact,entry] of entries){
    if(!uuid.test(artifact)||!entry||typeof entry!=='object'||Array.isArray(entry))throw invalid()
    const record=entry as Record<string,unknown>
    if(Object.keys(record).length!==4||!['artifactId','targetId','intentId','idempotencyKey'].every(key=>typeof record[key]==='string'&&uuid.test(record[key] as string))||record.artifactId!==artifact)throw invalid()
    result[artifact]={artifactId:artifact,targetId:record.targetId as string,intentId:record.intentId as string,idempotencyKey:record.idempotencyKey as string}
  }
  return result
}
export function writePendingRestores(storage:Storage,actor:string,pending:PendingRestores){
  if(Object.keys(pending).length>1000)throw new Error('Resolve existing restore requests before starting another restore.')
  try{
    if(Object.keys(pending).length)storage.setItem(storageKey(actor),JSON.stringify(pending))
    else storage.removeItem(storageKey(actor))
  }catch{throw new Error('The browser could not save this restore request. No new restore request was sent; allow session storage before retrying.')}
}
