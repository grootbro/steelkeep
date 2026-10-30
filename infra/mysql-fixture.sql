-- Disposable MariaDB fixture. Does not run against any user database.
CREATE DATABASE IF NOT EXISTS source_mysql;
CREATE DATABASE IF NOT EXISTS restore_mysql;
CREATE USER 'backup_reader'@'%' IDENTIFIED BY 'local-mysql-reader-only';
CREATE USER 'restore_writer'@'%' IDENTIFIED BY 'local-mysql-writer-only';
GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, EXECUTE ON source_mysql.* TO 'backup_reader'@'%';
GRANT RELOAD ON *.* TO 'backup_reader'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, CREATE VIEW, SHOW VIEW, TRIGGER, EVENT, EXECUTE, LOCK TABLES ON restore_mysql.* TO 'restore_writer'@'%';
USE source_mysql;
CREATE TABLE projects(id BIGINT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(200) NOT NULL UNIQUE) ENGINE=InnoDB;
CREATE TABLE entries(id BIGINT PRIMARY KEY AUTO_INCREMENT, project_id BIGINT NOT NULL, body VARCHAR(200) NOT NULL, amount DECIMAL(12,2) NOT NULL CHECK(amount>=0), FOREIGN KEY(project_id) REFERENCES projects(id)) ENGINE=InnoDB;
INSERT INTO projects(name) VALUES ('Synthetic MariaDB recovery fixture');
INSERT INTO entries(project_id,body,amount) VALUES (1,'Synthetic row one',1.25),(1,'Synthetic row two',2.50),(1,'Synthetic row three',3.75);
