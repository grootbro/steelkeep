import {test,expect} from 'bun:test'
import {historyDateBoundary} from '../src/history-dates'

test('invalid calendar dates cannot silently change the selected history day',()=>{
  for(const value of ['2026-02-31','0000-01-01','10000-01-01','tomorrow','2026-13-01'])expect(()=>historyDateBoundary(value,'from')).toThrow()
})

test('inclusive local date filters preserve complete DST-short and DST-long days at database precision',async()=>{
  const script="import {historyDateBoundary as b} from './src/history-dates';console.log(JSON.stringify(['2026-03-08','2026-11-01'].map(day=>[b(day,'from'),b(day,'until')])));"
  const child=Bun.spawn([process.execPath,'-e',script],{cwd:process.cwd(),env:{...process.env,TZ:'America/New_York'},stdout:'pipe',stderr:'pipe'})
  const result=JSON.parse(await new Response(child.stdout).text())
  expect(await child.exited).toBe(0)
  expect(result).toEqual([['2026-03-08T05:00:00.000Z','2026-03-09T03:59:59.999999Z'],['2026-11-01T04:00:00.000Z','2026-11-02T04:59:59.999999Z']])
})
