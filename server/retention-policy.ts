import {AppError} from './security'

// Semantics adapted from Databasement's MIT ApplyRetentionPoliciesAction;
// see THIRD-PARTY-NOTICES.md. Locked/reserved snapshots never fill keep slots.
export type RetentionPolicy={mode:'keep_all'}|{mode:'days';days:number}|{mode:'gfs';keepDaily:number;keepWeekly:number;keepMonthly:number}
export type RetentionProtection='locked'|'restore_review'|'restore_active'|'restore_uncertain'|'deletion_reserved'
export type RetentionRow={id:string;created_at:Date;size:string;retention_locked:boolean;deletion_state:string;pin:RetentionProtection|null}
export const retentionScanLimit=10000,retentionBatchLimit=20
export function retentionPolicy(value:unknown):RetentionPolicy{
 const p=value as Record<string,unknown>|null
 const integer=(n:unknown,min:number,max:number)=>typeof n==='number'&&Number.isInteger(n)&&n>=min&&n<=max
 if(p&&typeof p==='object'&&!Array.isArray(p)){
  if(p.mode==='keep_all'&&Object.keys(p).length===1)return {mode:'keep_all'}
  if(p.mode==='days'&&Object.keys(p).length===2&&integer(p.days,1,36500))return {mode:'days',days:p.days as number}
  if(p.mode==='gfs'&&Object.keys(p).length===4&&integer(p.keepDaily,0,1000)&&integer(p.keepWeekly,0,520)&&integer(p.keepMonthly,0,240)&&Number(p.keepDaily)+Number(p.keepWeekly)+Number(p.keepMonthly)>0)return {mode:'gfs',keepDaily:p.keepDaily as number,keepWeekly:p.keepWeekly as number,keepMonthly:p.keepMonthly as number}
 }
 throw new AppError('INVALID_RETENTION_POLICY','Choose keep all, a positive days period, or at least one bounded GFS tier.')
}
function period(date:Date,formatter:Intl.DateTimeFormat){
 const parts=formatter.formatToParts(date)
 const number=(name:string)=>Number(parts.find(part=>part.type===name)?.value)
 const year=number('year'),month=number('month'),day=number('day'),ordinal=Math.floor(Date.UTC(year,month-1,day)/86400000)
 return {week:ordinal-((new Date(ordinal*86400000).getUTCDay()+6)%7),month:year*12+month-1}
}
export function selectRetention(rows:RetentionRow[],policy:RetentionPolicy,now:Date,timezone:string,cutoff:Date,includeReservedId?:string){
 const protectedRows:Array<{id:string;reason:RetentionProtection}>=[],eligible:RetentionRow[]=[]
 for(const row of rows){
  const reason=row.retention_locked?'locked':row.pin??(row.deletion_state!=='active'&&row.id!==includeReservedId?'deletion_reserved':null)
  if(reason)protectedRows.push({id:row.id,reason});else eligible.push(row)
 }
 eligible.sort((a,b)=>b.created_at.getTime()-a.created_at.getTime()||b.id.localeCompare(a.id))
 const kept=new Set<string>()
 if(policy.mode==='keep_all'){for(const row of eligible)kept.add(row.id)}
 else if(policy.mode==='days'){for(const row of eligible)if(row.created_at>=cutoff)kept.add(row.id)}
 else{
  for(const row of eligible.slice(0,policy.keepDaily))kept.add(row.id)
  const formatter=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'numeric',day:'numeric'}),current=period(now,formatter),weeks=new Set<number>(),months=new Set<number>()
  for(const row of eligible){
   const bucket=period(row.created_at,formatter),weekAge=(current.week-bucket.week)/7,monthAge=current.month-bucket.month
   if(weekAge>=0&&weekAge<policy.keepWeekly&&!weeks.has(bucket.week)){weeks.add(bucket.week);kept.add(row.id)}
   if(monthAge>=0&&monthAge<policy.keepMonthly&&!months.has(bucket.month)){months.add(bucket.month);kept.add(row.id)}
  }
 }
 const candidates=eligible.filter(row=>!kept.has(row.id)).map(row=>({id:row.id,createdAt:row.created_at.toISOString(),size:row.size,reason:policy.mode==='days'?'expired_days' as const:'outside_gfs' as const}))
 return {candidates,protectedRows,kept:kept.size,bytes:candidates.reduce((sum,row)=>sum+BigInt(row.size),0n).toString()}
}
