# UI recovery acceptance: PostgreSQL 17 и MariaDB 11

Здесь находятся настоящие browser-сценарии поверх текущих `src/workspace.tsx`, `src/forms.tsx` и `src/ui.tsx`. **31 октября 2026 root выполнил оба сценария: 2 passed за 28.5 секунды** — PostgreSQL 14.2 s, MariaDB 13.5 s. Это реальный запуск после исправления select locators и backend validation, а не результат одного написания tests.

## Зафиксированный запуск

Точная команда root из корня проекта:

```sh
STEELKEEP_ACCEPTANCE=synthetic-local-ui DATABASE_URL=postgres://steelkeep:local-metadata-only@127.0.0.1:54371/steelkeep bunx playwright test --config=playwright.config.ts
```

Console результат, exec session `56332`, exit code `0`:

```text
2 passed (28.5s)
```

После этого запуска отдельно прочитан локальный [`.last-run.json`](../../test-results/ui-recovery/.last-run.json): `status: "passed"`, `failedTests: []`. Этот служебный файл не содержит полного отчёта и может быть заменён следующим запуском. Полный JSON report не сохранялся; количество сценариев и timings подтверждены console output root.

Дополнительно root независимо прочитал metadata: последние четыре UI-created operation rows — два backup и два restore — имели `succeeded`, оба restore содержали validation `passed`. Сам suite также выполнял независимые SQL и S3 assertions, описанные ниже. Утверждение относится к этому изолированному запуску PostgreSQL 17 и MariaDB 11.

## Что требуется перед запуском

Owner отдельно запускает разрешённый изолированный stack. Playwright config не содержит `webServer`, не устанавливает browser binaries, не собирает image, не поднимает сервисы и не делает reset данных.

- UI: строго `http://127.0.0.1:4310`; API proxy: `http://127.0.0.1:4311`.
- Metadata: строго `postgres://steelkeep:local-metadata-only@127.0.0.1:54371/steelkeep`, PostgreSQL 17 с текущими миграциями.
- PostgreSQL fixture admin: loopback 54372, `fixture_admin`, публичный fixture password `local-fixture-only`.
- MariaDB fixture admin: loopback 54375, `root`, публичный fixture password `local-mariadb-fixture-only`.
- RustFS: loopback 54373, публичные synthetic credentials `steelkeep-local` / `local-s3-fixture-only`.
- API и worker должны разрешать Docker internal endpoints `fixture`, `mysql-fixture`, `s3` и действительно достигать их. В UI создаются именно эти addresses, а не произвольные сохранённые подключения.
- Worker должен иметь настоящие `pg_dump/pg_restore 17`, `mariadb-dump/mariadb 11`, Linux `prlimit`, доступ к encryption key и тот же metadata database. Source роли получают только read/metadata права; для MariaDB отдельно разрешены `RELOAD` и явный UI opt-in на server-wide read lock.
- Установленные `@playwright/test`, Chromium, node/bun, mysql2, pg и AWS SDK должны работать на используемой машине. Сценарии рассчитаны на один headless Chromium desktop context 1440×1000; ARM/amd64 native image, ABI и доступность browser package проверяются владельцем окружения отдельно.

Перед любыми CREATE ROLE/DB/USER, S3 и UI-командами suite проверяет точный metadata URL, фактическое имя/пользователя/major PostgreSQL и мигрированные tables. Metadata соединения только read-only. Если в metadata есть non-fixture database/storage profiles, suite отказывает без очистки: для него требуется отдельное synthetic окружение.

Команда для повторного запуска после отдельной подготовки окружения:

```sh
STEELKEEP_ACCEPTANCE=synthetic-local-ui \
DATABASE_URL=postgres://steelkeep:local-metadata-only@127.0.0.1:54371/steelkeep \
bunx playwright test --config=playwright.config.ts
```

Не использовать production credentials, SSH tunnels или иные endpoints вместо фиксированных fixture ports. Guard не является способом переназначить существующий реальный проект. Suite не импортируется default unit test command; package scripts в этой работе не менялись.

## Сценарий и независимые доказательства

