#!/usr/bin/env bash
# Заполняет настройки базы и секреты в .env на сервере и проверяет подключение к базе.
# Запускается на сервере от root (ssh -t, чтобы пароль вводился скрытно):
#
#   scp scripts/configure-env.sh root@IP_СЕРВЕРА:/root/
#   ssh -t root@IP_СЕРВЕРА 'bash /root/configure-env.sh 192.168.0.4 default_db gen_user'
#
# Пароль базы вводится скрытно (на экране и в истории команд его нет). Два секрета JWT создаются здесь же, случайные,
# и никуда не показываются. Повторный запуск секреты не меняет (иначе все пользователи вышли бы из аккаунтов).
# Остальное в .env (Яндекс, CORS) скрипт не трогает.
set -euo pipefail

HOST="${1:-}"; DB="${2:-}"; USER_NAME="${3:-}"
if [ -z "$HOST" ] || [ -z "$DB" ] || [ -z "$USER_NAME" ]; then
  echo "Использование: bash configure-env.sh АДРЕС_БАЗЫ ИМЯ_БАЗЫ ПОЛЬЗОВАТЕЛЬ" >&2
  exit 2
fi
ENV_FILE="${ENV_FILE:-/var/www/VoltHomeBackend/.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "Нет файла $ENV_FILE: сначала запустите server-setup.sh" >&2
  exit 2
fi

read -r -s -p "Пароль базы (вставьте и нажмите Enter, символы не видны): " DB_PASSWORD
echo
if [ -z "$DB_PASSWORD" ]; then echo "Пароль пустой" >&2; exit 2; fi

export CFG_ENV_FILE="$ENV_FILE" CFG_HOST="$HOST" CFG_DB="$DB" CFG_USER="$USER_NAME" CFG_PASSWORD="$DB_PASSWORD"
python3 - <<'PY'
import os, secrets, sys

path = os.environ["CFG_ENV_FILE"]
password = os.environ["CFG_PASSWORD"]

def quote(value):
    # dotenv: в одинарных кавычках значение читается как есть
    if "\n" in value or "\r" in value:
        sys.exit("В пароле перевод строки: так нельзя")
    if "'" not in value:
        return "'" + value + "'"
    if '"' not in value and "\\" not in value and "$" not in value:
        return '"' + value + '"'
    sys.exit("Пароль содержит одинарную кавычку вместе с другими спецсимволами: смените пароль базы на более простой")

updates = {
    "PGHOST": os.environ["CFG_HOST"],
    "PGDATABASE": os.environ["CFG_DB"],
    "PGUSER": os.environ["CFG_USER"],
    "PGPASSWORD": quote(password),
    "PGSSLMODE": "require",
}
lines = open(path, encoding="utf-8").read().split("\n")

def current(key):
    for line in lines:
        if line.startswith(key + "="):
            return line[len(key) + 1:]
    return None

for key in ("JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"):
    value = current(key)
    if value is None or "__ЗАПОЛНИТЬ__" in value or len(value.strip("'\"")) < 32:
        updates[key] = secrets.token_urlsafe(48)

out, seen = [], set()
for line in lines:
    key = line.split("=", 1)[0]
    if key in updates and "=" in line and not line.startswith("#"):
        out.append(f"{key}={updates[key]}")
        seen.add(key)
    else:
        out.append(line)
for key, value in updates.items():
    if key not in seen:
        out.append(f"{key}={value}")
text = "\n".join(out)
if not text.endswith("\n"):
    text += "\n"
tmp = path + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write(text)
os.replace(tmp, path)
print("Записано в .env:", ", ".join(sorted(updates)).replace("PGPASSWORD", "PGPASSWORD (скрыт)"))
PY

# права как у заготовки: читает только владелец (deploy)
if id deploy >/dev/null 2>&1; then chown deploy:deploy "$ENV_FILE"; fi
chmod 600 "$ENV_FILE"

if ! command -v psql >/dev/null 2>&1; then
  echo "Устанавливаю psql (клиент PostgreSQL) для проверки подключения..."
  DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-client >/dev/null
fi

echo
echo "Проверка подключения к базе $HOST:"
PGPASSWORD="$DB_PASSWORD" PGSSLMODE=require psql -h "$HOST" -p 5432 -U "$USER_NAME" -d "$DB" -v ON_ERROR_STOP=1 -X -q \
  -c "select version();" \
  -c "select name from pg_available_extensions where name in ('uuid-ossp','pgcrypto') order by name;" \
  -c "select rolsuper, rolcreatedb from pg_roles where rolname = current_user;"
echo
echo "Готово: подключение работает."
