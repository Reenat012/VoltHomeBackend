// models/devices.js
import { query } from "../db/pool.js";
import { ensureDefaultGroups } from "./groups.js";

/** Нормализация meta в строку JSON или null */
function metaToJson(meta) {
    return meta ? (typeof meta === "string" ? meta : JSON.stringify(meta)) : null;
}

/** Достаёт room_id из meta (string | object) */
function extractRoomId(meta) {
    if (!meta) return null;
    if (typeof meta === "string") {
        try {
            const o = JSON.parse(meta);
            return o?.room_id ?? null;
        } catch {
            return null;
        }
    }
    return meta?.room_id ?? null;
}

/**
 * Апсерт устройств:
 * - если прислан group_id — используем его;
 * - если нет group_id, но есть meta.room_id — создаём/находим дефолтную группу комнаты;
 * - если нет ни group_id, ни meta.room_id — сохраняем с group_id = NULL.
 *
 * ДОБАВЛЕНО:
 * - Валидация: каждый meta.room_id обязан принадлежать projectId. Иначе кидаем 422 (ROOM_PROJECT_MISMATCH).
 * - Для записей БЕЗ id — всегда INSERT (gen_random_uuid()).
 */
export async function upsertDevices(projectId, items) {
    if (!items?.length) return [];

    // Собираем room_id из meta
    const roomIds = Array.from(new Set(
        items.map(d => extractRoomId(d.meta)).filter(Boolean)
    ));

    // Валидируем, что все room_id принадлежат проекту
    if (roomIds.length) {
        const { rows } = await query(
            `SELECT id FROM rooms
             WHERE project_id = $1
               AND id = ANY($2::uuid[])
               AND is_deleted = FALSE`,
            [projectId, roomIds]
        );
        const ok = new Set(rows.map(r => r.id));
        const bad = roomIds.filter(id => !ok.has(id));
        if (bad.length) {
            const err = new Error(`room_id не принадлежит проекту: ${bad.join(", ")}`);
            err.status = 422;
            err.expose = true;
            err.code = "ROOM_PROJECT_MISMATCH";
            throw err;
        }
    }

    // Гарантируем дефолтные группы под задействованные комнаты
    let defaultMap = new Map();
    if (roomIds.length) {
        try {
            defaultMap = await ensureDefaultGroups(projectId, roomIds);
        } catch {
            defaultMap = new Map();
        }
    }

    // Нормализуем и раскладываем по “с id” / “без id”
    const withId = [];
    const noId = [];
    for (const d of items) {
        const incomingGroupId =
            ("groupId" in d && d.groupId) ? d.groupId
                : (("group_id" in d && d.group_id) ? d.group_id : null);

        const rid = extractRoomId(d.meta);
        const groupId = incomingGroupId ?? (rid ? (defaultMap.get(rid) || null) : null);

        const norm = {
            ...d,
            group_id: groupId || null,
            name: d.name ?? null,
            meta: d.meta ?? null,
        };
        (d?.id ? withId : noId).push(norm);
    }

    const rows = [];

    // 1) bulk UPSERT с id (LWW по id, в рамках project_id)
    if (withId.length) {
        const values = [];
        const params = [];
        let i = 1;

        for (const d of withId) {
            values.push(
                `($${i++}::uuid, $${i++}::uuid, $${i++}::uuid, $${i++}::text, $${i++}::jsonb)`
            );
            params.push(
                d.id,              // id
                projectId,         // project_id
                d.group_id,        // group_id
                d.name,            // name
                metaToJson(d.meta) // meta
            );
        }

        const sql = `
            INSERT INTO devices (id, project_id, group_id, name, meta)
            VALUES ${values.join(", ")}
                ON CONFLICT (id) DO UPDATE SET
                project_id = EXCLUDED.project_id,
                                        group_id   = EXCLUDED.group_id,
                                        name       = EXCLUDED.name,
                                        meta       = EXCLUDED.meta,
                                        is_deleted = FALSE,
                                        updated_at = NOW()
                                    WHERE devices.project_id = EXCLUDED.project_id
                                        RETURNING id, project_id, group_id, name, meta, updated_at, is_deleted
        `;
        const res = await query(sql, params);
        rows.push(...res.rows);
    }

    // 2) INSERT без id — новая запись
    if (noId.length) {
        const values = [];
        const params = [];
        let i = 1;

        for (const d of noId) {
            values.push(
                `(gen_random_uuid(), $${i++}::uuid, $${i++}::uuid, $${i++}::text, $${i++}::jsonb, NOW(), FALSE)`
            );
            params.push(
                projectId,         // project_id
                d.group_id,        // group_id
                d.name,            // name
                metaToJson(d.meta) // meta
            );
        }

        const sql = `
            INSERT INTO devices (id, project_id, group_id, name, meta, updated_at, is_deleted)
            VALUES ${values.join(", ")}
                RETURNING id, project_id, group_id, name, meta, updated_at, is_deleted
        `;
        const res = await query(sql, params);
        rows.push(...res.rows);
    }

    return rows;
}

/** Мягкое удаление */
export async function deleteDevices(projectId, ids) {
    if (!ids?.length) return [];
    const res = await query(
        `UPDATE devices
         SET is_deleted = TRUE, updated_at = NOW()
         WHERE project_id = $1 AND id = ANY($2::uuid[])
             RETURNING id`,
        [projectId, ids]
    );
    return res.rows.map((r) => r.id);
}

/** Дельта устройств (updated_at >= since) */
export async function deltaDevices(projectId, sinceIso) {
    const res = await query(
        `SELECT id, project_id, group_id, name, meta, updated_at, is_deleted
         FROM devices
         WHERE project_id = $1
           AND updated_at >= $2
         ORDER BY updated_at ASC`,
        [projectId, sinceIso]
    );
    return res.rows;
}

/** Живые устройства проекта */
export async function getDevicesByProject(projectId) {
    const res = await query(
        `SELECT id, project_id, group_id, name, meta, updated_at, is_deleted
         FROM devices
         WHERE project_id = $1
           AND is_deleted = FALSE`,
        [projectId]
    );
    return res.rows;
}

/** Поиск устройств по имени (case-insensitive) в рамках проекта и комнаты */
export async function getDevicesByNameCI(projectId, roomId, name) {
    const res = await query(
        `SELECT id, project_id, group_id, name, meta, updated_at, is_deleted
         FROM devices
         WHERE project_id = $1
           AND (meta->>'room_id') = $2
           AND lower(name) = lower($3)
           AND is_deleted = FALSE
         ORDER BY updated_at DESC
             LIMIT 200`,
        [projectId, roomId, name]
    );
    return res.rows;
}