import {test,expect} from 'bun:test'
import {historyInput,historyCursor,historyAnchor} from '../server/history'

const key=Buffer.alloc(32,9),anchor={id:'00000000-0000-4000-8000-000000000001',createdAt:'2026-10-31T01:02:03.123456Z'}
test('history cursors retain microseconds and bind filters, ordering and resource type',()=>{
  const input=historyInput('jobs',{status:'succeeded',limit:'2'}),cursor=historyCursor('jobs',input,anchor,key)
  expect(historyAnchor('jobs',historyInput('jobs',{limit:2,status:'succeeded',cursor}),key)).toEqual(anchor)
  for(const changed of [{limit:2,status:'failed',cursor},{limit:2,status:'succeeded',order:'oldest',cursor},{limit:3,status:'succeeded',cursor}])expect(()=>historyAnchor('jobs',historyInput('jobs',changed),key)).toThrow('different filters')
  expect(()=>historyAnchor('snapshots',historyInput('snapshots',{limit:2,cursor}),key)).toThrow('different filters')
  expect(()=>historyAnchor('jobs',{...input,cursor},Buffer.alloc(32,8))).toThrow('different filters')
})
test('malformed or tampered cursors cannot inject a database boundary',()=>{
  const input=historyInput('jobs',{}),cursor=historyCursor('jobs',input,anchor,key)
  for(const changed of [cursor.replace(/^./,cursor[0]==='a'?'b':'a'),cursor+'.extra','not-json.bad','x'.repeat(4097)])expect(()=>historyAnchor('jobs',historyInput('jobs',{cursor:changed}),key)).toThrow()
})
test('history filters bound work and reject unsupported fields, enums and reversed dates',()=>{
  expect(historyInput('snapshots',{search:'  100%_literal  '})).toMatchObject({limit:30,order:'newest',search:'100%_literal'})
  expect(historyInput('jobs',{search:'  '})).not.toHaveProperty('search')
  for(const input of [{limit:101},{limit:0},{order:'sql injection'},{status:'anything'},{from:'yesterday'},{from:'2026-11-01T00:00:00Z',until:'2026-10-31T00:00:00Z'},{sourceId:'not-a-uuid'},{search:'x'.repeat(101)},{unknown:'field'}])expect(()=>historyInput('jobs',input)).toThrow()
})
