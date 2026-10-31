import {test,expect} from 'bun:test'
import {planInput,planCursor,planAnchor} from '../server/plan-history'
const key=Buffer.alloc(32,19),anchor={id:'00000000-0000-4000-8000-000000000001',createdAt:'2026-10-31T01:02:03.123456Z',name:'alpha',nextDue:'2035-01-01T00:00:00.123456Z'}
test('plan cursors bind every filter and retain microsecond/null next-run boundaries',()=>{
 const input=planInput({limit:'3',order:'next_due',status:'enabled',schedule:'scheduled',kind:'postgres',retentionMode:'keep_all',search:' alpha '}),cursor=planCursor(input,anchor,key)
 expect(planAnchor({...input,cursor},key)).toEqual(anchor)
 expect(planAnchor({...input,cursor:planCursor(input,{...anchor,nextDue:null},key)},key)?.nextDue).toBeNull()
 for(const change of [{limit:4},{order:'oldest'},{status:'paused'},{schedule:'manual'},{kind:'mysql'},{retentionMode:'days'},{search:'beta'},{sourceId:anchor.id},{storageId:anchor.id},{id:anchor.id}])expect(()=>planAnchor(planInput({...input,...change,cursor}),key)).toThrow('different filters')
 expect(()=>planAnchor({...input,cursor},Buffer.alloc(32,20))).toThrow()
 for(const bad of [cursor+'.extra',cursor.replace(/^./,cursor[0]==='a'?'b':'a'),'not-json.bad'])expect(()=>planAnchor({...input,cursor:bad},key)).toThrow()
})
test('plan filters reject unsupported discovery, SQL ordering and unbounded pages',()=>{
 expect(planInput({search:'  '})).toEqual({limit:30,order:'newest'})
 for(const input of [{limit:0},{limit:101},{limit:2.5},{order:'name;drop'},{kind:'s3'},{status:'running'},{schedule:'auto-discover'},{retentionMode:'forever'},{search:'x'.repeat(101)},{cursor:'x'.repeat(4097)},{sourceId:'bad'},{databasePattern:'.*'}])expect(()=>planInput(input)).toThrow()
})
