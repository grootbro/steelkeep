import {test,expect} from 'bun:test'
import {runInNewContext} from 'node:vm'
import {appearanceBootstrapScript,readTheme} from '../src/appearance'

test('one explicit appearance preference is shared with existing auth choices',()=>{
  const storage=(values:Record<string,string>)=>({getItem:(key:string)=>values[key]??null})
  expect(readTheme(storage({'steelkeep-theme':'dark','steelkeep-auth-theme':'light'}))).toBe('dark')
  expect(readTheme(storage({'steelkeep-auth-theme':'dark'}))).toBe('dark')
  expect(readTheme(storage({'steelkeep-theme':'light'}))).toBe('light')
  expect(readTheme(storage({}))).toBe('dark')
  expect(readTheme(storage({'steelkeep-theme':'system'}))).toBe('dark')
  expect(readTheme(storage({'steelkeep-theme':'invalid','steelkeep-auth-theme':'light'}))).toBe('light')
  expect(readTheme({getItem:()=>{throw new Error('storage denied')}})).toBe('dark')
})

test('the blocking head bootstrap applies the explicit theme before app code and survives unavailable storage',()=>{
  for(const [values,expected] of [[{},'dark'],[{'steelkeep-theme':'light'},'light'],[{'steelkeep-theme':'dark','steelkeep-auth-theme':'light'},'dark'],[{'steelkeep-auth-theme':'light'},'light'],[{'steelkeep-theme':'system'},'dark']] as const){
    const attributes:Record<string,string>={}
    runInNewContext(appearanceBootstrapScript,{localStorage:{getItem:(key:string)=>(values as Record<string,string>)[key]??null},document:{documentElement:{setAttribute:(key:string,value:string)=>{attributes[key]=value}}}})
    expect(attributes['data-theme']).toBe(expected)
  }
  const attributes:Record<string,string>={}
  runInNewContext(appearanceBootstrapScript,{get localStorage(){throw new Error('storage blocked')},document:{documentElement:{setAttribute:(key:string,value:string)=>{attributes[key]=value}}}})
  expect(attributes['data-theme']).toBe('dark')
})
