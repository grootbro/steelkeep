import {createHash,createHmac,timingSafeEqual} from 'node:crypto'
import {z} from 'zod'
import {sql,type Kysely} from 'kysely'
import type {Schema} from './db'
import {config} from './config'
import {AppError} from './security'
import {resourceKey,sourceBlockMatches,type Resource} from './resources'

export const connectionOrders=['newest','oldest','name_asc','name_desc'] as const
export const connectionRoles=['source','storage','target'] as const
export const connectionKinds=['postgres','mysql','mariadb','mongodb','sqlite','redis','clickhouse','mssql','s3'] as const
export const connectionHistoryInput=z.strictObject({limit:z.coerce.number().int().min(1).max(100).default(30),cursor:z.string().min(1).max(4096).optional(),order:z.enum(connectionOrders).default('newest'),role:z.enum(connectionRoles).optional(),kind:z.enum(connectionKinds).optional(),status:z.enum(['untested','available','failed']).optional(),search:z.string().trim().max(100).optional()})
type Input=z.infer<typeof connectionHistoryInput>
type Anchor={id:string;createdAt:string;name:string}
const anchorSchema=z.strictObject({id:z.uuid(),createdAt:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),name:z.string().max(320)})
const cursorSchema=z.strictObject({v:z.literal(1),kind:z.literal('connections'),filter:z.string().regex(/^[a-f0-9]{64}$/),anchor:anchorSchema})
export function connectionInput(value:unknown):Input{const parsed=connectionHistoryInput.safeParse(value);if(!parsed.success)throw new AppError('INVALID_CONNECTION_FILTER','Check the connection filters, ordering and page size.',422);if(parsed.data.search==='')delete parsed.data.search;return parsed.data}
function filterHash(input:Input){const {cursor:_,...filter}=input;return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(filter).sort(([a],[b])=>a.localeCompare(b))))).digest('hex')}
export function connectionCursor(input:Input,anchor:Anchor,key:Buffer){const encoded=Buffer.from(JSON.stringify({v:1,kind:'connections',filter:filterHash(input),anchor})).toString('base64url');return encoded+'.'+createHmac('sha256',key).update('steelkeep.connections.v1.'+encoded).digest('base64url')}
export function connectionAnchor(input:Input,key:Buffer):Anchor|undefined{
 if(!input.cursor)return
 const invalid=()=>new AppError('INVALID_CONNECTION_CURSOR','This connection cursor is invalid or belongs to different filters. Start from the first page.',422)
 const parts=input.cursor.split('.');if(parts.length!==2||!parts.every(part=>/^[A-Za-z0-9_-]+$/.test(part)))throw invalid()
 const expected=createHmac('sha256',key).update('steelkeep.connections.v1.'+parts[0]).digest(),provided=Buffer.from(parts[1],'base64url')
 if(provided.length!==expected.length||!timingSafeEqual(provided,expected))throw invalid()
 let value:unknown;try{value=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'))}catch{throw invalid()}
 const parsed=cursorSchema.safeParse(value);if(!parsed.success||parsed.data.filter!==filterHash(input))throw invalid();return parsed.data.anchor
}
export const connectionRole=(row:Resource)=>row.kind==='s3'?'storage' as const:row.config.restoreTarget===true?'target' as const:'source' as const
export function connectionHolds(row:Resource,sourceKeys:readonly string[],targetKeys:readonly string[]){return row.kind==='s3'?{sourceBlocked:false,targetBlocked:false}:{sourceBlocked:sourceKeys.some(key=>sourceBlockMatches(row,key)),targetBlocked:targetKeys.includes(resourceKey(row))}}
const publicFields=['id','name','kind','config','check_status','checked_at','created_at','updated_at','revision'] as const
const named=sql<string>`lower(name) COLLATE "C"`
const timeAnchor=sql<string>`to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('_cursor_created_at')
export class ConnectionHistoryServices{
 constructor(readonly db:Kysely<Schema>){}
 private async holdKeys(db:Kysely<Schema>){const [sources,targets]=await Promise.all([db.selectFrom('source_blocks').select('resource_key').execute(),db.selectFrom('target_blocks').select('resource_key').execute()]);return {sources:sources.map(row=>row.resource_key),targets:targets.map(row=>row.resource_key)}}
 async browse(value:unknown){
  const input=connectionInput(value),key=config.key(),anchor=connectionAnchor(input,key),descending=input.order==='newest'||input.order==='name_desc',direction=descending?'desc':'asc',byName=input.order.startsWith('name_')
  return this.db.transaction().setIsolationLevel('repeatable read').execute(async db=>{
   let filtered=db.selectFrom('connections')
   if(input.role==='storage')filtered=filtered.where('kind','=','s3')
   if(input.role==='target')filtered=filtered.where('kind','!=','s3').where(sql<boolean>`config->'restoreTarget'='true'::jsonb`)
   if(input.role==='source')filtered=filtered.where('kind','!=','s3').where(sql<boolean>`config->'restoreTarget' IS DISTINCT FROM 'true'::jsonb`)
   if(input.kind)filtered=filtered.where('kind','=',input.kind)
   if(input.status)filtered=filtered.where('check_status','=',input.status)
   if(input.search){const pattern='%'+input.search.replace(/[!%_]/g,char=>'!'+char)+'%';filtered=filtered.where(sql<boolean>`name ILIKE ${pattern} ESCAPE '!'`)}
   const count=await filtered.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()
   let page=filtered.select(publicFields).select([timeAnchor,named.as('_cursor_name')])
   if(anchor)page=page.where(byName?sql<boolean>`(lower(name) COLLATE "C",id) ${sql.raw(descending?'<':'>')} (${anchor.name}::text COLLATE "C",${anchor.id}::uuid)`:sql<boolean>`(created_at,id) ${sql.raw(descending?'<':'>')} (${anchor.createdAt}::timestamptz,${anchor.id}::uuid)`)
   const rows=await page.orderBy(byName?named:'created_at',direction).orderBy('id',direction).limit(input.limit+1).execute(),keys=await this.holdKeys(db),items=rows.slice(0,input.limit),last=items.at(-1)
   return {items:items.map(({_cursor_created_at:_,_cursor_name:__,...row})=>{const holds=connectionHolds(row,keys.sources,keys.targets);return {...row,role:connectionRole(row),blocked:holds.sourceBlocked||holds.targetBlocked}}),nextCursor:rows.length>input.limit&&last?connectionCursor(input,{id:last.id,createdAt:last._cursor_created_at,name:last._cursor_name},key):null,total:count.n,limit:input.limit,order:input.order}
  })
 }
 async summary(id:string){
  if(!z.uuid().safeParse(id).success)throw new AppError('INVALID_ID','Use a valid connection identifier.')
  return this.db.transaction().setIsolationLevel('repeatable read').execute(async db=>{
   const connection=await db.selectFrom('connections').select(publicFields).where('id','=',id).executeTakeFirst();if(!connection)throw new AppError('NOT_FOUND','Connection not found.',404)
   const plans=await db.selectFrom('plans').select([sql<number>`count(*)::int`.as('total'),sql<number>`count(*) FILTER(WHERE enabled)::int`.as('enabled')]).where(eb=>eb.or([eb('source_id','=',id),eb('storage_id','=',id)])).executeTakeFirstOrThrow()
   const jobs=await db.selectFrom('runs').select([sql<number>`count(*)::int`.as('total'),sql<number>`count(*) FILTER(WHERE type='backup')::int`.as('backup'),sql<number>`count(*) FILTER(WHERE type='restore')::int`.as('restore'),sql<number>`count(*) FILTER(WHERE status='queued')::int`.as('queued'),sql<number>`count(*) FILTER(WHERE status='running')::int`.as('running'),sql<number>`count(*) FILTER(WHERE status='cancelling')::int`.as('cancelling'),sql<number>`count(*) FILTER(WHERE status='succeeded')::int`.as('succeeded'),sql<number>`count(*) FILTER(WHERE status='failed')::int`.as('failed'),sql<number>`count(*) FILTER(WHERE status='cancelled')::int`.as('cancelled'),sql<number>`count(*) FILTER(WHERE status='interrupted')::int`.as('interrupted')]).where(eb=>eb.or([eb('source_id','=',id),eb('storage_id','=',id),eb('target_id','=',id)])).executeTakeFirstOrThrow()
   const snapshots=await db.selectFrom('artifacts').select([sql<number>`count(*)::int`.as('total'),sql<number>`count(*) FILTER(WHERE deletion_state<>'deleted')::int`.as('retained'),sql<number>`count(*) FILTER(WHERE deletion_state='deleted')::int`.as('deleted'),sql<number>`count(*) FILTER(WHERE deletion_state<>'deleted' AND retention_locked)::int`.as('locked'),sql<string>`coalesce(sum(size) FILTER(WHERE deletion_state<>'deleted'),0)::text`.as('retainedBytes')]).where(eb=>eb.or([eb('source_id','=',id),eb('storage_id','=',id)])).executeTakeFirstOrThrow()
   const keys=await this.holdKeys(db),holds=connectionHolds(connection,keys.sources,keys.targets)
   return {connection:{...connection,blocked:holds.sourceBlocked||holds.targetBlocked},role:connectionRole(connection),scope:'all-recorded-history' as const,plans,jobs,snapshots:{...snapshots,scope:'metadata-records' as const,physicalUsage:'not-measured' as const},holds}
  })
 }
}
