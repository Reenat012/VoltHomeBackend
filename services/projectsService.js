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
 * Батч-запись с LWW и проверкой baseVersion.
 * Порядок:
 *   DELETE: devices → groups → rooms
 *   UPSERT: rooms → groups → devices
 * Версию инкрементируем в той же транзакции.
 */
export async function applyBatch({ userId, projectId, baseVersion, ops }) {
    const meta = await getProjectMeta({ userId, projectId });
    if (!meta) return { notFound: true };

    const conflicts = [];
    const stale = typeof baseVersion === "number" && baseVersion < meta.version;

    const newVersion = await withTransaction(async (client) => {
        // DELETE (дети → родители)
        if (ops?.devices?.delete?.length) await deleteDevices(projectId, ops.devices.delete);
        if (ops?.groups?.delete?.length)  await deleteGroups(projectId, ops.groups.delete);
        if (ops?.rooms?.delete?.length)   await deleteRooms(projectId, ops.rooms.delete);

        // UPSERT (родители → дети)
        if (ops?.rooms?.upsert?.length)   await upsertRooms(projectId, ops.rooms.upsert);
        if (ops?.groups?.upsert?.length)  await upsertGroups(projectId, ops.groups.upsert);

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
            await upsertDevices(projectId, ops.devices.upsert);
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

    if (stale) {
        const reason = "Stale baseVersion; server wins (LWW)";
        const items = [
            ...(ops?.rooms?.upsert   || []).map((x) => ["rooms",   x.id]),
            ...(ops?.groups?.upsert  || []).map((x) => ["groups",  x.id]),
            ...(ops?.devices?.upsert || []).map((x) => ["devices", x.id]),
            ...(ops?.rooms?.delete   || []).map((id) => ["rooms",   id]),
            ...(ops?.groups?.delete  || []).map((id) => ["groups",  id]),
            ...(ops?.devices?.delete || []).map((id) => ["devices", id]),
        ];
        for (const [entity, id] of items) conflicts.push(conflict(reason, entity, id));
    }

    return { newVersion, conflicts };
}