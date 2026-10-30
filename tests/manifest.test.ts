import {test,expect} from 'bun:test'
import {manifestComparison} from '../server/engines/database'
import type {Manifest} from '../server/engines/types'

const manifest:Manifest={format:1,engine:'postgres',database:'source',serverVersion:'17.11',objects:{schemas:'schema-hash',columns:'columns-hash'},data:{entries:{rows:'1000',hash_a:'12',hash_b:'34'}},sequences:{entries_id_seq:{last_value:'1000',is_called:true}}}

test('manifest comparison survives JSONB object-key ordering without losing mismatches',()=>{
  const stored={...manifest,objects:{columns:'columns-hash',schemas:'schema-hash'},data:{entries:{hash_b:'34',hash_a:'12',rows:'1000'}},sequences:{entries_id_seq:{is_called:true,last_value:'1000'}}}
  expect(manifestComparison(stored,manifest).checks).toEqual({schema:true,data:true,sequences:true})
  const nullMaps={...manifest,objects:Object.assign(Object.create(null),manifest.objects),data:Object.assign(Object.create(null),manifest.data)}
  expect(manifestComparison(stored,nullMaps).passed).toBe(true)
  expect(manifestComparison(nullMaps,stored).passed).toBe(true)
  expect(manifestComparison(stored,{...manifest,objects:{...manifest.objects,columns:'different'}}).checks.schema).toBe(false)
  expect(manifestComparison(stored,{...manifest,data:{entries:{rows:'999',hash_a:'12',hash_b:'34'}}}).checks.data).toBe(false)
  expect(manifestComparison(stored,{...manifest,sequences:{entries_id_seq:{last_value:'1001',is_called:true}}}).checks.sequences).toBe(false)
  expect(manifestComparison({...manifest,objects:{columns:['a','b']}},{...manifest,objects:{columns:['b','a']}}).checks.schema).toBe(false)
})
