import {test,expect} from 'bun:test'
import {activityDays,activityScale,recentStorage} from '../src/dashboard-data'
import type {Artifact,Connection,Job,Overview} from '../src/state'

const base:Overview={jobs:[],connections:[],plans:[],backups:[],serverTime:'2026-11-01T00:15:00Z'}
test('activity uses UTC dates and authoritative daily data, without counting failures twice',()=>{
  const jobs=[{id:'recent',created_at:'2026-11-01T00:01:00Z',type:'backup',status:'failed'}] as Job[]
  const days=activityDays({...base,activity:[{date:'2026-11-01',backup:12,restore:3,failed:2}]},jobs)
  expect(days).toHaveLength(14)
  expect(days[0].key).toBe('2026-10-19')
  expect(days.at(-1)).toMatchObject({key:'2026-11-01',backup:12,restore:3,failed:2})
  expect(activityDays(base,jobs).at(-1)).toMatchObject({backup:1,restore:0,failed:1})
})
test('chart ticks are distinct integers and fit the highest operation count',()=>{
  for(const count of [0,1,2,4,5,19,100,401]){
    const scale=activityScale(count)
    expect(scale.maximum).toBeGreaterThanOrEqual(count)
    expect(new Set(scale.ticks).size).toBe(5)
    expect(scale.ticks.every(Number.isInteger)).toBe(true)
    expect(scale.ticks.at(-1)).toBe(0)
  }
})
test('volume shares preserve exact byte totals and exclude deleted tombstones',()=>{
  const data={...base,connections:[{id:'s3',kind:'s3'}] as Connection[],backups:[{storage_id:'s3',size:'9007199254740993',deletion_state:'active'},{storage_id:'s3',size:'2',deletion_state:'held'},{storage_id:'s3',size:'99999999999999999',deletion_state:'deleted'}] as Artifact[]}
  const storage=recentStorage(data)
  expect(storage.total).toBe(9007199254740995n)
  expect(storage.rows[0].size).toBe(storage.total)
  expect(storage.share(storage.rows[0].size)).toBe(100)
})
