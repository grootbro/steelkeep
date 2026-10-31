import {test,expect,type Page,type Locator,type Response} from '@playwright/test'
import {randomBytes,createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {resolve,dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import pg from 'pg'
import mysql,{type RowDataPacket,type Connection as MariaConnection,type ResultSetHeader} from 'mysql2/promise'
import {S3Client,CreateBucketCommand,GetObjectCommand} from '@aws-sdk/client-s3'

const metadataUrl='postgres://steelkeep:local-metadata-only@127.0.0.1:54371/steelkeep'
const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'../..')
type Engine='postgres'|'mariadb'
type Fixture={engine:Engine;suffix:string;sourceDatabase:string;targetDatabase:string;reader:string;writer:string;readerPassword:string;writerPassword:string;sourceName:string;targetName:string;storageName:string;planName:string;bucket:string;prefix:string}
type Artifact={id:string;source_id:string;storage_id:string;run_id:string;object_key:string;size:string;sha256:string;engine:string;checked_at:Date|null}

function optIn(){
  if(process.env.STEELKEEP_ACCEPTANCE!=='synthetic-local-ui'||process.env.DATABASE_URL!==metadataUrl||process.env.STEELKEEP_DATABASE_PASSWORD_FILE)throw new Error('Refusing mutations outside the exact synthetic UI fixture metadata configuration.')
}
async function metadata(sql:string,values:unknown[]=[]){
  optIn()
  const db=new pg.Client({connectionString:metadataUrl,connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000,options:'-c default_transaction_read_only=on'})
  db.on('error',()=>{})
  try{await db.connect();return (await db.query(sql,values)).rows as Array<Record<string,unknown>>}
  catch{throw new Error('The fixed local fixture metadata inspection failed; no metadata URL or credential is included in this error.')}
  finally{await db.end().catch(()=>{})}
}
async function guardMetadata(){
  optIn()
  const [identity]=await metadata("SELECT current_database() AS name,current_user AS actor,current_setting('server_version_num')::int AS version,to_regclass('public.connections')::text AS connections,to_regclass('public.runs')::text AS runs")
  if(identity?.name!=='steelkeep'||identity.actor!=='steelkeep'||Math.floor(Number(identity.version)/10000)!==17||!identity.connections||!identity.runs)throw new Error('The expected migrated PostgreSQL 17 synthetic metadata database was not established.')
  const [owner]=await metadata('SELECT count(*)::int AS count FROM owner_account')
  if(Number(owner?.count)!==1)throw new Error('Complete the first owner account setup yourself in the local UI before operational recovery acceptance. This suite never creates an owner or requests your account password; no fixture, storage or recovery mutation was started.')
  const hosts=new Set(['fixture','mysql-fixture','mysql8-fixture','mongodb-fixture','redis-fixture','clickhouse-fixture','mssql-fixture'])
  for(const row of await metadata('SELECT kind,config FROM connections')){
    const c=row.config as Record<string,unknown>
    if(row.kind==='s3'){
      if(c.endpoint!=='http://s3:9000')throw new Error('UI recovery requires dedicated fixture metadata without non-fixture storage profiles.')
    }else if(row.kind==='sqlite'){
      if(typeof c.path!=='string'||!c.path.startsWith('/var/lib/steelkeep-fixtures/sqlite/'))throw new Error('UI recovery requires dedicated fixture metadata without non-fixture local database paths.')
    }else if(!hosts.has(String(c.host)))throw new Error('UI recovery requires dedicated fixture metadata without non-fixture database hosts.')
  }
}
function definition(engine:Engine):Fixture{
  const suffix=randomBytes(6).toString('hex'),label=engine==='postgres'?'PG17':'Maria11'
  return {engine,suffix,sourceDatabase:`ui_${engine}_src_${suffix}`,targetDatabase:`ui_${engine}_dst_${suffix}`,reader:`ui_reader_${suffix}`,writer:`ui_writer_${suffix}`,readerPassword:randomBytes(24).toString('hex'),writerPassword:randomBytes(24).toString('hex'),sourceName:`UI ${label} source ${suffix}`,targetName:`UI ${label} recovery ${suffix}`,storageName:`UI ${label} storage ${suffix}`,planName:`UI ${label} plan ${suffix}`,bucket:`steelkeep-ui-${engine}-${suffix}`,prefix:`ui/${engine}/${suffix}`}
}
async function pgConnection(database:string,user:string,password:string){
  const db=new pg.Client({host:'127.0.0.1',port:54372,database,user,password,connectionTimeoutMillis:5000,statement_timeout:15000,query_timeout:17000})
  db.on('error',()=>{})
  try{await db.connect();return db}catch{await db.end().catch(()=>{});throw new Error('Cannot connect to the dedicated PostgreSQL fixture; credentials are omitted.')}
}
async function mariaConnection(database:string,user:string,password:string){
  try{return await mysql.createConnection({host:'127.0.0.1',port:54375,database,user,password,connectTimeout:5000,charset:'utf8mb4',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true,multipleStatements:false})}
  catch{throw new Error('Cannot connect to the dedicated MariaDB fixture; credentials are omitted.')}
}
async function provision(f:Fixture){
  await guardMetadata() // Before CREATE ROLE/DB, CREATE USER, S3 or UI mutation.
  if(f.engine==='postgres'){
    const admin=await pgConnection('source','fixture_admin','local-fixture-only')
    let source:pg.Client|undefined
    try{
      const version=await admin.query("SELECT current_setting('server_version_num')::int AS version")
      if(Math.floor(Number(version.rows[0].version)/10000)!==17)throw new Error()
      await admin.query(`CREATE ROLE ${f.reader} LOGIN PASSWORD '${f.readerPassword}'`)
      await admin.query(`CREATE ROLE ${f.writer} LOGIN PASSWORD '${f.writerPassword}'`)
      await admin.query(`CREATE DATABASE ${f.sourceDatabase} OWNER fixture_admin`)
      await admin.query(`CREATE DATABASE ${f.targetDatabase} OWNER ${f.writer}`)
      source=await pgConnection(f.sourceDatabase,'fixture_admin','local-fixture-only')
      await source.query(`
        CREATE TABLE projects(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,name text NOT NULL UNIQUE);
        CREATE TABLE entries(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,project_id integer NOT NULL REFERENCES projects(id),body text NOT NULL,legacy_removed text,amount numeric(12,2) NOT NULL CHECK(amount>=0),binary_value bytea NOT NULL);
        ALTER TABLE entries DROP COLUMN legacy_removed;
        CREATE INDEX entries_project ON entries(project_id);
        INSERT INTO projects(name) VALUES('Synthetic UI recovery fixture');
        INSERT INTO entries(project_id,body,amount,binary_value)
          SELECT 1,CASE WHEN n=1 THEN 'Русский текст, café, 🚀' ELSE 'Synthetic UI record '||n END,n*1.25,decode('00ff007f','hex')||decode(lpad(to_hex(n),8,'0'),'hex') FROM generate_series(1,1000) n;
        GRANT CONNECT ON DATABASE ${f.sourceDatabase} TO ${f.reader};
        GRANT USAGE ON SCHEMA public TO ${f.reader};
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${f.reader};
        GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${f.reader};
      `)
    }catch{throw new Error('PostgreSQL synthetic UI fixture preparation failed. Resources are retained; generated credentials are omitted.')}
    finally{await source?.end().catch(()=>{});await admin.end().catch(()=>{})}
  }else{
    const admin=await mariaConnection('mysql','root','local-mariadb-fixture-only')
    try{
      const [version]=await admin.query<RowDataPacket[]>('SELECT VERSION() AS version')
      if(!/^11\./.test(String(version[0].version))||!/mariadb/i.test(String(version[0].version)))throw new Error()
      await admin.query(`CREATE DATABASE \`${f.sourceDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
      await admin.query(`CREATE DATABASE \`${f.targetDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
      await admin.query(`CREATE USER '${f.reader}'@'%' IDENTIFIED BY '${f.readerPassword}'`)
      await admin.query(`CREATE USER '${f.writer}'@'%' IDENTIFIED BY '${f.writerPassword}'`)
      await admin.query(`GRANT SELECT,SHOW VIEW,TRIGGER,EVENT,EXECUTE ON \`${f.sourceDatabase.replace(/[%_]/g,'\\$&')}\`.* TO '${f.reader}'@'%'`)
      await admin.query(`GRANT RELOAD ON *.* TO '${f.reader}'@'%'`)
      await admin.query(`GRANT SELECT,INSERT,CREATE,ALTER,INDEX,REFERENCES,SHOW VIEW,TRIGGER,EVENT,EXECUTE,LOCK TABLES ON \`${f.targetDatabase.replace(/[%_]/g,'\\$&')}\`.* TO '${f.writer}'@'%'`)
      await admin.query(`USE \`${f.sourceDatabase}\``)
      await admin.query(`CREATE TABLE \`${f.sourceDatabase}\`.projects(id BIGINT PRIMARY KEY AUTO_INCREMENT,name VARCHAR(190) NOT NULL UNIQUE) ENGINE=InnoDB`)
      await admin.query(`CREATE TABLE \`${f.sourceDatabase}\`.entries(id BIGINT PRIMARY KEY AUTO_INCREMENT,project_id BIGINT NOT NULL,body VARCHAR(200) NOT NULL,amount DECIMAL(12,2) NOT NULL,binary_value VARBINARY(64) NOT NULL,CONSTRAINT entries_project_fk FOREIGN KEY(project_id) REFERENCES projects(id),CONSTRAINT entries_amount_check CHECK(amount>=0),INDEX entries_project(project_id)) ENGINE=InnoDB`)
      await admin.query(`INSERT INTO \`${f.sourceDatabase}\`.projects(name) VALUES(?)`,['Synthetic UI recovery fixture'])
      await admin.query(`ALTER TABLE \`${f.sourceDatabase}\`.projects AUTO_INCREMENT=41`)
      for(const [body,amount,binary] of [['Synthetic row one','1.25','00FF007F'],['Русский текст, café, 🚀','2.50','FF008001'],['Synthetic row three','3.75','000102FF']] as const)await admin.query(`INSERT INTO \`${f.sourceDatabase}\`.entries(project_id,body,amount,binary_value) VALUES(1,?,?,UNHEX(?))`,[body,amount,binary])
    }catch{throw new Error('MariaDB synthetic UI fixture preparation failed. Resources are retained; generated credentials are omitted.')}
    finally{await admin.end().catch(()=>{})}
  }
}
function storage(){return new S3Client({endpoint:'http://127.0.0.1:54373',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'steelkeep-local',secretAccessKey:'local-s3-fixture-only'}})}
async function secretInput(locator:Locator,key:string){
  // Secret is returned by a private in-memory binding, never a fill(value) API
  // parameter that Playwright can include in an action failure call log.
  await locator.evaluate(async(node,key)=>{
    if(!(node instanceof HTMLInputElement))throw new Error('Expected a credential input.')
    const provide=(window as unknown as {__steelkeepUiFixtureSecret:(key:string)=>Promise<string>}).__steelkeepUiFixtureSecret
    const value=await provide(key),setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set
    if(!setter)throw new Error('The native input value setter is unavailable.')
    setter.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}))
  },key)
}
async function response(page:Page,path:string,action:()=>Promise<unknown>):Promise<Response>{
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='POST')
  try{
    await action();const result=await pending
    if(!result.ok())throw new Error('A real UI command was refused by the API; inspect the visible safe error. Request credentials are omitted.')
    return result
  }catch(error){void pending.catch(()=>{});throw error}
}
async function navigate(page:Page,label:string){await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:label,exact:true}).click();await expect(page.getByRole('heading',{name:label,exact:true,level:1})).toBeVisible()}
async function createDatabaseConnection(page:Page,f:Fixture,target:boolean){
  await navigate(page,'Connections');await page.locator('.page-header').getByRole('button',{name:'Add connection',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'Add connection',exact:true})
  await dialog.getByRole('combobox',{name:'Connection type',exact:true}).selectOption(f.engine)
  const name=target?f.targetName:f.sourceName
  await dialog.getByLabel('Name',{exact:true}).fill(name)
  await dialog.getByLabel('Host',{exact:true}).fill(f.engine==='postgres'?'fixture':'mysql-fixture')
  await dialog.getByLabel('Port',{exact:true}).fill(f.engine==='postgres'?'5432':'3306')
  await dialog.getByLabel('Database',{exact:true}).fill(target?f.targetDatabase:f.sourceDatabase)
  await dialog.getByLabel('Username',{exact:true}).fill(target?f.writer:f.reader)
  await secretInput(dialog.getByLabel('Password',{exact:true}),target?'target-password':'source-password')
  await dialog.getByRole('checkbox',{name:'Verify TLS certificate',exact:true}).uncheck()
  if(target)await dialog.getByRole('checkbox',{name:'Use only as a restore destination',exact:true}).check()
  if(f.engine==='mariadb'&&!target)await dialog.getByRole('checkbox',{name:'Allow this backup to temporarily block writes across the source server.',exact:true}).check()
  const saved=await response(page,'/api/v1/connections',()=>dialog.getByRole('button',{name:'Save connection',exact:true}).click()),value=await saved.json() as {id:string}
  await expect(dialog).not.toBeVisible()
  const [persisted]=await metadata('SELECT name,kind,config FROM connections WHERE id=$1',[value.id])
  if(persisted?.name!==name||persisted.kind!==f.engine||(persisted.config as Record<string,unknown>).database!==(target?f.targetDatabase:f.sourceDatabase))throw new Error('The UI/API is not writing to the guarded local metadata database.')
  const row=page.getByRole('row').filter({has:page.getByText(name,{exact:true})})
  const checked=await response(page,`/api/v1/connections/${value.id}/test`,()=>row.getByRole('button',{name:'Test connection',exact:true}).click())
  if((await checked.json() as {status:string}).status!=='available')throw new Error('The real database UI connection test failed.')
  await expect(row.locator('.badge').filter({hasText:'available'})).toBeVisible()
  return value.id
}
async function createStorageConnection(page:Page,f:Fixture){
  await navigate(page,'Connections');await page.locator('.page-header').getByRole('button',{name:'Add connection',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'Add connection',exact:true})
  await dialog.getByRole('combobox',{name:'Connection type',exact:true}).selectOption('s3')
  for(const [label,value] of [['Name',f.storageName],['Endpoint','http://s3:9000'],['Bucket',f.bucket],['Region','us-east-1'],['Object prefix',f.prefix]])await dialog.getByLabel(label,{exact:true}).fill(value)
  await secretInput(dialog.getByLabel('Access key',{exact:true}),'s3-access')
  await secretInput(dialog.getByLabel('Secret key',{exact:true}),'s3-secret')
  const saved=await response(page,'/api/v1/connections',()=>dialog.getByRole('button',{name:'Save connection',exact:true}).click()),value=await saved.json() as {id:string}
  await expect(dialog).not.toBeVisible()
  const row=page.getByRole('row').filter({has:page.getByText(f.storageName,{exact:true})})
  const checked=await response(page,`/api/v1/connections/${value.id}/test`,()=>row.getByRole('button',{name:'Test connection',exact:true}).click())
  if((await checked.json() as {status:string}).status!=='available')throw new Error('The real S3 UI connection test failed.')
  return value.id
}
async function waitForJob(page:Page,id:string,operation:'backup'|'restore'){
  const dialog=page.getByRole('dialog',{name:'Job details',exact:true})
  await expect(dialog).toBeVisible();await expect(dialog.locator('.detail-header .mono')).toHaveText(id)
  await expect(dialog.locator('.job-metadata dt').filter({hasText:/^Operation$/}).locator('xpath=following-sibling::dd[1]')).toHaveText(operation)
  const status=dialog.locator('.detail-header .badge')
  await expect.poll(async()=>String(await status.textContent()).trim(),{timeout:120000,intervals:[250,500,1000,2000]}).toMatch(/^(succeeded|failed|cancelled|interrupted)$/)
  if((await status.textContent())?.trim()!=='succeeded')throw new Error('The actual UI job did not succeed. No source, object or target was reset.')
  await expect(dialog.locator('.job-metadata dt').filter({hasText:/^Phase$/}).locator('xpath=following-sibling::dd[1]')).toHaveText('completed')
  const phases=(await dialog.locator('.job-log .log-phase').allTextContents()).map(value=>value.trim())
  expect(phases).toEqual(expect.arrayContaining(operation==='backup'?['queued','preflight','dumping','uploading','publishing','completed']:['queued','preflight','downloading','verifying','restoring','validating-data','completed']))
  if(operation==='restore'){
    const validation=dialog.locator('.validation-result')
    await expect(validation.getByRole('heading',{name:'Restore validation Passed'})).toBeVisible()
    for(const label of ['Archive SHA-256','Schema','Data','Sequences and identities'])await expect(validation.locator('dt').filter({hasText:new RegExp('^'+label+'$')}).locator('xpath=following-sibling::dd[1]')).toHaveText('Verified')
  }else await expect(dialog.locator('.validation-result')).toHaveCount(0)
  return dialog
}

