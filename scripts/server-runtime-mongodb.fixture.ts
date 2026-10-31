import {MongoClient,BSON} from 'mongodb'
import {readFile,lstat} from 'node:fs/promises'
import assert from 'node:assert/strict'

assert.equal(process.platform,'linux')
assert.equal(process.env.STEELKEEP_ACCEPTANCE,'synthetic-server-mongodb-native')
const path='/run/steelkeep/mongodb-proof-config',info=await lstat(path)
assert.ok(info.isFile()&&(info.mode&0o777)===0o600&&info.uid===process.getuid?.())
const cfg=JSON.parse(await readFile(path,'utf8')) as Record<string,string>
assert.match(cfg.nonce,/^[a-f0-9]{64}$/)
assert.equal(cfg.sourceDatabase,'source_native_mongo');assert.equal(cfg.targetDatabase,'restore_native_mongo')
const local=new MongoClient('mongodb://127.0.0.1:27017/admin?directConnection=true',{serverSelectionTimeoutMS:5000})
await local.connect()
// Only the new isolated server's localhost exception may establish its first administrator.
try{await local.db('admin').command({createUser:cfg.adminUser,pwd:cfg.adminPassword,mechanisms:['SCRAM-SHA-256'],roles:['root']})}finally{await local.close()}
const uri=`mongodb://${encodeURIComponent(cfg.adminUser)}:${encodeURIComponent(cfg.adminPassword)}@127.0.0.1:27017/admin?directConnection=true&authSource=admin`
const client=new MongoClient(uri,{serverSelectionTimeoutMS:5000})
try{
 await client.connect();const admin=client.db('admin'),existing=await admin.admin().listDatabases()
 assert.ok(existing.databases.every(row=>['admin','config','local'].includes(row.name)))
 await admin.collection<{_id:string;nonce:string;purpose:string}>('steelkeep_fixture_identity').insertOne({_id:'proof',nonce:cfg.nonce,purpose:'steelkeep-mongodb-native-proof'})
 const reads=['find','listCollections','listIndexes','collStats','dbStats','killCursors']
 await admin.command({createRole:'steelkeep_source_native',privileges:[{resource:{db:cfg.sourceDatabase,collection:''},actions:reads},{resource:{cluster:true},actions:['fsync','unlock','inprog']}],roles:[]})
 await admin.command({createUser:cfg.sourceUser,pwd:cfg.sourcePassword,mechanisms:['SCRAM-SHA-256'],roles:[{role:'steelkeep_source_native',db:'admin'}]})
 await admin.command({createRole:'steelkeep_target_native',privileges:[{resource:{db:cfg.targetDatabase,collection:''},actions:[...reads,'insert','createCollection','createIndex','validate']}],roles:[]})
 await admin.command({createUser:cfg.targetUser,pwd:cfg.targetPassword,mechanisms:['SCRAM-SHA-256'],roles:[{role:'steelkeep_target_native',db:'admin'}]})
 const source=client.db(cfg.sourceDatabase),target=client.db(cfg.targetDatabase)
 await source.createCollection('projects')
 await source.createCollection('entries',{validator:{$jsonSchema:{bsonType:'object',required:['projectId','amount'],properties:{amount:{bsonType:'decimal'}}}},validationLevel:'strict'})
 const projectId=new BSON.ObjectId('650000000000000000000001')
 await source.collection('projects').insertOne({_id:projectId,fixture:'steelkeep-mongodb-native-proof',name:'Synthetic BSON recovery'})
 await source.collection('entries').insertMany([
  {_id:new BSON.ObjectId('650000000000000000000011'),projectId,amount:BSON.Decimal128.fromString('1.25'),counter:BSON.Long.fromString('9007199254740993'),binary:new BSON.Binary(Buffer.from([0,255,65,66,127])),createdAt:new Date('2026-01-02T03:04:05Z'),nested:{enabled:true,nullable:null,tags:['one','два']},stamp:BSON.Timestamp.fromBits(7,1700000000)},
  {_id:new BSON.ObjectId('650000000000000000000012'),projectId,amount:BSON.Decimal128.fromString('2.50'),counter:BSON.Long.fromString('-9007199254740993'),binary:new BSON.Binary(Buffer.from([1,2,3,4])),createdAt:new Date('2026-02-03T04:05:06Z'),nested:{enabled:false,nullable:null,tags:[]},stamp:BSON.Timestamp.fromBits(2,1700000001)}
 ])
 await source.collection('projects').createIndex({fixture:1},{unique:true,name:'fixture_unique'})
 await source.collection('entries').createIndex({projectId:1,createdAt:-1},{name:'project_created'})
 await target.createCollection('__steelkeep_empty_target')
 console.info(JSON.stringify({proof:'mongodb-fixture-initialized',sourceCollections:2,sourceDocuments:3,precreatedEmptyTarget:true,credentialsPrinted:false}))
}finally{await client.close()}
