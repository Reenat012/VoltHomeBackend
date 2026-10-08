#!/usr/bin/env bash
# Первичная настройка ЧИСТОГО сервера Ubuntu 24.04 под backend ВольтХом.
# Запускается один раз от root. Безопасно запускать повторно (шаги проверяют, что уже сделано).
#
#   scp scripts/server-setup.sh root@IP_СЕРВЕРА:/root/
#   ssh root@IP_СЕРВЕРА 'bash /root/server-setup.sh api.volthome.ru'
#
# Откуда скачивается код (внешние источники):
#   - Ubuntu: обновления системы и fail2ban, ufw, unattended-upgrades (репозитории Ubuntu)
#   - NodeSource (deb.nodesource.com): Node.js 22 LTS (Node 20 снят с поддержки в апреле 2026), в репозитории Ubuntu 24.04 версия другая
#   - Caddy (dl.cloudsmith.io, официальный репозиторий проекта Caddy): веб-сервер с автоматическим HTTPS
#   - npm (registry.npmjs.org): pm2, менеджер процессов
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "Использование: bash server-setup.sh api.volthome.ru" >&2
  exit 2
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите от root (ssh root@...)" >&2
  exit 2
fi

DEPLOY_USER="deploy"
APP_DIR="/var/www/VoltHomeBackend"
export DEBIAN_FRONTEND=noninteractive

say() { echo; echo "==> $1"; }

say "1/9 Обновление системы и базовые пакеты"
apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg ufw fail2ban unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https

say "2/9 Автоматические обновления безопасности"
dpkg-reconfigure -f noninteractive unattended-upgrades || true

say "3/9 Небольшой файл подкачки (если ещё нет): npm ci на 2 ГБ памяти идёт спокойнее"
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "4/9 Node.js 22"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

say "5/9 pm2"
npm install -g pm2
pm2 -v

say "6/9 Пользователь $DEPLOY_USER и каталоги"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
# Ваш ключ (с которым вы вошли под root) даём и пользователю deploy; ключ для GitHub Actions добавляется вручную (см. docs/DEPLOY.md)
if [ -f /root/.ssh/authorized_keys ] && [ ! -f "/home/$DEPLOY_USER/.ssh/authorized_keys" ]; then
  install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /root/.ssh/authorized_keys "/home/$DEPLOY_USER/.ssh/authorized_keys"
fi
install -d -m 755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR" "$APP_DIR/releases" "$APP_DIR/incoming"
if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" <<'ENVEOF'
# Настройки боевого сервера. Заполните значения ВМЕСТО __ЗАПОЛНИТЬ__ (nano /var/www/VoltHomeBackend/.env).
# Пока остаются заготовки, сервер не запустится: так задумано. Подробности: docs/DEPLOY.md
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
CORS_ORIGINS=https://volthome.ru

PGHOST=__ЗАПОЛНИТЬ__
PGPORT=5432
PGDATABASE=__ЗАПОЛНИТЬ__
PGUSER=__ЗАПОЛНИТЬ__
PGPASSWORD=__ЗАПОЛНИТЬ__
PGSSLMODE=require
PG_POOL_MAX=5

JWT_ACCESS_SECRET=__ЗАПОЛНИТЬ__
JWT_REFRESH_SECRET=__ЗАПОЛНИТЬ__

YANDEX_CLIENT_ID=__ЗАПОЛНИТЬ__
YANDEX_CLIENT_SECRET=__ЗАПОЛНИТЬ__
YANDEX_ALLOWED_REDIRECT_URIS=https://volthome.ru/auth/callback.html
ENVEOF
  chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
fi

say "7/9 Автозапуск pm2 для пользователя $DEPLOY_USER"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$DEPLOY_USER" --hp "/home/$DEPLOY_USER" >/dev/null
systemctl enable "pm2-$DEPLOY_USER" >/dev/null 2>&1 || true

say "8/9 Caddy (HTTPS) для $DOMAIN"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi
cat > /etc/caddy/Caddyfile <<CADDYEOF
$DOMAIN {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
    header -Server
}
CADDYEOF
systemctl enable caddy >/dev/null 2>&1 || true
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "9/9 Брандмауэр и SSH"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
# Вход по паролю выключен (на панели Timeweb он тоже отключён); вход root только по ключу
cat > /etc/ssh/sshd_config.d/99-volthome.conf <<'SSHEOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
SSHEOF
sshd -t && systemctl reload ssh
systemctl enable --now fail2ban >/dev/null 2>&1 || true

echo
echo "Готово. Дальше:"
echo "  1) заполните $APP_DIR/.env (пароль базы, секреты JWT, Яндекс)"
echo "  2) создайте в DNS запись $DOMAIN -> IP этого сервера"
echo "  3) настройте GitHub Actions и сделайте первую выкладку (docs/DEPLOY.md)"
