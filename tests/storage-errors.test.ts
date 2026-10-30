import {test,expect} from 'bun:test'
import {storageBackupFailure} from '../server/storage-errors'
import {AppError,safeFailure} from '../server/security'

test('permanent S3 refusals have distinct safe errors and never request a retry',()=>{
  const cases:Array<[unknown,string]>=[
    [{name:'NoSuchBucket',$metadata:{httpStatusCode:404}},'STORAGE_BUCKET_MISSING'],
    [{$metadata:{httpStatusCode:401}},'STORAGE_ACCESS_DENIED'],
    [{name:'AccessDenied',$metadata:{httpStatusCode:403}},'STORAGE_ACCESS_DENIED'],
    [{code:'SignatureDoesNotMatch'},'STORAGE_ACCESS_DENIED'],
    [{name:'InvalidRequest',$metadata:{httpStatusCode:400}},'STORAGE_INVALID_REQUEST'],
    [{name:'PreconditionFailed',$metadata:{httpStatusCode:412}},'STORAGE_OBJECT_CONFLICT'],
    [{name:'NoSuchKey',$metadata:{httpStatusCode:404}},'STORAGE_OBJECT_MISSING'],
    [{$metadata:{httpStatusCode:422},cause:{code:'ECONNRESET'}},'STORAGE_INVALID_REQUEST']
  ]
  for(const [input,code] of cases){expect(storageBackupFailure(input).code).toBe(code);expect(code).not.toBe('STORAGE_UNAVAILABLE')}
})

test('recognized transient service and transport failures allow bounded backup retries',()=>{
  for(const input of [{$metadata:{httpStatusCode:429}},{$metadata:{httpStatusCode:500}},{$metadata:{httpStatusCode:503}},{name:'SlowDown'},{name:'TimeoutError'},{code:'ECONNRESET'},{cause:{cause:{code:'ETIMEDOUT'}}}])expect(storageBackupFailure(input).code).toBe('STORAGE_UNAVAILABLE')
})

test('unknown errors and malformed metadata fail closed without exposing SDK content',()=>{
  const secret='password=request-header-secret; bucket=private-internal-name'
  const cycle:{cause?:unknown;message:string}={message:secret};cycle.cause=cycle
  for(const input of [new Error(secret),{message:secret},{$metadata:{httpStatusCode:'503'},message:secret},{$metadata:{httpStatusCode:500.5}},cycle,{cause:{cause:{cause:{cause:{code:'ECONNRESET'}}}}}]){
    const output=storageBackupFailure(input)
    expect(output.code).toBe('STORAGE_FAILED')
    expect(JSON.stringify(safeFailure(output))).not.toContain(secret)
    expect(output.cause).toBeUndefined()
  }
  const refused=storageBackupFailure({name:'NoSuchBucket',message:secret,request:{headers:{authorization:secret}}})
  expect(JSON.stringify(safeFailure(refused))).not.toContain(secret)
})

test('parent cancellation and trusted checkpoint failures survive storage handling',()=>{
  const checkpoint=new AppError('RUN_OWNERSHIP_LOST','The execution lease was lost.')
  expect(storageBackupFailure(checkpoint)).toBe(checkpoint)
  const abort=new AbortController();abort.abort(checkpoint)
  expect(storageBackupFailure({name:'NoSuchBucket'},abort.signal)).toBe(checkpoint)
  const cancelled=new AbortController();cancelled.abort()
  expect(storageBackupFailure({code:'ECONNRESET'},cancelled.signal).code).toBe('CANCELLED')
  expect(storageBackupFailure(new AppError('ARTIFACT_SIZE_MISMATCH','Object metadata mismatch.')).code).toBe('ARTIFACT_SIZE_MISMATCH')
})
