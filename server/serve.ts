import {resolve,sep} from 'node:path'
import {pathToFileURL} from 'node:url'
import pino from 'pino'
import {connectDb} from './db'
import {Services} from './services'
import {createApp} from './app'

// Start owns document rendering; Elysia owns every product API and MCP operation.
const root=resolve('dist/client')
const {default:start}=await import(pathToFileURL(resolve('dist/server/server.js')).href) as {default:{fetch:(request:Request)=>Promise<Response>}}
const {db}=connectDb(),api=createApp(new Services(db)),log=pino({name:'steelkeep'})
const server=Bun.serve({
  hostname:process.env.HOST??'127.0.0.1',port:Number(process.env.PORT??4310),maxRequestBodySize:65536,
  async fetch(request){
    const url=new URL(request.url)
    if(url.pathname.startsWith('/api/')||url.pathname==='/mcp'||url.pathname.startsWith('/openapi'))return api.handle(request)
    if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD'}})
    let pathname:string
    try{pathname=decodeURIComponent(url.pathname)}catch{return new Response('Invalid path',{status:400})}
    const candidate=resolve(root,'.'+pathname)
    if(candidate!==root&&!candidate.startsWith(root+sep))return new Response('Not found',{status:404})
    const file=Bun.file(candidate)
    if(candidate!==root&&await file.exists())return new Response(request.method==='HEAD'?null:file,{headers:{'Content-Type':file.type,'Cache-Control':pathname.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache','X-Content-Type-Options':'nosniff'}})
    return start.fetch(request)
  },
  error(){return new Response('The application could not complete this request.',{status:500})}
})
log.info({port:server.port},'Steelkeep web, API and MCP ready')
let stopping:Promise<void>|undefined
function stop(){return stopping??=(async()=>{await server.stop(false);await db.destroy()})()}
process.on('SIGTERM',()=>void stop())
process.on('SIGINT',()=>void stop())
