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
 * - Если d.id задан — обычный LWW по id (INSERT ... ON CONFLICT (id) DO UPDATE).
 * - Если d.id отсутствует — ИДЕМПОТЕНТНЫЙ UPSERT одной командой:
 *   INSERT ... ON CONFLICT ON CONSTRAINT ux_devices_project_room_name_alive DO UPDATE
 *   (требуется уникальный индекс на (project_id, meta->>'room_id', lower(name)) WHERE is_deleted=false).
 */
export async function upsertDevices(projectId, items) {
    if (!items?.length) return [];

    const withId = [];
    const noId = [];
    for (const d of items) (d?.id ? withId : noId).push(d);

    const rows = [];

    // 1) bulk по id — прежняя логика
    if (withId.length) {
        const values = [];
        const params = [];
        let i = 1;

        for (const d of withId) {
            const groupId =
                "groupId" in d ? d.groupId : "group_id" in d ? d.group_id : null;
            values.push(
                `(COALESCE($${i++}, uuid_generate_v4()), $${i++}, $${i++}, $${i++}, $${i++}, now(), false)`
            );
            params.push(
                d.id || null, // id
                projectId, // project_id
                groupId || null, // group_id
                d.name ?? null, // name
                metaToJson(d.meta) // meta
            );
        }

        const sql = `
            INSERT INTO devices (id, project_id, group_id, name, meta, updated_at, is_deleted)
            VALUES ${values.join(",")}
                ON CONFLICT (id) DO UPDATE SET
                project_id = EXCLUDED.project_id,
                                        group_id   = EXCLUDED.group_id,
                                        name       = COALESCE(EXCLUDED.name, devices.name),
                                        meta       = COALESCE(EXCLUDED.meta, devices.meta),
                                        updated_at = now(),
                                        is_deleted = false
                                        RETURNING id, project_id, group_id, name, meta, updated_at, is_deleted;
        `;
        const res = await query(sql, params);
        rows.push(...res.rows);
    }

    // 2) идемпотентная обработка без id — один UPSERT по частичному индексу
    for (const d of noId) {
        const groupId =
            "groupId" in d ? d.groupId : "group_id" in d ? d.group_id : null;
        const metaJson = metaToJson(d.meta);
        // room_id из meta должен присутствовать, чтобы корректно сработал уникальный ключ
        // (если его нет, всё равно выполняем INSERT — индекс не задействуется)
        const sql = `
      INSERT INTO devices (id, project_id, group_id, name, meta, updated_at, is_deleted)
      VALUES (uuid_generate_v4(), $1, $2, $3, $4, now(), false)
      ON CONFLICT ON CONSTRAINT ux_devices_project_room_name_alive
      DO UPDATE SET
        group_id   = COALESCE(EXCLUDED.group_id, devices.group_id),
        name       = COALESCE(EXCLUDED.name, devices.name),
        meta       = COALESCE(EXCLUDED.meta, devices.meta),
        updated_at = now(),
        is_deleted = false
      RETURNING id, project_id, group_id, name, meta, updated_at, is_deleted
    `;
        const ins = await query(sql, [
            projectId,
            groupId || null,
            d.name ?? null,
            metaJson,
        ]);
        rows.push(ins.rows[0]);
    }

    return rows;
}

export async function deleteDevices(projectId, ids) {
    if (!ids?.length) return [];
    const res = await query(
        `UPDATE devices
         SET is_deleted = true,
             updated_at = now()
         WHERE project_id = $1
           AND id = ANY($2::uuid[])
             RETURNING id`,
        [projectId, ids]
    );
    return res.rows.map((r) => r.id);
}

/**
 * Дельта устройств.
 * Фикс: используем updated_at >= since (вместо >), чтобы не терять запись
 * при равенстве меток времени.
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

export async function getDevicesByProject(projectId) {
    const res = await query(
        `SELECT id, group_id, name, meta, updated_at, is_deleted
         FROM devices
         WHERE project_id = $1`,
        [projectId]
    );
    return res.rows;
}