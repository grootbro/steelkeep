import {mkdir,lstat,realpath,chmod} from 'node:fs/promises'
import {resolve} from 'node:path'

// Provisioning only, explicitly invoked by a human before Docker Compose.
// Never starts a process, contacts Docker, changes existing file ownership or
// deletes archives/journals. macOS/Linux: export STEELKEEP_UID/GID to your IDs.
if(process.env.STEELKEEP_ACCEPTANCE!=='synthetic-local-clickhouse')throw new Error('Explicit synthetic-local-clickhouse opt-in required')
const uid=Number(process.env.STEELKEEP_UID??1000),gid=Number(process.env.STEELKEEP_GID??1000)
if(!Number.isSafeInteger(uid)||!Number.isSafeInteger(gid)||uid<=0||gid<=0||process.getuid?.()!==uid||process.getgid?.()!==gid)throw new Error('Set STEELKEEP_UID and STEELKEEP_GID to the current non-root OS user/group; use the same values for Compose')
const root=resolve('.steelkeep'),parts=['extra-fixtures','clickhouse','backups']
await mkdir(root,{mode:0o700}).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='EEXIST')throw error})
let path=root
for(const part of ['',...parts]){
  if(part){path=resolve(path,part);await mkdir(path,{mode:0o700}).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='EEXIST')throw error})}
  const info=await lstat(path)
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path||info.uid!==uid||info.gid!==gid||(info.mode&0o007)!==0)throw new Error('Fixture directory must be canonical, owned by the selected user/group, and inaccessible to other users')
}
await chmod(path,0o2770)
console.log('Private fixture spool prepared. No containers were started.')
