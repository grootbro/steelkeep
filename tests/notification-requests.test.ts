import {test,expect} from 'bun:test'
import {readPendingNotifications,writePendingNotifications,notificationRequestWasRejected,type PendingNotifications} from '../src/notification-requests'
function memoryStorage():Storage{const data=new Map<string,string>();return {get length(){return data.size},clear:()=>data.clear(),getItem:key=>data.get(key)??null,key:index=>[...data.keys()][index]??null,removeItem:key=>{data.delete(key)},setItem:(key,value)=>{data.set(key,value)}}}
const id='00000000-0000-4000-8000-000000000001',key='00000000-0000-4000-8000-000000000002'
test('notification test and retry preserve their keys after remount and are isolated by actor',()=>{
  const storage=memoryStorage(),pending:PendingNotifications={[`test:${id}`]:{kind:'test',id,key,revision:1},[`retry:${id}`]:{kind:'retry',id,key,confirmDuplicateRisk:true}}
  writePendingNotifications(storage,'owner',pending);expect(readPendingNotifications(storage,'owner')).toEqual(pending);expect(readPendingNotifications(storage,'agent')).toEqual({});writePendingNotifications(storage,'owner',{});expect(storage.length).toBe(0)
})
test('corrupt notification bookmarks and payload fields fail closed rather than generating duplicate sends',()=>{
  const storage=memoryStorage();writePendingNotifications(storage,'owner',{[`test:${id}`]:{kind:'test',id,key,revision:1}});const name=storage.key(0)!
  for(const raw of ['{broken','[]',JSON.stringify({[`test:${id}`]:{kind:'test',id,key,revision:1,token:'must-not-be-stored'}}),JSON.stringify({[`retry:${id}`]:{kind:'test',id,key,revision:1}}),JSON.stringify({[`test:${id}`]:{kind:'test',id,key:'invalid'}})]){storage.setItem(name,raw);expect(()=>readPendingNotifications(storage,'owner')).toThrow()}
})
test('unavailable session storage fails before any notification can be submitted',()=>{const storage=memoryStorage();storage.setItem=()=>{throw new Error('denied')};expect(()=>writePendingNotifications(storage,'owner',{[`test:${id}`]:{kind:'test',id,key,revision:1}})).toThrow('No new request was sent')})
test('permission, rate, proxy and key conflicts retain original notification commands',()=>{
 for(const status of [400,401,403,404,408,409,429,500,503])expect(notificationRequestWasRejected({status,code:'UNKNOWN'})).toBe(false)
 expect(notificationRequestWasRejected({status:409,code:'IDEMPOTENCY_CONFLICT'})).toBe(false)
 expect(notificationRequestWasRejected({status:429,code:'REVISION_CONFLICT'})).toBe(false)
 expect(notificationRequestWasRejected({status:409,code:'REVISION_CONFLICT'})).toBe(true)
 expect(notificationRequestWasRejected({status:404,code:'NOTIFICATION_CHANNEL_NOT_FOUND'})).toBe(true)
})
