#!/bin/sh
# Disposable synthetic daemon only. No production data, host ports or system install.
set -eu
engine=${1:?Choose mysql or mariadb}
prefix=/opt/steelkeep-sqlclients
test "${STEELKEEP_SQLCLIENTS_FIXTURE:-}" = synthetic-core-14bafed8114d2c726a31e7040b155f28
test -d /data
test ! -e /data/ready
case "$engine" in
  mysql) vendor=mysql8; server=mysqld; client=mysql ;;
  mariadb) vendor=mariadb11; server=mariadbd; client=mariadb ;;
  *) exit 64 ;;
esac
base=$prefix/$vendor/usr
export LD_LIBRARY_PATH="$base/lib/x86_64-linux-gnu:$prefix/$vendor/lib/x86_64-linux-gnu:$prefix/common/usr/lib/x86_64-linux-gnu:$prefix/common/lib/x86_64-linux-gnu"
export PATH="$prefix/bin:$base/bin:/usr/bin:/bin"
if [ "$engine" = mysql ]; then
  "$base/sbin/mysqld" --no-defaults --initialize-insecure --basedir="$base" --datadir=/data --innodb-buffer-pool-size=32M --innodb-redo-log-capacity=16M --performance-schema=OFF --log-error=/data/initialize.log || { tail -n 50 /data/initialize.log; exit 1; }
  "$base/sbin/mysqld" --no-defaults --basedir="$base" --datadir=/data --socket=/data/server.sock --pid-file=/data/server.pid --bind-address=0.0.0.0 --port=3306 --mysqlx=0 --skip-log-bin --skip-name-resolve --local-infile=0 --secure-file-priv=NULL --innodb-buffer-pool-size=32M --innodb-redo-log-capacity=16M --innodb-use-native-aio=0 --performance-schema=OFF --max-connections=20 --information-schema-stats-expiry=0 --log-error=/data/server.log &
else
  sh "$base/bin/mariadb-install-db" --no-defaults --basedir="$base" --datadir=/data --auth-root-authentication-method=normal --skip-test-db > /data/initialize.log 2>&1 || { tail -n 50 /data/initialize.log; exit 1; }
  "$base/sbin/mariadbd" --no-defaults --basedir="$base" --datadir=/data --socket=/data/server.sock --pid-file=/data/server.pid --bind-address=0.0.0.0 --port=3306 --skip-log-bin --skip-name-resolve --local-infile=0 --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci --innodb-buffer-pool-size=32M --innodb-log-file-size=16M --innodb-use-native-aio=0 --performance-schema=OFF --max-connections=20 --log-error=/data/server.log &
fi
pid=$!
trap 'status=$?; if [ "$status" -ne 0 ]; then tail -n 50 /data/server.log 2>/dev/null || true; fi; kill -TERM "$pid" 2>/dev/null || true; wait "$pid" || true' EXIT HUP INT TERM
ready=false
for attempt in $(seq 1 90); do
  if "$client" --no-defaults --protocol=SOCKET --socket=/data/server.sock --user=root --batch --skip-column-names --execute='SELECT 1' >/dev/null 2>&1; then ready=true; break; fi
  kill -0 "$pid"
  sleep 1
done
test "$ready" = true
"$client" --no-defaults --protocol=SOCKET --socket=/data/server.sock --user=root < "/fixtures/$engine.sql"
touch /data/ready
printf '%s\n' "Synthetic $engine fixture ready; data lives only in capped tmpfs."
wait "$pid"
