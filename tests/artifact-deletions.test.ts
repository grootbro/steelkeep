import {test,expect} from 'bun:test'
import {randomUUID} from 'node:crypto'
import type {Kysely,Selectable} from 'kysely'
import type {Schema} from '../server/db'
import {ArtifactDeletionServices,deletionIds,deletionRequestInput,deletionPublication} from '../server/artifact-deletions'

test('explicit deletion selection is bounded and refuses duplicate, disguised duplicate and arbitrary object keys',()=>{
 const a=randomUUID(),b=randomUUID();expect(deletionIds({artifactIds:[b,a]})).toEqual([a,b].sort())
 expect(deletionIds({artifactIds:Array.from({length:100},()=>randomUUID())})).toHaveLength(100)
 for(const value of [{artifactIds:[]},{artifactIds:Array.from({length:101},()=>randomUUID())},{artifactIds:[a,a]},{artifactIds:[a,a.toUpperCase()]},{artifactIds:['bucket/key.dump']},{artifactIds:[a],objectKey:'other/key'},null])expect(()=>deletionIds(value)).toThrow()
 const request={reviewId:a,idempotencyKey:randomUUID(),confirmDeletion:true};expect(deletionRequestInput.safeParse(request).success).toBe(true)
 for(const value of [{...request,confirmDeletion:false},{...request,confirmDeletion:undefined},{...request,idempotencyKey:'x'},{...request,idempotencyKey:'dangerous\nrequest-key'},{...request,artifactIds:[b]}])expect(deletionRequestInput.safeParse(value).success).toBe(false)
})
test('deletion publication binds the exact successful backup and connection revisions while notes and HEAD status remain metadata only',()=>{
 const sourceId=randomUUID(),storageId=randomUUID(),runId=randomUUID(),id=randomUUID(),execution=randomUUID()
 const fields={created_at:new Date(),updated_at:new Date(),checked_at:null,secret:'synthetic-not-used',check_status:'untested'}
 const source:Selectable<Schema['connections']>={...fields,id:sourceId,kind:'postgres',name:'Source',revision:1,config:{database:'source_db'}},storage:Selectable<Schema['connections']>={...fields,id:storageId,kind:'s3',name:'Storage',revision:1,config:{prefix:'backups'}}
 const run={id:runId,plan_id:null,type:'backup',status:'succeeded',artifact_id:id,source_id:sourceId,storage_id:storageId,execution_token:execution} as Selectable<Schema['runs']>
 const artifact={id,run_id:runId,source_id:sourceId,storage_id:storageId,object_key:`backups/${runId}/${execution}/${id}.dump`,engine:'postgres',size:'123',sha256:'a'.repeat(64),server_version:'17',tool_version:'17',created_at:new Date(),comment:null,availability:'unknown'} as Selectable<Schema['artifacts']>
 const original=deletionPublication(artifact,run,source,storage);expect(original.valid).toBe(true)
 expect(deletionPublication({...artifact,comment:'Useful operator note',availability:'missing'},run,source,storage)).toEqual(original)
 expect(deletionPublication(artifact,run,source,{...storage,revision:2}).fingerprint).not.toBe(original.fingerprint)
 expect(deletionPublication(artifact,run,{...source,revision:2},storage).fingerprint).not.toBe(original.fingerprint)
 for(const changed of [{...artifact,object_key:'arbitrary/key'},{...artifact,sha256:'not-a-digest'},{...artifact,size:'0'},{...artifact,size:'-1'},{...artifact,size:'18446744073709551616'},{...artifact,engine:'constructor'},{...artifact,engine:'__proto__'},{...artifact,source_id:randomUUID()}])expect(deletionPublication(changed,run,source,storage).valid).toBe(false)
 for(const changed of [{...run,status:'failed'},{...run,type:'restore' as const},{...run,execution_token:null},{...run,artifact_id:randomUUID()},{...run,storage_id:sourceId}])expect(deletionPublication(artifact,changed,source,storage).valid).toBe(false)
})
test('configure/read/setup sessions cannot prepare, inspect or consume deletion reviews before metadata access',async()=>{
 const service=new ArtifactDeletionServices({} as Kysely<Schema>),id=randomUUID()
 for(const scopes of [[],['read'],['configure']]as const){const principal={actor:'fixture-agent',scopes:[...scopes]};await expect(service.prepare(principal,{artifactIds:[id]})).rejects.toMatchObject({code:'FORBIDDEN'});await expect(service.get(principal,id)).rejects.toMatchObject({code:'FORBIDDEN'});await expect(service.queue(principal,{reviewId:id,idempotencyKey:randomUUID(),confirmDeletion:true})).rejects.toMatchObject({code:'FORBIDDEN'})}
})
