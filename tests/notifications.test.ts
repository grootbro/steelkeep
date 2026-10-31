import {test,expect} from 'bun:test'
import {validateNotification,notificationDestination,notificationUrl} from '../server/notifications-config'
import {notificationHttpRequest,sendNotification,NotificationSendError} from '../server/notifications-send'
const message={title:'steelkeep backup failed',text:'Source <ops> & @everyone',runId:null,timestamp:new Date().toISOString()},delivery='ff2f2059-c9bd-41bb-8a41-a6717db72972'
function allow<T>(action:()=>T){const previous=process.env.STEELKEEP_ALLOWED_HOSTS;process.env.STEELKEEP_ALLOWED_HOSTS='127.0.0.1,notify.example';try{return action()}finally{if(previous===undefined)delete process.env.STEELKEEP_ALLOWED_HOSTS;else process.env.STEELKEEP_ALLOWED_HOSTS=previous}}
test('channel secrets remain write-only; blank edit retains values and public destination omits credential paths',()=>allow(()=>{
 const checked=validateNotification('webhook',{}, {url:'https://notify.example/private?token=hidden',bearerToken:'hidden'})
 expect(checked.config).toEqual({});expect(notificationDestination('webhook',checked.config,checked.secrets)).toBe('https://notify.example')
 expect(validateNotification('webhook',{}, {url:'',bearerToken:''},checked.secrets).secrets).toEqual(checked.secrets)
 expect(()=>validateNotification('webhook',{}, {url:'https://notify.example',bearerToken:'x\r\nInjected:y'})).toThrow()
 expect(()=>validateNotification('webhook',{url:'https://notify.example'},{url:'https://notify.example'})).toThrow()
 expect(()=>notificationUrl('https://elsewhere.invalid')).toThrow()
 expect(()=>notificationUrl('http://notify.example')).toThrow()
 expect(()=>notificationUrl('https://user:password@notify.example')).toThrow()
 expect(()=>notificationUrl('https://notify.example/#token')).toThrow()
}))
test('SMTP accepts bounded recipients and requires verified TLS outside loopback',()=>allow(()=>{
 const c={host:'notify.example',port:587,tls:'starttls',from:'backup@example.test',to:['owner@example.test','owner@example.test']}
 expect(validateNotification('email',c,{}).config.to).toEqual(['owner@example.test'])
 expect(()=>validateNotification('email',{...c,tls:'none'},{})).toThrow()
 expect(()=>validateNotification('email',{...c,to:['owner@example.test\r\nBcc:private@example.test']},{})).toThrow()
 expect(()=>validateNotification('email',{...c,to:Array(11).fill('owner@example.test')},{})).toThrow()
 expect(()=>validateNotification('email',c,{username:'u'})).toThrow()
 expect(()=>validateNotification('email',{...c,attachment:'/etc/passwd'},{})).toThrow()
}))
test('all provider formats disable accidental mentions and preserve stable delivery identity',()=>{
 const slack=notificationHttpRequest('slack',{}, {webhookUrl:'https://notify.example/token'},message,delivery)
 expect(JSON.parse(slack.body).blocks[0].text.type).toBe('plain_text');expect(JSON.parse(slack.body).text).toContain('&lt;ops&gt; &amp;')
 const discord=notificationHttpRequest('discord',{channelId:'123'}, {botToken:'synthetic'},message,delivery)
 expect(discord.url).toBe('https://discord.com/api/v10/channels/123/messages');expect(JSON.parse(discord.body).allowed_mentions.parse).toEqual([]);expect(JSON.parse(discord.body).enforce_nonce).toBe(true)
 expect(new URL(notificationHttpRequest('discord_webhook',{}, {webhookUrl:'https://notify.example/token'},message,delivery).url).searchParams.get('wait')).toBe('true')
 expect(JSON.parse(notificationHttpRequest('telegram',{chatId:'-123'},{botToken:'123:synthetic'},message,delivery).body).parse_mode).toBeUndefined()
 expect(JSON.parse(notificationHttpRequest('teams',{}, {webhookUrl:'https://notify.example/token'},message,delivery).body).attachments[0].content.type).toBe('AdaptiveCard')
 expect(JSON.parse(notificationHttpRequest('pushover',{priority:0},{appToken:'a',userKey:'u'},message,delivery).body).user).toBe('u')
 expect(notificationHttpRequest('gotify',{serverUrl:'https://notify.example/base',priority:5},{token:'secret'},message,delivery).headers['X-Gotify-Key']).toBe('secret')
 const webhook=notificationHttpRequest('webhook',{}, {url:'https://notify.example',bearerToken:'secret'},message,delivery)
 expect(webhook.headers['Idempotency-Key']).toBe(delivery);expect(JSON.parse(webhook.body).deliveryId).toBe(delivery)
})
test('HTTP redirect is refused, provider refusal sanitized and ambiguous acknowledgement stops replay',async()=>{
 const previous=process.env.STEELKEEP_ALLOWED_HOSTS;process.env.STEELKEEP_ALLOWED_HOSTS='127.0.0.1';let followed=0
 const sink=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){const path=new URL(request.url).pathname;if(path==='/redirect')return new Response(null,{status:302,headers:{location:'/target'}});if(path==='/target'){followed++;return new Response('ok')};if(path==='/temporary')return new Response('secret raw provider error',{status:503});if(path==='/slack')return new Response('not accepted');return new Response('ok')}})
 const endpoint='http://127.0.0.1:'+sink.port
 try{
  for(const [path,outcome,code,kind] of [['redirect','failed','NOTIFICATION_REDIRECT_REFUSED','webhook'],['temporary','retry','NOTIFICATION_HTTP_TEMPORARY','webhook'],['slack','uncertain','NOTIFICATION_ACK_INVALID','slack']] as const){
   try{await sendNotification(kind,{},kind==='slack'?{webhookUrl:endpoint+'/'+path}:{url:endpoint+'/'+path},message,delivery,AbortSignal.timeout(2000));throw new Error('Unexpected acceptance')}catch(error){expect(error).toBeInstanceOf(NotificationSendError);expect(error).toMatchObject({outcome,code});expect((error as Error).message).not.toContain('secret raw')}
  }
  expect(followed).toBe(0)
 }finally{sink.stop(true);if(previous===undefined)delete process.env.STEELKEEP_ALLOWED_HOSTS;else process.env.STEELKEEP_ALLOWED_HOSTS=previous}
})
test('SMTP absolute cancellation destroys an in-flight socket without waiting for idle timeout',async()=>{
 const {createServer}=await import('node:net'),sockets=new Set<import('node:net').Socket>()
 const sink=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.write('220 synthetic stalled SMTP\r\n');socket.on('data',()=>{})})
 await new Promise<void>(resolve=>sink.listen(0,'127.0.0.1',resolve));const address=sink.address();if(!address||typeof address==='string')throw new Error('Expected loopback SMTP socket.')
 const previous=process.env.STEELKEEP_ALLOWED_HOSTS;process.env.STEELKEEP_ALLOWED_HOSTS='127.0.0.1'
 const started=Date.now()
 try{
  await expect(sendNotification('email',{host:'127.0.0.1',port:address.port,tls:'none',from:'backup@example.test',to:['owner@example.test']},{},message,delivery,AbortSignal.timeout(100))).rejects.toMatchObject({outcome:'uncertain',code:'NOTIFICATION_SMTP_UNCERTAIN'})
  expect(Date.now()-started).toBeLessThan(1000)
  const deadline=Date.now()+500;while(sockets.size&&Date.now()<deadline)await Bun.sleep(5)
  expect(sockets.size).toBe(0)
 }finally{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>sink.close(()=>resolve()));if(previous===undefined)delete process.env.STEELKEEP_ALLOWED_HOSTS;else process.env.STEELKEEP_ALLOWED_HOSTS=previous}
})
