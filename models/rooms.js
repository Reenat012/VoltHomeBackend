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
 * - Если r.id отсутствует — идемпотентная логика:
 *   ищем живую запись по (project_id, name). Если нашли — UPDATE, иначе INSERT.
 *
 * Это защищает от дублей при ретраях batch-запросов, когда клиент слал комнаты без id.
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
            values.push(`(COALESCE($${i++}, uuid_generate_v4()), $${i++}, $${i++}, $${i++}, now(), false)`);
            params.push(
                r.id || null,           // id
                projectId,              // project_id
                r.name ?? null,         // name
                metaToJson(r.meta)      // meta
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

    // 2) Идемпотентно без id — по (project_id, name)
    for (const r of noId) {
        const name = r.name ?? null;
        const metaJson = metaToJson(r.meta);

        if (name) {
            const sel = await query(
                `SELECT id
           FROM rooms
          WHERE project_id = $1
            AND name = $2
            AND is_deleted = false
          LIMIT 1`,
                [projectId, name]
            );

            if (sel.rows[0]?.id) {
                const u = await query(
                    `UPDATE rooms
              SET name       = COALESCE($3, name),
                  meta       = COALESCE($4, meta),
                  updated_at = now(),
                  is_deleted = false
            WHERE id = $2 AND project_id = $1
        RETURNING id, project_id, name, meta, updated_at, is_deleted`,
                    [projectId, sel.rows[0].id, name, metaJson]
                );
                rows.push(u.rows[0]);
                continue;
            }
        }

        // INSERT новой, если не нашли подходящую
        const ins = await query(
            `INSERT INTO rooms (id, project_id, name, meta, updated_at, is_deleted)
       VALUES (uuid_generate_v4(), $1, $2, $3, now(), false)
   RETURNING id, project_id, name, meta, updated_at, is_deleted`,
            [projectId, name, metaJson]
        );
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