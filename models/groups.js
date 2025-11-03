// models/groups.js
import { query } from "../db/pool.js";

export async function upsertGroups(projectId, items) {
    if (!items?.length) return [];
    const values = [];
    const params = [];
    let i = 1;

    for (const g of items) {
        values.push(
            `(COALESCE($${i++}, uuid_generate_v4()), $${i++}, $${i++}, $${i++}, $${i++}, now(), false)`
        );
        params.push(
            g.id || null,                               // id
            projectId,                                  // project_id
            g.roomId || null,                           // room_id
            g.name ?? null,                             // name
            g.meta ? JSON.stringify(g.meta) : null      // meta
        );
    }

    const sql = `
        INSERT INTO groups (id, project_id, room_id, name, meta, updated_at, is_deleted)
        VALUES ${values.join(",")}
            ON CONFLICT (id) DO UPDATE SET
            project_id = EXCLUDED.project_id,
                                    room_id    = EXCLUDED.room_id,
                                    name       = COALESCE(EXCLUDED.name, groups.name),
                                    meta       = COALESCE(EXCLUDED.meta, groups.meta),
                                    updated_at = now(),
                                    is_deleted = false
                                    RETURNING id, project_id, room_id, name, meta, updated_at, is_deleted;
    `;

    const res = await query(sql, params);
    return res.rows;
}

export async function deleteGroups(projectId, ids) {
    if (!ids?.length) return [];
    const res = await query(
        `UPDATE groups
         SET is_deleted = true, updated_at = now()
         WHERE project_id = $1 AND id = ANY($2::uuid[])
             RETURNING id`,
        [projectId, ids]
    );
    return res.rows.map((r) => r.id);
}

export async function deltaGroups(projectId, sinceIso) {
    const res = await query(
        `SELECT id, project_id, room_id, name, meta, updated_at, is_deleted
         FROM groups
         WHERE project_id = $1
           AND updated_at >= $2
         ORDER BY updated_at ASC`,
        [projectId, sinceIso]
    );
    return res.rows;
}

export async function getGroupsByProject(projectId) {
    const res = await query(
        `SELECT g.id, g.room_id, g.name, g.meta, g.updated_at, g.is_deleted
         FROM groups g
                  JOIN rooms r ON r.id = g.room_id
             AND r.is_deleted = FALSE
         WHERE g.project_id = $1
           AND g.is_deleted = FALSE`,
        [projectId]
    );
    return res.rows;
}