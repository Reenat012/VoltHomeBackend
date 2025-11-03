// models/devices.js
import { query } from "../db/pool.js";

/**
 * Вспомогательные утилиты для работы с meta
 */
function metaToJson(meta) {
    return meta ? (typeof meta === "string" ? meta : JSON.stringify(meta)) : null;
}

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
    // object
    return meta?.room_id ?? null;
}

/**
 * Апсерт устройств в рамках проекта.
 *
 * Поведение:
 * - Если d.id задан — UPSERT по первичному ключу (INSERT ... ON CONFLICT (id) DO UPDATE).
 * - Если d.id отсутствует — ВСЕГДА создаём новое устройство (uuid_generate_v4()).
 *
 * Никакой уникальности/идемпотентности по name больше нет.
 */
export async function upsertDevices(projectId, items) {
    if (!items?.length) return [];

    const withId = [];
    const noId = [];
    for (const d of items) (d?.id ? withId : noId).push(d);

    const rows = [];

    // 1) bulk UPSERT по id
    if (withId.length) {
        const values = [];
        const params = [];
        let i = 1;

        for (const d of withId) {
            const groupId =
                "groupId" in d ? d.groupId : ("group_id" in d ? d.group_id : null);

            values.push(
                `($${i++}::uuid, $${i++}::uuid, $${i++}::uuid, $${i++}::text, $${i++}::jsonb)`
            );
            params.push(
                d.id,               // id
                projectId,          // project_id
                groupId || null,    // group_id
                d.name ?? null,     // name
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

    // 2) bulk INSERT для записей без id — всегда создаём новое устройство
    if (noId.length) {
        const values = [];
        const params = [];
        let i = 1;

        for (const d of noId) {
            const groupId =
                "groupId" in d ? d.groupId : ("group_id" in d ? d.group_id : null);

            values.push(
                `(uuid_generate_v4(), $${i++}::uuid, $${i++}::uuid, $${i++}::text, $${i++}::jsonb, NOW(), FALSE)`
            );
            params.push(
                projectId,          // project_id
                groupId || null,    // group_id
                d.name ?? null,     // name
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

/**
 * Мягкое удаление по списку id.
 */
export async function deleteDevices(projectId, ids) {
    if (!ids?.length) return [];
    const res = await query(
        `UPDATE devices
         SET is_deleted = TRUE,
             updated_at = NOW()
         WHERE project_id = $1
           AND id = ANY($2::uuid[])
         RETURNING id`,
        [projectId, ids]
    );
    return res.rows.map((r) => r.id);
}

/**
 * Дельта устройств.
 * Используем updated_at >= since, чтобы не терять запись при равенстве меток.
 */
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
 * Все устройства проекта (только живые, с живой группой и живой комнатой).
 */
export async function getDevicesByProject(projectId) {
    const res = await query(
        `SELECT d.id, d.project_id, d.group_id, d.name, d.meta, d.updated_at, d.is_deleted
           FROM devices d
           JOIN groups g ON g.id = d.group_id
                        AND g.is_deleted = FALSE
           JOIN rooms  r ON r.id = g.room_id
                        AND r.is_deleted = FALSE
          WHERE d.project_id = $1
            AND d.is_deleted = FALSE`,
        [projectId]
    );
    return res.rows;
}

/**
 * Поиск по имени (регистронезависимый) — всегда массив.
 */
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