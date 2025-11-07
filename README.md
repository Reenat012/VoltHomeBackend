# VoltHomeBackend

Node.js/Express backend для VoltHome. Хранит проекты/комнаты/группы/устройства в PostgreSQL, поддерживает офлайн-синхронизацию через пакетные операции (Batch) и версионирование проекта.

## Быстрый старт

### Зависимости
- Node.js 18+ (рекомендовано 20 LTS)
- PostgreSQL 14+
- Расширения БД: `uuid-ossp`, `pgcrypto`, `plpgsql`

### Переменные окружения
Создайте `.env` в корне:

DATABASE_URL=postgres://user:pass@host:5432/dbname
JWT_SECRET=very_secret_string
REFRESH_TTL_DAYS=30
PORT=3000
NODE_ENV=production

### Миграции
В БД должна быть таблица `schema_migrations`. Миграции лежат в `migrations/` и применяются вашим деплоем. Ключевые из последних:
- `020_add_fk_cascade_not_valid.sql` / `021_cleanup_and_validate_fk.sql` — строгие FK + каскад.
- `022_soft_delete_cascade_triggers.sql` — soft-каскад (триггеры).
- `023_groups_default_index.sql` — частичный уникальный индекс для `__default__` групп.
- `024_uuid_pgcrypto.sql` — генераторы UUID.

### Запуск
```bash
npm ci
NODE_ENV=production node server/server.js
# или
npm run dev

Важные файлы
	•	server/server.js — конфигурация Express и маршрутов.
	•	routes/*.js — HTTP эндпоинты.
	•	services/projectsService.js — агрегирующая бизнес-логика по проектам.
	•	models/*.js — доступ к данным (SQL).
	•	db/pool.js — пул подключений к PostgreSQL.
	•	utils/jwt.js — работа с JWT.

Архитектурные тезисы
	•	Проект — единица синхронизации с версией version.
	•	Batch — атомарная операция с набором upsert/delete для rooms, groups, devices.
	•	Soft-delete: is_deleted = true + updated_at = now(). Каскады через триггеры.
	•	Default group: в каждой «живой» комнате может существовать единственная «живая» группа с name="__default__". Частичный уникальный индекс это обеспечивает.
	•	Группировка устройств: при devices.upsert сервер либо использует переданный group_id, либо резолвит по meta.room_id и создаёт/использует дефолтную группу.

---

# docs/Auth.md

```md
# Аутентификация и сессии

## JWT доступ
Все запросы к `v1/*` требуют JWT в заголовке:

Authorization: Bearer 

Payload минимально: `{ uid: "<user_id>" }`.
Секрет: `JWT_SECRET` из `.env`.

**Ошибки**
- `401 {"error":"invalid_token"}` — подпись/срок/формат неверный.
- Отсутствие заголовка — также `401`.

## Refresh-сессии
Таблица: `refresh_sessions`
- `id` bigint PK
- `user_id` text (идентификатор пользователя)
- `token_hash` text (SHA-256 HEX от refresh-токена)
- `expires_at` timestamptz
- `revoked_at` timestamptz nullable
- `replaced_by` FK self-ref (ротация цепочки)

**Важно:** Хеш считается как **hex-строка** (`sha256Hex`), чтобы избежать проблем UTF-8.

Ротация/отзыв реализованы в `server/models/sessions.js`. TTL задаётся `REFRESH_TTL_DAYS`. Конкретные эндпоинты рефреш-токенов могут быть недоступны публично (в мобильном приложении — через собственный шлюз/поток).


⸻

docs/API.md

# HTTP API

Базовый префикс: `/v1`

## Схема ответа об ошибке

HTTP status: 4xx/5xx
{
“error”: “”,
“message”: “читаемое описание (может отсутствовать)”,
“detail”: “…”,        // опционально
“constraint”: “…”     // опционально (ошибка БД)
}

### Общие коды
- `invalid_token` — нет/неверный JWT.
- `bad_request` — некорректный JSON/параметры.
- `fk_violation` — нарушение внешнего ключа (например, несуществующая `room_id`).
- `GROUP_UNRESOLVED` — сервер не смог определить `group_id` для устройства (см. Batch).

---

## Проекты

### GET /v1/projects
Список всех **ваших** проектов (возможны «помеченные удалёнными» — см. поле `is_deleted`).

**200**

{
“items”:[
{“id”:”…”,“name”:”…”,“note”:null,“version”:N,“updated_at”:”…”,“is_deleted”:false},
…
],
“next”: null     // зарезервировано под пагинацию
}

