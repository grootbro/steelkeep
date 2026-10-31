import {test,expect,spyOn} from 'bun:test'
import {randomBytes} from 'node:crypto'
import {seal,unseal,tokenMatches,databaseName,identifier,safeFailure,AppError} from '../server/security'
import {nextOccurrence,upcomingOccurrences,authorize,validId} from '../server/services'
import {resourceKey,sameResource} from '../server/resources'
import {nativeCredentials} from '../server/engines/database'
import {mongoCredentials,MongoAdapter} from '../server/engines/mongodb'
import {ClickHouseAdapter} from '../server/engines/clickhouse'
import {createMssqlAdapter} from '../server/engines/mssql'
import {config} from '../server/config'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

test('common database names accept leading digits and internal hyphens without widening schema identifiers',()=>{
 for(const name of ['app','my-app','123db','123','_source','Mixed-App_123','a'.repeat(63)])expect(databaseName(name)).toBe(name)
 for(const name of ['my-app','123db'])expect(()=>identifier(name)).toThrow()
 expect(identifier('table_column_123')).toBe('table_column_123')
})

test('database names cannot contain native connection overrides, options, namespace patterns or SQL syntax',()=>{
 for(const name of ['', '-db','--clean','postgresql://other/db','postgres://other/db','dbname=other host=other','app=other','app.*','app?','app$wildcard$','app\\other','app/other','app:other','app%other','app`other','app"other',"app'other",'app;DROP','app other','app\nother','app\0other','a'.repeat(64),'база'])expect(()=>databaseName(name)).toThrow()
 for(const value of [null,undefined,123,['my-app'],{}])expect(()=>databaseName(value as unknown as string)).toThrow()
})

test('native PostgreSQL passes common names literally and refuses conninfo before preparing credentials',async()=>{
 for(const database of ['my-app','123db']){
  const dir=await mkdtemp(join(tmpdir(),'steelkeep-db-name-'))
  try{
   const c={host:'synthetic.invalid',port:5432,database,user:'synthetic_reader',tls:true,restoreTarget:false},secret={password:'synthetic-local-secret'}
   const credentials=await nativeCredentials('postgres',c,secret,dir)
   expect(credentials.args).toEqual(['--host','synthetic.invalid','--port','5432','--username','synthetic_reader','--dbname',database,'--no-password'])
   expect(await readFile(join(dir,'pgpass'),'utf8')).toBe(`synthetic.invalid:5432:${database}:synthetic_reader:synthetic-local-secret\n`)
   expect(credentials.args.join(' ')).not.toContain(secret.password)
   for(const name of ['dbname=other host=other','postgresql://other/db','--clean'])await expect(nativeCredentials('postgres',{...c,database:name},secret,dir)).rejects.toMatchObject({code:'INVALID_DATABASE_NAME'})
  }finally{await rm(dir,{recursive:true,force:true})}
 }
})

test('Mongo database and auth names remain literal URI components while restore patterns are rejected',async()=>{
 const hosts=spyOn(config,'allowedHosts').mockReturnValue(['synthetic.invalid']),dir=await mkdtemp(join(tmpdir(),'steelkeep-mongo-name-'))
 const c={host:'synthetic.invalid',port:27017,database:'my-app',authDatabase:'123auth-db',user:'synthetic_reader',tls:true,restoreTarget:true},secret={password:'synthetic-local-secret'}
 try{
  const credentials=await mongoCredentials(c,secret,dir),text=await readFile(credentials.args[1],'utf8'),uri=new URL(JSON.parse(text.slice('uri: '.length)))
  expect(decodeURIComponent(uri.pathname.slice(1))).toBe('my-app')
  expect(uri.searchParams.get('authSource')).toBe('123auth-db')
  expect(credentials.args.join(' ')).not.toContain(secret.password)
  await expect(mongoCredentials({...c,authDatabase:'auth.*'},secret,dir)).rejects.toMatchObject({code:'INVALID_DATABASE_NAME'})
  const adapter=new MongoAdapter(c,secret)
  try{
   for(const database of ['source.*','source$wild$','source\\other'])await expect(adapter.restore('/unused/archive','/unused',new AbortController().signal,{format:1,engine:'mongodb',database,serverVersion:'8.0',objects:{},data:{},sequences:{}})).rejects.toMatchObject({code:'INVALID_DATABASE_NAME'})
  }finally{await adapter.close()}
  for(const database of ['my-app','123db']){
   const adapter=createMssqlAdapter({config:{...c,port:1433,database},secret,signal:new AbortController().signal})
   await adapter.close()
  }
 }finally{hosts.mockRestore();await rm(dir,{recursive:true,force:true})}
})

