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
 * - если нет group_id, но есть meta.room_id — создаём/находим дефолтную группу комнаты и подставляем её;
 * - если нет ни group_id, ни meta.room_id — сохраняем как «сироту» (group_id = NULL).
 */
export async function upsertDevices(projectId, items) {
    if (!items?.length) return [];

    // 1) Собираем список room_id, где нужно создать/получить дефолтную группу
    const roomIdsNeedingDefault = [];
    for (const d of items) {
        const hasGroupId = ("groupId" in d && d.groupId) || ("group_id" in d && d.group_id);
        if (!hasGroupId) {
            const rid = extractRoomId(d.meta);
            if (rid) roomIdsNeedingDefault.push(rid);
        }
    }

    // 2) Идемпотентно гарантируем дефолтные группы для этих комнат
    let defaultMap = new Map();
    if (roomIdsNeedingDefault.length) {
        defaultMap = await ensureDefaultGroups(projectId, roomIdsNeedingDefault);
    }

    // 3) Разносим элементы с нормализованным group_id
    const withId = [];
    const noId = [];
    for (const d of items) {
        const groupId =
            ("groupId" in d && d.groupId) ? d.groupId
                : (("group_id" in d && d.group_id) ? d.group_id
                    : (() => {
                        const rid = extractRoomId(d.meta);
                        return rid ? (defaultMap.get(rid) || null) : null;
                    })());

        const norm = {
            ...d,
            group_id: groupId || null,
            name: d.name ?? null,
            meta: d.meta ?? null,
        };
        (d?.id ? withId : noId).push(norm);
    }

    const rows = [];

    // 4) bulk UPSERT по id
    if (withId.length) {
        const values = [];
        const params = [];
        let i = 1;

        for (const d of withId) {
            values.push(
                `($${i++}::uuid, $${i++}::uuid, $${i++}::uuid, $${i++}::text, $${i++}::jsonb)`
            );
            params.push(
                d.id,               // id
                projectId,          // project_id
                d.group_id,         // group_id (возможно null)
                d.name,             // name
                metaToJson(d.meta)  // meta
            );
        }

        const sql = `
            INSERT INTO devices (id, project_id, group_id, name, meta)
            VALUES ${values.join(", ")}
                ON CONFLICT (id) DO UPDATE SET
                group_id   = EXCLUDED.group_id,
                                        name       = EXCLUDED.name,
                                        meta       = EXCLUDED.meta,
                                        is_deleted = FALSE,
                                        updated_at = NOW()
                                        RETURNING id, project_id, group_id, name, meta, updated_at, is_deleted
        `;
        const res = await query(sql, params);
        rows.push(...res.rows);
    }

    // 5) bulk INSERT без id
    if (noId.length) {
        const values = [];
        const params = [];
        let i = 1;

        for (const d of noId) {
            values.push(
                `(uuid_generate_v4(), $${i++}::uuid, $${i++}::uuid, $${i++}::text, $${i++}::jsonb, NOW(), FALSE)`
            );
            params.push(
                projectId,          // project_id
                d.group_id,         // group_id (возможно null)
                d.name,             // name
                metaToJson(d.meta)  // meta
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

/** Мягкое удаление по списку id */
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

/** Дельта устройств (>= since, чтобы не терять границы) */
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

/**
 * Все «живые» устройства проекта без JOIN — чтобы не прятать «сирот».
 * Клиент сразу увидит свои устройства, даже если group_id = NULL.
 */
export async function getDevicesByProject(projectId) {
    const res = await query(
        `SELECT id, project_id, group_id, name, meta, updated_at, is_deleted
         FROM devices
         WHERE project_id = $1
           AND is_deleted = FALSE
         ORDER BY updated_at ASC`,
        [projectId]
    );
    return res.rows;
}

/** Поиск по имени (CI) */
export async function getDevicesByNameCI(projectId, name) {
    const res = await query(
        `SELECT id, project_id, group_id, name, meta, updated_at, is_deleted
         FROM devices
         WHERE project_id = $1
           AND is_deleted = FALSE
           AND lower(name) = lower($2)`,
        [projectId, name]
    );
    return res.rows;
}