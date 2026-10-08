#!/usr/bin/env bash
# Записывает данные приложения Яндекса в .env на сервере и перезапускает приложение.
# Запускается на сервере от root (ssh -t, чтобы секрет вводился скрытно):
#
#   scp scripts/configure-yandex.sh root@IP_СЕРВЕРА:/root/
#   ssh -t root@IP_СЕРВЕРА 'bash /root/configure-yandex.sh ID_ПРИЛОЖЕНИЯ'
#
# ID приложения не секретный (его видно на странице сайта). Пароль (секрет) приложения вводится скрытно и
# нигде не показывается. Адрес возврата для сайта: https://volthome.ru/auth/callback.html (его можно переопределить
# вторым аргументом, несколько адресов через запятую).
set -euo pipefail

CLIENT_ID="${1:-}"
REDIRECTS="${2:-https://volthome.ru/auth/callback.html}"
if [ -z "$CLIENT_ID" ]; then
  echo "Использование: bash configure-yandex.sh ID_ПРИЛОЖЕНИЯ [адреса_возврата_через_запятую]" >&2
  exit 2
fi
if ! printf '%s' "$CLIENT_ID" | grep -Eq '^[0-9a-f]{32}$'; then
  echo "ID приложения Яндекса выглядит иначе (ожидается 32 символа 0-9 a-f)" >&2
  exit 2
fi
APP_DIR="${APP_DIR:-/var/www/VoltHomeBackend}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "Нет файла $ENV_FILE: сначала запустите server-setup.sh" >&2
  exit 2
fi

read -r -s -p "Пароль (секрет) приложения Яндекса: " SECRET
echo
if [ -z "$SECRET" ]; then echo "Секрет пустой" >&2; exit 2; fi
if printf '%s' "$SECRET" | grep -Eq "[^A-Za-z0-9_.-]"; then
  echo "В секрете есть необычные символы: проверьте, что скопировали только его" >&2
  exit 2
fi

export CFG_ENV_FILE="$ENV_FILE" CFG_ID="$CLIENT_ID" CFG_SECRET="$SECRET" CFG_REDIRECTS="$REDIRECTS"
python3 - <<'PY'
import os

path = os.environ["CFG_ENV_FILE"]
updates = {
    "YANDEX_CLIENT_ID": os.environ["CFG_ID"],
    "YANDEX_CLIENT_SECRET": os.environ["CFG_SECRET"],
    "YANDEX_ALLOWED_REDIRECT_URIS": os.environ["CFG_REDIRECTS"],
}
lines = open(path, encoding="utf-8").read().split("\n")
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
print("Записано в .env: " + ", ".join(sorted(updates)).replace("YANDEX_CLIENT_SECRET", "YANDEX_CLIENT_SECRET (скрыт)"))
PY

if id deploy >/dev/null 2>&1; then chown deploy:deploy "$ENV_FILE"; fi
chmod 600 "$ENV_FILE"

# Работающее приложение читает свою копию .env из каталога релиза (её кладёт выкладка): обновляем и её, затем перезапуск
CURRENT="$APP_DIR/current"
if [ -L "$CURRENT" ]; then
  RELEASE="$(readlink -f "$CURRENT")"
  install -m 600 -o deploy -g deploy "$ENV_FILE" "$RELEASE/.env"
  if su - deploy -c 'pm2 describe volthome-api >/dev/null 2>&1'; then
    su - deploy -c 'pm2 reload volthome-api --update-env >/dev/null && pm2 save >/dev/null'
    echo "Приложение перезапущено."
  fi
fi
echo "Готово."
