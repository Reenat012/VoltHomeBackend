# VoltHome Backend (Node.js)

Минимальный API для мобильного приложения + **поддержка проектов и синхронизации**.

---

## 📌 Эндпоинты

### Базовые
- `GET /health` — проверка живости (200 OK).
- `GET /healthz` — healthcheck c JSON `{ ok: true, ts: ... }`.
- `POST /auth/yandex/exchange` — мок-обмен Яндекс-кода/uid на серверную сессию (возвращает `sessionJwt`).
- `POST /auth/session/refresh` — мок-рефреш.
- `POST /auth/session/logout` — инвалидирует мок-refresh.
- `GET /profile/me` — защищённый профиль (`Authorization: Bearer <sessionJwt>`).

### Проекты и синхронизация (v1)
- `GET /v1/projects?since=timestamp&limit=50` — список проектов пользователя (пагинация по `updated_at`).
- `POST /v1/projects` — создать проект `{ id? (uuid), name, note? }` → `version=1`.
- `GET /v1/projects/{id}` — получить проект целиком (единое JSON-дерево: `project`, `rooms`, `groups`, `devices`).
- `PUT /v1/projects/{id}` — обновить метаданные `{ name?, note? }` → `version++`.
- `DELETE /v1/projects/{id}` — мягкое удаление (`is_deleted=true`, `version++`).
- `GET /v1/projects/{id}/delta?since=timestamp` — дельта-изменения по сущностям (`rooms`,`groups`,`devices`) с `updated_at > since`.
- `POST /v1/projects/{id}/batch` — батч-запись изменений (upsert/delete по сущностям) с проверкой `baseVersion` и стратегией конфликтов **LWW**.

**Пример батча:**
```json
{
  "baseVersion": 12,
  "ops": {
    "rooms":   { "upsert": [...], "delete": ["uuid1","uuid2"] },
    "groups":  { "upsert": [...], "delete": [] },
    "devices": { "upsert": [...], "delete": [] }
  }
}
```

**Пример ответа:**
```json
{
  "newVersion": 13,
  "conflicts": [
    { "entity":"devices","id":"uuidX","reason":"Stale baseVersion; server wins (LWW)" }
  ]
}
```

Swagger / OpenAPI
	•	UI: http://127.0.0.1:3000/docs
	•	Файл спецификации: docs/openapi.yaml

⸻

⚙️ Требования
	•	Node.js 20.x
	•	npm 10+
	•	PostgreSQL 14+
	•	(прод) PM2 6.x

⸻

🔑 Переменные окружения (.env)

# JWT
SESSION_JWT_SECRET=<случайная_строка>
SESSION_JWT_TTL=3600s

# CORS (в dev можно "*", в prod — домены через запятую)
CORS_ORIGINS=*

# HTTP
HOST=0.0.0.0
PORT=3000

# Мок-авторизация Яндекс
YANDEX_CLIENT_ID=<id>
YANDEX_CLIENT_SECRET=<secret>

# PostgreSQL
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=volthome
PGUSER=volthome
PGPASSWORD=volthome_password
PGSSLMODE=disable   # либо require/verify-full

# Rate limiting
RATE_LIMIT_DELTA_PER_MIN=60
RATE_LIMIT_BATCH_PER_MIN=30


⸻

🚀 Быстрый старт локально

git clone https://github.com/Reenat012/VoltHomeBackend.git
cd VoltHomeBackend
cp env.example .env
npm install

# инициализация БД (один раз)
npm run migrate

# запуск
npm start

Проверка:

curl -i http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/healthz | jq

Получить sessionJwt:

SESSION=$(curl -s -X POST http://127.0.0.1:3000/auth/yandex/exchange \
  -H "Content-Type: application/json" \
  -d '{"uid":"demo-user"}' | jq -r .sessionJwt)

curl -s http://127.0.0.1:3000/profile/me -H "Authorization: Bearer $SESSION" | jq


⸻

🗄️ Схема БД и миграции

Основные таблицы:
	•	projects(id uuid pk, user_id text, name text, note text, version int, created_at, updated_at, is_deleted bool)
	•	rooms(id uuid pk, project_id uuid fk, name text, meta jsonb, updated_at, is_deleted bool)
	•	groups(id uuid pk, project_id uuid fk, name text, meta jsonb, updated_at, is_deleted bool)
	•	devices(id uuid pk, project_id uuid fk, name text, meta jsonb, updated_at, is_deleted bool)

Ключевые поля:
	•	version — версия проекта, инкремент при изменениях.
	•	updated_at — UTC-время последнего изменения.
	•	is_deleted — мягкое удаление.

Миграции:
	•	001_init.sql — таблицы.
	•	002_indexes.sql — индексы.
	•	003_audit.sql — аудит.

Команды:

npm run migrate        # применить новые миграции
npm run migrate:down   # откатить последнюю


⸻

🔍 Примеры запросов (curl)

# Создание проекта
curl -s -X POST http://127.0.0.1:3000/v1/projects \
  -H "Authorization: Bearer $SESSION" -H "Content-Type: application/json" \
  -d '{"name":"Квартира","note":"Черновик"}'