Для каждого engine owner harness создаёт новую synthetic source DB, отдельную пустую target DB, ограниченные reader/writer credentials и собственный bucket. PostgreSQL source содержит 1,000 строк, точную сумму `625625.00`, sparse physical layout после DROP одного column slot, Unicode и bytea; identity после восстановления должна выдать project ID 2. MariaDB source содержит три InnoDB строки с суммой `7.50`, Unicode/binary, FK/CHECK и auto-increment 41 при `MAX(id)=1`.

Все продуктовые команды проходят через UI:

1. Реальный login через password input `Installation token`.
2. `Connections` → `Add connection`: source, destination-only target и S3. Для MariaDB source явно отмечается checkbox блокировки записей; fixture TLS checkbox отключается только для этих локальных endpoints. Реальный `Test connection` проверяется по UI и HTTP result.
3. `Backup plans` → `Create plan`: только только что созданные source/storage, manual-only, `Asia/Bangkok`.
4. `Run backup` → `Job details`: ID реального принятого задания, фазы из реального job log и terminal `succeeded`. Для маленькой fixture transient `running` может закончиться до следующего UI poll: вместо искусственной задержки проверяется сохранённая последовательность фаз.
5. `Snapshots` → `Check availability`: проверяется `object-head-only`, UI cached check time и сообщение, что полные bytes не проверены. Snapshot всё ещё `Not restored`; никакого restore job от availability check не появилось.
6. Независимый S3 GET проверяет фактический размер и SHA-256; для PostgreSQL дополнительно требуется native `PGDMP` header, для MariaDB — native dump header.
7. `Restore` → `Check destination` → review с точными source/target names. `Start restore` должен быть disabled до явного confirmation checkbox.
8. Реальное restore задание проходит фазы download/hash/restore/validation. В UI должны быть `Restore validation Passed` и отдельные `Verified` для SHA, schema, data, sequences.
9. Прямые независимые SQL connections подтверждают count/sum, Unicode/binary, identity/auto-increment, сохранённый исходник и FK/CHECK обоих engines по фактическим server error codes. PG проверяет один dropped slot в исходнике и отсутствие slot в логически восстановленной target. Snapshot показывает `Validation: passed`.

HTTP responses читаются только для корреляции реальных UI-команд с IDs. Metadata SQL используется только read-only для корреляции API с guarded DB и фактического published artifact. Нет `page.route`, fake workers, mocked job success, intercepted database responses или вставки ожидаемых данных в restore target.

Sources, targets, роли/пользователи, buckets, objects и recovery history сохраняются. Ничего не удаляется, не сбрасывается и не очищается при ошибке; неопределённая target остаётся для разбора.

## Секреты и артефакты запуска

Trace, video, HAR, storageState export, persistent context и debug/protocol logs отключены. Config отказывает при `DEBUG`, `NODE_DEBUG`, `PWDEBUG` и recording/interactive CLI flags. Автоматический Playwright failure DOM-copy prompt отключён для текущей закреплённой версии.

Credential inputs заполняются через private in-memory browser binding и настоящие DOM input/change events. Так значение password/token не попадает в аргумент `fill(value)`, который Playwright способен записать в failure call log. Binding работает только в основном frame фиксированного local origin. Сам form и его HTTP requests остаются настоящими.

Автоматические screenshots отключены. После failure удаляются credential values из DOM и сохраняется только screenshot с маской всех `input/textarea`. Credentials и auth cookies не экспортируются; ни console, ни network body/token не прикладываются к отчёту. Не переопределять эти настройки через CLI, другой config или сторонние reporters при использовании настоящего installation token.

## Оставшиеся проверки

Указанный запуск подтвердил browser/SDK взаимодействие, native tools, fixture roles, Docker endpoints, metadata/API correlation, dropped-column normalization и UI flow для конкретного локального окружения. Один успешный прогон не подтверждает другие OS/architectures/versions, длительную повторяемость, нагрузку или fault-injection сценарии.

Эти tests не доказывают physical-device/mobile UX, keyboard-only/a11y acceptance, production readiness, PITR, другие engines или business-level восстановление приложения. Full machine-readable report и success screenshots в этом прогоне не сохранялись. При изменении Playwright version отдельно перепроверить privacy flags и поведение failure artifacts.