### POST /v1/projects
Создать проект.

{ “name”: “Проект №4”, “note”: null }

**201**

{ “id”:”…”,“user_id”:”…”,“name”:“Проект №4”,“note”:null,“version”:1,“updated_at”:”…”,“is_deleted”:false }

### GET /v1/projects/:id
Снимок проекта:
**200**

{
“project”: { “id”:”…”,“user_id”:”…”,“name”:”…”,“note”:null,“version”:N,“updated_at”:”…”,“is_deleted”:false },
“rooms”:   [ { “id”:”…”,“name”:”…”,“meta”:{…},“updated_at”:”…”,“is_deleted”:false }, … ],
“groups”:  [ { “id”:”…”,“room_id”:”…”,“name”:”default”,“meta”:null,“updated_at”:”…”,“is_deleted”:false }, … ],
“devices”: [ { “id”:”…”,“project_id”:”…”,“group_id”:”…”,“name”:”…”,“meta”:{…},“updated_at”:”…”,“is_deleted”:false }, … ]
}

---

## Batch

### POST /v1/projects/:id/batch
Атомарный пакет с операциями над `rooms`, `groups`, `devices`.

**Запрос**

{
“ops”: {
“rooms”:   { “delete”:[…], “upsert”:[ {…}, … ] },
“groups”:  { “delete”:[…], “upsert”:[ {…}, … ] },
“devices”: { “delete”:[…], “upsert”:[ {…}, … ] }
}
}

- `delete` — soft-delete (`is_deleted=true`, `updated_at=now()`), каскады сработают триггерами.
- `upsert` — вставка/обновление. Если `id` не указан — сервер сгенерит `uuid_generate_v4()`.

**Ответ**

200 { “newVersion”: , “conflicts”: [] }

`newVersion` — версия проекта после применения батча.

**Конфликты**
Поле `conflicts` зарезервировано для будущих конфликтов LWW/семантики.

См. подробные правила в `docs/Batch.md`.


⸻

docs/Batch.md

# Семантика Batch

## Общие принципы
- Все операции в `ops` применяются в транзакции — либо всё, либо ничего.
- Любой `upsert` всегда выставляет `updated_at = now()` и `is_deleted = false`.
- Для LWW по `id`: если `id` существует — обновляем, если нет — вставляем.
- На уровне БД включены строгие внешние ключи и каскады (см. DB.md).

## Rooms (комнаты)
### upsert
Поля:
- `id?: uuid` — если не задан, будет сгенерирован.
- `name: text`
- `meta?: object|string|null` — сериализуется в `jsonb` (или `null`).
- Прочее: `project_id` берётся из маршрута (`:id`).

Ограничения:
- Уникальность «живых» комнат по `(project_id, lower(name)) WHERE is_deleted=false` (частичный уникальный индекс).
- При soft-delete комнаты триггер **мягко удаляет** связанные `groups` и `devices`.

### delete
Помечает комнату удалённой (`is_deleted=true`). Триггеры **soft-каскадно** пометят `groups`/`devices`.

---

## Groups (группы)
### upsert
Поля:
- `id?: uuid`
- `room_id?: uuid` — **может быть null**.
- `name?: text` — может быть `null`; для дефолтной группы должно быть `"__default__"`.
- `meta?: object|string|null`.

Особенная логика — **дефолтные группы**:
- Для каждой «живой» комнаты **может существовать только одна «живая»** группа с `name="__default__"`.
- Это обеспечивается частичным уникальным индексом

UNIQUE (project_id, room_id) WHERE is_deleted=false AND name=’default’

- Сервисная функция `ensureDefaultGroups(projectId, roomIds)` создаёт недостающие дефолтные группы и возвращает `Map(roomId -> groupId)`.

