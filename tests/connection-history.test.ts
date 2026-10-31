import {test,expect} from 'bun:test'
import {connectionInput,connectionCursor,connectionAnchor,connectionRole,connectionHolds} from '../server/connection-history'
const key=Buffer.alloc(32,14),anchor={id:'00000000-0000-4000-8000-000000000001',createdAt:'2026-10-31T01:02:03.123456Z',name:'alpha'}
test('connection cursors bind every filter, page size, name order and microsecond boundary',()=>{
 const input=connectionInput({role:'source',kind:'postgres',status:'available',search:' alpha ',order:'name_asc',limit:'3'}),cursor=connectionCursor(input,anchor,key)
 expect(connectionAnchor({...input,cursor},key)).toEqual(anchor)
 for(const change of [{role:'target'},{kind:'mysql'},{status:'failed'},{search:'beta'},{order:'name_desc'},{limit:4}])expect(()=>connectionAnchor(connectionInput({...input,...change,cursor}),key)).toThrow('different filters')
 expect(()=>connectionAnchor({...input,cursor},Buffer.alloc(32,15))).toThrow()
 for(const bad of [cursor+'.extra',cursor.replace(/^./,cursor[0]==='a'?'b':'a'),'not-json.bad'])expect(()=>connectionAnchor({...input,cursor:bad},key)).toThrow()
})
test('connection filters are bounded and omission does not select a default role or kind',()=>{
 expect(connectionInput({search:'  '})).toEqual({limit:30,order:'newest'})
 for(const input of [{limit:0},{limit:101},{limit:2.5},{order:'name;drop'},{role:'database'},{kind:'unknown'},{status:'running'},{search:'x'.repeat(101)},{cursor:'x'.repeat(4097)},{unknown:'x'}])expect(()=>connectionInput(input)).toThrow()
})
test('roles and holds use existing conservative resource identities, including Mongo server journals and Maria aliases',()=>{
 expect(connectionRole({kind:'s3',config:{restoreTarget:true}})).toBe('storage')
 expect(connectionRole({kind:'postgres',config:{restoreTarget:true}})).toBe('target')
 expect(connectionRole({kind:'postgres',config:{restoreTarget:'true'}})).toBe('source')
 expect(connectionHolds({kind:'mariadb',config:{database:'App'}},['mysql:app'],[])).toEqual({sourceBlocked:true,targetBlocked:false})
 expect(connectionHolds({kind:'mongodb',config:{database:'different'}},['mongodb:other-server/database'],[])).toEqual({sourceBlocked:true,targetBlocked:false})
 expect(connectionHolds({kind:'postgres',config:{database:'APP'}},[],['postgres:app'])).toEqual({sourceBlocked:false,targetBlocked:true})
 expect(connectionHolds({kind:'s3',config:{}},['anything'],['anything'])).toEqual({sourceBlocked:false,targetBlocked:false})
})
