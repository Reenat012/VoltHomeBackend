import { query } from "../db/pool.js";

/**
 * Гарантирует существование дефолтных групп (__default__) для набора roomIds.
 * Идемпотентно за счёт частичного уникального индекса:
 *   ux_groups_project_room_default (project_id, room_id)
 *   WHERE is_deleted = FALSE AND name = '__default__'
 * Возвращает Map(roomId -> groupId).
 */
export async function ensureDefaultGroups(projectId, roomIds) {
    if (!roomIds?.length) return new Map();

    const res = await query(
        `
            WITH ids AS (
                SELECT DISTINCT UNNEST($1::uuid[]) AS room_id
            ),
                 up AS (
            INSERT INTO public."groups"(id, project_id, room_id, name, meta, updated_at, is_deleted)
            SELECT uuid_generate_v4(), $2::uuid, i.room_id, '__default__', NULL, now(), FALSE
            FROM ids i
                ON CONFLICT ON CONSTRAINT ux_groups_project_room_default
                DO UPDATE SET updated_at = now(), is_deleted = FALSE
                       RETURNING id, room_id
                       )
            SELECT g.id, g.room_id
            FROM public."groups" g
                     JOIN ids i ON i.room_id = g.room_id
            WHERE g.project_id = $2
              AND g.name = '__default__'
              AND g.is_deleted = FALSE;
        `,
        [roomIds, projectId]
    );

    const m = new Map();
    for (const r of res.rows) m.set(r.room_id, r.id);
    return m;
}

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
            g.id || null,
            projectId,
            g.roomId || null,
            g.name ?? null,
            g.meta ? JSON.stringify(g.meta) : null
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
                  JOIN rooms r ON r.id = g.room_id AND r.is_deleted = FALSE
         WHERE g.project_id = $1
           AND g.is_deleted = FALSE`,
        [projectId]
    );
    return res.rows;
}