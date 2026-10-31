import {mkdir,writeFile,realpath,access} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import {createConnection} from 'node:net'
import {join} from 'node:path'
import pg from 'pg'

const workspace='/Users/dobrota/dev/steelkeep',root=join(workspace,'.steelkeep/ui-proof')
if(await realpath(process.cwd())!==workspace||process.env.DOCKER_HOST||process.env.DOCKER_CONTEXT)throw new Error('Use the fixed local Steelkeep checkout and default local Docker context.')
for(const port of [4321,4322]){
 const listening=await new Promise<boolean>(resolve=>{const socket=createConnection({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',()=>{socket.destroy();resolve(false)});socket.setTimeout(1000,()=>{socket.destroy();resolve(true)})})
 if(listening)throw new Error('A dedicated proof port is occupied. Inspect its existing process; it will not be replaced.')
}
let exists=false
try{await access(root);exists=true}catch{}
if(exists)throw new Error('The dedicated private proof directory already exists. Inspect its evidence before reusing or cleaning it.')
const admin=new pg.Client({connectionString:'postgres://steelkeep:local-metadata-only@127.0.0.1:54371/steelkeep',connectionTimeoutMillis:5000,statement_timeout:10000})
try{
 await admin.connect()
 const {rows}=await admin.query("SELECT current_user AS actor,current_setting('server_version_num')::int AS version,EXISTS(SELECT 1 FROM pg_database WHERE datname='steelkeep_ui_proof') AS exists")
 if(rows[0]?.actor!=='steelkeep'||Math.floor(rows[0].version/10000)!==17||rows[0].exists)throw new Error('Require the known PostgreSQL 17 fixture and an absent dedicated proof database.')
 await mkdir(root,{mode:0o700})
 await writeFile(join(root,'key'),randomBytes(32),{mode:0o600,flag:'wx'})
 await writeFile(join(root,'token'),randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'})
 await admin.query('CREATE DATABASE steelkeep_ui_proof OWNER steelkeep')
}catch(error){if(error instanceof Error&&error.message.startsWith('Require '))throw error;throw new Error('Dedicated proof preparation failed. Inspect retained resources; no existing database or key was replaced.')}
finally{await admin.end()}
const child=Bun.spawn([process.execPath,'server/migrate.ts'],{cwd:workspace,env:{...process.env,DATABASE_URL:'postgres://steelkeep:local-metadata-only@127.0.0.1:54371/steelkeep_ui_proof',STEELKEEP_DATABASE_PASSWORD_FILE:'',STEELKEEP_KEY_FILE:join(root,'key'),STEELKEEP_TOKEN_FILE:join(root,'token')},stdout:'ignore',stderr:'ignore'})
const timer=setTimeout(()=>child.kill(),120000)
try{if(await child.exited!==0)throw new Error('Dedicated proof migration failed; its database and private files are retained for inspection.')}
finally{clearTimeout(timer)}
console.log('Dedicated UI proof metadata and private keys prepared. No main owner, data, image or running service was changed.')
