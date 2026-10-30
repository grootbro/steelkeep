# Независимая fixture MySQL 8.0.46

Статус на 2026-10-31: написаны Compose overlay, SQL fixture, seed и MCP acceptance. Они **не запускались**. Образ не скачивался, worker не собирался, SQL и TypeScript не исполнялись. MariaDB fixture на порту 54375 не является доказательством работы этого профиля.

## Версии и границы

Используется официальный `mysql:8.0.46` с закреплённым OCI index:

```text
sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b
```

2026-10-31 прочитаны только [метаданные Docker Hub](https://hub.docker.com/v2/repositories/library/mysql/tags/8.0.46/): tag активен, перечислены Linux amd64 и arm64/v8; последнее обновление tag — 2026-05-05. Это проверка метаданных, а не скачанного образа или работающего сервера. Oracle публикует [release notes MySQL 8.0.46 от 2026-04-21](https://dev.mysql.com/doc/relnotes/mysql/8.0/en/news-8-0-46.html).

Worker recipe проекта предусматривает собственные MySQL `mysqldump`/`mysql` версии `8.0.46-0ubuntu0.24.04.4` из Ubuntu 24.04. Acceptance проверяет фактические строки версий сервера, dump и restore, а также отсутствие `MariaDB` в версиях инструментов. Переход на MySQL 8.4/9.x или MariaDB требует отдельного профиля и доказательств. Полный случай преднамеренной подмены клиента MariaDB отдельным worker здесь не реализован; неправильный клиент должен привести к отказу основного сценария, а не к его пропуску.

Сценарий ограничен InnoDB base tables, индексами, FK, CHECK, JSON, `utf8mb4_0900_ai_ci`, точными DECIMAL, unsigned BIGINT, Unicode, binary и auto-increment. Нет routines, triggers, events, views, external/cross-database references, PITR или переноса системных пользователей. `mysqldump` создаёт логический SQL backup; это не физический disaster recovery. См. [официальное описание mysqldump](https://dev.mysql.com/doc/refman/8.0/en/mysqldump.html) и [MySQL CHECK constraints](https://dev.mysql.com/doc/refman/8.0/en/create-table-check-constraints.html).

## Изоляция и разрешения

- Новый сервис `mysql8-fixture`, только `127.0.0.1:54379`, отдельный named volume `mysql8-fixture-data`; существующие datadir и MariaDB не переиспользуются.
- SQL initializer действует при первом старте пустого datadir. Нет `DROP`, `TRUNCATE`, сброса данных или автоматической очистки прошлых восстановлений.
- `backup_reader` получает `SELECT, SHOW VIEW, TRIGGER, EVENT, EXECUTE` только на `source_mysql8.*`. Эти права обеспечивают видимость всего поддерживаемого и неподдерживаемого schema metadata. Отдельное глобальное `RELOAD` нужно для выбранного `FLUSH TABLES WITH READ LOCK`.
- В приложении источник дополнительно требует явного `allowGlobalReadLock:true`. Lock временно останавливает записи **на всём отдельном fixture-сервере**, а не только в исходной БД.
- `restore_writer` ограничен заранее созданной `restore_mysql8.*`. Нет `DROP`, глобальных прав, grant option, создания пользователей или наследуемых ролей. Acceptance создаёт для каждой попытки новую пустую БД и отдельного пользователя с теми же ограничениями.
- Root credential используется исключительно owner harness для подготовки свежих synthetic targets на фиксированном loopback порту. Продукт не использует root для успешного восстановления; negative case проверяет отказ такой конфигурации.

Учётные записи используют `caching_sha2_password`. В локальной fixture задано `tls:false`; самостоятельный CLI должен уметь холодную RSA-аутентификацию, а не зависеть от кеша, прогретого mysql2. MySQL документирует `--get-server-public-key` для [mysqldump](https://dev.mysql.com/doc/refman/8.0/en/mysqldump.html#option_mysqldump_get-server-public-key) и [mysql/остальных клиентов](https://dev.mysql.com/doc/refman/8.0/en/caching-sha2-pluggable-authentication.html). Для обычных удалённых подключений действует политика TLS по умолчанию; публичные fixture-пароли не подходят для реальных сервисов.

Для чтения актуального auto-increment acceptance устанавливает `information_schema_stats_expiry=0`: MySQL может кешировать `TABLES.AUTO_INCREMENT` до 86400 секунд. Обоснование — [официальная документация переменной](https://dev.mysql.com/doc/refman/8.0/en/server-system-variables.html#sysvar_information_schema_stats_expiry). Следующее фактическое INSERT дополнительно проверяет восстановление счётчика 51 при исходном `MAX(id)=2`.

## Будущая ручная последовательность

Ни одна команда ниже в этой задаче не выполнялась. Их можно использовать после разрешения запуска окружения и проверок. Базовые локальные ключи, metadata schema, RustFS bucket и connection `Local S3 · RustFS` должны быть подготовлены по основному README. Worker image должен быть собран из текущего `Dockerfile.engines`, где отдельно установлены оба семейства клиентов.

```sh
docker compose -f compose.yaml -f compose.mysql-fixture.yaml --profile mysql8 up -d --wait mysql8-fixture
docker compose -f compose.yaml -f compose.mysql-fixture.yaml --profile mysql8 --profile application up -d --wait
STEELKEEP_ACCEPTANCE=synthetic-local-mysql bun scripts/seed-mysql8-fixture.ts
STEELKEEP_ACCEPTANCE=synthetic-local-mysql bun test acceptance/mysql8-recovery.test.ts
```

Если используются другие fixture overlays, `compose.mysql-fixture.yaml` ставится последним: его host allowlist включает все текущие fixture hostnames. Новый seed добавляет encrypted connections через общий API и переиспользует существующее локальное S3-хранилище; он не создаёт заменяющее хранилище и не запускает backup. Повторный seed сохраняет существующие источники и цели. Несовпадение fixture-конфигурации вызывает отказ вместо перезаписи.

Acceptance использует официальный MCP client, `run_backup`/`get_job`/`prepare_restore`/`start_restore`; проверяет duplicate request keys, фактический S3 GET и SHA-256, отсутствие `CREATE/DROP DATABASE`, `DROP TABLE` и `USE` в SQL archive. Затем mysql2 независимо читает строки, schema DDL, JSON type, порядок колонок индекса, DECIMAL, BIGINT, Unicode, binary, NULL/empty values и microsecond DATETIME. Реальный INSERT доказывает auto-increment; отрицательные INSERT проверяют unique, FK и CHECK. Отдельные случаи отказывают source alias, непустой цели, повторному использованию target и привилегированному root-target. Исходные строки и schema проверяются повторно после target-операций.

Все свежие databases/users, успешные и частичные targets сохраняются для проверки. Suite не выполняет автоматическое удаление, сброс или cleanup данных. Он не включён в default test script и запускается только при `STEELKEEP_ACCEPTANCE=synthetic-local-mysql`.

## Что пока не подтверждено

Нужны отдельные разрешённые проверки build/typecheck, запуска OCI image и initializer, фактических пакетов/ABI worker, SHA-2 cold-cache CLI authentication, полного native backup/upload/download/restore, независимых assertions и MCP transport/schema compatibility. Отдельная fault-injection проверка подмены MySQL client на MariaDB и UI/browser acceptance пока не выполнены. Ни один написанный test case не считается пройденным.
