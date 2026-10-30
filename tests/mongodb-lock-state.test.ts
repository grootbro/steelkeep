import {test,expect} from 'bun:test'
import {mongoFsyncLocked} from '../server/engines/mongodb'

test('MongoDB currentOp omits fsyncLock when unlocked and reports true when locked',()=>{
  expect(mongoFsyncLocked({ok:1,inprog:[]})).toBe(false)
  expect(mongoFsyncLocked({ok:1,inprog:[],fsyncLock:false})).toBe(false)
  expect(mongoFsyncLocked({ok:1,inprog:[],fsyncLock:true})).toBe(true)
})
test('Malformed or unsuccessful currentOp cannot be mistaken for unlocked',()=>{
  for(const value of [null,{}, {ok:0,inprog:[]},{ok:1},{ok:1,inprog:null},{ok:1,inprog:[],fsyncLock:null},{ok:1,inprog:[],fsyncLock:'false'},{ok:1,inprog:[],fsyncLock:undefined}])expect(()=>mongoFsyncLocked(value)).toThrow('fsync lock state could not be established')
})
