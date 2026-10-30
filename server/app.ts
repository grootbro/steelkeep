import { Elysia, t } from 'elysia'
import { openapi } from '@elysia/openapi'
import {connectionInput,connectionUpdateInput,planInput,planUpdateInput,commandInput,prepareRestoreInput,startRestoreInput,errorResponse,idResponse,connectionResponse,planResponse,jobResponse,artifactResponse,restorePreparedResponse,overviewResponse,agentInput,tokenInput,agentResponse,tokenResponse,issuedTokenResponse,auditResponse,sourceBlockResponse,artifactAvailabilityResponse} from './contracts'
import {Services,authorize,validateScopedTokens,engineProfiles,type Scope} from './services'
import {AppError,safeFailure} from './security'
import {config} from './config'
import {mcpHandler} from './mcp'
import {openapiPage} from './openapi-page'

const params=t.Object({id:t.String({format:'uuid'})})
const errors={400:errorResponse,401:errorResponse,403:errorResponse,404:errorResponse,409:errorResponse,422:errorResponse,500:errorResponse}
export const capabilities={engines:engineProfiles.map(p=>p.kind),profiles:engineProfiles.map(profile=>({...profile})),operations:['list','configure','run_backup','check_backup_availability','prepare_restore','start_restore','cancel_job','manage_agents','issue_scoped_token','revoke_token','audit'],restore:{target:'precreated-empty',reviewExpiresSeconds:600},schedules:{missed:'skip',overlap:'skip',timezone:'IANA',upcomingCount:3},support:'Selected implementation profiles. No runtime acceptance has been performed; required native tools, helper and mounts must be provisioned.'}
export function createApp(services:Services){
 validateScopedTokens()
 const principals=new WeakMap<Request,ReturnType<Services['authenticate']>>()
 const authenticate=(request:Request)=>{let principal=principals.get(request);if(!principal){principal=services.authenticate(request);principals.set(request,principal)}return principal}
 const guard=(scope:Scope)=>async({request}:{request:Request})=>{authorize(await authenticate(request),scope)}
 return new Elysia({strictPath:true,normalize:false,serve:{maxRequestBodySize:64*1024}})
 .onRequest(async({request,set})=>{
  set.headers['cache-control']='no-store'
  set.headers['x-content-type-options']='nosniff'
  const url=new URL(request.url)
  if(!(process.env.STEELKEEP_PUBLIC_HOSTS??'localhost,127.0.0.1').split(',').map(s=>s.trim()).includes(url.hostname)){set.status=403;return {error:{code:'HOST_NOT_ALLOWED',message:'Host not allowed.'}}}
  const origin=request.headers.get('origin')
  if(origin&&!config.allowedOrigins().includes(origin)){set.status=403;return {error:{code:'ORIGIN_NOT_ALLOWED',message:'Origin not allowed.'}}}
  const path=url.pathname.replace(/\/+$/,'')||'/'
  if(path==='/api/v1/health'&&request.method==='GET')return
  const principal=await authenticate(request)
  // Actual route guards own permissions; path aliases cannot downgrade a command scope.
  if(path.startsWith('/openapi'))authorize(principal,'read')
 })
 .onError(({error,code,set})=>{
  if(code==='NOT_FOUND'){set.status=404;return {error:{code:'NOT_FOUND',message:'Route not found.'}}}
  if(code==='PARSE'){set.status=400;return {error:{code:'INVALID_JSON',message:'Send a valid JSON request body.'}}}
  if(code==='VALIDATION'){set.status=422;return {error:{code:'INVALID_INPUT',message:'Check the request fields.'}}}
  set.status=error instanceof AppError?error.status:500;return {error:safeFailure(error)}
 })
 .use(openapi({provider:null,documentation:{info:{title:'Steelkeep API',version:'0.1.0',description:'Authenticated asynchronous backup and recovery. Read, configure, backup:run, restore:run, jobs:cancel and agents:manage scopes are enforced.'},components:{securitySchemes:{installationToken:{type:'http',scheme:'bearer'}}},security:[{installationToken:[]}]}}))
 .get('/openapi',()=>new Response(openapiPage,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}}),{beforeHandle:guard('read'),detail:{hide:true}})
 .get('/openapi/assets/scalar.js',()=>new Response(Bun.file(new URL('../node_modules/@scalar/api-reference/dist/browser/standalone.js',import.meta.url)),{headers:{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}}),{beforeHandle:guard('read'),detail:{hide:true}})
 .get('/api/v1/health',()=>({status:'ok',version:'0.1.0'}),{response:{200:t.Object({status:t.String(),version:t.String()})},detail:{operationId:'health',security:[]}})
 .post('/api/v1/session',({request,cookie,set})=>{
  const token=request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1]
  if(!token)throw new AppError('UNAUTHORIZED','A bearer token is required to create a session.',401)
  cookie.steelkeep_session.set({value:token,httpOnly:true,sameSite:'strict',secure:process.env.STEELKEEP_SECURE_COOKIE==='true',path:'/',maxAge:3600});set.status=204
 },{beforeHandle:guard('read'),detail:{operationId:'createSession',description:'Exchange a read-scoped bearer token for an HttpOnly local session retaining its exact scopes.'}})
 .post('/api/v1/session/logout',({cookie,set})=>{cookie.steelkeep_session.set({value:'',path:'/',httpOnly:true,sameSite:'strict',secure:process.env.STEELKEEP_SECURE_COOKIE==='true',maxAge:0});set.status=204},{beforeHandle:guard('read'),detail:{operationId:'deleteSession',description:'Expire this browser session; agent token revocation is a separate operation.'}})
 .get('/api/v1/me',async({request})=>{const principal=await authenticate(request);return {actor:principal.actor,scopes:[...principal.scopes]}},{response:{200:t.Object({actor:t.String(),scopes:t.Array(t.String())}),...errors},beforeHandle:guard('read'),detail:{operationId:'getCurrentPrincipal'}})
 .get('/api/v1/capabilities',()=>capabilities,{response:{200:t.Object({engines:t.Array(t.String()),profiles:t.Array(t.Record(t.String(),t.Unknown())),operations:t.Array(t.String()),restore:t.Object({target:t.String(),reviewExpiresSeconds:t.Number()}),schedules:t.Object({missed:t.String(),overlap:t.String(),timezone:t.String(),upcomingCount:t.Number()}),support:t.String()}),...errors},beforeHandle:guard('read'),detail:{operationId:'getCapabilities'}})
 .get('/api/v1/overview',()=>services.overview(),{response:{200:overviewResponse,...errors},beforeHandle:guard('read'),detail:{operationId:'overview'}})
 .get('/api/v1/connections',()=>services.connections(),{response:{200:t.Array(connectionResponse),...errors},beforeHandle:guard('read'),detail:{operationId:'listConnections'}})
 .post('/api/v1/connections',async({body,request})=>services.createConnection(body,(await authenticate(request)).actor),{body:connectionInput,response:{200:idResponse,...errors},beforeHandle:guard('configure'),detail:{operationId:'createConnection'}})
 .patch('/api/v1/connections/:id',async({params,body,request})=>services.updateConnection(params.id,body,(await authenticate(request)).actor),{params,body:connectionUpdateInput,response:{200:connectionResponse,...errors},beforeHandle:guard('configure'),detail:{operationId:'updateConnection',description:'Optimistic revision update of name and applicable credentials/settings only. Identity, endpoint and restore designation are immutable; active operations block credential/settings changes.'}})
 .delete('/api/v1/connections/:id',async({params,request})=>services.deleteUnusedConnection(params.id,(await authenticate(request)).actor),{params,response:{200:t.Object({id:t.String(),deleted:t.Literal(true)}),...errors},beforeHandle:guard('configure'),detail:{operationId:'deleteUnusedConnection',description:'Delete unused metadata only. Any plan, operation, artifact or recovery-history reference returns CONNECTION_IN_USE; stored objects and history are never deleted.'}})
 .post('/api/v1/connections/:id/test',({params})=>services.testConnection(params.id),{params,response:{200:t.Object({status:t.String(),error:t.Optional(t.String())}),...errors},beforeHandle:guard('configure'),detail:{operationId:'testConnection'}})
 .post('/api/v1/connections/:id/native-operations/:operationId/reconcile',async({params,request})=>services.reconcileNativeOperation(params.id,params.operationId,(await authenticate(request)).actor),{params:t.Object({id:t.String({format:'uuid'}),operationId:t.String({format:'uuid'})}),response:{200:t.Object({operationId:t.String(),kind:t.String(),status:t.String(),terminal:t.Boolean()}),...errors},beforeHandle:guard('configure'),detail:{operationId:'observeNativeOperation',description:'Observe a journaled ClickHouse operation by its existing native ID. Does not submit/retry a backup or restore and does not clear a target reservation.'}})
 .get('/api/v1/plans',()=>services.plans(),{response:{200:t.Array(planResponse),...errors},beforeHandle:guard('read'),detail:{operationId:'listPlans'}})
 .get('/api/v1/plans/:id/occurrences',({params})=>services.scheduleOccurrences(params.id),{params,response:{200:t.Array(t.Object({plan_id:t.String(),due_at:t.Union([t.String(),t.Date()]),outcome:t.String(),run_id:t.Nullable(t.String()),created_at:t.Union([t.String(),t.Date()])})),...errors},beforeHandle:guard('read'),detail:{operationId:'listScheduleOccurrences'}})
 .post('/api/v1/plans',async({body,request})=>services.createPlan(body,(await authenticate(request)).actor),{body:planInput,response:{200:t.Object({id:t.String(),nextDue:t.Union([t.Date(),t.String(),t.Null()])}),...errors},beforeHandle:guard('configure'),detail:{operationId:'createPlan'}})
 .patch('/api/v1/plans/:id',async({params,body,request})=>services.updatePlan(params.id,body,(await authenticate(request)).actor),{params,body:planUpdateInput,response:{200:planResponse,...errors},beforeHandle:guard('configure'),detail:{operationId:'updatePlan'}})
 .post('/api/v1/plans/:id/run',async({params,body,set,request})=>{const row=await services.runBackup(params.id,body.idempotencyKey,(await authenticate(request)).actor);set.status=202;return row},{body:commandInput,params,response:{202:jobResponse,...errors},beforeHandle:guard('backup:run'),detail:{operationId:'runBackup'}})
 .get('/api/v1/jobs',()=>services.jobs(),{response:{200:t.Array(jobResponse),...errors},beforeHandle:guard('read'),detail:{operationId:'listJobs'}})
 .get('/api/v1/jobs/:id',({params})=>services.job(params.id),{params,response:{200:jobResponse,...errors},beforeHandle:guard('read'),detail:{operationId:'getJob'}})
 .post('/api/v1/jobs/:id/cancel',async({params,request})=>services.cancel(params.id,(await authenticate(request)).actor),{params,response:{200:jobResponse,...errors},beforeHandle:guard('jobs:cancel'),detail:{operationId:'cancelJob'}})
 .get('/api/v1/backups',()=>services.artifacts(),{response:{200:t.Array(artifactResponse),...errors},beforeHandle:guard('read'),detail:{operationId:'listBackups'}})
 .post('/api/v1/backups/:id/check',async({params,request})=>services.checkArtifactAvailability(params.id,(await authenticate(request)).actor),{params,response:{200:artifactAvailabilityResponse,...errors},beforeHandle:guard('read'),detail:{operationId:'checkBackupAvailability',description:'Bounded S3 HEAD only. Object presence/size/metadata checks do not verify full bytes. Access failures remain unknown; explicit rechecks can recover missing/changed/unknown availability.'}})
 .post('/api/v1/restores/prepare',async({body,request})=>services.prepareRestore(body.artifactId,body.targetId,(await authenticate(request)).actor),{body:prepareRestoreInput,response:{200:restorePreparedResponse,...errors},beforeHandle:guard('restore:run'),detail:{operationId:'prepareRestore',description:'Validate a trusted artifact and separate empty target; creates an actor-bound review valid for ten minutes.'}})
 .post('/api/v1/restores/start',async({body,request,set})=>{const run=await services.startRestore(body.intentId,body.idempotencyKey,(await authenticate(request)).actor);set.status=202;return run},{body:startRestoreInput,response:{202:jobResponse,...errors},beforeHandle:guard('restore:run'),detail:{operationId:'startRestore',description:'Consume the review once and atomically reserve the target, enqueue the job and record dispatch intent.'}})
 .get('/api/v1/source-blocks',()=>services.sourceBlocks(),{response:{200:t.Array(sourceBlockResponse),...errors},beforeHandle:guard('read'),detail:{operationId:'listSourceBlocks',description:'Uncertain source locks are never cleared automatically; inspect before further backup.'}})
 .get('/api/v1/agents',async({request})=>services.agents.list(await authenticate(request)),{response:{200:t.Array(agentResponse),...errors},beforeHandle:guard('agents:manage'),detail:{operationId:'listAgents'}})
 .post('/api/v1/agents',async({request,body})=>services.agents.create(await authenticate(request),body),{body:agentInput,response:{200:agentResponse,...errors},beforeHandle:guard('agents:manage'),detail:{operationId:'createAgent'}})
 .post('/api/v1/agents/:id/revoke',async({request,params})=>services.agents.revokeAgent(await authenticate(request),params.id),{params,response:{200:t.Object({id:t.String(),revoked:t.Boolean()}),...errors},beforeHandle:guard('agents:manage'),detail:{operationId:'revokeAgent'}})
 .get('/api/v1/agents/:id/tokens',async({request,params})=>services.agents.tokens(await authenticate(request),params.id),{params,response:{200:t.Array(tokenResponse),...errors},beforeHandle:guard('agents:manage'),detail:{operationId:'listAgentTokens'}})
 .post('/api/v1/agents/:id/tokens',async({request,params,body})=>services.agents.issue(await authenticate(request),params.id,body),{params,body:tokenInput,response:{200:issuedTokenResponse,...errors},beforeHandle:guard('agents:manage'),detail:{operationId:'issueAgentToken',description:'Returns the credential once. Only a hash is stored. Scope subset and issuer expiry are enforced.'}})
 .post('/api/v1/agent-tokens/:id/revoke',async({request,params})=>services.agents.revokeToken(await authenticate(request),params.id),{params,response:{200:t.Object({id:t.String(),revoked:t.Boolean()}),...errors},beforeHandle:guard('agents:manage'),detail:{operationId:'revokeAgentToken'}})
 .get('/api/v1/audit',async({request})=>services.agents.history(await authenticate(request)),{response:{200:t.Array(auditResponse),...errors},beforeHandle:guard('agents:manage'),detail:{operationId:'listAuditEvents'}})
 .all('/mcp',async({request})=>mcpHandler(services,await authenticate(request)).fetch(request),{parse:'none',detail:{hide:true}})
}
export type App=ReturnType<typeof createApp>
