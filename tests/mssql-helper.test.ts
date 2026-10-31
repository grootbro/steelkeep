import {test,expect} from 'bun:test'
import {parseMssqlHelperResponse} from '../server/engines/mssql'

const valid={identity:{engine:'mssql' as const,database:'fixture',serverVersion:'16.0',binding:'fixture-host:fixture'},empty:true,restricted:true,toolVersion:'DacFx 170.5.96.0',packageVersion:'170.5.96'}

test('DacFx protocol preserves only allowlisted failure stages without driver text',()=>{
  for(const stage of ['request','connection','identity','catalog','manifest','manifest_permissions','manifest_features','manifest_tables','manifest_columns','manifest_schema','manifest_data','manifest_sequences','export','import','import_policy','import_model','import_plan','import_guard','runtime']){
    try{parseMssqlHelperResponse(JSON.stringify({error:{code:'MSSQL_HELPER_FAILED',stage,message:'password=must-never-escape; SELECT private_data'}}),'fixture');throw new Error('expected refusal')}
    catch(error){expect((error as {code:string}).code).toBe('MSSQL_HELPER_'+stage.toUpperCase());expect(String(error)).not.toContain('must-never-escape');expect(String(error)).not.toContain('private_data')}
  }
})
test('DacFx protocol rejects malformed, ambiguous or unverified helper results',()=>{
  expect(parseMssqlHelperResponse(JSON.stringify(valid),'fixture')).toEqual(valid)
  for(const result of [null,[],{}, {...valid,packageVersion:'latest'}, {...valid,toolVersion:'DacFx 170.5.96.0 unexpected'}, {...valid,identity:{...valid.identity,database:'other'}}, {...valid,error:{code:'MSSQL_HELPER_FAILED',stage:'unknown'}},{...valid,error:null},{...valid,error:0}]){
    expect(()=>parseMssqlHelperResponse(JSON.stringify(result),'fixture')).toThrow()
  }
  expect(()=>parseMssqlHelperResponse('not json','fixture')).toThrow()
})
test('DacFx imports require the exact verified application-data policy',()=>{
  expect(()=>parseMssqlHelperResponse(JSON.stringify(valid),'fixture',true)).toThrow()
  for(const importPolicy of [null,'','application-schema-data-v0','user-controlled'])expect(()=>parseMssqlHelperResponse(JSON.stringify({...valid,importPolicy}),'fixture',true)).toThrow()
  expect(parseMssqlHelperResponse(JSON.stringify({...valid,importPolicy:'application-schema-data-v1'}),'fixture',true).importPolicy).toBe('application-schema-data-v1')
})