test('ClickHouse quotes common database names and normalizes matching DDL without widening tables or disks',async()=>{
 const hosts=spyOn(config,'allowedHosts').mockReturnValue(['synthetic.invalid']),metadata=spyOn(config,'databaseUrl').mockReturnValue('postgres://synthetic.invalid/steelkeep')
 let current='my-app',table='entries',column='id'
 const queries:Array<{database:string|null;sql:string}>=[]
 const mocked=spyOn(globalThis,'fetch').mockImplementation(Object.assign(async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
  const url=new URL(input instanceof Request?input.url:String(input)),sql=String(init?.body??'')
  queries.push({database:url.searchParams.get('database'),sql})
  let rows:Record<string,unknown>[]
  if(sql.includes('FROM system.databases'))rows=[{name:current,engine:'Atomic',engine_full:'Atomic',comment:'',uuid:'11111111-1111-4111-8111-111111111111',version:'25.8.12',server:'22222222-2222-4222-8222-222222222222'}]
  else if(sql.startsWith('CHECK GRANT'))rows=[{result:1}]
  else if(sql.startsWith('SELECT count()'))rows=[{count:sql.includes("FROM system.disks WHERE name='default'")?'1':'0'}]
  else if(sql.startsWith('SELECT name,engine,create_table_query'))rows=[{name:table,engine:'MergeTree',storage_policy:'default',create_table_query:`CREATE TABLE \`${current}\`.\`${table}\` (\`id\` UInt64) ENGINE = MergeTree ORDER BY id`}]
  else if(sql.startsWith('SELECT name,type,default_kind'))rows=[{name:column,type:'UInt64',default_kind:'',default_expression:''}]
  else if(sql.startsWith('SELECT hex(SHA256('))rows=[{digest:'1'.repeat(64),bytes:'8'}]
  else throw new Error('Unexpected synthetic ClickHouse query')
  return new Response(rows.map(row=>JSON.stringify(row)).join('\n')+'\n',{headers:{'Content-Type':'application/x-ndjson'}})
 },{preconnect:()=>{throw new Error('Synthetic ClickHouse test forbids preconnect')}}))
 const adapter=(database:string,backupDisk='backups')=>new ClickHouseAdapter({config:{host:'synthetic.invalid',port:8443,database,user:'synthetic_reader',tls:true,restoreTarget:false,backupDisk,sharedBackupRoot:'/unused',quiescentSource:true},secret:{password:'synthetic-local-secret'},signal:new AbortController().signal})
 try{
  const first=await adapter(current).manifest();current='123db';const second=await adapter(current).manifest()
  expect(first.database).toBe('my-app');expect(second.database).toBe('123db')
  expect(first.objects).toEqual(second.objects);expect(first.data).toEqual(second.data)
  for(const database of ['my-app','123db']){
   const actual=queries.filter(query=>query.database===database)
   expect(actual.some(query=>query.sql===`CHECK GRANT SELECT ON \`${database}\`.*`)).toBe(true)
   expect(actual.some(query=>query.sql.includes(`FROM \`${database}\`.\`entries\` FORMAT JSONEachRow`))).toBe(true)
  }
  await expect(adapter(current,'backup-disk').identity()).rejects.toMatchObject({code:'INVALID_IDENTIFIER'})
  table='unsafe-table';await expect(adapter(current).manifest()).rejects.toMatchObject({code:'INVALID_IDENTIFIER'})
  table='entries';column='unsafe-column';await expect(adapter(current).manifest()).rejects.toMatchObject({code:'INVALID_IDENTIFIER'})
  await expect(adapter(current).restore('/unused','/unused',new AbortController().signal,{format:1,engine:'clickhouse',database:'source.*',serverVersion:'25.8.12',objects:{profile:'25.8-plain-MergeTree-quiescent-v1'},data:{},sequences:{}})).rejects.toMatchObject({code:'INVALID_DATABASE_NAME'})
 }finally{mocked.mockRestore();metadata.mockRestore();hosts.mockRestore()}
})

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
