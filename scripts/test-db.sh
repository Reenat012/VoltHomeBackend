#!/usr/bin/env sh
# Локальная тестовая БД PostgreSQL: отдельный кластер в .testdb/ на порту 54329.
# Другие базы на машине не затрагивает. Использование: sh scripts/test-db.sh start|stop|status|reset|psql
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="$ROOT/.testdb"
DATA="$BASE/data"
LOG="$BASE/postgres.log"
PORT="${TEST_PGPORT:-54329}"
DB="volthome_test"
USERNAME="volthome_test"
PASSWORD="volthome_test_local_only"

find_bin_dir() {
  if command -v postgres >/dev/null 2>&1; then dirname "$(command -v postgres)"; return; fi
  for d in /opt/homebrew/opt/postgresql@16/bin /opt/homebrew/opt/postgresql@17/bin \
           /opt/homebrew/opt/postgresql@15/bin /opt/homebrew/opt/postgresql@14/bin \
           /usr/local/opt/postgresql@17/bin /usr/local/opt/postgresql@16/bin \
           /usr/lib/postgresql/17/bin /usr/lib/postgresql/16/bin /usr/lib/postgresql/15/bin; do
    if [ -x "$d/postgres" ]; then echo "$d"; return; fi
  done
  echo "Не найден сервер PostgreSQL (postgres). Установите: brew install postgresql@16" >&2
  exit 1
}

BIN="$(find_bin_dir)"
export PGPASSWORD="$PASSWORD"
# Без явной локали PostgreSQL на macOS не стартует (ошибка про многопоточный postmaster).
export LC_ALL=en_US.UTF-8
export LANG=en_US.UTF-8

is_running() { "$BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; }

cmd="${1:-status}"
case "$cmd" in
  start)
    mkdir -p "$BASE"
    if [ ! -d "$DATA" ]; then
      echo "Создаю кластер в $DATA"
      printf '%s' "$PASSWORD" > "$BASE/pwfile"
      "$BIN/initdb" -D "$DATA" -U "$USERNAME" -A scram-sha-256 -E UTF8 --locale=en_US.UTF-8 --pwfile="$BASE/pwfile" >/dev/null
      rm -f "$BASE/pwfile"
    fi
    if ! is_running; then
      "$BIN/pg_ctl" -D "$DATA" -l "$LOG" -w \
        -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$BASE" start >/dev/null
    fi
    if ! "$BIN/psql" -h 127.0.0.1 -p "$PORT" -U "$USERNAME" -d postgres -tAc \
         "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1; then
      "$BIN/createdb" -h 127.0.0.1 -p "$PORT" -U "$USERNAME" "$DB"
    fi
    if [ ! -f "$ROOT/.env.test" ]; then cp "$ROOT/.env.test.example" "$ROOT/.env.test"; fi
    echo "Тестовая БД запущена: 127.0.0.1:$PORT/$DB"
    ;;
  stop)
    if [ -d "$DATA" ] && is_running; then "$BIN/pg_ctl" -D "$DATA" -m fast stop >/dev/null; fi
    echo "Тестовая БД остановлена"
    ;;
  status)
    if [ -d "$DATA" ] && is_running; then echo "запущена (порт $PORT)"; else echo "не запущена"; fi
    ;;
  reset)
    "$BIN/psql" -h 127.0.0.1 -p "$PORT" -U "$USERNAME" -d "$DB" -qc \
      "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
    echo "Схема тестовой БД сброшена"
    ;;
  psql)
    shift
    exec "$BIN/psql" -h 127.0.0.1 -p "$PORT" -U "$USERNAME" -d "$DB" "$@"
    ;;
  *)
    echo "Использование: $0 start|stop|status|reset|psql" >&2
    exit 1
    ;;
esac
