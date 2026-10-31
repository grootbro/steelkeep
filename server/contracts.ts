import { t } from 'elysia'

const connectionName={name:t.String({minLength:1,maxLength:80}),restoreTarget:t.Optional(t.Boolean())}
const networkFields={...connectionName,host:t.String({minLength:1,maxLength:253}),port:t.Optional(t.Integer({minimum:1,maximum:65535})),database:t.String({minLength:1,maxLength:63}),user:t.String({minLength:1,maxLength:80}),password:t.String({minLength:1,maxLength:1024}),tls:t.Optional(t.Boolean())}
export const connectionInput=t.Union([
 t.Object({...networkFields,kind:t.Literal('postgres')}),
 t.Object({...networkFields,kind:t.Literal('mysql'),allowGlobalReadLock:t.Optional(t.Boolean())}),
 t.Object({...networkFields,kind:t.Literal('mariadb'),allowGlobalReadLock:t.Optional(t.Boolean())}),
 t.Object({...networkFields,kind:t.Literal('mongodb'),authDatabase:t.Optional(t.String({minLength:1,maxLength:63})),allowGlobalReadLock:t.Optional(t.Boolean())}),
 t.Object({...networkFields,kind:t.Literal('mssql')}),
 t.Object({...networkFields,kind:t.Literal('clickhouse'),backupDisk:t.String({minLength:1,maxLength:80}),sharedBackupRoot:t.String({minLength:1,maxLength:4096}),quiescentSource:t.Optional(t.Boolean())}),
 t.Object({...connectionName,kind:t.Literal('redis'),host:t.String({minLength:1,maxLength:253}),port:t.Optional(t.Integer({minimum:1,maximum:65535})),dbIndex:t.Integer({minimum:0,maximum:15}),user:t.Optional(t.String({minLength:1,maxLength:80})),password:t.String({minLength:1,maxLength:1024}),tls:t.Optional(t.Boolean()),allowGlobalReadLock:t.Optional(t.Boolean())}),
 t.Object({...connectionName,kind:t.Literal('sqlite'),path:t.String({minLength:1,maxLength:4096})}),
 t.Object({name:connectionName.name,kind:t.Literal('s3'),endpoint:t.String({minLength:1,maxLength:2048}),region:t.Optional(t.String({maxLength:80})),bucket:t.String({minLength:3,maxLength:63}),prefix:t.Optional(t.String({maxLength:200})),accessKey:t.String({minLength:1,maxLength:1024}),secretKey:t.String({minLength:1,maxLength:1024})})
])
export type ConnectionInput = typeof connectionInput.static
export const connectionUpdateInput=t.Object({revision:t.Integer({minimum:1}),name:t.String({minLength:1,maxLength:80}),user:t.Optional(t.String({minLength:1,maxLength:80})),password:t.Optional(t.String({minLength:1,maxLength:1024})),accessKey:t.Optional(t.String({minLength:1,maxLength:1024})),secretKey:t.Optional(t.String({minLength:1,maxLength:1024})),tls:t.Optional(t.Boolean()),allowGlobalReadLock:t.Optional(t.Boolean()),quiescentSource:t.Optional(t.Boolean())},{additionalProperties:false})
export type ConnectionUpdateInput=typeof connectionUpdateInput.static

export const planInput = t.Object({
  name:t.String({minLength:1,maxLength:80}),sourceId:t.String({format:'uuid'}),
  storageId:t.String({format:'uuid'}),cron:t.Optional(t.Nullable(t.String({maxLength:80}))),timezone:t.String({maxLength:80})
})
export type PlanInput = typeof planInput.static
export const commandInput = t.Object({ idempotencyKey:t.String({minLength:16,maxLength:160}) })

