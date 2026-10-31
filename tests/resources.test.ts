import {test,expect} from 'bun:test'
import {resourceKey,sameResource,sourceAdmissionKey,sourceBlockMatches} from '../server/resources'

test('host aliases cannot bypass conservative SQL target reservation',()=>{
  const a={kind:'postgres',config:{host:'primary.internal',database:'Recovery'}}
  const b={kind:'postgres',config:{host:'127.0.0.1',database:'recovery'}}
  expect(sameResource(a,b)).toBe(true)
  expect(sameResource(a,{kind:'postgres',config:{database:'different'}})).toBe(false)
  expect(sameResource({kind:'mysql',config:{database:'app'}},{kind:'mariadb',config:{database:'APP'}})).toBe(true)
})
test('Redis database indexes and canonical SQLite paths define reservations',()=>{
  expect(resourceKey({kind:'redis',config:{dbIndex:4,host:'alias'}})).toBe('redis:4')
  expect(()=>resourceKey({kind:'redis',config:{dbIndex:16}})).toThrow()
  expect(()=>resourceKey({kind:'redis',config:{dbIndex:'0'}})).toThrow()
  expect(resourceKey({kind:'sqlite',config:{path:'/data/targets/recovery.sqlite'}})).toBe('sqlite:/data/targets/recovery.sqlite')
  expect(()=>resourceKey({kind:'sqlite',config:{path:'relative.sqlite'}})).toThrow()
  expect(()=>resourceKey({kind:'s3',config:{}})).toThrow()
})
test('Mongo source admission covers server-wide locks across databases and endpoint aliases without merging restore targets',()=>{
  const a={kind:'mongodb',config:{host:'primary.internal',port:27017,database:'orders'}},b={kind:'mongodb',config:{host:'alias.internal',port:27018,database:'billing'}}
  expect(sourceAdmissionKey(a)).toBe(sourceAdmissionKey(b))
  expect(resourceKey(a)).not.toBe(resourceKey(b))
  expect(sourceBlockMatches(a,'mongodb:alias.internal:27018')).toBe(true)
  expect(sourceBlockMatches(b,'mongodb:primary.internal:27017')).toBe(true)
  expect(sourceBlockMatches(a,'postgres:orders')).toBe(false)
  const sql={kind:'postgres',config:{database:'orders'}}
  expect(sourceAdmissionKey(sql)).toBe(resourceKey(sql))
  expect(sourceBlockMatches(sql,'postgres:orders')).toBe(true)
  expect(sourceBlockMatches(sql,'postgres:billing')).toBe(false)
  expect(sourceBlockMatches(sql,'mongodb:primary.internal:27017')).toBe(false)
})
