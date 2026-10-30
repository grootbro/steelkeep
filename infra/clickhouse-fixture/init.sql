-- Fresh named volume only. No IF NOT EXISTS hiding stale or modified fixture data.
CREATE DATABASE fixture_ch_source ENGINE = Atomic;
CREATE DATABASE fixture_ch_target ENGINE = Atomic;
CREATE TABLE fixture_ch_source.entries
(
  id UInt64,
  label String,
  amount Decimal(18, 4),
  optional Nullable(Int64),
  tags Array(String),
  occurred DateTime64(3, 'UTC'),
  fixed FixedString(4)
) ENGINE = MergeTree ORDER BY id;
INSERT INTO fixture_ch_source.entries VALUES
  (1, 'alpha', 12.3400, NULL, ['a','b'], '2026-01-02 03:04:05.678', 'abcd'),
  (2, 'Юникод', -0.0001, -7, [], '2026-02-03 04:05:06.001', 'wxyz'),
  (3, 'comma,quote"line', 9007199254.7409, 9223372036854775807, ['x'], '2026-03-04 05:06:07.999', '0123');
CREATE USER fixture_owner IDENTIFIED WITH sha256_password BY 'local-clickhouse-owner-only';
-- Fixture owner is intentionally outside the application's registered connections.
GRANT ALL ON *.* TO fixture_owner WITH GRANT OPTION;
CREATE USER backup_reader IDENTIFIED WITH sha256_password BY 'local-clickhouse-reader-only';
CREATE USER restore_writer IDENTIFIED WITH sha256_password BY 'local-clickhouse-writer-only';
GRANT SELECT, SHOW TABLES, BACKUP ON fixture_ch_source.* TO backup_reader;
GRANT SELECT, INSERT, CREATE TABLE, SHOW TABLES ON fixture_ch_target.* TO restore_writer;
-- Exact adapter inspection surface; no SELECT ON system.* shortcut.
GRANT SELECT ON system.databases TO backup_reader, restore_writer;
GRANT SELECT ON system.tables TO backup_reader, restore_writer;
GRANT SELECT ON system.columns TO backup_reader, restore_writer;
GRANT SELECT ON system.data_skipping_indices TO backup_reader, restore_writer;
GRANT SELECT ON system.projections TO backup_reader, restore_writer;
GRANT SELECT ON system.detached_tables TO backup_reader, restore_writer;
GRANT SELECT ON system.dictionaries TO backup_reader, restore_writer;
GRANT SELECT ON system.grants TO backup_reader, restore_writer;
GRANT SELECT ON system.role_grants TO backup_reader, restore_writer;
GRANT SELECT ON system.enabled_roles TO backup_reader, restore_writer;
GRANT SELECT ON system.row_policies TO backup_reader, restore_writer;
GRANT SELECT ON system.disks TO backup_reader, restore_writer;
GRANT SELECT ON system.backups TO backup_reader, restore_writer;
GRANT SELECT ON system.mutations TO backup_reader, restore_writer;
GRANT SELECT ON system.asynchronous_inserts TO backup_reader, restore_writer;
GRANT SELECT ON system.replicas TO backup_reader, restore_writer;
GRANT SELECT ON system.clusters TO backup_reader, restore_writer;
GRANT SELECT ON system.functions TO backup_reader, restore_writer;
GRANT SELECT ON system.parts TO backup_reader, restore_writer;
GRANT SHOW USERS, SHOW ROLES, SHOW ROW POLICIES ON *.* TO backup_reader, restore_writer;
-- No grants permit the application source user to write. Only fixture_owner can
-- change the source; acceptance must not use it while capture is in progress.
