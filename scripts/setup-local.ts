import { mkdir, writeFile, access, chmod, copyFile,appendFile,readFile,lstat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
await mkdir('.steelkeep',{recursive:true,mode:0o700})
const directory=await lstat('.steelkeep')
if(!directory.isDirectory()||directory.isSymbolicLink())throw new Error('The local Steelkeep secret directory must be a real private directory, not a link.')
await chmod('.steelkeep',0o700)
for(const [name,content] of [['key',randomBytes(32)],['token',Buffer.from(randomBytes(32).toString('hex'))],['metadata-password',Buffer.from(randomBytes(32).toString('hex'))]] as const){
  try {await writeFile(`.steelkeep/${name}`,content,{flag:'wx',mode:0o600})}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e}
  const file=await lstat(`.steelkeep/${name}`)
  if(!file.isFile()||file.isSymbolicLink()||file.size>4096)throw new Error('Local Steelkeep secrets must be regular bounded files, not links.')
  await chmod(`.steelkeep/${name}`,0o600)
}
if((await readFile('.steelkeep/key')).length!==32||(await readFile('.steelkeep/token','utf8')).trim().length<32||(await readFile('.steelkeep/metadata-password','utf8')).trim().length<32)throw new Error('Existing local secret material is invalid; inspect it without replacing recovery keys.')
try{await access('.env')}catch{await copyFile('.env.example','.env');await chmod('.env',0o600)}
const env=await readFile('.env','utf8')
if(!env.includes('STEELKEEP_UID='))await appendFile('.env',`\nSTEELKEEP_UID=${process.getuid?.()??1000}\nSTEELKEEP_GID=${process.getgid?.()??1000}\n`)
console.log('Local key, installation token and development configuration ready. Existing files preserved.')
