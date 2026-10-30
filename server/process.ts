import {spawn} from 'node:child_process'
import {open,stat} from 'node:fs/promises'
import {AppError} from './security'

const tools=new Set(['pg_dump','pg_restore','mysqldump','mysql','mariadb-dump','mariadb','mongodump','mongorestore','sqlite3','dotnet','clickhouse','clickhouse-client'])
export const maxArchiveBytes=2*1024*1024*1024

// Do not inherit ambient database passwords, libpq settings or startup files.
export function toolEnv(extra:NodeJS.ProcessEnv={}):NodeJS.ProcessEnv {
  return {PATH:process.env.PATH,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC',...extra}
}
type ToolOptions={env:NodeJS.ProcessEnv;signal:AbortSignal;timeoutMs?:number;capture?:boolean;captureLimitBytes?:number;stdoutFile?:string;stdinFile?:string;maxFileBytes?:number}

/** argv only. Linux prlimit applies a hard per-file limit, including dump stdout. */
export async function runTool(binary:string,args:string[],options:ToolOptions):Promise<string>{
  if(!tools.has(binary))throw new AppError('INVALID_TOOL','This database tool is not permitted.')
  if(options.signal.aborted)throw options.signal.reason instanceof AppError?options.signal.reason:new AppError('CANCELLED','Operation cancelled.')
  const output=options.stdoutFile?await open(options.stdoutFile,'wx',0o600):undefined
  let input:Awaited<ReturnType<typeof open>>|undefined
  try {
    input=options.stdinFile?await open(options.stdinFile,'r'):undefined
    if(options.signal.aborted)throw options.signal.reason instanceof AppError?options.signal.reason:new AppError('CANCELLED','Operation cancelled.')
    return await new Promise<string>((resolve,reject)=>{
      const child=spawn('prlimit',[`--fsize=${options.maxFileBytes??maxArchiveBytes}`, '--',binary,...args],{
        env:options.env,detached:true,stdio:[input?.fd??'ignore',output?.fd??(options.capture?'pipe':'ignore'),'pipe']
      })
      let timedOut=false,aborted=false,tooLarge=false,settled=false,stopping=false
      let text='',bytes=0,escalation:ReturnType<typeof setTimeout>|undefined
      const kill=(signal:NodeJS.Signals)=>{try{if(child.pid)process.kill(-child.pid,signal)}catch{}}
      const stop=()=>{
        if(stopping)return
        stopping=true;kill('SIGTERM');escalation=setTimeout(()=>kill('SIGKILL'),2000)
      }
      const abort=()=>{aborted=true;stop()}
      const timer=setTimeout(()=>{timedOut=true;stop()},options.timeoutMs??2*60*60*1000)
      // Never collect stderr: driver messages can contain credentials or SQL values.
      child.stderr?.on('data',()=>{})
      child.stdout?.on('data',(chunk:Buffer)=>{
        bytes+=chunk.length
        if(bytes>Math.min(options.captureLimitBytes??16*1024,2*1024*1024)){tooLarge=true;stop();return}
        text+=chunk.toString('utf8')
      })
      options.signal.addEventListener('abort',abort,{once:true})
      if(options.signal.aborted)abort()
      const cleanup=()=>{clearTimeout(timer);clearTimeout(escalation);options.signal.removeEventListener('abort',abort)}
      child.once('error',()=>{
        if(settled)return;settled=true;cleanup()
        reject(new AppError('TOOL_UNAVAILABLE','The database client or Linux resource limiter could not start.'))
      })
      child.once('close',(code,exitSignal)=>{
        kill('SIGKILL')
        if(settled)return;settled=true;cleanup()
        if(timedOut)reject(new AppError('TIMEOUT','The database operation exceeded its time limit.'))
        else if(aborted)reject(options.signal.reason instanceof AppError?options.signal.reason:new AppError('CANCELLED','Operation cancelled.'))
        else if(tooLarge||exitSignal==='SIGXFSZ')reject(new AppError('RESOURCE_LIMIT','The database operation exceeded its resource limit.'))
        else if(code!==0)reject(new AppError('DATABASE_TOOL_FAILED','The native database tool failed. Check client versions, permissions and available disk space.'))
        else resolve(text.trim())
      })
    })
  } finally {await input?.close();await output?.close()}
}

export async function assertArchiveSize(path:string){
  const {size}=await stat(path)
  if(size===0||size>maxArchiveBytes)throw new AppError('RESOURCE_LIMIT','Archive is empty or exceeds the 2 GiB limit for this release.')
  return size
}
