// models/devices.js
import { query } from "../db/pool.js";

/**
 * Апсерт устройств в рамках проекта.
 * Поддерживаем как d.groupId, так и d.group_id.
 * meta нормализуем: если пришла строка — пишем как есть, если объект — JSON.stringify.
 */
export async function upsertDevices(projectId, items) {
    if (!items?.length) return [];
    const values = [];
    const params = [];
    let i = 1;

    for (const d of items) {
        const groupId = ("groupId" in d) ? d.groupId : (("group_id" in d) ? d.group_id : null);
        const metaJson = d.meta
            ? (typeof d.meta === "string" ? d.meta : JSON.stringify(d.meta))
            : null;

        values.push(
            `(COALESCE($${i++}, uuid_generate_v4()), $${i++}, $${i++}, $${i++}, $${i++}, now(), false)`
        );
        params.push(
            d.id || null,     // id
            projectId,        // project_id
            groupId || null,  // group_id
            d.name ?? null,   // name
            metaJson          // meta
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
    return res.rows;
}

export async function deleteDevices(projectId, ids) {
    if (!ids?.length) return [];
    const res = await query(
        `UPDATE devices
         SET is_deleted = true, updated_at = now()
         WHERE project_id = $1 AND id = ANY($2::uuid[])
             RETURNING id`,
        [projectId, ids]
    );
    return res.rows.map((r) => r.id);
}

/**
 * Дельта устройств.
 * ВАЖНО: не выбираем несуществующие столбцы (например, room_id),
 * так как привязка комнаты хранится в meta.room_id по текущей схеме.
 */
export async function deltaDevices(projectId, sinceIso) {
    const res = await query(
        `SELECT id, project_id, group_id, name, meta, updated_at, is_deleted
         FROM devices
         WHERE project_id = $1 AND updated_at > $2
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