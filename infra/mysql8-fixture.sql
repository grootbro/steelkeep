-- Disposable, independent MySQL 8.0.46 fixture. Not MariaDB.
-- Official entrypoint applies this only when the new named datadir is empty.
-- No DROP, TRUNCATE, reset, cross-database reference, routine, event or trigger.
SET NAMES utf8mb4;
SET time_zone='+00:00';
CREATE DATABASE source_mysql8 CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE restore_mysql8 CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE source_mysql8;
CREATE TABLE projects(
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(190) NOT NULL,
  CONSTRAINT projects_name_unique UNIQUE(name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE TABLE entries(
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT UNSIGNED NOT NULL,
  external_id BIGINT UNSIGNED NOT NULL,
  body TEXT NOT NULL,
  amount DECIMAL(18,4) NOT NULL,
  binary_value VARBINARY(64) NOT NULL,
  optional_text VARCHAR(100) NULL,
  payload JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  CONSTRAINT entries_external_unique UNIQUE(external_id),
  CONSTRAINT entries_project_fk FOREIGN KEY(project_id) REFERENCES projects(id),
  CONSTRAINT entries_amount_nonnegative CHECK(amount>=0),
  CONSTRAINT entries_payload_object CHECK(JSON_TYPE(payload)='OBJECT'),
  INDEX entries_project_created(project_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
INSERT INTO projects(name) VALUES('Synthetic MySQL 8 fixture'),('Проект 🚀');
INSERT INTO entries(project_id,external_id,body,amount,binary_value,optional_text,payload,created_at) VALUES
  (1,9007199254740993,'Synthetic first row',1.2500,X'00FF7F0041',NULL,JSON_OBJECT('label','first','nested',JSON_OBJECT('active',CAST('true' AS JSON))),'2026-01-02 03:04:05.123456'),
  (2,18446744073709551615,'Русский текст, café, 🚀',2.5000,X'FF00800102','',JSON_OBJECT('label','unicode 🚀','tags',JSON_ARRAY('one','два')),'2026-02-03 04:05:06.654321'),
  (1,0,'Exact decimal and nullable fixture',123456789.1250,X'00010200FF','fixture',JSON_OBJECT('label','decimal','nullable',NULL),'2026-03-04 05:06:07.000001');
-- A counter beyond MAX(id) proves state recovery rather than merely MAX(id)+1.
ALTER TABLE projects AUTO_INCREMENT=51;

CREATE USER 'backup_reader'@'%' IDENTIFIED WITH caching_sha2_password BY 'local-mysql8-reader-only';
CREATE USER 'restore_writer'@'%' IDENTIFIED WITH caching_sha2_password BY 'local-mysql8-writer-only';
-- Metadata visibility prevents hidden unsupported routines/views from being
-- mistaken for absence. The worker never calls application routines.
GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, EXECUTE ON source_mysql8.* TO 'backup_reader'@'%';
-- Explicit source opt-in is also required by the application before FTWRL.
GRANT RELOAD ON *.* TO 'backup_reader'@'%';
-- Target privileges stay inside the already created empty target. No global
-- privilege, DROP, CREATE USER, CREATE DATABASE, GRANT OPTION or role inheritance.
GRANT SELECT, INSERT, CREATE, ALTER, INDEX, REFERENCES, SHOW VIEW, TRIGGER, EVENT, EXECUTE, LOCK TABLES ON restore_mysql8.* TO 'restore_writer'@'%';
