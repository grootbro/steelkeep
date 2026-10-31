import {test,expect} from 'bun:test'
import {readPendingRetention,writePendingRetention,retentionCommandId,retentionRequestWasRejected,type PendingRetention} from '../src/retention-requests'
function memoryStorage():Storage{const data=new Map<string,string>();return {get length(){return data.size},clear:()=>data.clear(),getItem:key=>data.get(key)??null,key:index=>[...data.keys()][index]??null,removeItem:key=>{data.delete(key)},setItem:(key,value)=>{data.set(key,value)}}}
const id='00000000-0000-4000-8000-000000000001',key='00000000-0000-4000-8000-000000000002'
test('cleanup recovery preserves original revision and request key across remount, isolated by actor',()=>{
  const storage=memoryStorage(),pending:PendingRetention={[`run:${id}`]:{kind:'run',id,revision:7,key},[`retry:${id}`]:{kind:'retry',id,key}}
  writePendingRetention(storage,'owner',pending)
  expect(readPendingRetention(storage,'owner')).toEqual(pending)
  expect(readPendingRetention(storage,'agent')).toEqual({})
  expect(retentionCommandId(pending[`run:${id}`])).toBe(`run:${id}`)
  writePendingRetention(storage,'owner',{});expect(storage.length).toBe(0)
})
test('malformed recovery state fails closed instead of creating replacement delete requests',()=>{
  const storage=memoryStorage();writePendingRetention(storage,'owner',{[`run:${id}`]:{kind:'run',id,revision:1,key}})
  const name=storage.key(0)!
  for(const invalid of ['{broken','[]',JSON.stringify({[`run:${id}`]:{kind:'run',id,revision:0,key}}),JSON.stringify({[`retry:${id}`]:{kind:'run',id,revision:1,key}}),JSON.stringify({[`run:${id}`]:{kind:'run',id,revision:1,key:'invalid'}})]){storage.setItem(name,invalid);expect(()=>readPendingRetention(storage,'owner')).toThrow()}
})
test('storage failure prevents a new destructive command from being submitted',()=>{
  const storage=memoryStorage();storage.setItem=()=>{throw new Error('denied')}
  expect(()=>writePendingRetention(storage,'owner',{[`run:${id}`]:{kind:'run',id,revision:3,key}})).toThrow('No new cleanup request was sent')
})
test('authentication, throttling and unknown proxy refusals cannot forget an earlier accepted cleanup',()=>{
  for(const status of [400,401,403,404,408,409,429,500,503])expect(retentionRequestWasRejected({status,code:'UNKNOWN'})).toBe(false)
  expect(retentionRequestWasRejected({status:429,code:'REVISION_CONFLICT'})).toBe(false)
  expect(retentionRequestWasRejected({status:403,code:'NOT_FOUND'})).toBe(false)
  expect(retentionRequestWasRejected({status:409,code:'IDEMPOTENCY_CONFLICT'})).toBe(false)
  expect(retentionRequestWasRejected({status:409,code:'REVISION_CONFLICT'})).toBe(true)
  expect(retentionRequestWasRejected({status:409,code:'RETENTION_NOT_ELIGIBLE'})).toBe(true)
  expect(retentionRequestWasRejected({status:409,code:'RETENTION_RETRY_NOT_READY'})).toBe(true)
  expect(retentionRequestWasRejected({status:404,code:'NOT_FOUND'})).toBe(true)
})
