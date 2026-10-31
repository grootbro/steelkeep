import {expect,test} from 'bun:test'
import {randomUUID} from 'node:crypto'
import {readDeletionRequests,writeDeletionRequests,deletionRequestRejected} from '../src/deletion-requests'

test('deletion recovery stores only the confirmed command identity under its actor',()=>{
 const data=new Map<string,string>(),storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value)},removeItem:(key:string)=>{data.delete(key)}}
 const reviewId=randomUUID(),command={reviewId,idempotencyKey:randomUUID(),confirmDeletion:true as const}
 writeDeletionRequests(storage,'owner:a',{[reviewId]:command})
 expect(readDeletionRequests(storage,'owner:a')).toEqual({[reviewId]:command});expect(readDeletionRequests(storage,'agent:b')).toEqual({})
 expect([...data.values()][0]).not.toContain('artifactIds');expect([...data.values()][0]).not.toContain('credential')
 writeDeletionRequests(storage,'owner:a',{});expect(readDeletionRequests(storage,'owner:a')).toEqual({})
})
test('invalid acknowledgement, corrupt storage and failed persistence cannot authorize a new command',()=>{
 const id=randomUUID(),key=randomUUID()
 for(const raw of ['{','[]',JSON.stringify({[id]:{reviewId:id,idempotencyKey:key,confirmDeletion:false}}),JSON.stringify({[id]:{reviewId:randomUUID(),idempotencyKey:key,confirmDeletion:true}})])expect(()=>readDeletionRequests({getItem:()=>raw},'owner')).toThrow()
 expect(()=>writeDeletionRequests({setItem:()=>{throw new Error('blocked')},removeItem:()=>{}},'owner',{[id]:{reviewId:id,idempotencyKey:key,confirmDeletion:true}})).toThrow()
})
test('only refusals checked after original-key lookup resolve an unknown deletion',()=>{
 for(const code of ['DELETION_REVIEW_EXPIRED','DELETION_REVIEW_CHANGED','DELETION_PROTECTED'])expect(deletionRequestRejected({status:409,code})).toBe(true)
 expect(deletionRequestRejected({status:404,code:'DELETION_REVIEW_NOT_FOUND'})).toBe(true)
 for(const [status,code]of [[404,'NOT_FOUND'],[401,'UNAUTHORIZED'],[403,'FORBIDDEN'],[429,'RATE_LIMITED'],[500,'DELETION_REVIEW_CHANGED'],[409,'IDEMPOTENCY_CONFLICT'],[422,'INVALID_DELETION_REQUEST']] as const)expect(deletionRequestRejected({status,code})).toBe(false)
})