export const planUpdateInput=t.Object({name:t.String({minLength:1,maxLength:80}),cron:t.Optional(t.Nullable(t.String({maxLength:80}))),timezone:t.String({minLength:1,maxLength:80}),enabled:t.Boolean()})
export type PlanUpdateInput=typeof planUpdateInput.static
export const prepareRestoreInput=t.Object({artifactId:t.String({format:'uuid'}),targetId:t.String({format:'uuid'})})
export const startRestoreInput=t.Object({intentId:t.String({format:'uuid'}),idempotencyKey:t.String({minLength:16,maxLength:160})})
export const errorResponse=t.Object({error:t.Object({code:t.String(),message:t.String()})})
export const idResponse=t.Object({id:t.String({format:'uuid'})})
export const dateResponse=t.Union([t.String(),t.Date(),t.Null()])
export const retentionPolicyInput=t.Union([t.Object({mode:t.Literal('keep_all')},{additionalProperties:false}),t.Object({mode:t.Literal('days'),days:t.Integer({minimum:1,maximum:36500})},{additionalProperties:false}),t.Object({mode:t.Literal('gfs'),keepDaily:t.Integer({minimum:0,maximum:1000}),keepWeekly:t.Integer({minimum:0,maximum:520}),keepMonthly:t.Integer({minimum:0,maximum:240})},{additionalProperties:false})])
export const retentionSettingsResponse=t.Object({policy:retentionPolicyInput,enabled:t.Boolean(),revision:t.Integer(),timezone:t.String(),lastEvaluatedAt:dateResponse,lastErrorCode:t.Nullable(t.String()),lastErrorMessage:t.Nullable(t.String())})
export const retentionUpdateInput=t.Object({policy:retentionPolicyInput,enabled:t.Boolean(),revision:t.Integer({minimum:1}),confirmDeletion:t.Optional(t.Boolean())},{additionalProperties:false})
export const retentionUpdateResponse=t.Intersect([t.Object({planId:t.String()}),retentionSettingsResponse])
export const retentionPreviewResponse=t.Object({planId:t.String(),evaluatedAt:dateResponse,timezone:t.String(),revision:t.Integer(),enabled:t.Boolean(),policy:retentionPolicyInput,scanned:t.Integer(),kept:t.Integer(),candidateCount:t.Integer(),bytes:t.String(),candidates:t.Array(t.Object({id:t.String(),createdAt:t.String(),size:t.String(),reason:t.Union([t.Literal('expired_days'),t.Literal('outside_gfs')])})),protectedCount:t.Integer(),protected:t.Array(t.Object({id:t.String(),reason:t.Union([t.Literal('locked'),t.Literal('restore_review'),t.Literal('restore_active'),t.Literal('restore_uncertain'),t.Literal('deletion_reserved')])})),limit:t.Integer()})
export const retentionRunInput=t.Object({revision:t.Integer({minimum:1}),idempotencyKey:t.String({minLength:16,maxLength:160})},{additionalProperties:false})
export const retentionRunResponse=t.Object({planId:t.String(),revision:t.Integer(),queued:t.Integer(),skipped:t.Integer(),jobIds:t.Array(t.String()),idempotencyKey:t.String()})
export const retentionJobResponse=t.Object({id:t.String(),planId:t.String(),artifactId:t.String(),status:t.Union([t.Literal('queued'),t.Literal('deleting'),t.Literal('retry_wait'),t.Literal('held'),t.Literal('cancelled'),t.Literal('succeeded')]),attempt:t.Integer(),maxAttempts:t.Integer(),nextAttemptAt:dateResponse,errorCode:t.Nullable(t.String()),errorMessage:t.Nullable(t.String()),createdAt:dateResponse,finishedAt:dateResponse})
export const retentionLockResponse=t.Object({id:t.String(),retention_locked:t.Boolean(),deletion_state:t.Union([t.Literal('active'),t.Literal('queued'),t.Literal('deleting'),t.Literal('held'),t.Literal('deleted')]),deleted_at:dateResponse})
export const jobResponse=t.Object({
 id:t.String(),plan_id:t.Nullable(t.String()),type:t.String(),status:t.String(),phase:t.String(),
 idempotency_key:t.String(),source_id:t.String(),storage_id:t.String(),target_id:t.Nullable(t.String()),artifact_id:t.Nullable(t.String()),
 created_at:dateResponse,started_at:dateResponse,finished_at:dateResponse,heartbeat_at:dateResponse,
 error_code:t.Nullable(t.String()),error_message:t.Nullable(t.String()),validation:t.Nullable(t.Record(t.String(),t.Unknown())),
 cancel_requested:t.Boolean(),attempt:t.Number(),events:t.Optional(t.Array(t.Object({id:t.Union([t.String(),t.Number()]),run_id:t.String(),phase:t.String(),message:t.String(),created_at:dateResponse})))
})
export const connectionResponse=t.Object({id:t.String(),name:t.String(),kind:t.String(),config:t.Record(t.String(),t.Unknown()),check_status:t.String(),checked_at:dateResponse,created_at:dateResponse,updated_at:dateResponse,revision:t.Integer({minimum:1}),blocked:t.Boolean()})
export const planResponse=t.Object({id:t.String(),name:t.String(),source_id:t.String(),storage_id:t.String(),cron:t.Nullable(t.String()),timezone:t.String(),enabled:t.Boolean(),next_due:dateResponse,created_at:dateResponse,upcoming:t.Array(t.String()),missed_policy:t.Literal('skip'),overlap_policy:t.Literal('skip'),retention:retentionSettingsResponse})
export const artifactResponse=t.Object({id:t.String(),run_id:t.String(),source_id:t.String(),storage_id:t.String(),object_key:t.String(),size:t.String(),sha256:t.String(),engine:t.String(),server_version:t.String(),tool_version:t.String(),created_at:dateResponse,availability:t.String(),checked_at:dateResponse,retention_locked:t.Boolean(),deletion_state:retentionLockResponse.properties.deletion_state,deleted_at:dateResponse,last_restore:t.Nullable(t.Object({status:t.String(),validation:t.Nullable(t.Record(t.String(),t.Unknown())),finished_at:dateResponse}))})
export const restorePreparedResponse=t.Object({intentId:t.String(),expiresAt:t.String(),review:t.Record(t.String(),t.Unknown())})
export const overviewResponse=t.Object({jobs:t.Array(jobResponse),backups:t.Array(artifactResponse),plans:t.Array(planResponse),connections:t.Array(connectionResponse),serverTime:t.String(),activity:t.Array(t.Object({date:t.String(),backup:t.Number(),restore:t.Number(),failed:t.Number()})),activityWindow:t.Object({from:t.String(),to:t.String(),timezone:t.Literal('UTC')}),jobSummary:t.Object({windowDays:t.Number(),total:t.Number(),succeeded:t.Number(),failed:t.Number(),cancelled:t.Number(),interrupted:t.Number(),active:t.Number(),scope:t.String()}),storageSummary:t.Object({bytes:t.String(),count:t.Number(),scope:t.String()})})

