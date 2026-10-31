import {createHash,createHmac,timingSafeEqual} from 'node:crypto'
import {z} from 'zod'
import {sql,type Kysely} from 'kysely'
import type {Schema} from './db'
import {config} from './config'
import {AppError} from './security'
import {engineProfiles} from '../shared/engines'
import {safeRun} from './services'

const common={limit:z.coerce.number().int().min(1).max(100).default(30),order:z.enum(['newest','oldest']).default('newest'),cursor:z.string().min(1).max(4096).optional(),id:z.uuid().optional(),sourceId:z.uuid().optional(),storageId:z.uuid().optional(),from:z.iso.datetime({offset:true}).optional(),until:z.iso.datetime({offset:true}).optional(),search:z.string().trim().max(100).optional()}
export const jobHistoryInput=z.strictObject({...common,type:z.enum(['backup','restore']).optional(),status:z.enum(['queued','running','cancelling','succeeded','failed','cancelled','interrupted']).optional(),targetId:z.uuid().optional(),planId:z.uuid().optional()})
export const snapshotHistoryInput=z.strictObject({...common,engine:z.enum(engineProfiles.map(profile=>profile.kind)).optional(),availability:z.enum(['present','missing','changed','unknown']).optional(),deletionState:z.enum(['active','queued','deleting','held','deleted']).optional()})
type HistoryInput=z.infer<typeof jobHistoryInput>|z.infer<typeof snapshotHistoryInput>
type Anchor={createdAt:string;id:string}
const anchorSchema=z.strictObject({createdAt:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),id:z.uuid()})
const cursorSchema=z.strictObject({v:z.literal(1),kind:z.enum(['jobs','snapshots']),filter:z.string().regex(/^[a-f0-9]{64}$/),anchor:anchorSchema})
export function historyInput(kind:'jobs'|'snapshots',value:unknown):HistoryInput{
  const parsed=(kind==='jobs'?jobHistoryInput:snapshotHistoryInput).safeParse(value)
  if(!parsed.success)throw new AppError('INVALID_HISTORY_FILTER','Check the history filters, date range and page size.',422)
  const result=parsed.data
  if(result.from&&result.until&&Date.parse(result.from)>Date.parse(result.until))throw new AppError('INVALID_HISTORY_FILTER','The start of the date range must not follow its end.',422)
  if(result.search==='')delete result.search
  return result
}
function filterHash(input:HistoryInput){const {cursor:_,...filter}=input;return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(filter).sort(([a],[b])=>a.localeCompare(b))))).digest('hex')}
export function historyCursor(kind:'jobs'|'snapshots',input:HistoryInput,anchor:Anchor,key:Buffer){
  const encoded=Buffer.from(JSON.stringify({v:1,kind,filter:filterHash(input),anchor})).toString('base64url')
  const signature=createHmac('sha256',key).update('steelkeep.history.v1.'+encoded).digest('base64url')
  return encoded+'.'+signature
}
export function historyAnchor(kind:'jobs'|'snapshots',input:HistoryInput,key:Buffer):Anchor|undefined{
  if(!input.cursor)return
  const invalid=()=>new AppError('INVALID_HISTORY_CURSOR','This history cursor is invalid or belongs to different filters. Start from the first page.',422)
  const parts=input.cursor.split('.')
  if(parts.length!==2||!parts.every(part=>/^[A-Za-z0-9_-]+$/.test(part)))throw invalid()
  const expected=createHmac('sha256',key).update('steelkeep.history.v1.'+parts[0]).digest(),provided=Buffer.from(parts[1],'base64url')
  if(provided.length!==expected.length||!timingSafeEqual(provided,expected))throw invalid()
  let value:unknown;try{value=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'))}catch{throw invalid()}
  const parsed=cursorSchema.safeParse(value)
  if(!parsed.success||parsed.data.kind!==kind||parsed.data.filter!==filterHash(input))throw invalid()
  return parsed.data.anchor
}
const literalLike=(value:string)=>'%'+value.replace(/[!%_]/g,char=>'!'+char)+'%'
const dateAnchor=(table:'r'|'a')=>sql<string>`to_char(${sql.ref(table+'.created_at')} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('_cursor_created_at')

export class HistoryServices{
  constructor(readonly db:Kysely<Schema>,private readonly key=config.key()){}
  async snapshot(id:string){
    if(!z.uuid().safeParse(id).success)throw new AppError('INVALID_ID','Use a valid snapshot identifier.')
    const row=(await this.snapshots({id,limit:1})).items[0]
    if(!row)throw new AppError('NOT_FOUND','Backup not found.',404)
    const {source_name:_,storage_name:__,...backup}=row
    return backup
  }
  async jobs(value:unknown){
    const input=historyInput('jobs',value) as z.infer<typeof jobHistoryInput>,anchor=historyAnchor('jobs',input,this.key),direction=input.order==='newest'?'desc':'asc'
    let query=this.db.selectFrom('runs as r').innerJoin('connections as s','s.id','r.source_id').innerJoin('connections as v','v.id','r.storage_id').leftJoin('connections as t','t.id','r.target_id').selectAll('r').select([dateAnchor('r'),'s.name as source_name','v.name as storage_name','t.name as target_name'])
    if(input.id)query=query.where('r.id','=',input.id)
    if(input.sourceId)query=query.where('r.source_id','=',input.sourceId)
    if(input.storageId)query=query.where('r.storage_id','=',input.storageId)
    if(input.targetId)query=query.where('r.target_id','=',input.targetId)
    if(input.planId)query=query.where('r.plan_id','=',input.planId)
    if(input.type)query=query.where('r.type','=',input.type)
    if(input.status)query=query.where('r.status','=',input.status)
    if(input.from)query=query.where('r.created_at','>=',sql<Date>`${input.from}::timestamptz`)
    if(input.until)query=query.where('r.created_at','<=',sql<Date>`${input.until}::timestamptz`)
    if(input.search){const pattern=literalLike(input.search);query=query.where(eb=>eb.or([sql<boolean>`r.id::text ILIKE ${pattern} ESCAPE '!'`,sql<boolean>`s.name ILIKE ${pattern} ESCAPE '!'`,sql<boolean>`v.name ILIKE ${pattern} ESCAPE '!'`,sql<boolean>`t.name ILIKE ${pattern} ESCAPE '!'`]))}
    if(anchor)query=query.where(sql<boolean>`(r.created_at,r.id) ${sql.raw(input.order==='newest'?'<':'>')} (${anchor.createdAt}::timestamptz,${anchor.id}::uuid)`)
    const rows=await query.orderBy('r.created_at',direction).orderBy('r.id',direction).limit(input.limit+1).execute(),page=rows.slice(0,input.limit),last=page.at(-1)
    return {items:page.map(({_cursor_created_at,...row})=>({...safeRun(row),source_name:row.source_name,storage_name:row.storage_name,target_name:row.target_name})),nextCursor:rows.length>input.limit&&last?historyCursor('jobs',input,{createdAt:last._cursor_created_at,id:last.id},this.key):null,limit:input.limit,order:input.order}
  }
  async snapshots(value:unknown){
    const input=historyInput('snapshots',value) as z.infer<typeof snapshotHistoryInput>,anchor=historyAnchor('snapshots',input,this.key),direction=input.order==='newest'?'desc':'asc'
    let query=this.db.selectFrom('artifacts as a').innerJoin('connections as s','s.id','a.source_id').innerJoin('connections as v','v.id','a.storage_id').select(['a.id','a.run_id','a.source_id','a.storage_id','a.object_key','a.size','a.sha256','a.engine','a.server_version','a.tool_version','a.created_at','a.availability','a.checked_at','a.retention_locked','a.deletion_state','a.deleted_at','a.comment','a.comment_revision','a.commented_at','s.name as source_name','v.name as storage_name',dateAnchor('a')]).select(eb=>eb.selectFrom('runs as rr').select(sql<{status:string;validation:Record<string,unknown>|null;finished_at:string|null}>`json_build_object('status',rr.status,'validation',rr.validation,'finished_at',rr.finished_at)`.as('restore')).whereRef('rr.artifact_id','=','a.id').where('rr.type','=','restore').orderBy('rr.created_at','desc').orderBy('rr.id','desc').limit(1).as('last_restore'))
    if(input.id)query=query.where('a.id','=',input.id)
    if(input.sourceId)query=query.where('a.source_id','=',input.sourceId)
    if(input.storageId)query=query.where('a.storage_id','=',input.storageId)
    if(input.engine)query=query.where('a.engine','=',input.engine)
    if(input.availability)query=query.where('a.availability','=',input.availability)
    if(input.deletionState)query=query.where('a.deletion_state','=',input.deletionState)
    if(input.from)query=query.where('a.created_at','>=',sql<Date>`${input.from}::timestamptz`)
    if(input.until)query=query.where('a.created_at','<=',sql<Date>`${input.until}::timestamptz`)
    if(input.search){const pattern=literalLike(input.search);query=query.where(eb=>eb.or([sql<boolean>`a.id::text ILIKE ${pattern} ESCAPE '!'`,sql<boolean>`s.name ILIKE ${pattern} ESCAPE '!'`,sql<boolean>`v.name ILIKE ${pattern} ESCAPE '!'`,sql<boolean>`a.sha256 ILIKE ${pattern} ESCAPE '!'`]))}
    if(anchor)query=query.where(sql<boolean>`(a.created_at,a.id) ${sql.raw(input.order==='newest'?'<':'>')} (${anchor.createdAt}::timestamptz,${anchor.id}::uuid)`)
    const rows=await query.orderBy('a.created_at',direction).orderBy('a.id',direction).limit(input.limit+1).execute(),page=rows.slice(0,input.limit),last=page.at(-1)
    return {items:page.map(({_cursor_created_at,...row})=>({...row,last_restore:row.last_restore?{...row.last_restore,finished_at:row.last_restore.finished_at?new Date(row.last_restore.finished_at).toISOString():null}:null})),nextCursor:rows.length>input.limit&&last?historyCursor('snapshots',input,{createdAt:last._cursor_created_at,id:last.id},this.key):null,limit:input.limit,order:input.order}
  }
}
