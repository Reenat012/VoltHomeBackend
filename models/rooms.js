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
 * - Если r.id отсутствует — идемпотентный UPDATE-или-INSERT без ON CONSTRAINT:
 *   1) ищем «живую» комнату по (project_id, lower(name)),
 *   2) если есть — UPDATE (возврат обновлённой строки),
 *   3) если нет — INSERT новой.
 *
 * Это снимает потребность в частичном уникальном индексе и устраняет 42P10.
 */
export async function upsertRooms(projectId, items) {
    if (!items?.length) return [];

    const withId = [];
    const noId = [];
    for (const r of items) (r?.id ? withId : noId).push(r);

    const rows = [];

    // 1) Bulk по id (LWW)
    if (withId.length) {
        const values = [];
        const params = [];
        let i = 1;

        for (const r of withId) {
            values.push(
                `(COALESCE($${i++}, uuid_generate_v4()), $${i++}, $${i++}, $${i++}, now(), false)`
            );
            params.push(
                r.id || null,        // id
                projectId,           // project_id
                r.name ?? null,      // name
                metaToJson(r.meta)   // meta
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

    // 2) Идемпотентно без id — UPDATE-или-INSERT без частичного уникального индекса
    for (const r of noId) {
        const name = r.name ?? null;
        const metaJson = metaToJson(r.meta);

        const sql = `
            WITH existing AS (
                SELECT id
                FROM rooms
                WHERE project_id = $1
                  AND lower(name) = lower($2)
                  AND is_deleted = false
                LIMIT 1
                ), updated AS (
            UPDATE rooms AS rm
            SET name       = COALESCE($2, rm.name),
                meta       = COALESCE($3, rm.meta),
                updated_at = now(),
                is_deleted = false
            WHERE rm.id IN (SELECT id FROM existing)
                RETURNING rm.id, rm.project_id, rm.name, rm.meta, rm.updated_at, rm.is_deleted
                )
            INSERT INTO rooms (id, project_id, name, meta, updated_at, is_deleted)
            SELECT uuid_generate_v4(), $1, $2, $3, now(), false
                WHERE NOT EXISTS (SELECT 1 FROM updated)
      RETURNING id, project_id, name, meta, updated_at, is_deleted;
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
         WHERE project_id = $1
           AND is_deleted = FALSE`,
        [projectId]
    );
    return res.rows;
}