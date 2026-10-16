#!/usr/bin/env bash
# Записывает ключи RuStore Public API в .env сервера и включает настоящую проверку покупок.
# Запускается на сервере от пользователя deploy (ssh -t, чтобы вводилось в терминале):
#
#   scp ~/Downloads/rustore_private_key.pem deploy@IP_СЕРВЕРА:/tmp/rustore.pem
#   scp scripts/set-rustore-keys.sh deploy@IP_СЕРВЕРА:/tmp/
#   ssh -t deploy@IP_СЕРВЕРА 'bash /tmp/set-rustore-keys.sh /tmp/rustore.pem'
#
# Приватный ключ читается из файла, на экран и в историю команд не попадает; файл после записи удаляется.
# Пишет в основной .env (его копирует каждый деплой) и в .env работающего релиза, затем перезапускает приложение.
set -euo pipefail

KEY_FILE="${1:-}"
if [ -z "$KEY_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  echo "Использование: bash set-rustore-keys.sh ФАЙЛ_С_ПРИВАТНЫМ_КЛЮЧОМ" >&2
  exit 2
fi
MASTER_ENV="${MASTER_ENV:-/var/www/VoltHomeBackend/.env}"
CURRENT_ENV="${CURRENT_ENV:-/var/www/VoltHomeBackend/current/.env}"
[ -f "$MASTER_ENV" ] || { echo "Нет файла $MASTER_ENV" >&2; exit 2; }

read -r -p "Key ID (идентификатор ключа API из консоли RuStore): " KEY_ID
read -r -p "ID приложения в консоли RuStore (число): " APP_ID
SANDBOX="false"
read -r -p "Проверять тестовые покупки (песочница)? [y/N]: " ANSWER
case "${ANSWER:-n}" in y|Y) SANDBOX="true" ;; esac
if [ -z "$KEY_ID" ] || [ -z "$APP_ID" ]; then echo "Key ID и ID приложения обязательны" >&2; exit 2; fi

export RS_KEY_FILE="$KEY_FILE" RS_KEY_ID="$KEY_ID" RS_APP_ID="$APP_ID" RS_SANDBOX="$SANDBOX"
export RS_FILES="$MASTER_ENV:$CURRENT_ENV"
python3 - <<'PY'
import os, re, sys

key = open(os.environ["RS_KEY_FILE"], encoding="utf-8").read().strip()
if "PRIVATE KEY" not in key and len(key) < 100:
    sys.exit("Файл не похож на приватный ключ")
# в .env ключ хранится одной строкой с \n (так его читает сервер)
key_line = '"' + key.replace("\r", "").replace("\n", "\\n").replace('"', '\\"') + '"'

updates = {
    "BILLING_REAL_VERIFY_ENABLED": "true",
    "BILLING_STRICT_CONFIRM_VALIDATION_ENABLED": "true",
    "RUSTORE_VERIFY_STUB": "false",
    "RUSTORE_KEY_ID": os.environ["RS_KEY_ID"].strip(),
    "RUSTORE_CONSOLE_APP_ID": os.environ["RS_APP_ID"].strip(),
    "RUSTORE_PRIVATE_KEY": key_line,
    "RUSTORE_USE_SANDBOX": os.environ["RS_SANDBOX"],
}
for path in os.environ["RS_FILES"].split(":"):
    if not os.path.isfile(path):
        print(f"пропускаю (нет файла): {path}")
        continue
    lines = open(path, encoding="utf-8").read().split("\n")
    for name, value in updates.items():
        entry = f"{name}={value}"
        for i, line in enumerate(lines):
            if re.match(rf"^{re.escape(name)}=", line):
                lines[i] = entry
                break
        else:
            while lines and lines[-1] == "":
                lines.pop()
            lines.append(entry)
    text = "\n".join(lines).rstrip("\n") + "\n"
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(path, 0o600)
    print(f"записано: {path}")
PY

rm -f "$KEY_FILE"
echo "Файл с ключом удалён."
if [ "${SKIP_RESTART:-0}" != "1" ]; then
  pm2 restart volthome-api --update-env >/dev/null
  echo "Приложение перезапущено."
fi
echo "Готово. Значения (кроме ключа) в .env:"
grep -E "^(BILLING_|RUSTORE_VERIFY_STUB|RUSTORE_KEY_ID|RUSTORE_CONSOLE_APP_ID|RUSTORE_USE_SANDBOX)" "$MASTER_ENV" || true
echo "RUSTORE_PRIVATE_KEY: $(grep -c '^RUSTORE_PRIVATE_KEY=' "$MASTER_ENV") строка (значение не показываю)"
