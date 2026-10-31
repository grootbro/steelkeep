import {test,expect} from 'bun:test'
import {randomBytes} from 'node:crypto'
import {seal,unseal,tokenMatches,identifier,safeFailure,AppError} from '../server/security'
import {nextOccurrence,upcomingOccurrences,authorize,validId} from '../server/services'
import {resourceKey,sameResource} from '../server/resources'
import {nativeCredentials} from '../server/engines/database'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

test('native PostgreSQL TLS uses system roots and full hostname verification through the sanitized environment',async()=>{
 for(const tls of [true,false]){
  const dir=await mkdtemp(join(tmpdir(),'steelkeep-pg-tls-'))
  try{
   const credentials=await nativeCredentials('postgres',{host:'synthetic.invalid',port:5432,database:'synthetic',user:'synthetic_reader',tls,restoreTarget:false},{password:'synthetic-local-secret'},dir)
   expect(credentials.env.PGSSLMODE).toBe(tls?'verify-full':'disable')
   expect(credentials.env.PGSSLROOTCERT).toBe(tls?'system':undefined)
   expect(credentials.env.PGPASSFILE).toBe(join(dir,'pgpass'))
   expect(credentials.env.PGPASSWORD).toBeUndefined()
   expect(credentials.args).not.toContain('synthetic-local-secret')
  }finally{await rm(dir,{recursive:true,force:true})}
 }
})

test('credentials are authenticated ciphertext; corruption cannot decrypt',()=>{
  const key=randomBytes(32),secret={password:'test-secret-unique'}
  const blob=seal(secret,key)
  expect(blob).not.toContain(secret.password)
  expect(unseal(blob,key)).toEqual(secret)
  const corrupted=Buffer.from(blob,'base64');corrupted[30]^=1
  expect(()=>unseal(corrupted.toString('base64'),key)).toThrow()
  expect(()=>unseal(blob,randomBytes(32))).toThrow()
})
test('unsafe identifiers cannot become CLI options',()=>{
  for(const value of ['--clean','db;drop','../source','source\nother',''])expect(()=>identifier(value)).toThrow()
  expect(identifier('restore_2026')).toBe('restore_2026')
})
test('driver errors never expose secrets to persisted failure messages',()=>{
  expect(JSON.stringify(safeFailure(new Error('password=very-secret postgres://user:pw@host')))).not.toContain('very-secret')
  expect(safeFailure(new AppError('TARGET_NOT_EMPTY','Target is not empty.')).code).toBe('TARGET_NOT_EMPTY')
  expect(tokenMatches('wrong','expected')).toBe(false)
})
test('schedule uses explicit IANA timezone',()=>{
  expect(nextOccurrence('0 9 * * *','Asia/Bangkok',new Date('2026-10-30T03:00:00Z')).toISOString()).toBe('2026-10-31T02:00:00.000Z')
  expect(()=>nextOccurrence('invalid','Asia/Bangkok')).toThrow()
  expect(()=>nextOccurrence('0 9 * * *','Not/AZone')).toThrow()
})

test('read token authorization does not inherit write access from tool hints',()=>{
 const reader={actor:'read-agent',scopes:['read' as const]}
 expect(()=>authorize(reader,'read')).not.toThrow()
 for(const scope of ['configure','backup:run','restore:run','jobs:cancel'] as const)expect(()=>authorize(reader,scope)).toThrow()
 expect(()=>authorize({actor:'backup-agent',scopes:['backup:run']},'restore:run')).toThrow()
})
test('schedule preview returns exactly three increasing real timezone slots',()=>{
 const dates=upcomingOccurrences('0 9 * * *','Asia/Bangkok',new Date('2026-10-30T03:00:00Z'))
 expect(dates).toEqual(['2026-10-31T02:00:00.000Z','2026-11-01T02:00:00.000Z','2026-11-02T02:00:00.000Z'])
 expect(upcomingOccurrences(null,'UTC')).toEqual([])
 expect(()=>validId('--clean')).toThrow()
})

test('schedule keeps the local wall-clock hour across daylight-saving offset changes',()=>{
 expect(upcomingOccurrences('0 9 * * *','America/New_York',new Date('2026-03-07T13:59:00Z'))).toEqual(['2026-03-07T14:00:00.000Z','2026-03-08T13:00:00.000Z','2026-03-09T13:00:00.000Z'])
})

test('nonexistent DST wall time is skipped instead of shifted to another hour',()=>{
 expect(nextOccurrence('30 2 * * *','America/New_York',new Date('2026-03-08T00:00:00Z')).toISOString()).toBe('2026-03-09T06:30:00.000Z')
})
test('ambiguous DST wall time runs at its earlier occurrence once across fresh parser calls',()=>{
 const first=nextOccurrence('30 1 * * *','America/New_York',new Date('2026-11-01T00:00:00Z'))
 expect(first.toISOString()).toBe('2026-11-01T05:30:00.000Z')
 expect(nextOccurrence('30 1 * * *','America/New_York',first).toISOString()).toBe('2026-11-02T06:30:00.000Z')
 expect(nextOccurrence('30 1 * * *','America/New_York',new Date('2026-11-01T05:45:00Z')).toISOString()).toBe('2026-11-02T06:30:00.000Z')
})

test('resource identities serialize database aliases and keep Redis indices and SQLite files distinct',()=>{
 expect(resourceKey({kind:'mariadb',config:{database:'App'}})).toBe(resourceKey({kind:'mysql',config:{database:'app'}}))
 expect(sameResource({kind:'postgres',config:{host:'alias-one',database:'app'}},{kind:'postgres',config:{host:'alias-two',database:'app'}})).toBe(true)
 expect(resourceKey({kind:'redis',config:{dbIndex:0}})).not.toBe(resourceKey({kind:'redis',config:{dbIndex:1}}))
 expect(resourceKey({kind:'sqlite',config:{path:'/mount/source.db'}})).not.toBe(resourceKey({kind:'sqlite',config:{path:'/mount/target.db'}}))
 expect(()=>resourceKey({kind:'redis',config:{dbIndex:16}})).toThrow()
})
