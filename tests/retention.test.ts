import {test,expect} from 'bun:test'
import {retentionPolicy,selectRetention,type RetentionRow} from '../server/retention-policy'

const row=(id:string,created:string,extra:Partial<RetentionRow>={}):RetentionRow=>({id,created_at:new Date(created),size:'10',retention_locked:false,deletion_state:'active',pin:null,...extra})
const now=new Date('2026-10-31T10:00:00Z'),cutoff=new Date('2026-10-17T10:00:00Z')

test('retention defaults retain all and invalid or empty destructive policies are refused',()=>{
 expect(retentionPolicy({mode:'keep_all'})).toEqual({mode:'keep_all'})
 expect(selectRetention([row('old','2020-01-01')],{mode:'keep_all'},now,'UTC',cutoff).candidates).toEqual([])
 for(const policy of [null,{},[],{mode:'keep_all',enabled:true},{mode:'days',days:0},{mode:'days',days:1.5},{mode:'days',days:36501},{mode:'gfs',keepDaily:0,keepWeekly:0,keepMonthly:0},{mode:'gfs',keepDaily:1001,keepWeekly:0,keepMonthly:0}])expect(()=>retentionPolicy(policy)).toThrow()
})
test('days retention expires only strictly older snapshots and protects locks and restore pins',()=>{
 const selected=selectRetention([row('old','2026-10-01'),row('boundary',cutoff.toISOString()),row('locked','2026-10-01',{retention_locked:true}),row('review','2026-10-01',{pin:'restore_review'}),row('active','2026-10-01',{pin:'restore_active'}),row('uncertain','2026-10-01',{pin:'restore_uncertain'}),row('deleting','2026-10-01',{deletion_state:'held'})],{mode:'days',days:14},now,'UTC',cutoff)
 expect(selected.candidates.map(r=>r.id)).toEqual(['old']);expect(selected.kept).toBe(1);expect(selected.bytes).toBe('10')
 expect(selected.protectedRows.map(r=>r.reason)).toEqual(['locked','restore_review','restore_active','restore_uncertain','deletion_reserved'])
})
test('GFS daily is the latest N snapshots, while weekly and monthly tiers add their newest snapshots',()=>{
 const snapshots=[row('a','2026-10-31T09:00Z'),row('b','2026-10-31T08:00Z'),row('c','2026-10-27'),row('d','2026-10-25'),row('e','2026-10-20'),row('f','2026-09-30'),row('g','2026-08-31')]
 const selected=selectRetention(snapshots,{mode:'gfs',keepDaily:2,keepWeekly:2,keepMonthly:2},now,'UTC',cutoff)
 expect(selected.candidates.map(r=>r.id)).toEqual(['c','e','g']);expect(selected.kept).toBe(4)
 snapshots[0].retention_locked=true
 const locked=selectRetention(snapshots,{mode:'gfs',keepDaily:2,keepWeekly:2,keepMonthly:2},now,'UTC',cutoff)
 expect(locked.candidates.map(r=>r.id)).toEqual(['e','g']);expect(locked.protectedRows).toEqual([{id:'a',reason:'locked'}])
})
test('GFS calendar weeks begin Monday and use the explicit plan timezone',()=>{
 const date=new Date('2026-10-25T20:00Z'),snapshots=[row('a','2026-10-25T19:00Z'),row('b','2026-10-25T16:00Z'),row('c','2026-10-18T10:00Z')],policy={mode:'gfs' as const,keepDaily:0,keepWeekly:2,keepMonthly:0}
 expect(selectRetention(snapshots,policy,date,'Asia/Bangkok',cutoff).candidates.map(r=>r.id)).toEqual(['c'])
 expect(selectRetention(snapshots,policy,date,'UTC',cutoff).candidates.map(r=>r.id)).toEqual(['b'])
})
test('GFS calendar month windows do not collapse at month-end or count protected keep slots',()=>{
 const date=new Date('2026-10-31T20:00Z'),snapshots=[row('a','2026-10-31T19:00Z'),row('b','2026-10-31T16:00Z'),row('c','2026-09-30T10:00Z')],policy={mode:'gfs' as const,keepDaily:0,keepWeekly:0,keepMonthly:2}
 expect(selectRetention(snapshots,policy,date,'Asia/Bangkok',cutoff).candidates.map(r=>r.id)).toEqual(['c'])
 expect(selectRetention(snapshots,policy,date,'UTC',cutoff).candidates.map(r=>r.id)).toEqual(['b'])
 snapshots[0].deletion_state='queued'
 const selected=selectRetention(snapshots,{mode:'gfs',keepDaily:1,keepWeekly:0,keepMonthly:0},date,'UTC',cutoff)
 expect(selected.protectedRows).toEqual([{id:'a',reason:'deletion_reserved'}]);expect(selected.candidates.map(r=>r.id)).toEqual(['c'])
})
