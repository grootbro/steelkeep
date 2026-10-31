import {createHash,createHmac,timingSafeEqual} from 'node:crypto'
import {z} from 'zod'
import {sql,type Kysely} from 'kysely'
import type {Schema} from './db'
import {config} from './config'
import {AppError} from './security'
import {retainedPlanDto} from './retention'
import {upcomingOccurrences} from './services'

export const planOrders=['newest','oldest','name_asc','name_desc','next_due'] as const
export const planEngineKinds=['postgres','mysql','mariadb','mongodb','sqlite','redis','clickhouse','mssql'] as const
export const planHistoryInput=z.strictObject({limit:z.coerce.number().int().min(1).max(100).default(30),cursor:z.string().min(1).max(4096).optional(),order:z.enum(planOrders).default('newest'),id:z.uuid().optional(),sourceId:z.uuid().optional(),storageId:z.uuid().optional(),kind:z.enum(planEngineKinds).optional(),status:z.enum(['enabled','paused']).optional(),schedule:z.enum(['scheduled','manual']).optional(),retentionMode:z.enum(['keep_all','days','gfs']).optional(),search:z.string().trim().max(100).optional()})
type Input=z.infer<typeof planHistoryInput>
type Anchor={id:string;createdAt:string;name:string;nextDue:string|null}
const timestamp=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
const cursorSchema=z.strictObject({v:z.literal(1),kind:z.literal('plans'),filter:z.string().regex(/^[a-f0-9]{64}$/),anchor:z.strictObject({id:z.uuid(),createdAt:timestamp,name:z.string().max(320),nextDue:timestamp.nullable()})})
export function planInput(value:unknown):Input{const parsed=planHistoryInput.safeParse(value);if(!parsed.success)throw new AppError('INVALID_PLAN_FILTER','Check the plan filters, ordering and page size.',422);if(parsed.data.search==='')delete parsed.data.search;return parsed.data}
function filterHash(input:Input){const {cursor:_,...filter}=input;return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(filter).sort(([a],[b])=>a.localeCompare(b))))).digest('hex')}
export function planCursor(input:Input,anchor:Anchor,key:Buffer){const encoded=Buffer.from(JSON.stringify({v:1,kind:'plans',filter:filterHash(input),anchor})).toString('base64url');return encoded+'.'+createHmac('sha256',key).update('steelkeep.plans.v1.'+encoded).digest('base64url')}
export function planAnchor(input:Input,key:Buffer):Anchor|undefined{
 if(!input.cursor)return
 const invalid=()=>new AppError('INVALID_PLAN_CURSOR','This plan cursor is invalid or belongs to different filters. Start from the first page.',422)
 const parts=input.cursor.split('.');if(parts.length!==2||!parts.every(part=>/^[A-Za-z0-9_-]+$/.test(part)))throw invalid()
 const expected=createHmac('sha256',key).update('steelkeep.plans.v1.'+parts[0]).digest(),provided=Buffer.from(parts[1],'base64url')
 if(provided.length!==expected.length||!timingSafeEqual(provided,expected))throw invalid()
 let value:unknown;try{value=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'))}catch{throw invalid()}
 const parsed=cursorSchema.safeParse(value);if(!parsed.success||parsed.data.filter!==filterHash(input))throw invalid();return parsed.data.anchor
}
const named=sql<string>`lower(p.name) COLLATE "C"`
const createdAnchor=sql<string>`to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('_cursor_created_at')
const dueAnchor=sql<string|null>`to_char(p.next_due AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('_cursor_next_due')
export class PlanHistoryServices{
 constructor(readonly db:Kysely<Schema>){}
 async browse(value:unknown){
  const input=planInput(value),key=config.key(),anchor=planAnchor(input,key),descending=input.order==='newest'||input.order==='name_desc',direction=descending?'desc':'asc',byName=input.order.startsWith('name_'),now=new Date()
  return this.db.transaction().setIsolationLevel('repeatable read').execute(async db=>{
   // Counts and page share one metadata snapshot; the global summary intentionally ignores filters.
   const summary=await db.selectFrom('plans').select([sql<number>`count(*)::int`.as('total'),sql<number>`count(*) FILTER(WHERE enabled)::int`.as('enabled'),sql<number>`count(*) FILTER(WHERE NOT enabled)::int`.as('paused'),sql<number>`count(*) FILTER(WHERE cron IS NOT NULL)::int`.as('scheduled'),sql<number>`count(*) FILTER(WHERE cron IS NULL)::int`.as('manual')]).executeTakeFirstOrThrow()
   let filtered=db.selectFrom('plans as p').innerJoin('connections as s','s.id','p.source_id').innerJoin('connections as v','v.id','p.storage_id')
   if(input.id)filtered=filtered.where('p.id','=',input.id)
   if(input.sourceId)filtered=filtered.where('p.source_id','=',input.sourceId)
   if(input.storageId)filtered=filtered.where('p.storage_id','=',input.storageId)
   if(input.kind)filtered=filtered.where('s.kind','=',input.kind)
   if(input.status)filtered=filtered.where('p.enabled','=',input.status==='enabled')
   if(input.schedule)filtered=input.schedule==='scheduled'?filtered.where('p.cron','is not',null):filtered.where('p.cron','is',null)
   if(input.retentionMode)filtered=filtered.where(sql<boolean>`p.retention_policy->>'mode'=${input.retentionMode}`)
   if(input.search){const pattern='%'+input.search.replace(/[!%_]/g,char=>'!'+char)+'%';filtered=filtered.where(eb=>eb.or([sql<boolean>`p.name ILIKE ${pattern} ESCAPE '!'`,sql<boolean>`s.name ILIKE ${pattern} ESCAPE '!'`,sql<boolean>`v.name ILIKE ${pattern} ESCAPE '!'`]))}
   const count=await filtered.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()
   let page=filtered.selectAll('p').select(['s.name as source_name','v.name as storage_name','s.kind as source_kind',createdAnchor,dueAnchor,named.as('_cursor_name')])
   if(anchor){
    if(input.order==='next_due')page=page.where(anchor.nextDue===null?sql<boolean>`p.next_due IS NULL AND p.id>${anchor.id}::uuid`:sql<boolean>`(p.next_due IS NULL OR (p.next_due,p.id)>(${anchor.nextDue}::timestamptz,${anchor.id}::uuid))`)
    else page=page.where(byName?sql<boolean>`(lower(p.name) COLLATE "C",p.id) ${sql.raw(descending?'<':'>')} (${anchor.name}::text COLLATE "C",${anchor.id}::uuid)`:sql<boolean>`(p.created_at,p.id) ${sql.raw(descending?'<':'>')} (${anchor.createdAt}::timestamptz,${anchor.id}::uuid)`)
   }
   if(input.order==='next_due')page=page.orderBy(sql`p.next_due ASC NULLS LAST`)
   else page=page.orderBy(byName?named:'p.created_at',direction)
   const rows=await page.orderBy('p.id',direction).limit(input.limit+1).execute(),items=rows.slice(0,input.limit),last=items.at(-1)
   return {items:items.map(({_cursor_created_at:_,_cursor_name:__,_cursor_next_due:___,...row})=>{
    if(row.source_kind==='s3')throw new AppError('INVALID_PLAN_SOURCE','This plan does not reference a supported database source.',409)
    return {...retainedPlanDto(row),source_name:row.source_name,storage_name:row.storage_name,source_kind:row.source_kind,upcoming:row.enabled?upcomingOccurrences(row.cron,row.timezone,now):[],missed_policy:'skip' as const,overlap_policy:'skip' as const}
   }),nextCursor:rows.length>input.limit&&last?planCursor(input,{id:last.id,createdAt:last._cursor_created_at,name:last._cursor_name,nextDue:last._cursor_next_due},key):null,total:count.n,limit:input.limit,order:input.order,summary:{...summary,scope:'all-recorded-plans' as const}}
  })
 }
}
