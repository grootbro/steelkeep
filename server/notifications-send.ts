import {createConnection,type Socket} from 'node:net'
import {AppError} from './security'
import {notificationUrl,validateNotification,type NotificationKind,type NotificationConfig,type NotificationSecrets} from './notifications-config'

export class NotificationSendError extends Error{
 constructor(public outcome:'retry'|'failed'|'uncertain',public code:string,message:string){super(message)}
}
const rejected=(outcome:'retry'|'failed'|'uncertain',code:string)=>new NotificationSendError(outcome,code,outcome==='retry'?'The provider temporarily refused this delivery.':outcome==='uncertain'?'The provider may have accepted this message, but its acknowledgement was not confirmed. Automatic replay is stopped.':'The provider refused this delivery. Check the channel configuration and permissions.')
type Message={title:string;text:string;runId:string|null;timestamp:string;[key:string]:unknown}
export function notificationHttpRequest(kind:Exclude<NotificationKind,'email'>,config:NotificationConfig,secrets:NotificationSecrets,message:Message,deliveryId:string){
 let url:string,body:unknown,headers:Record<string,string>={'Content-Type':'application/json','Idempotency-Key':deliveryId,'X-Steelkeep-Delivery-Id':deliveryId}
 const text=message.title+'\n'+message.text
 if(kind==='slack'){url=secrets.webhookUrl;body={text:text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),blocks:[{type:'section',text:{type:'plain_text',text}}]}}
 else if(kind==='discord'||kind==='discord_webhook'){
  url=kind==='discord'?`https://discord.com/api/v10/channels/${config.channelId}/messages`:secrets.webhookUrl
  if(kind==='discord')headers.Authorization='Bot '+secrets.botToken;else{const parsed=new URL(url);parsed.searchParams.set('wait','true');url=parsed.toString()}
  body={content:text.slice(0,2000),allowed_mentions:{parse:[]},...(kind==='discord'?{nonce:deliveryId.replaceAll('-','').slice(0,25),enforce_nonce:true}:{})}
 }else if(kind==='teams'){
  url=secrets.webhookUrl;body={type:'message',attachments:[{contentType:'application/vnd.microsoft.card.adaptive',contentUrl:null,content:{$schema:'http://adaptivecards.io/schemas/adaptive-card.json',type:'AdaptiveCard',version:'1.2',body:[{type:'TextBlock',text:message.title,weight:'Bolder',wrap:true},{type:'TextBlock',text:message.text,wrap:true}]}}]}
 }else if(kind==='telegram'){url=`https://api.telegram.org/bot${secrets.botToken}/sendMessage`;body={chat_id:config.chatId,text:text.slice(0,4096),link_preview_options:{is_disabled:true}}}
 else if(kind==='pushover'){url='https://api.pushover.net/1/messages.json';body={token:secrets.appToken,user:secrets.userKey,title:message.title.slice(0,250),message:message.text.slice(0,1024),priority:config.priority,...(config.device?{device:config.device}:{})}}
 else if(kind==='gotify'){url=String(config.serverUrl)+'/message';headers['X-Gotify-Key']=secrets.token;body={title:message.title,message:message.text,priority:config.priority}}
 else{url=secrets.url;if(secrets.bearerToken)headers.Authorization='Bearer '+secrets.bearerToken;body={...message,deliveryId}}
 return {url,headers,body:JSON.stringify(body)}
}
async function responseText(response:Response){
 if(Number(response.headers.get('content-length')??0)>65536){await response.body?.cancel();throw rejected('uncertain','NOTIFICATION_ACK_TOO_LARGE')}
 if(!response.body)return ''
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0
 try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>65536)throw rejected('uncertain','NOTIFICATION_ACK_TOO_LARGE');chunks.push(next.value)}return Buffer.concat(chunks).toString('utf8')}finally{await reader.cancel().catch(()=>{})}
}
export async function sendNotification(kind:NotificationKind,config:NotificationConfig,secrets:NotificationSecrets,payload:Record<string,unknown>,deliveryId:string,signal:AbortSignal){
 const checked=validateNotification(kind,config,secrets),message=payload as Message
 if(typeof message.title!=='string'||typeof message.text!=='string'||message.title.length>250||message.text.length>6000)throw new AppError('INVALID_NOTIFICATION_PAYLOAD','The queued notification payload is invalid.')
 if(kind==='email'){
  const {default:nodemailer}=await import('nodemailer')
  const c=checked.config,s=checked.secrets,recipients=c.to as string[]
  let socket:Socket|undefined
  const transport=nodemailer.createTransport({getSocket:(_options,callback)=>{
   let returned=false
   const done=(error:Error|null)=>{if(returned)return;returned=true;if(error)callback(error);else callback(null,{connection:socket})}
   socket=createConnection({host:String(c.host),port:Number(c.port),signal})
   socket.setTimeout(5000,()=>socket?.destroy(new Error('SMTP socket timeout')))
   socket.once('error',error=>done(error));socket.once('connect',()=>done(signal.aborted?new Error('SMTP send aborted'):null))
  },host:String(c.host),port:Number(c.port),secure:c.tls==='implicit',requireTLS:c.tls==='starttls',ignoreTLS:c.tls==='none',opportunisticTLS:false,tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},...(s.username?{auth:{user:s.username,pass:s.password}}:{}),connectionTimeout:5000,greetingTimeout:5000,socketTimeout:5000,dnsTimeout:3000,logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true})
  const abort=()=>{socket?.destroy();transport.close()};signal.addEventListener('abort',abort,{once:true})
  try{
   if(signal.aborted)throw rejected('uncertain','NOTIFICATION_SEND_ABORTED')
   const sent=await transport.sendMail({from:String(c.from),to:recipients,subject:message.title,text:message.text,messageId:`<${deliveryId}@steelkeep.local>`,headers:{'X-Steelkeep-Delivery-Id':deliveryId},disableFileAccess:true,disableUrlAccess:true})
   if(sent.rejected.length||sent.accepted.length!==recipients.length)throw rejected('uncertain','NOTIFICATION_PARTIAL_ACCEPTANCE')
  }catch(error){
   if(error instanceof NotificationSendError)throw error
   const e=error as {responseCode?:number;code?:string;command?:string;timeoutType?:string}
   if(e.responseCode&&e.responseCode>=400&&e.responseCode<500)throw rejected('retry','NOTIFICATION_SMTP_TEMPORARY')
   if(e.responseCode&&e.responseCode>=500||e.code==='EAUTH')throw rejected('failed','NOTIFICATION_SMTP_REFUSED')
   if(['ECONNREFUSED','ENOTFOUND','EAI_AGAIN'].includes(e.code??'')||['CONNECT_TIMEOUT','GREETING_TIMEOUT','UPGRADE_TIMEOUT'].includes(e.timeoutType??''))throw rejected('retry','NOTIFICATION_SMTP_UNAVAILABLE')
   throw rejected('uncertain','NOTIFICATION_SMTP_UNCERTAIN')
  }finally{signal.removeEventListener('abort',abort);socket?.destroy();transport.close()}
  return
 }
 const request=notificationHttpRequest(kind,checked.config,checked.secrets,message,deliveryId),url=notificationUrl(request.url)
 let response:Response
 try{response=await fetch(url,{method:'POST',headers:request.headers,body:request.body,redirect:'manual',signal})}catch{throw rejected('uncertain','NOTIFICATION_HTTP_UNCERTAIN')}
 if(response.status===429||response.status>=500){await response.body?.cancel();throw rejected('retry','NOTIFICATION_HTTP_TEMPORARY')}
 if(!response.ok){await response.body?.cancel();throw rejected('failed',response.status>=300&&response.status<400?'NOTIFICATION_REDIRECT_REFUSED':'NOTIFICATION_HTTP_REFUSED')}
 const text=await responseText(response)
 if(kind==='slack'){if(text.trim()!=='ok')throw rejected('uncertain','NOTIFICATION_ACK_INVALID');return}
 if(kind==='telegram'||kind==='pushover'||kind==='discord'||kind==='discord_webhook'||kind==='gotify'){
  let data:Record<string,unknown>;try{data=JSON.parse(text)}catch{throw rejected('uncertain','NOTIFICATION_ACK_INVALID')}
  if(kind==='telegram'&&data.ok!==true||kind==='pushover'&&data.status!==1)throw rejected('failed','NOTIFICATION_PROVIDER_REFUSED')
  if((kind==='discord'||kind==='discord_webhook'||kind==='gotify')&&!data.id)throw rejected('uncertain','NOTIFICATION_ACK_INVALID')
 }
}
