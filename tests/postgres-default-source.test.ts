import {test,expect,spyOn} from 'bun:test'
import {config} from '../server/config'
import {assertProtectedDatabase,assertBackupSourceDatabase,assertArchivedSourceDatabase} from '../server/engines/database'
import {NativeAdapter} from '../server/engines/native'
import {Services} from '../server/services'
import type {Manifest} from '../server/engines/types'

const source={database:'postgres',host:'db.example.test',port:5432,restoreTarget:false}
function fixture(run:()=>void|Promise<void>){
 const previous=process.env.STEELKEEP_POSTGRES_SOURCE_ALLOWLIST,database=spyOn(config,'databaseUrl').mockReturnValue('postgresql://synthetic@metadata.example.test/steelkeep_metadata'),hosts=spyOn(config,'allowedHosts').mockReturnValue(['db.example.test','other.example.test','fd00::1'])
 delete process.env.STEELKEEP_POSTGRES_SOURCE_ALLOWLIST
 return Promise.resolve().then(()=>run()).finally(()=>{database.mockRestore();hosts.mockRestore();if(previous===undefined)delete process.env.STEELKEEP_POSTGRES_SOURCE_ALLOWLIST;else process.env.STEELKEEP_POSTGRES_SOURCE_ALLOWLIST=previous})
}
test('literal postgres capture is disabled by default and requires an exact endpoint plus normal host admission',()=>fixture(()=>{
 expect(()=>assertBackupSourceDatabase('postgres',source)).toThrow()
 process.env.STEELKEEP_POSTGRES_SOURCE_ALLOWLIST=' db.example.test:5432, [fd00::1]:6543 '
 expect(()=>assertBackupSourceDatabase('postgres',source)).not.toThrow()
 expect(()=>assertBackupSourceDatabase('postgres',{...source,host:'fd00::1',port:6543})).not.toThrow()
 for(const change of [{port:5433},{port:'5432'},{port:undefined},{host:'other.example.test'},{host:'DB.example.test'},{host:'db.example.test.'},{host:'db.example.test.evil'},{host:' db.example.test'},{host:'[fd00::1]',port:6543},{host:'fd00::1',port:5432},{database:'POSTGRES'},{restoreTarget:true},{importedArchive:true}])expect(()=>assertBackupSourceDatabase('postgres',{...source,...change})).toThrow()
 for(const value of ['*','*:5432','*.example.test:5432','db.example.test','db.example.test:05432','postgresql://db.example.test:5432/postgres']){process.env.STEELKEEP_POSTGRES_SOURCE_ALLOWLIST=value;expect(()=>assertBackupSourceDatabase('postgres',source)).toThrow()}
 process.env.STEELKEEP_POSTGRES_SOURCE_ALLOWLIST='untrusted.example.test:5432'
 expect(()=>assertBackupSourceDatabase('postgres',{...source,host:'untrusted.example.test'})).toThrow()
}))
test('capture exception never admits metadata, other engines or other protected database names',()=>fixture(()=>{
 process.env.STEELKEEP_POSTGRES_SOURCE_ALLOWLIST='db.example.test:5432'
 for(const name of ['steelkeep_metadata','template0','template1','mysql','information_schema','performance_schema','sys','admin','config','local','system','master','model','msdb','tempdb'])expect(()=>assertBackupSourceDatabase('postgres',{...source,database:name})).toThrow()
 for(const engine of ['mysql','mariadb','mongodb','clickhouse','mssql','redis','sqlite'])expect(()=>assertBackupSourceDatabase(engine,source)).toThrow()
 expect(()=>assertProtectedDatabase('postgres')).toThrow()
 const metadata=spyOn(config,'databaseUrl').mockReturnValue('postgresql://synthetic@db.example.test:5432/post%67res')
 try{expect(()=>assertBackupSourceDatabase('postgres',source)).toThrow();expect(()=>assertArchivedSourceDatabase('postgres','postgres')).toThrow()}finally{metadata.mockRestore()}
}))
test('archived postgres identity is readable without granting capture or target privileges',()=>fixture(()=>{
 expect(()=>assertArchivedSourceDatabase('postgres','postgres')).not.toThrow()
 expect(()=>assertBackupSourceDatabase('postgres',source)).toThrow()
 expect(()=>assertProtectedDatabase('postgres')).toThrow()
 for(const name of ['steelkeep_metadata','template0','template1','POSTGRES'])expect(()=>assertArchivedSourceDatabase('postgres',name)).toThrow()
 expect(()=>assertArchivedSourceDatabase('mysql','postgres')).toThrow()
 expect(()=>assertArchivedSourceDatabase('postgres','fresh_target')).not.toThrow()
}))
test('native capture and restore enforce source/target boundaries before connecting or spawning clients',()=>fixture(async()=>{
 const signal=AbortSignal.timeout(5000),adapter=new NativeAdapter('postgres',{config:{...source,user:'synthetic',tls:false},secret:{password:'synthetic'},signal}),identity=spyOn(adapter,'identity').mockRejectedValue(new Error('The policy must refuse before inspecting a connection'))
 try{
  await expect(adapter.backup('/unused','/unused',signal,async()=>{})).rejects.toMatchObject({code:'PROTECTED_DATABASE'})
  process.env.STEELKEEP_POSTGRES_SOURCE_ALLOWLIST='db.example.test:5432'
  const manifest:Manifest={format:1,engine:'postgres',database:'ordinary_source',serverVersion:'18.7',objects:{},data:{},sequences:{}}
  await expect(adapter.restore('/unused','/unused',signal,manifest)).rejects.toMatchObject({code:'PROTECTED_DATABASE'})
  expect(identity).not.toHaveBeenCalled()
 }finally{identity.mockRestore()}
}))
test('shared connection admission refuses postgres captures or targets without touching metadata storage',()=>fixture(async()=>{
 const service=Object.create(Services.prototype) as Services,input={kind:'postgres' as const,name:'Synthetic policy-only source',...source,user:'synthetic',password:'synthetic',tls:false}
 await expect(service.createConnection(input)).rejects.toMatchObject({code:'PROTECTED_DATABASE'})
 process.env.STEELKEEP_POSTGRES_SOURCE_ALLOWLIST='db.example.test:5432'
 await expect(service.createConnection({...input,restoreTarget:true})).rejects.toMatchObject({code:'PROTECTED_DATABASE'})
}))