# Список проектов
curl -s "http://127.0.0.1:3000/v1/projects?since=1970-01-01T00:00:00Z&limit=50" \
  -H "Authorization: Bearer $SESSION"

# Получить дерево проекта
curl -s http://127.0.0.1:3000/v1/projects/$PID \
  -H "Authorization: Bearer $SESSION"

# Обновить мета
curl -s -X PUT http://127.0.0.1:3000/v1/projects/$PID \
  -H "Authorization: Bearer $SESSION" -H "Content-Type: application/json" \
  -d '{"name":"Квартира 2"}'

# Batch
curl -s -X POST http://127.0.0.1:3000/v1/projects/$PID/batch \
  -H "Authorization: Bearer $SESSION" -H "Content-Type: application/json" \
  -d '{"baseVersion":2,"ops":{"rooms":{"upsert":[{"name":"Комната 1"}]}}}'

# Delta
curl -s "http://127.0.0.1:3000/v1/projects/$PID/delta?since=1970-01-01T00:00:00Z" \
  -H "Authorization: Bearer $SESSION"

# Мягкое удаление
curl -s -X DELETE http://127.0.0.1:3000/v1/projects/$PID \
  -H "Authorization: Bearer $SESSION"


⸻

📂 Структура проекта

/routes        # /routes/auth.js, /routes/projects.js
/server        # /server/server.js
/models        # SQL-репозитории: projects, rooms, groups, devices
/services      # бизнес-логика (дерево, delta, batch/LWW)
/utils         # jwt, validation, rateLimit, time
/db            # pool.js, migrate.js
/migrations    # *.sql (UP + -- DOWN)
/docs          # openapi.yaml (Swagger)
/tests         # интеграционные тесты


⸻

☁️ Продакшен

Сервер
	•	IP: 147.45.185.209
	•	Port: 3000/tcp (0.0.0.0)
	•	Процесс-менеджер: PM2 (пользователь deploy)
	•	systemd unit: pm2-deploy.service → pm2-runtime start server/server.js --name volthome-api

Полезные команды

# systemd
systemctl status pm2-deploy --no-pager
journalctl -u pm2-deploy -n 200 --no-pager

# PM2
sudo -u deploy pm2 ls
sudo -u deploy pm2 logs volthome-api --lines 100
sudo -u deploy pm2 reload volthome-api
sudo -u deploy pm2 stop volthome-api
sudo -u deploy pm2 start server/server.js --name volthome-api
sudo -u deploy pm2 save

# проверка
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/healthz

PostgreSQL (инициализация)

CREATE USER volthome WITH PASSWORD 'volthome_password';
CREATE DATABASE volthome OWNER volthome;
GRANT ALL PRIVILEGES ON DATABASE volthome TO volthome;


⸻

🔄 Автодеплой (GitHub Actions → Timeweb)

Пуш в main запускает .github/workflows/deploy.yml.
Экшн делает:
	1.	git reset --hard origin/main
	2.	npm ci --omit=dev
	3.	npm run migrate
	4.	pm2 reload volthome-api
	5.	Healthcheck GET /health

Secrets в GitHub:
	•	SERVER_HOST = 147.45.185.209
	•	SERVER_USER = deploy
	•	SERVER_PATH = /var/www/VoltHomeBackend
	•	SSH_PRIVATE_KEY = приватный ключ для deploy (OpenSSH)

⸻

🛠️ Частые проверки
	•	curl: (7) Failed to connect
Проверьте порт:

ss -tulpen | grep ':3000'


	•	PM2 не стартует при перезагрузке
Используйте pm2 save && resurrect:

systemctl status pm2-deploy
sudo -u deploy pm2 save


	•	Ошибки импортов
В server/server.js импорты должны быть относительные:

import authRoutes from "../routes/auth.js";
import projectsRoutes from "../routes/projects.js";
import { authMiddleware } from "../utils/jwt.js";



⸻

✅ E2E-сценарий
	1.	POST /auth/yandex/exchange → sessionJwt
	2.	POST /v1/projects → создать проект
	3.	GET /v1/projects → список
	4.	GET /v1/projects/{id} → дерево проекта
	5.	POST /v1/projects/{id}/batch → изменения
	6.	GET /v1/projects/{id}/delta → проверить дельту
	7.	PUT /v1/projects/{id} → обновить мета (version++)
	8.	DELETE /v1/projects/{id} → мягкое удаление (is_deleted=true)

⸻

🔙 Откат (rollback)
	1.	Остановить API:

sudo -u deploy pm2 stop volthome-api


	2.	Откатить миграцию:

npm run migrate:down


	3.	Вернуть предыдущий код (git checkout / git revert).
	4.	Применить миграции снова:

npm run migrate
sudo -u deploy pm2 start volthome-api



⸻

Готово к продакшену 🚀:
миграции (npm run migrate), health-чек (/healthz), Swagger (/docs), логирование и rate-limit для delta/batch.