export const scopeInput=t.Union([t.Literal('read'),t.Literal('configure'),t.Literal('backup:run'),t.Literal('restore:run'),t.Literal('jobs:cancel'),t.Literal('agents:manage'),t.Literal('backup:delete')])
export const agentInput=t.Object({name:t.String({minLength:1,maxLength:80}),description:t.Optional(t.String({maxLength:500}))})
export const tokenInput=t.Object({name:t.String({minLength:1,maxLength:80}),scopes:t.Optional(t.Array(scopeInput,{minItems:1,maxItems:7})),expiresInHours:t.Optional(t.Integer({minimum:1,maximum:720}))})
export const agentResponse=t.Object({id:t.String(),name:t.String(),description:t.String(),created_at:dateResponse,revoked_at:dateResponse})
export const tokenResponse=t.Object({id:t.String(),agent_id:t.String(),name:t.String(),scopes:t.Array(scopeInput),expires_at:dateResponse,created_at:dateResponse,revoked_at:dateResponse,last_used_at:dateResponse,issuer_actor:t.String()})
export const issuedTokenResponse=t.Object({id:t.String(),agentId:t.String(),name:t.String(),scopes:t.Array(scopeInput),expiresAt:t.String(),token:t.String(),notice:t.String()})
export const auditResponse=t.Object({id:t.Union([t.String(),t.Number()]),actor:t.String(),action:t.String(),subject_id:t.Nullable(t.String()),created_at:dateResponse})
const recoveryRunSummary={run_status:t.String(),run_phase:t.String(),run_error_code:t.Nullable(t.String()),run_finished_at:dateResponse}
export const sourceBlockResponse=t.Object({resource_key:t.String(),server_identity:t.String(),run_id:t.String(),state:t.String(),reason_code:t.Nullable(t.String()),created_at:dateResponse,updated_at:dateResponse,source_id:t.String(),source_name:t.String(),source_kind:t.String(),...recoveryRunSummary})
export const targetBlockResponse=t.Object({target_id:t.String(),target_name:t.String(),target_kind:t.String(),resource_key:t.String(),run_id:t.String(),reason:t.String(),created_at:dateResponse,...recoveryRunSummary,validation_status:t.Nullable(t.Union([t.Literal('passed'),t.Literal('failed'),t.Literal('running')]))})

export const artifactAvailabilityResponse=t.Object({id:t.String(),availability:t.Union([t.Literal('present'),t.Literal('missing'),t.Literal('changed'),t.Literal('unknown')]),checkedAt:dateResponse,verification:t.Literal('object-head-only'),checks:t.Object({objectExists:t.Nullable(t.Boolean()),sizeMatches:t.Nullable(t.Boolean()),metadataSha256Matches:t.Nullable(t.Boolean())}),reason:t.String(),message:t.String(),stale:t.Boolean()})
export const ownerUserResponse=t.Object({id:t.String(),name:t.String(),email:t.String()})
export const ownerSessionResponse=t.Object({user:t.Nullable(ownerUserResponse),actor:t.String(),scopes:t.Array(t.String()),expiresAt:t.String()})
export const ownerStatusResponse=t.Object({setupRequired:t.Boolean(),authenticated:t.Boolean(),user:t.Nullable(ownerUserResponse),bootstrapAuthorized:t.Boolean()})
export const ownerSetupInput=t.Object({name:t.String({minLength:1,maxLength:80}),email:t.String({minLength:3,maxLength:254}),password:t.String({minLength:12,maxLength:128})},{additionalProperties:false})
export const ownerLoginInput=t.Object({email:t.String({minLength:3,maxLength:254}),password:t.String({maxLength:128})},{additionalProperties:false})
export const ownerPasswordInput=t.Object({currentPassword:t.String({maxLength:128}),newPassword:t.String({minLength:12,maxLength:128})},{additionalProperties:false})
export const setupLinkResponse=t.Object({code:t.String(),expiresAt:t.String()})
export const setupLinkClaimInput=t.Object({code:t.String()},{additionalProperties:false})
export const setupLinkClaimResponse=t.Object({expiresAt:t.String()})
