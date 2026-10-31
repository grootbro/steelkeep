import {test,expect} from 'bun:test'
import {mysqlGrantScope,mysqlRestoreGrantsSafe,mysqlMetadataPermissions} from '../server/engines/database'

const grant=(scope:string,permissions='SELECT, SHOW VIEW, TRIGGER, EVENT, EXECUTE')=>`GRANT ${permissions} ON ${scope} TO \`restore\`@\`%\``
const usage=grant('*.*','USAGE')

test('hyphen and leading-digit database grants retain exact target scope',()=>{
 for(const database of ['my-app','123db']){
  const exact=grant('`'+database+'`.*')
  for(const partialRevokes of [false,true]){
   expect(mysqlRestoreGrantsSafe([usage,exact],database,partialRevokes)).toBe(true)
   expect(mysqlMetadataPermissions([exact],database,partialRevokes)).toBe(true)
   expect(mysqlRestoreGrantsSafe([exact],'other-'+database,partialRevokes)).toBe(false)
  }
 }
})

test('quoted database wildcards remain unsafe unless escaped or partial revokes is ON',()=>{
  for(const database of ['restore_one','restore%one']){
    const raw=grant('`'+database+'`.*'),escaped=grant('`'+database.replace(/[%_]/g,'\\$&')+'`.*')
    expect(mysqlRestoreGrantsSafe([usage,raw],database,false)).toBe(false)
    expect(mysqlRestoreGrantsSafe([usage,escaped],database,false)).toBe(true)
    expect(mysqlRestoreGrantsSafe([raw,usage],database,true)).toBe(true)
  }
  expect(mysqlRestoreGrantsSafe([grant('`plain`.*')],'plain',false)).toBe(true)
  expect(mysqlRestoreGrantsSafe([grant('`Restore`.*')],'restore',false)).toBe(false)
})

test('target scope validation rejects other databases, global privileges, roles and grant options in any order',()=>{
  const exact=grant('`restore\\_one`.*')
  for(const unsafe of [grant('*.*'),grant('`other`.*'),grant('`restore\\_one`.entries'),"GRANT `writer`@`%` TO `restore`@`%`",exact+' WITH GRANT OPTION',grant('*.*','PROXY'),grant('`restore_one`.*')]){
    expect(mysqlRestoreGrantsSafe([exact,unsafe],'restore_one',false)).toBe(false)
    expect(mysqlRestoreGrantsSafe([unsafe,exact],'restore_one',false)).toBe(false)
  }
  expect(mysqlRestoreGrantsSafe([],'restore_one',false)).toBe(false)
  expect(mysqlRestoreGrantsSafe([usage,exact],'restore_one',false)).toBe(true)
  expect(mysqlRestoreGrantsSafe([exact,usage],'restore_one',false)).toBe(true)
})

test('normalization handles escaped backticks and backslashes without accepting malformed escapes or scope substrings',()=>{
  expect(mysqlGrantScope(grant('`a``b\\_c`.*'),false)?.database).toBe('a`b_c')
  expect(mysqlGrantScope(grant('`a\\\\b`.*'),false)?.database).toBe('a\\b')
  expect(mysqlGrantScope(grant('`a\\q`.*'),false)).toBe(null)
  expect(mysqlGrantScope(grant('`a\\`.*'),false)).toBe(null)
  expect(mysqlRestoreGrantsSafe([grant('`other`.*')+" IDENTIFIED BY 'ON `target`.* TO x'"],'target',false)).toBe(false)
  expect(mysqlRestoreGrantsSafe([grant('`__proto__`.*')],'__proto__',false)).toBe(false)
  expect(mysqlRestoreGrantsSafe([grant('`\\_\\_proto\\_\\_`.*')],'__proto__',false)).toBe(true)
})

test('metadata visibility recognizes old raw source grants and new escaped source grants for the actual database',()=>{
  for(const scope of ['`source_mysql`.*','`source\\_mysql`.*','*.*'])expect(mysqlMetadataPermissions([grant(scope)],'source_mysql',false)).toBe(true)
  expect(mysqlMetadataPermissions([grant('`other`.*')],'source_mysql',false)).toBe(false)
  expect(mysqlMetadataPermissions([grant('`source_mysql`.*','SELECT')],'source_mysql',false)).toBe(false)
  expect(mysqlMetadataPermissions([grant('*.*','ALL PRIVILEGES')+' WITH GRANT OPTION'],'source_mysql',false)).toBe(true)
  const split=[grant('`source\\_mysql`.*','TRIGGER, EVENT, EXECUTE'),grant('`source_mysql`.*','SHOW VIEW, SELECT')]
  expect(mysqlMetadataPermissions(split,'source_mysql',false)).toBe(true)
  expect(mysqlMetadataPermissions([...split].reverse(),'source_mysql',false)).toBe(true)
})
