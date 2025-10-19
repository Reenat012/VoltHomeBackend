// models/rooms.js
import { query } from "../db/pool.js";

/** Нормализация meta в строку JSON или null */
function metaToJson(meta) {
    return meta ? (typeof meta === "string" ? meta : JSON.stringify(meta)) : null;
}

/**
 * Апсерт комнат в рамках проекта.
 *
 * Поведение:
 * - Если r.id задан — обычный LWW по id (bulk INSERT ... ON CONFLICT (id) DO UPDATE).
 * - Если r.id отсутствует — ИДЕМПОТЕНТНЫЙ UPSERT одной командой:
 *   INSERT ... ON CONFLICT ON CONSTRAINT ux_rooms_project_name_alive DO UPDATE
 *   (требуется уникальный индекс на (project_id, lower(name)) WHERE is_deleted=false).
 */
export async function upsertRooms(projectId, items) {
    if (!items?.length) return [];

    const withId = [];
    const noId = [];
    for (const r of items) (r?.id ? withId : noId).push(r);

    const rows = [];

    // 1) Bulk по id
    if (withId.length) {
        const values = [];
        const params = [];
        let i = 1;

        for (const r of withId) {
            values.push(
                `(COALESCE($${i++}, uuid_generate_v4()), $${i++}, $${i++}, $${i++}, now(), false)`
            );
            params.push(
                r.id || null, // id
                projectId, // project_id
                r.name ?? null, // name
                metaToJson(r.meta) // meta
            );
        }

        const sql = `
            INSERT INTO rooms (id, project_id, name, meta, updated_at, is_deleted)
            VALUES ${values.join(",")}
                ON CONFLICT (id) DO UPDATE SET
                project_id = EXCLUDED.project_id,
                                        name       = COALESCE(EXCLUDED.name, rooms.name),
                                        meta       = COALESCE(EXCLUDED.meta, rooms.meta),
                                        updated_at = now(),
                                        is_deleted = false
                                        RETURNING id, project_id, name, meta, updated_at, is_deleted;
        `;
        const res = await query(sql, params);
        rows.push(...res.rows);
    }

    // 2) Идемпотентно без id — один UPSERT по уникальному частичному индексу
    for (const r of noId) {
        const name = r.name ?? null;
        const metaJson = metaToJson(r.meta);

        const sql = `
      INSERT INTO rooms (id, project_id, name, meta, updated_at, is_deleted)
      VALUES (uuid_generate_v4(), $1, $2, $3, now(), false)
      ON CONFLICT ON CONSTRAINT ux_rooms_project_name_alive
      DO UPDATE SET
        name       = COALESCE(EXCLUDED.name, rooms.name),
        meta       = COALESCE(EXCLUDED.meta, rooms.meta),
        updated_at = now(),
        is_deleted = false
      RETURNING id, project_id, name, meta, updated_at, is_deleted
    `;
        const ins = await query(sql, [projectId, name, metaJson]);
        rows.push(ins.rows[0]);
    }

    return rows;
}

export async function deleteRooms(projectId, ids) {
    if (!ids?.length) return [];
    const res = await query(
        `UPDATE rooms
         SET is_deleted = true, updated_at = now()
         WHERE project_id = $1 AND id = ANY($2::uuid[])
             RETURNING id`,
        [projectId, ids]
    );
    return res.rows.map((r) => r.id);
}

/**
 * Дельта комнат.
 * Фикс: используем updated_at >= since (вместо >), чтобы не терять изменения на границе времени.
 */
export async function deltaRooms(projectId, sinceIso) {
    const res = await query(
        `SELECT id, project_id, name, meta, updated_at, is_deleted
         FROM rooms
         WHERE project_id = $1
           AND updated_at >= $2
         ORDER BY updated_at ASC`,
        [projectId, sinceIso]
    );
    return res.rows;
}

export async function getRoomsByProject(projectId) {
    const res = await query(
        `SELECT id, name, meta, updated_at, is_deleted
         FROM rooms
         WHERE project_id = $1`,
        [projectId]
    );
    return res.rows;
}