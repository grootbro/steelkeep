import pg from 'pg'
import { Kysely, PostgresDialect, type Generated, type ColumnType } from 'kysely'
import { config } from './config'
import type {Scope} from './auth'

type DateTime = ColumnType<Date, Date | string | undefined, Date | string>
interface Connection {
  id: string; name: string; kind: 'postgres' | 'mysql' | 'mariadb' | 'mongodb' | 'sqlite' | 'redis' | 'clickhouse' | 'mssql' | 's3'; config: Record<string, unknown>;
  secret: string; checked_at: DateTime | null; check_status: string; created_at: Generated<Date>
}
interface Plan {
  id:string; name:string; source_id:string; storage_id:string; cron:string|null;
  timezone:string; enabled:boolean; next_due:DateTime|null; created_at:Generated<Date>
}
interface Run {
  id:string; plan_id:string|null; type:'backup'|'restore'; status:string; phase:string;
  idempotency_key:string; source_id:string; storage_id:string; target_id:string|null;
  artifact_id:string|null; created_at:Generated<Date>; started_at:DateTime|null;
  finished_at:DateTime|null; heartbeat_at:DateTime|null; error_code:string|null;
  error_message:string|null; validation:Record<string,unknown>|null; cancel_requested:boolean;
  attempt:number; execution_token:string|null; review_fingerprint?:string|null
}
interface Artifact {
  id:string; run_id:string; source_id:string; storage_id:string; object_key:string;
  size:string; sha256:string; engine:string; server_version:string; tool_version:string;
  created_at:Generated<Date>; availability:string; checked_at:DateTime|null; manifest?:Record<string,unknown>|null
}
interface Event { id:Generated<string>; run_id:string; phase:string; message:string; created_at:Generated<Date> }
interface Outbox { run_id:string; dispatched_at:DateTime|null }
interface RestoreIntent {
  id:string;actor:string;artifact_id:string;target_id:string;review:Record<string,unknown>;fingerprint:string;
  expires_at:DateTime;created_at:Generated<Date>;consumed_run_id:string|null;idempotency_key:string|null
}
interface Occurrence {plan_id:string;due_at:DateTime;outcome:string;run_id:string|null;created_at:Generated<Date>}
interface TargetBlock {target_id:string;resource_key:string;run_id:string;reason:string;created_at:Generated<Date>}
interface SourceBlock {resource_key:string;server_identity:string;run_id:string;execution_token:string;owner_token:string;state:'acquiring'|'uncertain';reason_code:string|null;created_at:Generated<Date>;updated_at:Generated<Date>}
interface Agent {id:string;name:string;description:string;revoked_at:DateTime|null;created_at:Generated<Date>}
interface AgentToken {id:string;agent_id:string;name:string;token_hash:string;scopes:Scope[];expires_at:DateTime;revoked_at:DateTime|null;last_used_at:DateTime|null;issuer_actor:string;parent_token_id:string|null;created_at:Generated<Date>}
interface AuditEvent {id:Generated<string>;actor:string;action:string;subject_id:string|null;created_at:Generated<Date>}

export interface Schema {
  worker_state:{singleton:boolean;epoch:string;started_at:Generated<Date>};
  connections:Connection;plans:Plan;runs:Run;artifacts:Artifact;events:Event;outbox:Outbox;
  restore_intents:RestoreIntent;schedule_occurrences:Occurrence;target_blocks:TargetBlock;source_blocks:SourceBlock;agents:Agent;agent_tokens:AgentToken;audit_events:AuditEvent
}
export function connectDb(options:{statementTimeoutMs?:number;queryTimeoutMs?:number}={}) {
  const pool = new pg.Pool({ connectionString:config.databaseUrl(),max:8,connectionTimeoutMillis:5000,statement_timeout:options.statementTimeoutMs??30000,query_timeout:options.queryTimeoutMs??35000 })
  pool.on('error',()=>{console.error('Steelkeep metadata connection was lost; requests will reconnect.')})
  return { pool, db:new Kysely<Schema>({ dialect:new PostgresDialect({pool}) }) }
}
