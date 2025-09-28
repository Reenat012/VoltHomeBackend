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
 * - Если d.id отсутствует — идемпотентная логика:
 *   ищем существующую (project_id, name, meta->>'room_id') при is_deleted=false.
 *   Если нашли — делаем UPDATE; если нет — INSERT с новым uuid.
 *
 * Почему так:
 * Клиент при создании «черновых» устройств шлёт их без id, полагаясь на
 * соответствие (комната + имя). Такая серверная логика предотвращает
 * дубли при ретраях batch-запроса.
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
            const groupId = ("groupId" in d) ? d.groupId : (("group_id" in d) ? d.group_id : null);
            values.push(`(COALESCE($${i++}, uuid_generate_v4()), $${i++}, $${i++}, $${i++}, $${i++}, now(), false)`);
            params.push(
                d.id || null,         // id
                projectId,            // project_id
                groupId || null,      // group_id
                d.name ?? null,       // name
                metaToJson(d.meta)    // meta
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

    // 2) идемпотентная обработка без id — по (project_id, room_id, name)
    for (const d of noId) {
        const groupId = ("groupId" in d) ? d.groupId : (("group_id" in d) ? d.group_id : null);
        const metaJson = metaToJson(d.meta);
        const roomId = extractRoomId(d.meta);

        if (roomId && d.name) {
            // ищем живую запись (не удалённую) с тем же project_id, room_id (в meta) и именем
            const sel = await query(
                `SELECT id
           FROM devices
          WHERE project_id = $1
            AND name = $2
            AND (meta->>'room_id') = $3
            AND is_deleted = false
          LIMIT 1`,
                [projectId, d.name, String(roomId)]
            );

            if (sel.rows[0]?.id) {
                // UPDATE существующей — LWW
                const u = await query(
                    `UPDATE devices
              SET group_id   = COALESCE($3, group_id),
                  name       = COALESCE($4, name),
                  meta       = COALESCE($5, meta),
                  updated_at = now(),
                  is_deleted = false
            WHERE id = $2 AND project_id = $1
        RETURNING id, project_id, group_id, name, meta, updated_at, is_deleted`,
                    [projectId, sel.rows[0].id, groupId || null, d.name ?? null, metaJson]
                );
                rows.push(u.rows[0]);
                continue;
            }
        }

        // INSERT новой — если не нашли подходящую
        const ins = await query(
            `INSERT INTO devices (id, project_id, group_id, name, meta, updated_at, is_deleted)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4, now(), false)
   RETURNING id, project_id, group_id, name, meta, updated_at, is_deleted`,
            [projectId, groupId || null, d.name ?? null, metaJson]
        );
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