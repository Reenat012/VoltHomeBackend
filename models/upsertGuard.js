// models/upsertGuard.js
// Общие правила записи rooms/groups/devices по id (docs/SYNC_CONTRACT.md, разделы 6 и 8):
//  1) id, занятый записью ДРУГОГО проекта, отклоняется явной ошибкой (раньше запись молча пропускалась
//     или, в rooms, перезаписывалась);
//  2) «последний победил по записи»: если на сервере запись новее, чем clientUpdatedAt клиента,
//     операция пропускается и попадает в conflicts с причиной server_newer.
import { query } from "../db/pool.js";

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000; // часы клиента могут спешить не более чем на 5 минут

function httpError(status, code, message) {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    err.expose = true;
    return err;
}

/** Разбирает clientUpdatedAt/client_updated_at. Возвращает ISO-строку или null. Неверное значение даёт 400. */
export function parseClientTs(item, now = Date.now()) {
    const raw = item?.clientUpdatedAt ?? item?.client_updated_at ?? null;
    if (raw === null || raw === undefined || raw === "") return null;
    const t = new Date(raw).getTime();
    if (Number.isNaN(t)) throw httpError(400, "bad_value", "clientUpdatedAt: неверная дата");
    return new Date(Math.min(t, now + MAX_FUTURE_SKEW_MS)).toISOString();
}

/**
 * @param {"rooms"|'"groups"'|"devices"} table  имя таблицы (только внутренние константы)
 * @param {string} projectId
 * @param {Array} items  записи с возможным id и clientUpdatedAt
 * @returns {{ accept: Array, skipped: Array<{entity, id, reason}> }}
 */
export async function classifyUpserts(table, entity, projectId, items) {
    const ids = [...new Set(items.map((i) => i?.id).filter(Boolean))];
    if (ids.length === 0) return { accept: items, skipped: [] };

    const { rows } = await query(
        `SELECT id, project_id, client_updated_at, updated_at FROM ${table} WHERE id = ANY($1::uuid[])`,
        [ids]
    );
    const existing = new Map(rows.map((r) => [r.id, r]));

    const foreign = rows.filter((r) => r.project_id !== projectId).map((r) => r.id);
    if (foreign.length) {
        throw httpError(409, "ID_CONFLICT", "Идентификатор уже используется в другом проекте");
    }

    const accept = [];
    const skipped = [];
    for (const item of items) {
        const row = item?.id ? existing.get(item.id) : null;
        const clientTs = parseClientTs(item);
        if (row && clientTs) {
            const serverTs = new Date(row.client_updated_at ?? row.updated_at).getTime();
            if (serverTs > new Date(clientTs).getTime()) {
                skipped.push({ entity, id: item.id, reason: "server_newer" });
                continue;
            }
        }
        accept.push(item);
    }
    return { accept, skipped };
}

/** Проверяет, что все комнаты принадлежат проекту и не удалены; иначе 422 ROOM_PROJECT_MISMATCH. */
export async function assertRoomsInProject(projectId, roomIds) {
    const ids = [...new Set((roomIds || []).filter(Boolean))];
    if (!ids.length) return;
    const { rows } = await query(
        `SELECT id FROM public.rooms WHERE project_id = $1 AND id = ANY($2::uuid[]) AND is_deleted = FALSE`,
        [projectId, ids]
    );
    const ok = new Set(rows.map((r) => r.id));
    const bad = ids.filter((id) => !ok.has(id));
    if (bad.length) throw httpError(422, "ROOM_PROJECT_MISMATCH", `room_id не принадлежит проекту: ${bad.join(", ")}`);
}

/** Проверяет, что все группы принадлежат проекту; иначе 422 GROUP_PROJECT_MISMATCH. */
export async function assertGroupsInProject(projectId, groupIds) {
    const ids = [...new Set((groupIds || []).filter(Boolean))];
    if (!ids.length) return;
    const { rows } = await query(
        `SELECT id FROM public."groups" WHERE project_id = $1 AND id = ANY($2::uuid[])`,
        [projectId, ids]
    );
    const ok = new Set(rows.map((r) => r.id));
    const bad = ids.filter((id) => !ok.has(id));
    if (bad.length) throw httpError(422, "GROUP_PROJECT_MISMATCH", `group_id не принадлежит проекту: ${bad.join(", ")}`);
}
