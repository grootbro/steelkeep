// Disposable MongoDB 8.0 standalone fixture. Never run against a user database.
// No collection, user, role or partial restore is dropped by this initializer.
const admin=db.getSiblingDB('admin')
const source=db.getSiblingDB('source_mongo')
const target=db.getSiblingDB('restore_mongo')
const reads=['find','listCollections','listIndexes','collStats','dbStats','killCursors']
const restores=[...reads,'insert','createCollection','createIndex','validate']

if(!admin.getRole('steelkeep_source_mongo'))admin.createRole({role:'steelkeep_source_mongo',privileges:[
  {resource:{db:'source_mongo',collection:''},actions:reads},
  {resource:{cluster:true},actions:['fsync','unlock','inprog']}
],roles:[]})
if(!admin.getUser('backup_reader'))admin.createUser({user:'backup_reader',pwd:'local-mongo-reader-only',mechanisms:['SCRAM-SHA-256'],roles:[{role:'steelkeep_source_mongo',db:'admin'}]})
if(!admin.getRole('steelkeep_target_mongo'))admin.createRole({role:'steelkeep_target_mongo',privileges:[{resource:{db:'restore_mongo',collection:''},actions:restores}],roles:[]})
if(!admin.getUser('restore_writer'))admin.createUser({user:'restore_writer',pwd:'local-mongo-writer-only',mechanisms:['SCRAM-SHA-256'],roles:[{role:'steelkeep_target_mongo',db:'admin'}]})

if(!source.getCollectionNames().includes('projects'))source.createCollection('projects')
if(!source.getCollectionNames().includes('entries'))source.createCollection('entries',{
  validator:{$jsonSchema:{bsonType:'object',required:['projectId','amount'],properties:{amount:{bsonType:'decimal'}}}},validationLevel:'strict'
})
const projectId=ObjectId('650000000000000000000001')
if(!source.projects.findOne({_id:projectId}))source.projects.insertOne({_id:projectId,fixture:'steelkeep-extra',name:'Synthetic BSON recovery fixture'})
const documents=[
  {_id:ObjectId('650000000000000000000011'),projectId,amount:NumberDecimal('1.25'),counter:NumberLong('9007199254740993'),binary:BinData(0,'AP9BQn8='),createdAt:ISODate('2026-01-02T03:04:05.000Z'),nested:{enabled:true,nullable:null,tags:['one','два']},stamp:Timestamp({t:1700000000,i:7})},
  {_id:ObjectId('650000000000000000000012'),projectId,amount:NumberDecimal('2.50'),counter:NumberLong('-9007199254740993'),binary:BinData(0,'AQIDBA=='),createdAt:ISODate('2026-02-03T04:05:06.000Z'),nested:{enabled:false,nullable:null,tags:[]},stamp:Timestamp({t:1700000001,i:2})}
]
for(const document of documents)if(!source.entries.findOne({_id:document._id}))source.entries.insertOne(document)
source.projects.createIndex({fixture:1},{unique:true,name:'fixture_unique'})
source.entries.createIndex({projectId:1,createdAt:-1},{name:'project_created'})

// MongoDB cannot persist a truly collection-free DB. The operator-created empty
// marker is the precreation proof; the product must retain it and never drop it.
if(!target.getCollectionNames().includes('__steelkeep_empty_target'))target.createCollection('__steelkeep_empty_target')