LWW по `id`:
```sql
ON CONFLICT (id) DO UPDATE
SET project_id = EXCLUDED.project_id,
    room_id    = EXCLUDED.room_id,
    name       = COALESCE(EXCLUDED.name, groups.name),
    meta       = COALESCE(EXCLUDED.meta, groups.meta),
    updated_at = now(),
    is_deleted = FALSE
WHERE groups.project_id = EXCLUDED.project_id;

delete

Soft-delete. Триггер soft_cascade_from_groups мягко удалит связанные devices.

⸻

Devices (устройства)

upsert

Поля:
	•	id?: uuid
	•	group_id?: uuid
	•	name: text
	•	meta?: object|string|null

Разрешение group_id:
	1.	Если передан group_id — используем его (FK проверит существование группы в проекте).
	2.	Иначе, если в meta.room_id присутствует валидный UUID комнаты — сервер обеспечит наличие дефолтной группы в этой комнате (через ensureDefaultGroups) и свяжет устройство с ней.
	3.	Иначе — ошибка 400 {"error":"GROUP_UNRESOLVED", "message":"...передайте group_id или meta.room_id"}.

Прочее:
	•	Если оба поля заданы (group_id и meta.room_id) и указывают на разные комнаты — приоритет у group_id (FK), но такие кейсы лучше избегать на клиенте.

delete

Soft-delete.

⸻

Ошибки уровня БД
	•	Несуществующий room_id в группе → 422 {"error":"fk_violation", "constraint":"groups_room_id_fkey"}
	•	Несуществующий group_id в устройстве → 422 {"error":"fk_violation", "constraint":"devices_group_id_fkey"}

⸻

Версионирование проекта
	•	Каждый успешный Batch увеличивает projects.version как минимум на +1.
	•	В ответе возвращается {"newVersion": <N>, "conflicts": []}.

---

# docs/DB.md

```md
# Схема БД (актуальные сущности)

## Таблицы
- `projects(id uuid PK, user_id text, name text, note text, version int, updated_at timestamptz, is_deleted bool)`
- `rooms(id uuid PK, project_id uuid FK -> projects ON DELETE CASCADE, name text, meta jsonb, updated_at timestamptz, is_deleted bool)`
- `groups(id uuid PK, project_id uuid FK -> projects ON DELETE CASCADE, room_id uuid FK -> rooms ON DELETE CASCADE, name text, meta jsonb, updated_at timestamptz, is_deleted bool)`
- `devices(id uuid PK, project_id uuid FK -> projects ON DELETE CASCADE, group_id uuid FK -> groups ON DELETE CASCADE, name text, meta jsonb, updated_at timestamptz, is_deleted bool)`
- `refresh_sessions(...)` — см. Auth.md
- `audit_log(...)` — аудит, если включён соответствующими миграциями.

## Ключевые индексы
- `rooms`: `idx_rooms_project`, `idx_rooms_project_name_live` (частичный), `idx_rooms_project_updated_at`
- `groups`: `idx_groups_project`, `idx_groups_project_updated_at`, **`ux_groups_project_room_default`** (частичный UNIQUE по `(project_id, room_id)` при `name='__default__'` и `is_deleted=false`)
- `devices`: `idx_devices_project`, `idx_devices_project_updated_at`, `idx_devices_project_room_lname_live` (оптимизация выборок по проекту/комнате и имени)

## Триггеры soft-каскада
- `trg_soft_cascade_from_rooms` → `soft_cascade_from_rooms()`:
  - при soft-delete комнаты помечает связанные `groups`/`devices` как `is_deleted=true`.
- `trg_soft_cascade_from_groups` → `soft_cascade_from_groups()`:
  - при soft-delete группы помечает связанные `devices` как `is_deleted=true`.

## Расширения
- `uuid-ossp` — `uuid_generate_v4()`
- `pgcrypto` — `gen_random_uuid()` (может использоваться в миграциях)
- `plpgsql` — функции триггеров

## Дельта и выборки
- Дельта по времени основана на `updated_at >= since`.
- «Живые» сущности: `is_deleted=false`.
- Срез проекта (`GET /v1/projects/:id`) возвращает «живые» `rooms`, «живые» `groups`, «живые» `devices`, привязанные к «живым» родителям.


⸻

docs/Debug.md

# Диагностика и отладка (плейбук)