test.beforeAll(async()=>{await guardMetadata()})
test.afterEach(async({page},info)=>{
  // Neither Playwright's automatic screenshot recorder nor auth DOM snapshots
  // are enabled. Clear credentials, then attach only a masked failure PNG.
  await page.locator('input[type=password],input[name=token],input[name=accessKey],textarea').evaluateAll(nodes=>{for(const node of nodes)if(node instanceof HTMLInputElement||node instanceof HTMLTextAreaElement)node.value=''}).catch(()=>{})
  if(info.status!==info.expectedStatus&&!page.isClosed()){
    try{const path=info.outputPath('failure-masked.png');await page.screenshot({path,fullPage:true,mask:[page.locator('input,textarea')],maskColor:'#1a1f2a',timeout:5000});await info.attach('Masked UI failure',{path,contentType:'image/png'})}catch{}
  }
})

for(const engine of ['postgres','mariadb'] as const)test(`${engine}: real UI backup and reviewed restore with independent data evidence`,async({page})=>{
  const f=definition(engine)
  await provision(f)
  const s3=storage(),secrets=new Map<string,string>([['installation-token',(await readFile(join(workspace,'.steelkeep','token'),'utf8')).trim()],['source-password',f.readerPassword],['target-password',f.writerPassword],['s3-access','steelkeep-local'],['s3-secret','local-s3-fixture-only']])
  let sourcePG:pg.Client|undefined,targetPG:pg.Client|undefined,sourceMaria:MariaConnection|undefined,targetMaria:MariaConnection|undefined
  try{
    if((secrets.get('installation-token')?.length??0)<32)throw new Error('The installation token is missing or invalid.')
    await s3.send(new CreateBucketCommand({Bucket:f.bucket}),{abortSignal:AbortSignal.timeout(15000)})
    await page.exposeBinding('__steelkeepUiFixtureSecret',({frame},key:string)=>{
      if(frame!==page.mainFrame()||new URL(frame.url()).origin!=='http://127.0.0.1:4310'||!secrets.has(key))throw new Error('Credential binding denied outside the fixed local main frame.')
      return secrets.get(key)!
    })
    await page.goto('/')
    // No owner password is needed for operational recovery acceptance. The
    // installation exchange issues a real opaque session after owner setup.
    await response(page,'/api/v1/session',()=>page.evaluate(async()=>{
      const provide=(window as unknown as {__steelkeepUiFixtureSecret:(key:string)=>Promise<string>}).__steelkeepUiFixtureSecret
      const credential=await provide('installation-token')
      const result=await fetch('/api/v1/session',{method:'POST',credentials:'same-origin',headers:{Authorization:'Bearer '+credential}})
      if(result.status!==204)throw new Error('The authorized installation session exchange failed; credential details omitted.')
    }))
    await page.reload()
    await expect(page.getByRole('navigation',{name:'Main navigation'})).toBeVisible()
    const sourceId=await createDatabaseConnection(page,f,false),targetId=await createDatabaseConnection(page,f,true),storageId=await createStorageConnection(page,f)
    await navigate(page,'Backup plans');await page.locator('.page-header').getByRole('button',{name:'Create plan',exact:true}).click()
    const planDialog=page.getByRole('dialog',{name:'Create backup plan',exact:true})
    await planDialog.getByLabel('Plan name',{exact:true}).fill(f.planName)
    await planDialog.getByRole('combobox',{name:'Source database',exact:true}).selectOption(sourceId)
    await planDialog.getByRole('combobox',{name:'Storage volume',exact:true}).selectOption(storageId)
    await planDialog.getByRole('checkbox',{name:'Run on a schedule',exact:true}).uncheck()
    await planDialog.getByLabel('Timezone',{exact:true}).fill('Asia/Bangkok')
    const planSaved=await response(page,'/api/v1/plans',()=>planDialog.getByRole('button',{name:'Create plan',exact:true}).click()),plan=await planSaved.json() as {id:string}
    await expect(planDialog).not.toBeVisible()
    const planCard=page.locator('section.plan').filter({has:page.getByRole('heading',{name:f.planName,exact:true})})
    await expect(planCard).toBeVisible();await expect(planCard).toContainText('Manual only')
    const start=await response(page,`/api/v1/plans/${plan.id}/run`,()=>planCard.getByRole('button',{name:'Run backup',exact:true}).click()),backup=await start.json() as {id:string}
    const backupDialog=await waitForJob(page,backup.id,'backup')
    await backupDialog.getByRole('button',{name:'Close dialog',exact:true}).click()
    const [artifactRow]=await metadata('SELECT id,source_id,storage_id,run_id,object_key,size::text,sha256,engine,checked_at FROM artifacts WHERE run_id=$1',[backup.id]),artifact=artifactRow as unknown as Artifact
    if(!artifact||artifact.source_id!==sourceId||artifact.storage_id!==storageId||artifact.engine!==engine||Number(artifact.size)<=0||Number(artifact.size)>16*1024*1024)throw new Error('The actual guarded metadata did not publish this fixture backup.')
    await navigate(page,'Snapshots')
    const snapshot=page.getByRole('row').filter({has:page.getByText(f.sourceName,{exact:true})})
    await expect(snapshot).toBeVisible();await expect(snapshot.getByText('Not restored',{exact:true})).toBeVisible();await expect(snapshot.getByText('Recorded at upload',{exact:true})).toBeVisible()
    const checked=await response(page,`/api/v1/backups/${artifact.id}/check`,()=>snapshot.getByRole('button',{name:'Check availability',exact:true}).click())
    const observation=await checked.json() as {verification:string;availability:string;checkedAt:string;stale:boolean;message:string}
    expect(observation.verification).toBe('object-head-only');expect(observation.availability).toBe('present');expect(observation.stale).toBe(false)
    expect(observation.message.includes('Full object bytes have not been verified.')).toBe(true)
    await expect(snapshot.locator('.availability-note')).toContainText('Full object bytes have not been verified.')
    const cachedDate=await page.evaluate(value=>new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}),observation.checkedAt)
    await expect(snapshot).toContainText('Checked '+cachedDate)
    await expect(snapshot.getByText('Not restored',{exact:true})).toBeVisible()
    const [recorded]=await metadata('SELECT checked_at FROM artifacts WHERE id=$1',[artifact.id])
    expect(new Date(recorded.checked_at as Date).getTime()).toBe(Date.parse(observation.checkedAt))
    const [noRestore]=await metadata("SELECT count(*)::int AS count FROM runs WHERE artifact_id=$1 AND type='restore'",[artifact.id])
    expect(noRestore.count).toBe(0)
    // Independent full object bytes: a green availability HEAD is insufficient.
    const object=await s3.send(new GetObjectCommand({Bucket:f.bucket,Key:artifact.object_key}),{abortSignal:AbortSignal.timeout(15000)})
    if(!object.Body||object.ContentLength!==Number(artifact.size))throw new Error('The real S3 object differs from its published size.')
    const archive=await object.Body.transformToByteArray()
    expect(createHash('sha256').update(archive).digest('hex')).toBe(artifact.sha256)
    if(engine==='postgres')expect(Buffer.from(archive.subarray(0,5)).toString()).toBe('PGDMP')
    else expect(new TextDecoder().decode(archive).includes('MariaDB dump')).toBe(true)
    await snapshot.getByRole('button',{name:'Restore',exact:true}).click()
    const restoreDialog=page.getByRole('dialog',{name:'Restore snapshot',exact:true})
    await restoreDialog.getByRole('combobox',{name:'Restore destination',exact:true}).selectOption(targetId)
    await response(page,'/api/v1/restores/prepare',()=>restoreDialog.getByRole('button',{name:'Check destination',exact:true}).click())
    await expect(restoreDialog.getByRole('heading',{name:'Review restore',exact:true})).toBeVisible()
    await expect(restoreDialog.locator('dt').filter({hasText:/^Source database$/}).locator('xpath=following-sibling::dd[1]')).toHaveText(f.sourceDatabase)
    await expect(restoreDialog.locator('dt').filter({hasText:/^Target database$/}).locator('xpath=following-sibling::dd[1]')).toHaveText(f.targetDatabase)
    await expect(restoreDialog.getByRole('button',{name:'Start restore',exact:true})).toBeDisabled()
    await restoreDialog.getByRole('checkbox',{name:'Restore this backup into the target database shown above.',exact:true}).check()
    const restoreStarted=await response(page,'/api/v1/restores/start',()=>restoreDialog.getByRole('button',{name:'Start restore',exact:true}).click()),restore=await restoreStarted.json() as {id:string}
    const job=await waitForJob(page,restore.id,'restore')
    if(engine==='postgres'){
      sourcePG=await pgConnection(f.sourceDatabase,f.reader,f.readerPassword);targetPG=await pgConnection(f.targetDatabase,f.writer,f.writerPassword)
      const result=await targetPG.query("SELECT count(*)::int AS count,sum(amount)::text AS total FROM entries")
      expect(result.rows[0]).toEqual({count:1000,total:'625625.00'})
      const actual=await targetPG.query("SELECT body,encode(binary_value,'hex') AS bytes FROM entries WHERE id=1")
      expect(actual.rows[0]).toEqual({body:'Русский текст, café, 🚀',bytes:'00ff007f00000001'})
      const sourceDropped=await sourcePG.query("SELECT count(*)::int AS count FROM pg_attribute WHERE attrelid='entries'::regclass AND attisdropped")
      const targetDropped=await targetPG.query("SELECT count(*)::int AS count FROM pg_attribute WHERE attrelid='entries'::regclass AND attisdropped")
      expect(sourceDropped.rows[0].count).toBe(1);expect(targetDropped.rows[0].count).toBe(0)
      expect((await targetPG.query('INSERT INTO projects(name) VALUES($1) RETURNING id',['Recovered UI fixture'])).rows[0].id).toBe(2)
      let fk='',check=''
      try{await targetPG.query('INSERT INTO entries(project_id,body,amount,binary_value) VALUES($1,$2,$3,$4)',[9999,'Invalid fixture FK','1.00',Buffer.from([1])])}catch(error){fk=String((error as {code?:unknown}).code??'')}
      try{await targetPG.query('INSERT INTO entries(project_id,body,amount,binary_value) VALUES($1,$2,$3,$4)',[1,'Invalid fixture CHECK','-1.00',Buffer.from([1])])}catch(error){check=String((error as {code?:unknown}).code??'')}
      expect(fk).toBe('23503');expect(check).toBe('23514')
      const unchanged=await sourcePG.query('SELECT count(*)::int AS count,sum(amount)::text AS total FROM entries')
      expect(unchanged.rows[0]).toEqual({count:1000,total:'625625.00'})
      expect((await sourcePG.query('SELECT last_value::int AS value FROM projects_id_seq')).rows[0].value).toBe(1)
    }else{
      sourceMaria=await mariaConnection(f.sourceDatabase,f.reader,f.readerPassword);targetMaria=await mariaConnection(f.targetDatabase,f.writer,f.writerPassword)
      const [actual]=await targetMaria.query<RowDataPacket[]>('SELECT count(*) AS count,CAST(sum(amount) AS CHAR) AS total FROM entries')
      expect(Number(actual[0].count)).toBe(3);expect(actual[0].total).toBe('7.50')
      const [binary]=await targetMaria.query<RowDataPacket[]>('SELECT body,HEX(binary_value) AS bytes FROM entries WHERE id=2')
      expect(binary[0].body).toBe('Русский текст, café, 🚀');expect(binary[0].bytes).toBe('FF008001')
      const [insert]=await targetMaria.execute<ResultSetHeader>('INSERT INTO projects(name) VALUES(?)',['Recovered UI fixture'])
      expect(Number(insert.insertId)).toBe(41)
      let fk=0,check=0
      try{await targetMaria.execute('INSERT INTO entries(project_id,body,amount,binary_value) VALUES(?,?,?,?)',[9999,'Invalid fixture FK','1.00',Buffer.from([1])])}catch(error){fk=Number((error as {errno?:unknown}).errno)}
      try{await targetMaria.execute('INSERT INTO entries(project_id,body,amount,binary_value) VALUES(?,?,?,?)',[1,'Invalid fixture CHECK','-1.00',Buffer.from([1])])}catch(error){check=Number((error as {errno?:unknown}).errno)}
      expect(fk).toBe(1452);expect(check).toBe(4025)
      const [unchanged]=await sourceMaria.query<RowDataPacket[]>('SELECT count(*) AS count,CAST(sum(amount) AS CHAR) AS total FROM entries')
      expect(Number(unchanged[0].count)).toBe(3);expect(unchanged[0].total).toBe('7.50')
      const [counter]=await sourceMaria.query<RowDataPacket[]>("SELECT AUTO_INCREMENT AS next_value FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='projects'")
      expect(Number(counter[0].next_value)).toBe(41)
    }
    await job.getByRole('button',{name:'Close dialog',exact:true}).click();await navigate(page,'Snapshots')
    const restoredSnapshot=page.getByRole('row').filter({has:page.getByText(f.sourceName,{exact:true})})
    await expect(restoredSnapshot).toContainText('Validation: passed')
  }finally{
    secrets.clear();s3.destroy();await sourcePG?.end().catch(()=>{});await targetPG?.end().catch(()=>{});await sourceMaria?.end().catch(()=>{});await targetMaria?.end().catch(()=>{})
  }
  // Keep source/target databases, users, object bucket and recovery history.
})
