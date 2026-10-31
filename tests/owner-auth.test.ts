import {test,expect} from 'bun:test'
import {normalizeOwnerEmail,validateOwnerPassword} from '../server/owner-auth'

test('owner email has one separator and normalizes consistently',()=>{
 expect(normalizeOwnerEmail('  Owner@Example.Test ')).toBe('owner@example.test')
 for(const email of ['owner','a@@example.test','a b@example.test','a@example','@example.test','a@b.','a\n@example.test'])expect(()=>normalizeOwnerEmail(email)).toThrow()
})
test('owner passwords retain whitespace and Unicode with explicit bounded length',()=>{
 expect(()=>validateOwnerPassword('  Good пароль  ')).not.toThrow()
 expect(()=>validateOwnerPassword('x'.repeat(128))).not.toThrow()
 for(const password of ['','short','x'.repeat(129)])expect(()=>validateOwnerPassword(password)).toThrow()
})
