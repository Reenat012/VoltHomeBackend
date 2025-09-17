VoltHome Backend (Node.js)

Минимальный API для мобильного приложения
•	GET /health — проверка живости
•	POST /auth/yandex/exchange — мок-обмен на серверную сессию (возвращает sessionJwt)
•	POST /auth/session/refresh — мок-рефреш
•	POST /auth/session/logout — инвалидирует мок-refresh
•	GET /profile/me — защищённый профиль (Authorization: Bearer <sessionJwt>)

Требования
•	Node.js 20.x
•	npm 10+
•	(прод) PM2 6.x

Переменные окружения (.env)

# JWT
SESSION_JWT_SECRET=<случайная_строка>
SESSION_JWT_TTL=3600s

# CORS
# В разработке можно "*". В проде перечисляйте домены через запятую.
CORS_ORIGINS=*

# HTTP
HOST=0.0.0.0
PORT=3000

# Мок-авторизация Яндекс
YANDEX_CLIENT_ID=<id>
YANDEX_CLIENT_SECRET=<secret>

Запуск локально

git clone https://github.com/Reenat012/VoltHomeBackend.git
cd VoltHomeBackend
cp env.example .env
npm install
node server/server.js   # или: npm start, если добавите в package.json

Проверка:

curl -i http://127.0.0.1:3000/health
# {"ok":true,"ts":...}

Структура проекта (важное)

/routes        # /routes/auth.js
/server        # /server/server.js  (импорты вида ../routes/auth.js)
/utils         # /utils/jwt.js

Продакшен

Сервер
•	IP: 147.45.185.209
•	Порт приложения: 3000/tcp (слушается на 0.0.0.0)
•	Процесс-менеджер: PM2 под пользователем deploy
•	Юнит systemd: pm2-deploy.service (запускает pm2-runtime start server/server.js --name volthome-api)

Полезные команды (на сервере):

# статус и логи
systemctl status pm2-deploy --no-pager
journalctl -u pm2-deploy -n 200 --no-pager

# управление приложением
sudo -u deploy pm2 ls
sudo -u deploy pm2 logs volthome-api --lines 100
sudo -u deploy pm2 reload volthome-api
sudo -u deploy pm2 stop volthome-api
sudo -u deploy pm2 start server/server.js --name volthome-api
sudo -u deploy pm2 save   # сохранить процесс-лист для автозапуска

# проверка изнутри
curl -fsS http://127.0.0.1:3000/health

Автодеплой (GitHub Actions → Timeweb)
•	Пуш в ветку main запускает workflow .github/workflows/deploy.yml.
•	Экшн подключается по SSH к пользователю deploy@147.45.185.209, делает:
1.	git fetch/reset до origin/main
2.	npm ci --omit=dev
3.	pm2 reload volthome-api (или start, если нет процесса)
4.	healthcheck GET /health

Секреты репозитория (Settings → Secrets and variables → Actions):
•	SERVER_HOST = 147.45.185.209
•	SERVER_USER = deploy
•	SERVER_PATH = /var/www/VoltHomeBackend
•	SSH_PRIVATE_KEY = приватный ключ для deploy (формат OpenSSH, целиком с -----BEGIN ... / -----END ...)

Если меняли ключ на локальной машине — обновите SSH_PRIVATE_KEY в секретах.

Частые проверки/ошибки
•	curl: (7) Failed to connect
Проверьте, что процесс слушает порт:

ss -tulpen | grep ':3000'

и что firewall/Timeweb Security Group пропускает TCP/3000.

	•	PM2 не стартует при перезагрузке
Убедитесь, что юнит активен и в нём используется pm2-runtime или pm2 resurrect:

systemctl status pm2-deploy
sudo -u deploy pm2 save


	•	Ошибки импорта путей
В server/server.js используйте относительные пути из папки server:

import authRoutes from "../routes/auth.js";
import { authMiddleware } from "../utils/jwt.js";
