// models/groups.js
import { query } from "../db/pool.js";

/** Нормализация meta в строку JSON или null */
function metaToJson(meta) {
    return meta ? (typeof meta === "string" ? meta : JSON.stringify(meta)) : null;
}

/** Достаёт room_id из g.roomId | g.room_id | g.meta */
function extractRoomIdNullable(obj) {
    if (!obj) return null;
    if (obj.roomId) return obj.roomId;
    if (obj.room_id) return obj.room_id;
    const m = obj.meta;
    if (!m) return null;
    if (typeof m === "string") {
        try {
            return JSON.parse(m)?.room_id ?? null;
        } catch {
            return null;
        }
    }
    return m?.room_id ?? null;
}

/** Уникальные truthy-значения */
function uniq(arr) {
    return Array.from(new Set((arr || []).filter(Boolean)));
}

/**
 * Гарантирует существование дефолтных групп (__default__) для набора roomIds.
 * ВАЖНО: не используем ON CONFLICT ON CONSTRAINT (частичного уникального констрейнта может не быть).
 * Вставляем только отсутствующие через LEFT JOIN ... WHERE g.id IS NULL.
 * Возвращает Map(roomId -> groupId).
 */
export async function ensureDefaultGroups(projectId, roomIds) {
    const rooms = uniq(roomIds);
    if (!rooms.length) return new Map();

    const res = await query(
        `
            WITH ids AS (
                SELECT DISTINCT UNNEST($1::uuid[]) AS room_id
            ),
                 ins AS (
            INSERT INTO public."groups"(id, project_id, room_id, name, meta, updated_at, is_deleted)
            SELECT uuid_generate_v4(), $2::uuid, i.room_id, '__default__', NULL, now(), FALSE
            FROM ids i
                     LEFT JOIN public."groups" g
                               ON g.project_id = $2::uuid
       AND g.room_id    = i.room_id
       AND g.name       = '__default__'
       AND g.is_deleted = FALSE
            WHERE g.id IS NULL
                RETURNING id, room_id
                )
            SELECT g.id, g.room_id
            FROM public."groups" g
                     JOIN ids i ON i.room_id = g.room_id
            WHERE g.project_id = $2::uuid
      AND g.name = '__default__'
      AND g.is_deleted = FALSE;
        `,
        [rooms, projectId]
    );

    const m = new Map();
    for (const r of res.rows) m.set(r.room_id, r.id);
    return m;
}

/**
 * BULK upsert групп.
 * - если передан id: INSERT ... ON CONFLICT(id) DO UPDATE (LWW по id в рамках project_id)
 * - если id нет: генерируем его через uuid_generate_v4()
 * Поля:
 *   - roomId | room_id (оба принимаются)
 *   - name (может быть null)
 *   - meta (объект или строка JSON)
 */
export async function upsertGroups(projectId, items) {
    if (!items?.length) return [];
    const values = [];
    const params = [];
    let i = 1;

    for (const g of items) {
        const roomId = extractRoomIdNullable(g);
        values.push(
            `(COALESCE($${i++}::uuid, uuid_generate_v4()), $${i++}::uuid, $${i++}::uuid, $${i++}::text, $${i++}::jsonb, now(), FALSE)`
        );
        params.push(
            g.id || null,          // id (или сгенерим)
            projectId,             // project_id
            roomId,                // room_id
            g.name ?? null,        // name
            metaToJson(g.meta)     // meta (jsonb|null)
        );
    }

    const sql = `
        INSERT INTO public."groups" (id, project_id, room_id, name, meta, updated_at, is_deleted)
        VALUES ${values.join(",")}
            ON CONFLICT (id) DO UPDATE SET
            project_id = EXCLUDED.project_id,
                                    room_id    = EXCLUDED.room_id,
                                    name       = COALESCE(EXCLUDED.name, "groups".name),
                                    meta       = COALESCE(EXCLUDED.meta, "groups".meta),
                                    updated_at = now(),
                                    is_deleted = FALSE
                                WHERE "groups".project_id = EXCLUDED.project_id
                                    RETURNING id, project_id, room_id, name, meta, updated_at, is_deleted;
    `;
    const res = await query(sql, params);
    return res.rows;
}

/** Мягкое удаление групп по id */
export async function deleteGroups(projectId, ids) {
    if (!ids?.length) return [];
    const res = await query(
        `UPDATE public."groups"
         SET is_deleted = TRUE, updated_at = now()
         WHERE project_id = $1 AND id = ANY($2::uuid[])
             RETURNING id`,
        [projectId, ids]
    );
    return res.rows.map((r) => r.id);
}

/** Дельта групп (updated_at >= since) */
export async function deltaGroups(projectId, sinceIso) {
    const res = await query(
        `SELECT id, project_id, room_id, name, meta, updated_at, is_deleted
         FROM public."groups"
         WHERE project_id = $1
           AND updated_at >= $2
         ORDER BY updated_at ASC`,
        [projectId, sinceIso]
    );
    return res.rows;
}

/** Живые группы проекта (только по «живым» комнатам) */
export async function getGroupsByProject(projectId) {
    const res = await query(
        `SELECT g.id, g.room_id, g.name, g.meta, g.updated_at, g.is_deleted
         FROM public."groups" g
                  JOIN public.rooms r
                       ON r.id = g.room_id
                           AND r.is_deleted = FALSE
         WHERE g.project_id = $1
           AND g.is_deleted = FALSE`,
        [projectId]
    );
    return res.rows;
}