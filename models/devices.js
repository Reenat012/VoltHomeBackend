// models/devices.js
import { query } from "../db/pool.js";
import { ensureDefaultGroups } from "./groups.js";

/** Нормализация meta в строку JSON или null */
function metaToJson(meta) {
    return meta ? (typeof meta === "string" ? meta : JSON.stringify(meta)) : null;
}

/** Достаёт room_id из meta (string | object) */
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
    return meta?.room_id ?? null;
}

function uniq(arr) {
    return Array.from(new Set((arr || []).filter(Boolean)));
}

/**
 * Апсерт устройств:
 * - если прислан group_id — используем его;
 * - если нет group_id, но есть meta.room_id — создаём/находим дефолтную группу комнаты;
 * - если нет ни group_id, ни meta.room_id — кидаем 400 (GROUP_UNRESOLVED), т.к. group_id теперь обязателен.
 *
 * Дополнительно:
 * - Валидация: каждый meta.room_id обязан принадлежать projectId → 422 (ROOM_PROJECT_MISMATCH).
 * - Для записей БЕЗ id — всегда INSERT (uuid_generate_v4()).
 * - Вставки/апдейты всегда задают updated_at и is_deleted.
 */
export async function upsertDevices(projectId, items) {
    if (!items?.length) return [];

    // Собираем и валидируем room_id из meta
    const roomIds = uniq(items.map(d => extractRoomId(d.meta)));

    if (roomIds.length) {
        const { rows } = await query(
            `SELECT id FROM public.rooms
       WHERE project_id = $1
         AND id = ANY($2::uuid[])
         AND is_deleted = FALSE`,
            [projectId, roomIds]
        );
        const ok = new Set(rows.map(r => r.id));
        const bad = roomIds.filter(id => !ok.has(id));
        if (bad.length) {
            const err = new Error(`room_id не принадлежит проекту: ${bad.join(", ")}`);
            err.status = 422;
            err.expose = true;
            err.code = "ROOM_PROJECT_MISMATCH";
            throw err;
        }
    }

    // Гарантируем дефолтные группы под задействованные комнаты
    const roomToDefaultGroup = roomIds.length
        ? await ensureDefaultGroups(projectId, roomIds).catch(() => new Map())
        : new Map();

    // Нормализуем элементы и разделяем на "с id" / "без id"
    const withId = [];
    const noId = [];

    for (const d of items) {
        const incomingGroupId =
            (d.groupId ?? d.group_id) ? (d.groupId ?? d.group_id) : null;

        const rid = extractRoomId(d.meta);
        const resolvedGroupId = incomingGroupId ?? (rid ? roomToDefaultGroup.get(rid) ?? null : null);

        if (!resolvedGroupId) {
            const err = new Error(
                `devices.upsert: нельзя определить group_id для устройства (id=${d.id ?? "<new>"}) — передайте group_id или meta.room_id`
            );
            err.status = 400;
            err.expose = true;
            err.code = "GROUP_UNRESOLVED";
            throw err;
        }

        const norm = {
            ...d,
            id: d.id ?? null,
            group_id: resolvedGroupId,
            name: d.name ?? null,
            meta: d.meta ?? null,
        };

        (norm.id ? withId : noId).push(norm);
    }

    const out = [];

    // 1) bulk UPSERT с id (LWW по id в рамках project_id)
    if (withId.length) {
        const values = [];
        const params = [];
        let i = 1;

        for (const d of withId) {
            values.push(
                `($${i++}::uuid, $${i++}::uuid, $${i++}::uuid, $${i++}::text, $${i++}::jsonb, NOW(), FALSE)`
            );
            params.push(
                d.id,               // id
                projectId,          // project_id
                d.group_id,         // group_id
                d.name,             // name
                metaToJson(d.meta)  // meta
            );
        }

        const sql = `
      INSERT INTO public.devices (id, project_id, group_id, name, meta, updated_at, is_deleted)
      VALUES ${values.join(", ")}
      ON CONFLICT (id) DO UPDATE SET
        project_id = EXCLUDED.project_id,
        group_id   = EXCLUDED.group_id,
        name       = EXCLUDED.name,
        meta       = EXCLUDED.meta,
        updated_at = NOW(),
        is_deleted = FALSE
      WHERE public.devices.project_id = EXCLUDED.project_id
      RETURNING id, project_id, group_id, name, meta, updated_at, is_deleted;
    `;
        const res = await query(sql, params);
        out.push(...res.rows);
    }

    // 2) INSERT без id — новые записи
    if (noId.length) {
        const values = [];
        const params = [];
        let i = 1;

        for (const d of noId) {
            values.push(
                `(uuid_generate_v4(), $${i++}::uuid, $${i++}::uuid, $${i++}::text, $${i++}::jsonb, NOW(), FALSE)`
            );
            params.push(
                projectId,          // project_id
                d.group_id,         // group_id
                d.name,             // name
                metaToJson(d.meta)  // meta
            );
        }

        const sql = `
      INSERT INTO public.devices (id, project_id, group_id, name, meta, updated_at, is_deleted)
      VALUES ${values.join(", ")}
      RETURNING id, project_id, group_id, name, meta, updated_at, is_deleted;
    `;
        const res = await query(sql, params);
        out.push(...res.rows);
    }

    return out;
}

/** Мягкое удаление */
export async function deleteDevices(projectId, ids) {
    if (!ids?.length) return [];
    const res = await query(
        `UPDATE public.devices
         SET is_deleted = TRUE, updated_at = NOW()
         WHERE project_id = $1 AND id = ANY($2::uuid[])
             RETURNING id`,
        [projectId, ids]
    );
    return res.rows.map(r => r.id);
}

/** Дельта устройств (updated_at >= since) */
export async function deltaDevices(projectId, sinceIso) {
    const res = await query(
        `SELECT id, project_id, group_id, name, meta, updated_at, is_deleted
         FROM public.devices
         WHERE project_id = $1
           AND updated_at >= $2
         ORDER BY updated_at ASC`,
        [projectId, sinceIso]
    );
    return res.rows;
}

/** Живые устройства проекта (только по «живым» группам и комнатам) */
export async function getDevicesByProject(projectId) {
    const res = await query(
        `SELECT d.id, d.project_id, d.group_id, d.name, d.meta, d.updated_at, d.is_deleted
         FROM public.devices d
                  JOIN public."groups" g ON g.id = d.group_id AND g.is_deleted = FALSE
                  JOIN public.rooms r    ON r.id = g.room_id AND r.is_deleted = FALSE
         WHERE d.project_id = $1
           AND d.is_deleted = FALSE`,
        [projectId]
    );
    return res.rows;
}

/** Поиск устройств по имени (case-insensitive) в рамках проекта и комнаты */
export async function getDevicesByNameCI(projectId, roomId, name) {
    const res = await query(
        `SELECT d.id, d.project_id, d.group_id, d.name, d.meta, d.updated_at, d.is_deleted
     FROM public.devices d
     JOIN public."groups" g ON g.id = d.group_id AND g.is_deleted = FALSE
     WHERE d.project_id = $1
       AND g.room_id = $2
       AND lower(d.name) = lower($3)
       AND d.is_deleted = FALSE
     ORDER BY d.updated_at DESC
     LIMIT 200`,
        [projectId, roomId, name]
    );
    return res.rows;
}