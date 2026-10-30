export const availabilityStates=['present','missing','changed','unknown'] as const
export type Availability=typeof availabilityStates[number]
export type AvailabilityChecks={objectExists:boolean|null;sizeMatches:boolean|null;metadataSha256Matches:boolean|null}
export type AvailabilityObservation={availability:Availability;verification:'object-head-only';checks:AvailabilityChecks;reason:string;message:string}
export type HeadResponse={ContentLength?:number;Metadata?:Record<string,string>}
export type HeadProbe={head(signal:AbortSignal):Promise<HeadResponse>;destroy():void}
const unknownChecks=():AvailabilityChecks=>({objectExists:null,sizeMatches:null,metadataSha256Matches:null})
const result=(availability:Availability,checks:AvailabilityChecks,reason:string,message:string):AvailabilityObservation=>({availability,verification:'object-head-only',checks,reason,message})

/** Metadata observation only. A matching metadata digest never verifies object bytes. */
export async function probeArtifactAvailability(probe:HeadProbe,expected:{size:string;sha256:string},timeoutMs=10000):Promise<AvailabilityObservation>{
 const signal=AbortSignal.timeout(Number.isFinite(timeoutMs)?Math.min(10000,Math.max(1,Math.trunc(timeoutMs))):10000)
 let removeAbort=()=>{}
 try{
  if(!/^\d+$/.test(expected.size)||!/^[a-f0-9]{64}$/i.test(expected.sha256))return result('unknown',unknownChecks(),'invalid_artifact_metadata','Stored artifact metadata is invalid. Availability was not checked.')
  const deadline=new Promise<never>((_resolve,reject)=>{
   const abort=()=>reject(new Error('HEAD_TIMEOUT'))
   signal.addEventListener('abort',abort,{once:true});removeAbort=()=>signal.removeEventListener('abort',abort)
  })
  // The deadline also bounds a client that fails to settle promptly after abort.
  const head=await Promise.race([Promise.resolve().then(()=>probe.head(signal)),deadline])
  const metadata=head.Metadata?.sha256
  const metadataSha256Matches=typeof metadata==='string'&&metadata.toLowerCase()===expected.sha256.toLowerCase()
  if(typeof head.ContentLength!=='number'||!Number.isSafeInteger(head.ContentLength)||head.ContentLength<0)return result('unknown',{objectExists:true,sizeMatches:null,metadataSha256Matches},'size_unavailable','The object exists, but storage did not provide a usable size. Full bytes were not verified.')
  const sizeMatches=BigInt(head.ContentLength)===BigInt(expected.size),checks={objectExists:true,sizeMatches,metadataSha256Matches}
  if(!sizeMatches)return result('changed',checks,'size_mismatch','The stored object size differs from the published artifact. Restore is blocked until this is resolved.')
  if(!metadataSha256Matches)return result('present',checks,'metadata_sha256_mismatch','The object exists with the expected size, but its metadata checksum is missing or different. Restore must verify the downloaded bytes.')
  return result('present',checks,'object_present','The object exists with the expected size and metadata checksum. Full object bytes have not been verified.')
 }catch(error){
  if(signal.aborted)return result('unknown',unknownChecks(),'check_timeout','Storage did not complete the bounded availability check. Object availability is unknown.')
  const status=error&&typeof error==='object'&&'$metadata' in error?(error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode:undefined
  if(status===404)return result('missing',{objectExists:false,sizeMatches:null,metadataSha256Matches:null},'object_not_found','Storage reported that the object or its bucket was not found.')
  if(status===401||status===403)return result('unknown',unknownChecks(),'access_denied','Storage denied this check. Object availability is unknown.')
  return result('unknown',unknownChecks(),'storage_unavailable','Storage could not complete this check. Object availability is unknown.')
 }finally{removeAbort();try{probe.destroy()}catch{/* Cleanup errors must not expose driver state or credentials. */}}
}
