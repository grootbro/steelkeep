import {test,expect} from 'bun:test'
import {readPendingBackups,writePendingBackups} from '../src/pending-backups'

function memoryStorage():Storage {
  const data=new Map<string,string>()
  return {get length(){return data.size},clear:()=>data.clear(),getItem:key=>data.get(key)??null,key:index=>[...data.keys()][index]??null,removeItem:key=>{data.delete(key)},setItem:(key,value)=>{data.set(key,value)}}
}
const plan='00000000-0000-4000-8000-000000000001',key='00000000-0000-4000-8000-000000000002'
test('an unresolved request survives a fresh read and is isolated by verified actor',()=>{
  const storage=memoryStorage()
  writePendingBackups(storage,'installation-owner',{[plan]:{key}})
  expect(readPendingBackups(storage,'installation-owner')[plan].key).toBe(key)
  expect(readPendingBackups(storage,'agent:different')).toEqual({})
  writePendingBackups(storage,'installation-owner',{})
  expect(readPendingBackups(storage,'installation-owner')).toEqual({})
})
test('malformed state refuses a replacement key instead of silently forgetting an ambiguous request',()=>{
  const storage=memoryStorage()
  writePendingBackups(storage,'installation-owner',{[plan]:{key}})
  const name=storage.key(0)!
  storage.setItem(name,'{broken')
  expect(()=>readPendingBackups(storage,'installation-owner')).toThrow()
  storage.setItem(name,JSON.stringify({[plan]:{key:'caller-controlled-not-a-uuid'}}))
  expect(()=>readPendingBackups(storage,'installation-owner')).toThrow()
})
test('unavailable storage fails before a command can be submitted',()=>{
  const storage=memoryStorage()
  storage.setItem=()=>{throw new Error('storage denied')}
  expect(()=>writePendingBackups(storage,'installation-owner',{[plan]:{key}})).toThrow('No new backup request was sent')
})
