import { sql } from 'kysely'
import { connectDb } from './db'
import {migrateOwnerAuth} from './owner-auth'

const {db} = connectDb({statementTimeoutMs:120000,queryTimeoutMs:125000})
try {
  await db.transaction().execute(async trx => {
    await sql`select pg_advisory_xact_lock(4356542)`.execute(trx)
    await sql`CREATE TABLE IF NOT EXISTS steelkeep_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`.execute(trx)
    const applied=await sql<{version:number}>`SELECT version FROM steelkeep_migrations`.execute(trx)
    const versions=new Set(applied.rows.map(r=>r.version))
    if(!versions.has(1)) {
    await sql`CREATE TABLE IF NOT EXISTS connections (
      id uuid PRIMARY KEY, name text NOT NULL, kind text NOT NULL CHECK(kind IN ('postgres','s3')),
      config jsonb NOT NULL, secret text NOT NULL, checked_at timestamptz,
      check_status text NOT NULL DEFAULT 'untested', created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(trx)
    await sql`CREATE TABLE IF NOT EXISTS plans (
      id uuid PRIMARY KEY,name text NOT NULL,source_id uuid NOT NULL REFERENCES connections,
      storage_id uuid NOT NULL REFERENCES connections,cron text,timezone text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,next_due timestamptz,created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(trx)
    await sql`CREATE TABLE IF NOT EXISTS runs (
      id uuid PRIMARY KEY,plan_id uuid REFERENCES plans,type text NOT NULL CHECK(type IN ('backup','restore')),
      status text NOT NULL DEFAULT 'queued',phase text NOT NULL DEFAULT 'queued',idempotency_key text UNIQUE NOT NULL,
      source_id uuid NOT NULL REFERENCES connections,storage_id uuid NOT NULL REFERENCES connections,
      target_id uuid REFERENCES connections,artifact_id uuid,created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,finished_at timestamptz,heartbeat_at timestamptz,error_code text,error_message text,
      validation jsonb,cancel_requested boolean NOT NULL DEFAULT false,attempt integer NOT NULL DEFAULT 0,execution_token uuid
    )`.execute(trx)
    await sql`CREATE TABLE IF NOT EXISTS artifacts (
      id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES runs,source_id uuid NOT NULL REFERENCES connections,
      storage_id uuid NOT NULL REFERENCES connections,object_key text UNIQUE NOT NULL,size bigint NOT NULL,
      sha256 text NOT NULL,engine text NOT NULL,server_version text NOT NULL,tool_version text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),availability text NOT NULL DEFAULT 'present',checked_at timestamptz
    )`.execute(trx)
    await sql`CREATE TABLE IF NOT EXISTS events (
      id bigserial PRIMARY KEY,run_id uuid NOT NULL REFERENCES runs,phase text NOT NULL,message text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(trx)
    await sql`CREATE INDEX IF NOT EXISTS events_run_idx ON events(run_id,id)`.execute(trx)
    await sql`CREATE TABLE IF NOT EXISTS outbox(run_id uuid PRIMARY KEY REFERENCES runs,dispatched_at timestamptz)`.execute(trx)
    await sql`INSERT INTO steelkeep_migrations(version) VALUES(1)`.execute(trx)
    }
    if(!versions.has(2)) {
      await sql`ALTER TABLE connections DROP CONSTRAINT IF EXISTS connections_kind_check`.execute(trx)
      await sql`ALTER TABLE connections ADD CONSTRAINT connections_kind_check CHECK(kind IN ('postgres','mysql','mariadb','s3'))`.execute(trx)
      await sql`ALTER TABLE artifacts ADD COLUMN manifest jsonb`.execute(trx)
      await sql`ALTER TABLE runs ADD COLUMN review_fingerprint text`.execute(trx)
      await sql`CREATE TABLE restore_intents(id uuid PRIMARY KEY,actor text NOT NULL,artifact_id uuid NOT NULL REFERENCES artifacts,target_id uuid NOT NULL REFERENCES connections,review jsonb NOT NULL,fingerprint text NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),consumed_run_id uuid REFERENCES runs,idempotency_key text)`.execute(trx)
      await sql`CREATE TABLE schedule_occurrences(plan_id uuid NOT NULL REFERENCES plans,due_at timestamptz NOT NULL,outcome text NOT NULL,run_id uuid REFERENCES runs,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(plan_id,due_at))`.execute(trx)
      await sql`CREATE TABLE target_blocks(target_id uuid PRIMARY KEY REFERENCES connections,run_id uuid NOT NULL REFERENCES runs,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())`.execute(trx)
      await sql`CREATE INDEX runs_source_active_idx ON runs(source_id,status)`.execute(trx)
      await sql`CREATE INDEX plans_due_idx ON plans(next_due) WHERE enabled AND cron IS NOT NULL`.execute(trx)
      await sql`INSERT INTO steelkeep_migrations(version) VALUES(2)`.execute(trx)
    }
    if(!versions.has(3)) {
      await sql`CREATE TABLE worker_state(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),epoch uuid NOT NULL,started_at timestamptz NOT NULL DEFAULT now())`.execute(trx)
      await sql`INSERT INTO steelkeep_migrations(version) VALUES(3)`.execute(trx)
    }
    if(!versions.has(4)) {
      await sql`ALTER TABLE connections DROP CONSTRAINT connections_kind_check`.execute(trx)
      await sql`ALTER TABLE connections ADD CONSTRAINT connections_kind_check CHECK(kind IN ('postgres','mysql','mariadb','mongodb','sqlite','redis','clickhouse','mssql','s3'))`.execute(trx)
      await sql`ALTER TABLE target_blocks ADD COLUMN resource_key text`.execute(trx)
      await sql`UPDATE target_blocks b SET resource_key=(CASE WHEN c.kind IN ('mysql','mariadb') THEN 'mysql' ELSE c.kind END)||':'||lower(c.config->>'database') FROM connections c WHERE c.id=b.target_id`.execute(trx)
      await sql`ALTER TABLE target_blocks ALTER COLUMN resource_key SET NOT NULL`.execute(trx)
      await sql`CREATE UNIQUE INDEX target_blocks_resource_key ON target_blocks(resource_key)`.execute(trx)
      await sql`CREATE TABLE source_blocks(resource_key text PRIMARY KEY,server_identity text UNIQUE NOT NULL,run_id uuid NOT NULL REFERENCES runs,execution_token uuid NOT NULL,owner_token uuid NOT NULL,state text NOT NULL CHECK(state IN ('acquiring','uncertain')),reason_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`.execute(trx)
      await sql`INSERT INTO steelkeep_migrations(version) VALUES(4)`.execute(trx)
    }
    if(!versions.has(5)) {
      await sql`CREATE TABLE agents(id uuid PRIMARY KEY,name text NOT NULL,description text NOT NULL DEFAULT '',revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now())`.execute(trx)
      await sql`CREATE TABLE agent_tokens(id uuid PRIMARY KEY,agent_id uuid NOT NULL REFERENCES agents,name text NOT NULL,token_hash text UNIQUE NOT NULL,scopes jsonb NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,last_used_at timestamptz,issuer_actor text NOT NULL,parent_token_id uuid REFERENCES agent_tokens,created_at timestamptz NOT NULL DEFAULT now())`.execute(trx)
      await sql`CREATE INDEX agent_tokens_agent_idx ON agent_tokens(agent_id,created_at)`.execute(trx)
      await sql`CREATE TABLE audit_events(id bigserial PRIMARY KEY,actor text NOT NULL,action text NOT NULL,subject_id uuid,created_at timestamptz NOT NULL DEFAULT now())`.execute(trx)
      await sql`INSERT INTO steelkeep_migrations(version) VALUES(5)`.execute(trx)
    }
    if(!versions.has(6)) {
      await sql`ALTER TABLE connections ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>=1),ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now()`.execute(trx)
      await sql`INSERT INTO steelkeep_migrations(version) VALUES(6)`.execute(trx)
    }
    // No owner or password is bootstrapped by migration.
    if(!versions.has(7)){await migrateOwnerAuth(trx);await sql`INSERT INTO steelkeep_migrations(version) VALUES(7)`.execute(trx)}
    if(!versions.has(8)){
      await sql`ALTER TABLE plans ADD COLUMN retention_policy jsonb NOT NULL DEFAULT '{"mode":"keep_all"}',ADD COLUMN retention_enabled boolean NOT NULL DEFAULT false,ADD COLUMN retention_revision integer NOT NULL DEFAULT 1 CHECK(retention_revision>=1),ADD COLUMN retention_checked_at timestamptz,ADD COLUMN retention_error_code text,ADD COLUMN retention_error_message text`.execute(trx)
      await sql`ALTER TABLE artifacts ADD COLUMN retention_locked boolean NOT NULL DEFAULT false,ADD COLUMN deletion_state text NOT NULL DEFAULT 'active' CHECK(deletion_state IN ('active','queued','deleting','held','deleted')),ADD COLUMN deleted_at timestamptz`.execute(trx)
      await sql`CREATE TABLE retention_jobs(id uuid PRIMARY KEY,plan_id uuid NOT NULL REFERENCES plans,artifact_id uuid NOT NULL REFERENCES artifacts,policy_revision integer NOT NULL,storage_revision integer NOT NULL,status text NOT NULL CHECK(status IN ('queued','deleting','retry_wait','held','cancelled','succeeded')),attempt integer NOT NULL DEFAULT 0,max_attempts integer NOT NULL DEFAULT 3,next_attempt_at timestamptz,execution_token uuid,worker_epoch uuid,object_etag text,object_version_id text,error_code text,error_message text,actor text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz)`.execute(trx)
      await sql`CREATE UNIQUE INDEX retention_jobs_open_artifact ON retention_jobs(artifact_id) WHERE status IN ('queued','deleting','retry_wait','held')`.execute(trx)
      await sql`CREATE INDEX retention_jobs_due ON retention_jobs(next_attempt_at,created_at) WHERE status IN ('queued','retry_wait')`.execute(trx)
      await sql`CREATE INDEX runs_plan_artifact ON runs(plan_id,artifact_id) WHERE type='backup' AND status='succeeded'`.execute(trx)
      await sql`CREATE INDEX runs_restore_artifact ON runs(artifact_id,status) WHERE type='restore'`.execute(trx)
      await sql`CREATE INDEX restore_intents_artifact_pin ON restore_intents(artifact_id,expires_at) WHERE consumed_run_id IS NULL`.execute(trx)
      await sql`CREATE TABLE retention_requests(key text PRIMARY KEY,actor text NOT NULL,plan_id uuid NOT NULL REFERENCES plans,job_id uuid REFERENCES retention_jobs,kind text NOT NULL,revision integer NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now())`.execute(trx)
      await sql`INSERT INTO steelkeep_migrations(version) VALUES(8)`.execute(trx)
    }
    if(!versions.has(9)){
      await sql`CREATE TABLE notification_channels(id uuid PRIMARY KEY,name text NOT NULL,kind text NOT NULL,enabled boolean NOT NULL,revision integer NOT NULL DEFAULT 1,events jsonb NOT NULL,config jsonb NOT NULL,secret text NOT NULL,deleted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`.execute(trx)
      await sql`CREATE TABLE notification_deliveries(id uuid PRIMARY KEY,channel_id uuid NOT NULL REFERENCES notification_channels,channel_revision integer NOT NULL,channel_name text NOT NULL,kind text NOT NULL,run_id uuid REFERENCES runs,event text NOT NULL CHECK(event IN ('success','failure','test')),payload jsonb NOT NULL,status text NOT NULL CHECK(status IN ('queued','sending','retry_wait','succeeded','failed','uncertain','cancelled')),attempt integer NOT NULL DEFAULT 0,max_attempts integer NOT NULL DEFAULT 3,execution_token uuid,worker_epoch uuid,next_attempt_at timestamptz,error_code text,error_message text,created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,UNIQUE(channel_id,run_id,event))`.execute(trx)
      await sql`CREATE TABLE notification_attempts(delivery_id uuid NOT NULL REFERENCES notification_deliveries,attempt integer NOT NULL,status text NOT NULL,started_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,error_code text,error_message text,PRIMARY KEY(delivery_id,attempt))`.execute(trx)
      await sql`CREATE INDEX notification_deliveries_due ON notification_deliveries(next_attempt_at,created_at) WHERE status IN ('queued','retry_wait')`.execute(trx)
      await sql`CREATE TABLE notification_requests(key text PRIMARY KEY,actor text NOT NULL,kind text NOT NULL,resource_id uuid NOT NULL,revision integer,confirm_duplicate boolean NOT NULL DEFAULT false,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now())`.execute(trx)
      // Atomic post-terminal outbox: there is deliberately no history backfill.
      await sql`CREATE FUNCTION steelkeep_queue_terminal_notifications() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE terminal_event text;
      BEGIN
       IF NEW.status NOT IN ('succeeded','failed','interrupted','cancelled') OR OLD.status IN ('succeeded','failed','interrupted','cancelled') THEN RETURN NEW; END IF;
       terminal_event:=CASE WHEN NEW.status='succeeded' THEN 'success' ELSE 'failure' END;
       INSERT INTO notification_deliveries(id,channel_id,channel_revision,channel_name,kind,run_id,event,payload,status,next_attempt_at)
       SELECT gen_random_uuid(),c.id,c.revision,c.name,c.kind,NEW.id,terminal_event,
       jsonb_build_object('title','steelkeep: '||NEW.type||' '||NEW.status,'text','Operation: '||NEW.type||E'\nStatus: '||NEW.status||E'\nSource: '||coalesce((SELECT name FROM connections WHERE id=NEW.source_id),'Unknown')||E'\nJob: '||NEW.id::text,'runId',NEW.id,'operation',NEW.type,'status',NEW.status,'errorCode',NEW.error_code,'timestamp',clock_timestamp()),'queued',clock_timestamp()
       FROM notification_channels c WHERE c.enabled AND c.deleted_at IS NULL AND c.events->>terminal_event='true'
       ON CONFLICT(channel_id,run_id,event) DO NOTHING;
       RETURN NEW;
      END $$`.execute(trx)
      await sql`CREATE TRIGGER steelkeep_terminal_notifications AFTER UPDATE OF status ON runs FOR EACH ROW WHEN(OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION steelkeep_queue_terminal_notifications()`.execute(trx)
      await sql`CREATE INDEX runs_created_id ON runs(created_at DESC,id DESC)`.execute(trx)
      await sql`CREATE INDEX artifacts_created_id ON artifacts(created_at DESC,id DESC)`.execute(trx)
      await sql`INSERT INTO steelkeep_migrations(version) VALUES(9)`.execute(trx)
    }
  })
  console.log('Steelkeep metadata schema ready')
} finally { await db.destroy() }
