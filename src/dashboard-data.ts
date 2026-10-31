import type {Job,Overview} from './state'

export function activityDays(data:Overview,jobs:Job[]){
  const end=new Date(data.serverTime)
  end.setUTCHours(0,0,0,0)
  return Array.from({length:14},(_,index)=>{
    const day=new Date(end)
    day.setUTCDate(day.getUTCDate()-13+index)
    const key=day.toISOString().slice(0,10),supplied=data.activity?.find(item=>item.date===key),recent=jobs.filter(job=>job.created_at.slice(0,10)===key)
    return {key,label:day.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'}),backup:supplied?.backup??recent.filter(job=>job.type==='backup').length,restore:supplied?.restore??recent.filter(job=>job.type==='restore').length,failed:supplied?.failed??recent.filter(job=>job.status==='failed').length}
  })
}

export function activityScale(maximum:number){
  const rough=Math.max(1,maximum)/4,magnitude=10**Math.floor(Math.log10(rough)),fraction=rough/magnitude
  const step=Math.max(1,(fraction<=1?1:fraction<=2?2:fraction<=2.5?2.5:fraction<=5?5:10)*magnitude)
  return {maximum:step*4,ticks:[4,3,2,1,0].map(value=>value*step)}
}

export function recentStorage(data:Overview){
  const retained=data.backups.filter(backup=>backup.deletion_state!=='deleted')
  const rows=data.connections.filter(connection=>connection.kind==='s3').map(connection=>({connection,size:retained.filter(backup=>backup.storage_id===connection.id).reduce((sum,backup)=>sum+BigInt(backup.size),0n)}))
  const total=rows.reduce((sum,row)=>sum+row.size,0n)
  return {rows,total,share:(size:bigint)=>total?Number(size*10000n/total)/100:0}
}
