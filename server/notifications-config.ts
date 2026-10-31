import {AppError,allowedHost} from './security'

export const notificationKinds=['email','slack','discord','discord_webhook','teams','telegram','pushover','gotify','webhook'] as const
export type NotificationKind=typeof notificationKinds[number]
export type NotificationConfig=Record<string,string|number|boolean|string[]>
export type NotificationSecrets=Record<string,string>
export type NotificationEvents={success:boolean;failure:boolean}
export const invalidNotification=()=>new AppError('INVALID_NOTIFICATION_CONFIG','Check the channel type, destination, required credentials and installation host allowlist.')
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
export function notificationUrl(value:unknown){
 if(typeof value!=='string'||value.length>2048||/[\r\n\0]/.test(value))throw invalidNotification()
 let url:URL;try{url=new URL(value)}catch{throw invalidNotification()}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw invalidNotification()
 allowedHost(url.hostname);return url
}
export function validateNotification(kind:NotificationKind,config:unknown,secrets:unknown,previous:NotificationSecrets={}){
 if(!notificationKinds.includes(kind)||!object(config)||!object(secrets))throw invalidNotification()
 const fields:Record<NotificationKind,string[]>={email:['username','password'],slack:['webhookUrl'],discord:['botToken'],discord_webhook:['webhookUrl'],teams:['webhookUrl'],telegram:['botToken'],pushover:['appToken','userKey'],gotify:['token'],webhook:['url','bearerToken']}
 if(Object.keys(secrets).some(key=>!fields[kind].includes(key)))throw invalidNotification()
 const merged:NotificationSecrets={...previous}
 for(const [key,value]of Object.entries(secrets)){if(typeof value!=='string'||value.length>2048||/[\r\n\0]/.test(value))throw invalidNotification();if(value!=='')merged[key]=value}
 const text=(field:string,max=254)=>{const value=config[field];if(typeof value!=='string'||!value||value.length>max||/[\r\n\0]/.test(value))throw invalidNotification();return value}
 const exact=(keys:string[])=>{if(Object.keys(config).some(key=>!keys.includes(key)))throw invalidNotification()}
 let safe:NotificationConfig={}
 if(kind==='email'){
  exact(['host','port','tls','from','to']);const host=text('host',253),from=text('from'),to=config.to
  allowedHost(host)
  if(!Number.isInteger(config.port)||Number(config.port)<1||Number(config.port)>65535||!['implicit','starttls','none'].includes(String(config.tls))||config.tls==='none'&&!['127.0.0.1','localhost','::1'].includes(host)||!Array.isArray(to)||to.length<1||to.length>10)throw invalidNotification()
  const email=(v:unknown)=>typeof v==='string'&&v.length<=254&&/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(v)
  if(!email(from)||to.some(value=>!email(value))||Boolean(merged.username)!==Boolean(merged.password))throw invalidNotification()
  safe={host,port:Number(config.port),tls:String(config.tls),from,to:[...new Set(to as string[])]}
 }else if(kind==='discord'){
  exact(['channelId']);const channelId=text('channelId',25);if(!/^\d+$/.test(channelId))throw invalidNotification();safe={channelId}
 }else if(kind==='telegram'){
  exact(['chatId']);const chatId=text('chatId',65);if(!/^(?:-?\d{1,20}|@[A-Za-z0-9_]{1,64})$/.test(chatId))throw invalidNotification();safe={chatId}
 }else if(kind==='gotify'){
  exact(['serverUrl','priority']);const url=notificationUrl(text('serverUrl',2048));if(url.search||!Number.isInteger(config.priority)||Number(config.priority)<0||Number(config.priority)>10)throw invalidNotification();safe={serverUrl:url.toString().replace(/\/$/,''),priority:Number(config.priority)}
 }else if(kind==='pushover'){
  exact(['device','priority']);if(!Number.isInteger(config.priority)||Number(config.priority)<-2||Number(config.priority)>1||config.device!==undefined&&(typeof config.device!=='string'||!/^[A-Za-z0-9_-]{0,25}$/.test(config.device)))throw invalidNotification();safe={priority:Number(config.priority),...(config.device?{device:String(config.device)}:{})}
 }else{
  exact([]);const field=kind==='webhook'?'url':'webhookUrl';merged[field]=notificationUrl(merged[field]).toString()
 }
 for(const field of fields[kind])if(!(kind==='email'||kind==='webhook'&&field==='bearerToken')&&!merged[field])throw invalidNotification()
 if(kind==='telegram'||kind==='discord')if(!/^[A-Za-z0-9_.:-]+$/.test(merged.botToken))throw invalidNotification()
 return {config:safe,secrets:merged}
}
export function notificationDestination(kind:NotificationKind,config:NotificationConfig,secrets:NotificationSecrets){
 if(kind==='email')return (config.to as string[]).join(', ')
 if(kind==='telegram')return String(config.chatId)
 if(kind==='discord')return String(config.channelId)
 if(kind==='gotify')return new URL(String(config.serverUrl)).origin
 if(kind==='pushover')return config.device?String(config.device):null
 return new URL(secrets[kind==='webhook'?'url':'webhookUrl']).origin
}
