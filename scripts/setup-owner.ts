import {readFile,lstat} from 'node:fs/promises'

const origin=new URL(process.env.STEELKEEP_SETUP_ORIGIN??'http://127.0.0.1:4310')
if(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!['https:','http:'].includes(origin.protocol)||origin.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(origin.hostname))throw new Error('Use your installation HTTPS origin, or a loopback HTTP origin, in STEELKEEP_SETUP_ORIGIN.')
const path=process.env.STEELKEEP_TOKEN_FILE??'.steelkeep/token',file=await lstat(path)
if(!file.isFile()||file.isSymbolicLink()||file.size<32||file.size>4096)throw new Error('The installation key must be a regular bounded local file.')
const token=(await readFile(path,'utf8')).trim()
let response:Response
try{response=await fetch(new URL('/api/v1/auth/setup-link',origin),{method:'POST',headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(10000)})}
catch{throw new Error('Could not reach this installation. Start Steelkeep and check STEELKEEP_SETUP_ORIGIN.')}
if(!response.ok){
  if(response.status===409)throw new Error('An owner account already exists. Open Steelkeep and sign in with your email and password.')
  throw new Error('Could not create a setup link. Check this installation address and its local setup key.')
}
const result=await response.json() as {code?:unknown;expiresAt?:unknown}
if(typeof result.code!=='string'||!/^ss_[a-f0-9]{64}$/.test(result.code)||typeof result.expiresAt!=='string'||!Number.isFinite(Date.parse(result.expiresAt)))throw new Error('Unexpected setup-link response.')
const link=new URL('/',origin);link.hash='setup='+result.code
console.log('Open this private one-time link to choose your owner name, email and password:')
console.log(link.href)
console.log('Valid for five minutes. The installation key is never included in this link.')
