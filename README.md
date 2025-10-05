# VoltHome API — краткий контракт и примеры

Этот README и `docs/openapi.yaml` — **единый источник правды** по контракту между клиентом и сервером.

- Полная схема: `docs/openapi.yaml` (OpenAPI 3.0.3).
- Базовые сущности: **Project**, **Room**, **Device**, **Group**.
- Ключевые операции: **Snapshot**, **Delta**, **Batch (upsert/delete)**.

## Авторизация

Все запросы требуют `Authorization: Bearer <JWT>`.

```bash
# пример
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/v1/projects?limit=100

Проекты

Список проектов

curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/v1/projects?limit=100"

Ответ (200):

{
  "items": [
    {
      "id": "29655675-c9a2-42b9-b579-de5d50302070",
      "name": "Новый проект",
      "note": null,
      "version": 25,
      "updated_at": "2025-09-28T19:02:39.439Z",
      "is_deleted": false
    }
  ],
  "next": null
}

Snapshot дерева проекта

curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/v1/projects/29655675-c9a2-42b9-b579-de5d50302070

Ответ (200):

{
  "project": { "...": "см. ProjectShortDto" },
  "rooms": [ { "id": "b86895d2-...", "name": "Кухня (УЗО)", "meta": {...}, "updated_at": "...", "is_deleted": false } ],
  "groups": [],
  "devices": [ { "id": "0718dfad-...", "name": "Розетка бытовая", "meta": {"room_id": "b86895d2-...", "power": 2200, "...": "..."}, "updated_at": "...", "is_deleted": false } ]
}

Delta (изменения с момента since)

curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/v1/projects/29655675-c9a2-42b9-b579-de5d50302070/delta?since=2025-09-28T16:00:00Z"

Ответ (200):

{
  "rooms":   { "upsert": [/*RoomDto*/],   "delete": ["<room-uuid>", "..."] },
  "groups":  { "upsert": [/*GroupDto*/],  "delete": [] },
  "devices": { "upsert": [/*DeviceDto*/], "delete": ["<device-uuid>", "..."] }
}

Batch: upsert / delete

1) Создать комнату (клиент генерирует UUID) + добавить устройства

curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  http://localhost:3000/v1/projects/29655675-c9a2-42b9-b579-de5d50302070/batch \
  -d @- <<'JSON'
{
  "baseVersion": null,
  "ops": {
    "rooms": {
      "upsert": [
        {
          "id": "05d8d7cb-e9f1-44e6-9c42-4809acd196c3",
          "name": "Кинотеатр",
          "meta": { "room_type": "STANDARD", "created_at_iso": "2025-09-28T19:02:23.500Z" }
        }
      ],
      "delete": []
    },
    "devices": {
      "upsert": [
        {
          "id": null,
          "group_id": null,
          "name": "Светодиодная лампа",
          "meta": {
            "room_id": "05d8d7cb-e9f1-44e6-9c42-4809acd196c3",
            "power": 10,
            "voltage_type": "AC_1PHASE",
            "voltage_value": 220,
            "demand_ratio": 1.0,
            "power_factor": 0.95,
            "has_motor": false,
            "requires_socket": false,
            "requires_dedicated": false,
            "created_at_iso": "2025-09-28T19:02:24.309Z"
          }
        }
      ],
      "delete": []
    }
  }
}
JSON

Ответ (200, укорочено):

{ "project": { "id": "29655675-c9a2-42b9-b579-de5d50302070", "version": 26, "updated_at": "..." } }

Примечания:
	•	RoomUpsert.id обязателен и генерируется клиентом.
	•	DeviceUpsert.id может быть null, сервер выдаст UUID и вернёт его в следующем snapshot/delta.

2) Удалить устройство(а)

curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  http://localhost:3000/v1/projects/29655675-c9a2-42b9-b579-de5d50302070/batch \
  -d '{
    "baseVersion": null,
    "ops": {
      "devices": {
        "upsert": [],
        "delete": ["0718dfad-d7f1-4e63-a83d-692e29bd51e2","ceec8f9b-b24c-4922-89e4-a1b9f7f73e9c"]
      }
    }
  }'

Ответ (200):

{ "project": { "id": "2965...2070", "version": 27, "updated_at": "..." } }

3) Удалить комнату и её устройства (без каскада на сервере)

Если сервер не удаляет устройства каскадно — клиент отправляет в одном батче два списка delete.

curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  http://localhost:3000/v1/projects/29655675-c9a2-42b9-b579-de5d50302070/batch \
  -d '{
    "baseVersion": null,
    "ops": {
      "rooms":   { "upsert": [], "delete": ["b86895d2-15cc-488e-b079-b770de273e66"] },
      "devices": { "upsert": [], "delete": ["0718dfad-d7f1-4e63-a83d-692e29bd51e2","ceec8f9b-b24c-4922-89e4-a1b9f7f73e9c"] }
    }
  }'

4) Delta после batch

После любого batch клиент может:
	1.	запросить delta с since = предыдущий project.updated_at, либо
	2.	просто сохранить project.version/updated_at из ответа batch.

⸻

Схемы и типы

Полное описание входов/выходов, включая:
	•	ProjectShortDto, ProjectTreeDto, ProjectDeltaResponse;
	•	ProjectBatchRequest/Response;
	•	RoomUpsert/DeviceUpsert/GroupUpsert;
	•	Ops, RoomOpsBucket/DeviceOpsBucket/GroupOpsBucket;

смотрите в docs/openapi.yaml.

⸻

Контрактные требования клиента
	•	Для новых комнат клиент сам генерирует UUID и шлёт его в rooms.upsert[].
	•	Для новых устройств id может быть null; обязательно указывать meta.room_id (UUID комнаты).
	•	Для удалений используем *.delete[] с массивом UUID.
	•	Пока каскада на сервере нет — при удалении комнаты включайте в тот же батч и devices.delete[] для всех её устройств (ровно так и реализовано на клиенте).
	•	baseVersion можно оставить null (best-effort). Если включите optimistic locking — договоримся о поведении 409 Conflict.



