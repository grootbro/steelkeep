import {test,expect} from 'bun:test'
import {readPendingRestores,writePendingRestores} from '../src/pending-restores'

function memoryStorage():Storage{
  const data=new Map<string,string>()
  return {get length(){return data.size},clear:()=>data.clear(),getItem:key=>data.get(key)??null,key:index=>[...data.keys()][index]??null,removeItem:key=>{data.delete(key)},setItem:(key,value)=>{data.set(key,value)}}
}
const artifactId='00000000-0000-4000-8000-000000000001',request={artifactId,targetId:'00000000-0000-4000-8000-000000000002',intentId:'00000000-0000-4000-8000-000000000003',idempotencyKey:'00000000-0000-4000-8000-000000000004'}
test('a confirmed restore command survives a fresh read without storing review contents and remains actor scoped',()=>{
  const storage=memoryStorage()
  writePendingRestores(storage,'owner:one',{[artifactId]:request})
  expect(readPendingRestores(storage,'owner:one')).toEqual({[artifactId]:request})
  expect(readPendingRestores(storage,'agent:other')).toEqual({})
  expect(Object.keys(JSON.parse(storage.getItem(storage.key(0)!)!)[artifactId]).sort()).toEqual(['artifactId','idempotencyKey','intentId','targetId'])
  writePendingRestores(storage,'owner:one',{})
  expect(readPendingRestores(storage,'owner:one')).toEqual({})
})
test('damaged or cross-artifact bookmarks fail closed instead of generating another command',()=>{
  const storage=memoryStorage()
  writePendingRestores(storage,'owner',{[artifactId]:request});const key=storage.key(0)!
  for(const value of ['{broken',JSON.stringify({[artifactId]:{...request,artifactId:request.targetId}}),JSON.stringify({[artifactId]:{...request,secret:'forbidden'}}),JSON.stringify({[artifactId]:{...request,intentId:'not-a-uuid'}})]){
    storage.setItem(key,value);expect(()=>readPendingRestores(storage,'owner')).toThrow('Review job history')
  }
})
test('a browser storage refusal blocks submission instead of losing its recovery key',()=>{
  const storage=memoryStorage();storage.setItem=()=>{throw new Error('denied')}
  expect(()=>writePendingRestores(storage,'owner',{[artifactId]:request})).toThrow('No new restore request was sent')
})
