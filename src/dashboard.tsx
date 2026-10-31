import {useState} from 'react'
import {Activity,Archive,ArrowRight,CheckCircle2,ChevronRight,Clock,Database,HardDrive,PieChart,Plus} from 'lucide-react'
import {Link} from '@tanstack/react-router'
import {active,Badge,bytes,date,duration} from './ui'
import {activityDays,activityScale,recentStorage} from './dashboard-data'
import type {Job,Overview} from './state'
import './dashboard.css'

const statuses=['succeeded','failed','running','queued','cancelling','cancelled','interrupted'] as const

/** Databasement's operational dashboard hierarchy, using Steelkeep's actual DTOs. */
export function Dashboard({data,jobs,name,onSelect,onConnection,onPlan}:{data:Overview;jobs:Job[];name:(id:string)=>string;onSelect:(id:string)=>void;onConnection?:()=>void;onPlan?:()=>void}){
  const [status,setStatus]=useState('all')
  const summary=data.jobSummary,terminal=jobs.filter(job=>['succeeded','failed'].includes(job.status))
  const outcomes=summary?summary.succeeded+summary.failed:terminal.length
  const successRate=outcomes?Math.round((summary?summary.succeeded:terminal.filter(job=>job.status==='succeeded').length)/outcomes*100):null
  const storage=recentStorage(data),sources=data.connections.filter(connection=>connection.kind!=='s3'&&!connection.config.restoreTarget)
  const volumes=data.connections.filter(connection=>connection.kind==='s3')
  const hasSource=sources.some(connection=>connection.check_status==='available'&&!connection.blocked),hasStorage=volumes.some(connection=>connection.check_status==='available')
  const sourcesBlocked=sources.length>0&&sources.every(source=>source.blocked)
  const plansBlocked=data.plans.length>0&&data.plans.every(plan=>sources.find(source=>source.id===plan.source_id)?.blocked)
  const needsFirstBackup=data.backups.length===0
  const recentJobs=[...jobs].sort((a,b)=>Number(active(b))-Number(active(a))||b.created_at.localeCompare(a.created_at))
  const selectedJobs=recentJobs.filter(job=>status==='all'||job.status===status).slice(0,8)
  const activeCount=summary?.active??jobs.filter(active).length

  return <div className="dashboard">
    <div className="dashboard-metrics">
      <section className="dashboard-metric dashboard-snapshots" aria-label="Snapshot summary">
        <div className="dashboard-metric-label"><h2>{data.storageSummary?'Snapshots':'Recent snapshots'}</h2><Archive size={17}/></div>
        <div className="dashboard-metric-value"><strong>{(data.storageSummary?.count??data.backups.filter(backup=>backup.deletion_state!=='deleted').length).toLocaleString()}</strong><span>retained</span></div>
        <div className="dashboard-metric-foot"><span>{data.storageSummary?'All recorded history':'Latest 100 records'}</span><Link to="/$section" params={{section:'backups'}} aria-label="Browse snapshots"><ArrowRight size={15}/></Link></div>
      </section>
      <section className="dashboard-metric">
        <span className="dashboard-metric-icon storage"><HardDrive size={23}/></span>
        <div className="dashboard-metric-content"><h2>Backup storage</h2><strong>{bytes(data.storageSummary?.bytes??storage.total.toString())}</strong><span>{data.storageSummary?'Retained artifact records':'Latest 100 artifact records'}</span></div>
      </section>
      <section className="dashboard-metric">
        <span className="dashboard-metric-icon success"><PieChart size={23}/></span>
        <div className="dashboard-metric-content"><h2>Success rate <span>({summary?`${summary.windowDays}d`:'recent'})</span></h2><div className="dashboard-rate"><strong>{successRate===null?'—':`${successRate}%`}</strong>{activeCount>0&&<span className="dashboard-active"><span aria-hidden="true"/>{activeCount} active</span>}</div><span>{outcomes?`${outcomes.toLocaleString()} succeeded or failed jobs`:'No completed outcomes yet'}</span></div>
      </section>
    </div>

    {needsFirstBackup&&<section className="first-backup"><div className="first-backup-heading"><div><h2>Set up your first backup</h2><p>{!sources.length?'Start with the database you want to protect.':!volumes.length?'Add S3 storage for your backup files.':sourcesBlocked?'The source is blocked pending operator review. Testing its connection cannot clear the safety block.':!hasSource||!hasStorage?'Check your source and storage before creating a plan.':!data.plans.length?'Your source and storage are checked. Create a backup plan.':plansBlocked?'Existing plans have blocked sources. Review them before starting another backup.':'Open a plan and run your first backup. Follow capture and upload in Jobs.'}</p></div>{!sources.length||!volumes.length?onConnection&&<button className="primary" onClick={onConnection}><Plus size={15}/>Add connection</button>:!hasSource||!hasStorage?<Link className="secondary" to="/$section" params={{section:'connections'}}>{sourcesBlocked?'Review blocked source':'Check connections'}<ArrowRight size={14}/></Link>:!data.plans.length?onPlan&&<button className="primary" onClick={onPlan}><Plus size={15}/>Create plan</button>:<Link className="primary" to="/$section" params={{section:'plans'}}>{plansBlocked?'Review plans':'Open plans'}<ArrowRight size={14}/></Link>}</div><ol className="first-backup-steps"><li className={hasSource?'ready':''}>{hasSource?<CheckCircle2 size={16}/>:<Database size={16}/>}<span>Database source<small>{hasSource?'Connection checked':sourcesBlocked?'Blocked · operator review':sources.length?'Needs a connection check':'Not added yet'}</small></span></li><li className={hasStorage?'ready':''}>{hasStorage?<CheckCircle2 size={16}/>:<HardDrive size={16}/>}<span>S3 storage<small>{hasStorage?'Bucket access checked':volumes.length?'Needs a connection check':'Not added yet'}</small></span></li><li className={data.plans.length&&!plansBlocked?'ready':''}>{data.plans.length&&!plansBlocked?<CheckCircle2 size={16}/>:<Clock size={16}/>}<span>Backup plan<small>{data.plans.length?(plansBlocked?'Source requires review':data.plans.every(plan=>!plan.enabled)?'Paused · manual runs available':'Plan created'):'Source, storage and schedule'}</small></span></li></ol></section>}

    <ActivityChart data={data} jobs={jobs}/>

    <div className="dashboard-lower">
      <section className="panel dashboard-jobs"><div className="dashboard-heading"><div><h2>Latest jobs</h2><p>Latest 100 · active work first</p></div><select value={status} onChange={event=>setStatus(event.target.value)} aria-label="Filter latest jobs by status"><option value="all">All statuses</option>{statuses.map(value=><option key={value} value={value}>{value}</option>)}</select></div>
        {selectedJobs.length?<div className="dashboard-job-list">{selectedJobs.map(job=>{
          const connection=data.connections.find(item=>item.id===(job.type==='restore'?job.target_id:job.source_id))
          const database=connection?.config.database??(connection?.kind==='sqlite'?connection.config.path:connection?.kind==='redis'?`DB ${String(connection.config.dbIndex??0)}`:undefined)
          return <button className="dashboard-job-row" key={job.id} onClick={()=>onSelect(job.id)} aria-label={`View ${job.type} job for ${name(job.type==='restore'?job.target_id??job.source_id:job.source_id)}: ${job.status}`}>
            <span className={`dashboard-operation ${job.type}`}><span>{job.type==='restore'?'Restore':'Backup'}</span></span>
            <span className="dashboard-job-connection"><strong>{name(job.type==='restore'?job.target_id??job.source_id:job.source_id)}</strong><span>{database?String(database):job.id.slice(0,12)+'…'}</span></span>
            <Badge status={job.status}/><span className="dashboard-job-time"><time dateTime={job.created_at} title={date(job.created_at)}>{date(job.created_at)}</time><small>{duration(job)}</small></span><ChevronRight size={15}/>
          </button>
        })}</div>:<div className="dashboard-empty"><Archive size={23}/><h3>{jobs.length?'No jobs with this status':'Your operation history starts here'}</h3><p>{jobs.length?'Choose another status to browse recent work.':'Run a backup plan to record its stages and outcome.'}</p>{jobs.length&&status!=='all'&&<button className="secondary small" onClick={()=>setStatus('all')}>Show all statuses</button>}</div>}
        <div className="dashboard-panel-footer"><Link to="/$section" params={{section:'jobs'}}>All operations<ArrowRight size={14}/></Link><Link to="/$section" params={{section:'backups'}}>Snapshots<ArrowRight size={14}/></Link></div>
      </section>
      <div className="dashboard-side">
        <section className="panel dashboard-status"><div className="dashboard-heading"><div><h2>Job status</h2><p>{jobs.length.toLocaleString()} most recent operations</p></div><Activity size={17}/></div>{jobs.length?<><div className="dashboard-job-grid">{recentJobs.map(job=><button className={`dashboard-job-square ${job.status}`} key={job.id} title={`${name(job.type==='restore'?job.target_id??job.source_id:job.source_id)} · ${job.type} · ${job.status} · ${date(job.created_at)}`} aria-label={`${name(job.type==='restore'?job.target_id??job.source_id:job.source_id)} ${job.type}: ${job.status}. Open details`} onClick={()=>onSelect(job.id)}/>)}</div><div className="dashboard-status-legend">{statuses.filter(value=>jobs.some(job=>job.status===value)).map(value=><span key={value}><i className={value}/>{value}</span>)}</div></>:<p className="dashboard-side-empty">Each recorded operation appears here with its worker-reported outcome.</p>}</section>
        <section className="panel dashboard-volumes"><div className="dashboard-heading"><div><h2>Storage by volume</h2><p>Latest 100 retained artifact records</p></div><HardDrive size={17}/></div>{storage.rows.length?<><VolumeChart storage={storage}/><div className="dashboard-volume-list">{storage.rows.map(({connection,size},index)=><div className="dashboard-volume" key={connection.id}><div className="dashboard-volume-name"><span className={`dashboard-volume-key volume-${index%4}`} aria-hidden="true"/><Link to="/connections/$connectionId" params={{connectionId:connection.id}} title={connection.name}>{connection.name}</Link><strong>{bytes(size.toString())}</strong></div><div className="dashboard-volume-meta"><span>{String(connection.config.bucket??'')}</span><span>{storage.share(size)}% of this window</span></div></div>)}</div></>:<p className="dashboard-side-empty">Add backup storage to see its recorded artifacts.</p>}<p className="dashboard-storage-scope">Recorded bytes; physical capacity is not measured.</p></section>
      </div>
    </div>
  </div>
}

