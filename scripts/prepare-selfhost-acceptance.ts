import {randomBytes} from 'node:crypto'
import {mkdir,lstat,realpath,readFile,writeFile} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

// No Docker, HTTP, database connection, image build, or service startup here.
async function main(){
  if(process.env.STEELKEEP_ACCEPTANCE!=='synthetic-local-selfhost'||process.argv.length!==2)throw new Error('Set STEELKEEP_ACCEPTANCE=synthetic-local-selfhost for the fixed local packaged proof.')
  const workspace=await realpath(resolve(dirname(fileURLToPath(import.meta.url)),'..'))
  if(workspace!=='/Users/dobrota/dev/steelkeep'||await realpath(process.cwd())!==workspace)throw new Error('Run preparation only from the exact local Steelkeep checkout.')
  const uid=process.getuid?.(),gid=process.getgid?.()
  if(!Number.isInteger(uid)||!Number.isInteger(gid)||uid===0||gid===0)throw new Error('Prepare proof material as the nonroot local owner so container secret access has a known UID/GID.')
  let directory=workspace
  for(const part of ['.steelkeep','selfhost-proof']){
    directory=join(directory,part)
    try{await mkdir(directory,{mode:0o700})}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
    const info=await lstat(directory)
    if(!info.isDirectory()||info.isSymbolicLink()||await realpath(directory)!==directory||info.uid!==uid||(info.mode&0o077)!==0)throw new Error('Proof directories must already be owner-only real directories; unsafe paths were not changed.')
  }
  async function preserve(name:string,content:Buffer|string,valid:(value:Buffer)=>boolean){
    const path=join(directory,name)
    try{await writeFile(path,content,{flag:'wx',mode:0o600})}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
    const info=await lstat(path)
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==uid||(info.mode&0o777)!==0o600||info.size>4096)throw new Error('Existing proof files must be regular, unique, owner-owned mode-0600 files. Nothing was overwritten.')
    if(!valid(await readFile(path)))throw new Error('Existing proof material is invalid or differs from this fixed configuration. Inspect it privately; keys/passwords were not replaced.')
  }
  await preserve('key',randomBytes(32),value=>value.length===32)
  for(const name of ['token','metadata-password'])await preserve(name,randomBytes(32).toString('hex'),value=>/^[a-f0-9]{64}$/.test(value.toString('utf8')))
  const environment=[
    'STEELKEEP_ALLOWED_HOSTS=fixture,mysql-fixture,s3',
    'STEELKEEP_ALLOWED_ORIGINS=http://127.0.0.1:4312,http://localhost:4312',
    'STEELKEEP_PUBLIC_HOSTS=localhost,127.0.0.1',
    'STEELKEEP_SECURE_COOKIE=false',
    `STEELKEEP_UID=${uid}`,`STEELKEEP_GID=${gid}`,''
  ].join('\n')
  await preserve('compose.env',environment,value=>value.toString('utf8')===environment)
  console.log('Packaged proof files are ready in .steelkeep/selfhost-proof with existing material preserved. No development secrets were read or copied. No service or image was started.')
}
try{await main()}catch(error){
  // Errors generated above are safe; arbitrary filesystem errors are not printed.
  const message=error instanceof Error&&/^(Set STEELKEEP_|Run preparation|Prepare proof|Proof directories|Existing proof)/.test(error.message)?error.message:'Proof preparation failed; inspect local filesystem access privately. Existing files were not replaced.'
  console.error(message);process.exitCode=1
}
