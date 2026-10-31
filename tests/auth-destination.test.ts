import {test,expect} from 'bun:test'
import {authDestination} from '../src/auth-destination'

test('sign-in preserves valid connection profile destinations and supported local sections',()=>{
  const base='http://127.0.0.1:4310',path='/connections/12345678-1234-4234-8234-123456789abc'
  expect(authDestination(base+path)).toBe(path)
  expect(authDestination(base+'/?next='+encodeURIComponent(path+'?tab=jobs#history'))).toBe(path+'?tab=jobs#history')
  for(const section of ['/','/overview','/connections','/plans','/backups','/jobs','/settings'])expect(authDestination(base+section)).toBe(section)
})
test('sign-in never redirects outside the installation or to an unrecognized profile path',()=>{
  const base='http://127.0.0.1:4310/'
  for(const next of ['https://evil.invalid/','//evil.invalid/','/\\evil.invalid/','javascript:alert(1)','/connections/invalid','/connections/12345678-1234-4234-8234-123456789abc/extra','/unknown'])expect(authDestination(base+'?next='+encodeURIComponent(next))).toBe('/')
})