function VolumeChart({storage}:{storage:ReturnType<typeof recentStorage>}){
  let offset=0
  return <div className="dashboard-volume-chart"><svg viewBox="0 0 140 140" role="img" aria-label="Storage volume shares of the latest retained artifact records; recorded bytes, not physical capacity"><circle className="dashboard-volume-empty-ring" cx="70" cy="70" r="53" fill="none" strokeWidth="15"/><g transform="rotate(-90 70 70)">{storage.rows.map(({connection,size},index)=>{const share=storage.share(size),start=offset;offset+=share;return share>0?<circle className={`dashboard-volume-segment volume-${index%4}`} key={connection.id} cx="70" cy="70" r="53" fill="none" strokeWidth="15" pathLength="100" strokeDasharray={`${share} ${100-share}`} strokeDashoffset={-start}><title>{connection.name}: {bytes(size.toString())} · {share}%</title></circle>:null})}</g></svg><div className="dashboard-volume-total"><strong>{bytes(storage.total.toString())}</strong><span>Recent bytes</span></div></div>
}

function ActivityChart({data,jobs}:{data:Overview;jobs:Job[]}){
  const days=activityDays(data,jobs),scale=activityScale(Math.max(0,...days.map(day=>Math.max(day.backup,day.restore))))
  const hasJobs=days.some(day=>day.backup+day.restore>0)
  const plotHeight=160,width=980,column=width/days.length,barWidth=column*.3
  return <section className="panel dashboard-activity"><div className="dashboard-heading"><div><h2>Jobs activity</h2><p>Last 14 days · UTC{!data.activity?' · latest 100 jobs only':''}</p></div><span className="dashboard-chart-range">{days[0]?.label} – {days.at(-1)?.label}</span></div>
    <div className="dashboard-chart"><div className="dashboard-chart-axis" aria-hidden="true">{scale.ticks.map(tick=><span key={tick}>{tick.toLocaleString()}</span>)}</div><div className="dashboard-chart-body"><svg viewBox={`0 0 ${width} ${plotHeight}`} preserveAspectRatio="none" role="img" aria-label={`Backup and restore jobs created per UTC day. ${hasJobs?'Exact counts are available in the chart data below.':'No jobs recorded in this period.'}`}>
      {scale.ticks.map((tick,index)=><line className="dashboard-chart-guide" key={tick} x1="0" x2={width} y1={index*plotHeight/4} y2={index*plotHeight/4}/>)}
      {days.map((day,index)=>{const x=index*column+column*.17,backup=day.backup/scale.maximum*plotHeight,restore=day.restore/scale.maximum*plotHeight;return <g className="dashboard-chart-day" key={day.key}><title>{`${day.label}: ${day.backup} backup, ${day.restore} restore; ${day.failed} failed (included)`}</title><rect className="dashboard-bar backup" x={x} y={plotHeight-backup} width={barWidth} height={backup} rx="3"/><rect className="dashboard-bar restore" x={x+barWidth+3} y={plotHeight-restore} width={barWidth} height={restore} rx="3"/></g>})}
    </svg>{!hasJobs&&<div className="dashboard-chart-empty">No jobs recorded in this period</div>}<div className="dashboard-chart-dates" aria-hidden="true">{days.map(day=><span key={day.key}>{day.label}</span>)}</div></div></div>
    <div className="dashboard-chart-key"><span><i className="backup"/>Backup</span><span><i className="restore"/>Restore</span><span>Failed jobs are included in these counts</span></div>
    <details className="dashboard-chart-data"><summary>View chart data</summary><div className="table-wrap"><table><thead><tr><th>Date (UTC)</th><th>Backup</th><th>Restore</th><th>Failed</th></tr></thead><tbody>{days.map(day=><tr key={day.key}><td>{day.key}</td><td>{day.backup}</td><td>{day.restore}</td><td>{day.failed}</td></tr>)}</tbody></table></div></details>
  </section>
}
