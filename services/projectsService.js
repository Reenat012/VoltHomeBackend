// services/projectsService.js
import { query, withTransaction } from "../db/pool.js";
import {
    createProject,
    listProjects,
    getProjectMeta,
    updateProjectMeta,
    softDeleteProject,
} from "../models/projects.js";
import {
    upsertRooms,
    deleteRooms,
    deltaRooms,
    getRoomsByProject,
} from "../models/rooms.js";
import {
    upsertGroups,
    deleteGroups,
    deltaGroups,
    getGroupsByProject,
    ensureDefaultGroups, // ⚠️ нужен экспорт в models/groups.js
} from "../models/groups.js";
import {
    upsertDevices,
    deleteDevices,
    deltaDevices,
    getDevicesByProject,
} from "../models/devices.js";

/** Конструктор описания конфликта (например, при устаревшем baseVersion). */
function conflict(reason, entity, id) {
    return { entity, id, reason };
}

/** Возвращает JSON-дерево проекта (мета + сущности) */
export async function getProjectTree({ userId, projectId }) {
    const meta = await getProjectMeta({ userId, projectId });
    if (!meta) return null;
    const [rooms, groups, devices] = await Promise.all([
        getRoomsByProject(projectId),
        getGroupsByProject(projectId),
        getDevicesByProject(projectId),
    ]);
    return { project: meta, rooms, groups, devices };
}

/** Дельта с updated_at > since (ISO) */
export async function getDelta({ userId, projectId, since }) {
    const meta = await getProjectMeta({ userId, projectId });
    if (!meta) return null;
    const [r, g, d] = await Promise.all([
        deltaRooms(projectId, since),
        deltaGroups(projectId, since),
        deltaDevices(projectId, since),
    ]);

    const rooms = {
        upsert: r.filter((x) => !x.is_deleted),
        delete: r.filter((x) => x.is_deleted).map((x) => x.id),
    };
    const groups = {
        upsert: g.filter((x) => !x.is_deleted),
        delete: g.filter((x) => x.is_deleted).map((x) => x.id),
    };
    const devices = {
        upsert: d.filter((x) => !x.is_deleted),
        delete: d.filter((x) => x.is_deleted).map((x) => x.id),
    };

    return { rooms, groups, devices };
}

/**
 * Пакетная запись. Все операции выполняются одной транзакцией: ошибка откатывает всё.
 * Порядок:
 *   DELETE: devices → groups → rooms
 *   UPSERT: rooms → groups → devices
 * Правило конфликтов (docs/SYNC_CONTRACT.md, раздел 8): «последний победил по записи».
 * Запись, у которой на сервере более новая версия, пропускается и возвращается в conflicts
 * с причиной server_newer. baseVersion принимается для совместимости, но на решение не влияет.
 */
export async function applyBatch({ userId, projectId, ops }) {
    const meta = await getProjectMeta({ userId, projectId });
    if (!meta) return { notFound: true };

    const conflicts = [];

    const newVersion = await withTransaction(async (client) => {
        // DELETE (дети → родители)
        if (ops?.devices?.delete?.length) await deleteDevices(projectId, ops.devices.delete);
        if (ops?.groups?.delete?.length)  await deleteGroups(projectId, ops.groups.delete);
        if (ops?.rooms?.delete?.length)   await deleteRooms(projectId, ops.rooms.delete);

        // UPSERT (родители → дети)
        if (ops?.rooms?.upsert?.length) {
            const r = await upsertRooms(projectId, ops.rooms.upsert);
            conflicts.push(...r.skipped);
        }
        if (ops?.groups?.upsert?.length) {
            const g = await upsertGroups(projectId, ops.groups.upsert);
            conflicts.push(...g.skipped);
        }

        // Обеспечиваем дефолтные группы под комнаты, используемые в devices.meta.room_id
        if (ops?.devices?.upsert?.length) {
            const roomIds = Array.from(new Set(
                ops.devices.upsert
                    .map(d => {
                        try {
                            const m = typeof d.meta === "string" ? JSON.parse(d.meta) : d.meta;
                            return m?.room_id ?? null;
                        } catch { return null; }
                    })
                    .filter(Boolean)
            ));
            if (roomIds.length) {
                await ensureDefaultGroups(projectId, roomIds);
            }
            const d = await upsertDevices(projectId, ops.devices.upsert);
            conflicts.push(...d.skipped);
        }

        // Инкремент версии проекта — внутри той же транзакции
        const verRes = await client.query(
            `UPDATE projects
             SET version = version + 1, updated_at = now()
             WHERE id = $1 AND user_id = $2
             RETURNING version`,
            [projectId, userId]
        );

        return verRes.rows?.[0]?.version ?? meta.version + 1;
    });

    return { newVersion, conflicts };
}
