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
export const jobResponse=t.Object({
 id:t.String(),plan_id:t.Nullable(t.String()),type:t.String(),status:t.String(),phase:t.String(),
 idempotency_key:t.String(),source_id:t.String(),storage_id:t.String(),target_id:t.Nullable(t.String()),artifact_id:t.Nullable(t.String()),
 created_at:dateResponse,started_at:dateResponse,finished_at:dateResponse,heartbeat_at:dateResponse,
 error_code:t.Nullable(t.String()),error_message:t.Nullable(t.String()),validation:t.Nullable(t.Record(t.String(),t.Unknown())),
 cancel_requested:t.Boolean(),attempt:t.Number(),events:t.Optional(t.Array(t.Object({id:t.Union([t.String(),t.Number()]),run_id:t.String(),phase:t.String(),message:t.String(),created_at:dateResponse})))
})
export const connectionResponse=t.Object({id:t.String(),name:t.String(),kind:t.String(),config:t.Record(t.String(),t.Unknown()),check_status:t.String(),checked_at:dateResponse,created_at:dateResponse,updated_at:dateResponse,revision:t.Integer({minimum:1}),blocked:t.Boolean()})
export const planResponse=t.Object({id:t.String(),name:t.String(),source_id:t.String(),storage_id:t.String(),cron:t.Nullable(t.String()),timezone:t.String(),enabled:t.Boolean(),next_due:dateResponse,created_at:dateResponse,upcoming:t.Array(t.String()),missed_policy:t.Literal('skip'),overlap_policy:t.Literal('skip')})
export const artifactResponse=t.Object({id:t.String(),run_id:t.String(),source_id:t.String(),storage_id:t.String(),object_key:t.String(),size:t.String(),sha256:t.String(),engine:t.String(),server_version:t.String(),tool_version:t.String(),created_at:dateResponse,availability:t.String(),checked_at:dateResponse,last_restore:t.Nullable(t.Object({status:t.String(),validation:t.Nullable(t.Record(t.String(),t.Unknown())),finished_at:dateResponse}))})
export const restorePreparedResponse=t.Object({intentId:t.String(),expiresAt:t.String(),review:t.Record(t.String(),t.Unknown())})
export const overviewResponse=t.Object({jobs:t.Array(jobResponse),backups:t.Array(artifactResponse),plans:t.Array(planResponse),connections:t.Array(connectionResponse),serverTime:t.String(),activity:t.Array(t.Object({date:t.String(),backup:t.Number(),restore:t.Number(),failed:t.Number()})),activityWindow:t.Object({from:t.String(),to:t.String(),timezone:t.Literal('UTC')}),jobSummary:t.Object({windowDays:t.Number(),total:t.Number(),succeeded:t.Number(),failed:t.Number(),cancelled:t.Number(),interrupted:t.Number(),active:t.Number(),scope:t.String()}),storageSummary:t.Object({bytes:t.String(),count:t.Number(),scope:t.String()})})

export const scopeInput=t.Union([t.Literal('read'),t.Literal('configure'),t.Literal('backup:run'),t.Literal('restore:run'),t.Literal('jobs:cancel'),t.Literal('agents:manage')])
export const agentInput=t.Object({name:t.String({minLength:1,maxLength:80}),description:t.Optional(t.String({maxLength:500}))})
export const tokenInput=t.Object({name:t.String({minLength:1,maxLength:80}),scopes:t.Optional(t.Array(scopeInput,{minItems:1,maxItems:6})),expiresInHours:t.Optional(t.Integer({minimum:1,maximum:720}))})
export const agentResponse=t.Object({id:t.String(),name:t.String(),description:t.String(),created_at:dateResponse,revoked_at:dateResponse})
export const tokenResponse=t.Object({id:t.String(),agent_id:t.String(),name:t.String(),scopes:t.Array(scopeInput),expires_at:dateResponse,created_at:dateResponse,revoked_at:dateResponse,last_used_at:dateResponse,issuer_actor:t.String()})
export const issuedTokenResponse=t.Object({id:t.String(),agentId:t.String(),name:t.String(),scopes:t.Array(scopeInput),expiresAt:t.String(),token:t.String(),notice:t.String()})
export const auditResponse=t.Object({id:t.Union([t.String(),t.Number()]),actor:t.String(),action:t.String(),subject_id:t.Nullable(t.String()),created_at:dateResponse})
export const sourceBlockResponse=t.Object({resource_key:t.String(),server_identity:t.String(),run_id:t.String(),state:t.String(),reason_code:t.Nullable(t.String()),created_at:dateResponse,updated_at:dateResponse})

export const artifactAvailabilityResponse=t.Object({id:t.String(),availability:t.Union([t.Literal('present'),t.Literal('missing'),t.Literal('changed'),t.Literal('unknown')]),checkedAt:dateResponse,verification:t.Literal('object-head-only'),checks:t.Object({objectExists:t.Nullable(t.Boolean()),sizeMatches:t.Nullable(t.Boolean()),metadataSha256Matches:t.Nullable(t.Boolean())}),reason:t.String(),message:t.String(),stale:t.Boolean()})