## 1) Получить JWT для теста (админ/скрипт)
```bash
export TOKEN=$(node -e 'const jwt=require("jsonwebtoken");require("dotenv").config();process.stdout.write(jwt.sign({uid:"<USER_ID>"},process.env.JWT_SECRET,{expiresIn:"30m"}));')
echo ${TOKEN:0:20}...

Проверка:

curl -i https://api.volthome.ru/v1/projects -H "Authorization: Bearer $TOKEN"

2) Переменные проекта/комнат

export PROJECT_ID=<uuid проекта>
export ROOM_STD=<uuid комнаты "Стандартная">
export ROOM_BATH=<uuid комнаты "Ванная (УЗО)">

3) Инспекция проекта

curl -s https://api.volthome.ru/v1/projects/$PROJECT_ID -H "Authorization: Bearer $TOKEN" | \
jq '{rooms:[.rooms[]|{id,name}],groups:[.groups[]|{id,room_id,name}],devices:([.devices[]|{id,name,group_id,meta_room_id:(.meta.room_id)}])}'

4) Batch: создать устройства (резолв по meta.room_id → default group)

curl -i https://api.volthome.ru/v1/projects/$PROJECT_ID/batch \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data @- <<EOF
{ "ops": { "devices": { "delete": [], "upsert": [
  {"name":"Тест-розетка","meta":{"room_id":"$ROOM_STD","device_type":"SOCKET","power":1000,"voltage_type":"AC_1PHASE","voltage_value":220,"demand_ratio":0.75,"power_factor":0.9,"requires_socket":true,"requires_dedicated":false}},
  {"name":"Тест-свет","meta":{"room_id":"$ROOM_BATH","device_type":"LIGHTING","power":12,"voltage_type":"AC_1PHASE","voltage_value":220,"demand_ratio":1.0,"power_factor":0.95,"requires_socket":false,"requires_dedicated":false}}
]}}}
EOF

5) Проверка разрешения группы

curl -s https://api.volthome.ru/v1/projects/$PROJECT_ID -H "Authorization: Bearer $TOKEN" | \
jq '{groups:[.groups[]|{id,room_id,name}], devices:[.devices[]|{id,name,group_id,meta_room_id:(.meta.room_id)}]}'

6) Ошибочные кейсы
	•	Неверная room_id:

422 {"error":"fk_violation","constraint":"groups_room_id_fkey"}


	•	Нет group_id и meta.room_id:

400 {"error":"GROUP_UNRESOLVED", "message":"...передайте group_id или meta.room_id"}



7) Удаление комнаты (soft-cascade)

# Создать временную комнату
TMP_ROOM=$(node -e "console.log(require('crypto').randomUUID())")
curl -i https://api.volthome.ru/v1/projects/$PROJECT_ID/batch \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data @- <<EOF
{ "ops": { "rooms": { "delete": [], "upsert": [
  {"id":"$TMP_ROOM","name":"Тестовая (TMP)","meta":{"room_type":"STANDARD"}}
]}}}
EOF

# Убедиться, что дефолтная группа создана автоматически при последующих devices.upsert (или создать явно через groups.upsert)
# Создать устройство в TMP комнате
DG=$(curl -s https://api.volthome.ru/v1/projects/$PROJECT_ID -H "Authorization: Bearer $TOKEN" | jq -r --arg r "$TMP_ROOM" '.groups[] | select(.room_id==$r and .name=="__default__") | .id' | head -n1)
curl -i https://api.volthome.ru/v1/projects/$PROJECT_ID/batch \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data @- <<EOF
{ "ops": { "devices": { "delete": [], "upsert": [
  {"name":"TMP-устройство","group_id":"$DG","meta":{"room_id":"$TMP_ROOM","device_type":"SOCKET","power":1234}}
]}}}
EOF

# Удалить комнату — триггеры пометят связанную группу и устройства удалёнными
curl -i https://api.volthome.ru/v1/projects/$PROJECT_ID/batch \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data @- <<EOF
{ "ops": { "rooms": { "delete": ["$TMP_ROOM"], "upsert": [] } } }
EOF

---

# CHANGELOG.md

```md
# Changelog

## 2025-11-07
- **Groups**: реализована функция `ensureDefaultGroups(projectId, roomIds)` — создаёт недостающие `__default__` группы по списку комнат, использует частичный уникальный индекс `ux_groups_project_room_default`.
- **Devices**: при `devices.upsert` добавлена строгая логика резолва группы:
  - если `group_id` передан — используем как есть (FK проверит);
  - иначе — берём `meta.room_id`, создаём/используем дефолтную группу комнаты;
  - иначе — возвращаем `400 GROUP_UNRESOLVED`.
- **FK/каскады**: подтверждены и документированы триггеры soft-каскада (`soft_cascade_from_rooms`, `soft_cascade_from_groups`) и строгие внешние ключи с `ON DELETE CASCADE`.
- **Документация**: добавлены файлы `docs/Auth.md`, `docs/API.md`, `docs/Batch.md`, `docs/DB.md`, `docs/Debug.md`, обновлён `README.md`.
- **Сессии**: в `server/models/sessions.js` исправлён расчёт хеша refresh-токена на `sha256Hex` (HEX-строка).


⸻

если нужно — могу разбить это на коммиты с путями (куда положить каждый файл) или адаптировать под ваш текущий формат wiki в репо.