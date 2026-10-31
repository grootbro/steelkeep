import {test,expect} from 'bun:test'
import {readTheme} from '../src/appearance'

test('one explicit appearance preference is shared with existing auth choices',()=>{
  const storage=(values:Record<string,string>)=>({getItem:(key:string)=>values[key]??null})
  expect(readTheme(storage({'steelkeep-theme':'dark','steelkeep-auth-theme':'light'}))).toBe('dark')
  expect(readTheme(storage({'steelkeep-auth-theme':'dark'}))).toBe('dark')
  expect(readTheme(storage({'steelkeep-theme':'light'}))).toBe('light')
  expect(readTheme(storage({}))).toBe('light')
  expect(readTheme(storage({'steelkeep-theme':'system'}))).toBe('light')
  expect(readTheme({getItem:()=>{throw new Error('storage denied')}})).toBe('light')
})
