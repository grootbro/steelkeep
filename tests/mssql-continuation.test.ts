import {test,expect} from 'bun:test'
import {guardMssqlMetadata,mssqlProofResultPath,type MssqlProof} from '../scripts/seed-mssql-fixture'

test('an explicit pre-export attempt preserves the original result and cannot reseed',async()=>{
  const proof:MssqlProof={remote:true,base:'http://synthetic.invalid',sqlHost:'synthetic.invalid',sqlPort:1433,s3Endpoint:'http://synthetic.invalid',metadataUrl:'invalid-never-connected',token:'synthetic',adminPassword:'synthetic',preExportFailureId:'00000000-0000-4000-8000-000000000001',attempt:'attempt-2'}
  expect(mssqlProofResultPath(proof)).toBe('/run/steelkeep/proof-result-attempt-2.json')
  expect(mssqlProofResultPath({...proof,attempt:undefined})).toBe('/run/steelkeep/proof-result.json')
  await expect(guardMssqlMetadata(proof,'seed')).rejects.toThrow('never permits reseeding')
})
