export type DeletionCommand={reviewId:string;idempotencyKey:string;confirmDeletion:true}
export type PendingDeletions=Record<string,DeletionCommand>
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const key=(actor:string)=>'steelkeep.pending-deletions.v1.'+encodeURIComponent(actor)

/** Only command identities and the prior acknowledgement are stored, never snapshot names or credentials. */
export function readDeletionRequests(storage:Pick<Storage,'getItem'>,actor:string):PendingDeletions{
 const raw=storage.getItem(key(actor));if(raw===null)return {}
 if(raw.length>65536)throw new Error('Saved deletion requests exceed their limit. Inspect cleanup history before another deletion.')
 let value:unknown;try{value=JSON.parse(raw)}catch{throw new Error('Saved deletion requests are unreadable. Inspect cleanup history before another deletion.')}
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>100)throw new Error('Saved deletion requests are invalid. Inspect cleanup history before another deletion.')
 const result:PendingDeletions={}
 for(const [id,item]of Object.entries(value)){
  if(!item||typeof item!=='object'||!('reviewId'in item)||!('idempotencyKey'in item)||!('confirmDeletion'in item)||typeof item.reviewId!=='string'||!uuid.test(item.reviewId)||id!==item.reviewId||typeof item.idempotencyKey!=='string'||!uuid.test(item.idempotencyKey)||item.confirmDeletion!==true)throw new Error('Saved deletion identifiers are invalid. Inspect cleanup history before another deletion.')
  result[id]={reviewId:item.reviewId,idempotencyKey:item.idempotencyKey,confirmDeletion:true}
 }
 return result
}
export function writeDeletionRequests(storage:Pick<Storage,'setItem'|'removeItem'>,actor:string,value:PendingDeletions){
 if(Object.keys(value).length>100)throw new Error('Resolve pending deletion requests before creating another one.')
 try{if(Object.keys(value).length)storage.setItem(key(actor),JSON.stringify(value));else storage.removeItem(key(actor))}catch{throw new Error('The browser could not save the deletion request key. No new request was sent.')}
}
export function deletionRequestRejected(error:{status:number;code?:string}){
 const statuses:Record<string,number>={DELETION_REVIEW_NOT_FOUND:404,DELETION_REVIEW_EXPIRED:409,DELETION_REVIEW_CHANGED:409,DELETION_PROTECTED:409}
 return error.code!==undefined&&statuses[error.code]===error.status
}
