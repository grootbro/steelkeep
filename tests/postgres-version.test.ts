import {test,expect} from 'bun:test'
import {postgresMajor,postgresTools,assertPostgresTool,assertPostgresRestoreVersion} from '../server/engines/postgres-version'

test('PostgreSQL 17 keeps its native command names while 18 uses an isolated tool family',()=>{
 expect(postgresTools('17.11')).toEqual({major:17,dump:'pg_dump',restore:'pg_restore'})
 expect(postgresTools('18.1 (Ubuntu 18.1-1.pgdg24.04+1)')).toEqual({major:18,dump:'pg_dump18',restore:'pg_restore18'})
 for(const unsupported of ['16.9','19.0','17','18','180.1','18.1garbage','18preview',''])expect(()=>postgresMajor(unsupported)).toThrow()
})
test('PostgreSQL clients must report the exact selected vendor operation and server major',()=>{
 for(const major of [17,18] as const)for(const operation of ['dump','restore'] as const){
  expect(()=>assertPostgresTool(`pg_${operation} (PostgreSQL) ${major}.3 (Ubuntu build)`,major,operation)).not.toThrow()
  for(const output of [`pg_${operation} (PostgreSQL) ${major===17?18:17}.3`,'tool 18.1','pg_dump (PostgreSQL) 180.1','wrapper PostgreSQL18.1',`pg_${operation} (PostgreSQL) ${major}.3fake`])expect(()=>assertPostgresTool(output,major,operation)).toThrow()
 }
})
test('PostgreSQL restore refuses cross-major or unsupported versions before target writes',()=>{
 for(const major of [17,18])expect(()=>assertPostgresRestoreVersion(`${major}.1`,`${major}.9 (Debian build)`)).not.toThrow()
 for(const [source,target]of [['17.11','18.1'],['18.1','17.11'],['16.1','18.1'],['18.1','19.1']])expect(()=>assertPostgresRestoreVersion(source,target)).toThrow()
})
