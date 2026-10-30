import {AppError} from './security'

const failure=(code:string,message:string)=>new AppError(code,message)
const access=()=>failure('STORAGE_ACCESS_DENIED','Storage refused access. Check the configured credentials and bucket permissions.')
const bucket=()=>failure('STORAGE_BUCKET_MISSING','The configured storage bucket does not exist. Check the storage connection before starting another backup.')
const invalid=()=>failure('STORAGE_INVALID_REQUEST','Storage rejected the request. Check the storage endpoint and configuration.')
const conflict=()=>failure('STORAGE_OBJECT_CONFLICT','Storage refused the immutable object write. Existing objects have been preserved.')
const temporary=()=>failure('STORAGE_UNAVAILABLE','Storage is temporarily unavailable. A bounded retry uses a separate immutable object.')
const unknown=()=>failure('STORAGE_FAILED','Storage upload or verification failed. Check the storage connection before starting another backup.')
const networkCodes=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','ENETUNREACH','EHOSTUNREACH','EAI_AGAIN','ENOTFOUND','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET'])

// Only bounded structured fields classify errors; raw SDK diagnostics never leave this function.
export function storageBackupFailure(error:unknown,signal?:AbortSignal):AppError{
  if(signal?.aborted)return signal.reason instanceof AppError?signal.reason:failure('CANCELLED','Operation cancelled.')
  if(error instanceof AppError)return error
  const seen=new Set<object>()
  let current=error
  for(let depth=0;depth<4&&current!==null&&typeof current==='object'&&!seen.has(current);depth++){
    seen.add(current)
    const row=current as {name?:unknown;code?:unknown;$metadata?:{httpStatusCode?:unknown};cause?:unknown}
    const code=typeof row.code==='string'?row.code:typeof row.name==='string'?row.name:''
    const status=row.$metadata?.httpStatusCode
    if(status===401||status===403)return access()
    if(code==='NoSuchBucket')return bucket()
    if(status===412||status===409||code==='PreconditionFailed'||code==='ConditionalRequestConflict')return conflict()
    if(['AccessDenied','InvalidAccessKeyId','SignatureDoesNotMatch','ExpiredToken','InvalidToken','AuthorizationHeaderMalformed'].includes(code))return access()
    if(status===404||code==='NoSuchKey'||code==='NotFound')return failure('STORAGE_OBJECT_MISSING','The uploaded object could not be found during storage verification.')
    if(status===400||['InvalidRequest','InvalidArgument','InvalidBucketName','InvalidDigest','BadDigest'].includes(code))return invalid()
    if(typeof status==='number'&&Number.isInteger(status)&&status>=400&&status<500&&status!==429)return invalid()
    if(status===429||(typeof status==='number'&&Number.isInteger(status)&&status>=500&&status<=599)||['SlowDown','ServiceUnavailable','InternalError','RequestTimeout','RequestTimeoutException','TimeoutError','NetworkingError'].includes(code)||networkCodes.has(code))return temporary()
    current=row.cause
  }
  return unknown()
}
