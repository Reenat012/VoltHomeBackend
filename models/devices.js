// models/devices.js
import { query } from "../db/pool.js";

export async function upsertDevices(projectId, items) {
    if (!items?.length) return [];
    const values = [];
    const params = [];
    let i = 1;

    for (const d of items) {
        values.push(
            `(COALESCE($${i++}, uuid_generate_v4()), $${i++}, $${i++}, $${i++}, $${i++}, now(), false)`
        );
        params.push(
            d.id || null,               // id
            projectId,                  // project_id
            d.groupId || null,          // group_id <-- ВАЖНО: сохраняем связь с группой
            d.name,                     // name
            d.meta ? JSON.stringify(d.meta) : null // meta
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
    return res.rows.map(r => r.id);
}

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