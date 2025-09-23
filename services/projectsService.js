// services/projectsService.js
import { query } from "../db/pool.js";
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
} from "../models/groups.js";
import {
    upsertDevices,
    deleteDevices,
    deltaDevices,
    getDevicesByProject,
} from "../models/devices.js";
import { nowUtcIso } from "../utils/time.js";

function conflict(reason, entity, id) {
    return { entity, id, reason };
}

/**
 * Безопасный аудит: сначала пытается писать в колонку detail,
 * если её нет — пробует payload. Любые ошибки аудита — только логируются.
 * Выполняется ВНЕ транзакции батча, чтобы не катить основные изменения.
 */
async function tryAuditBestEffort({ userId, action, entity, data }) {
    const payload = JSON.stringify(data ?? {});
    // detail
    try {
        await query(
            `INSERT INTO audit_log(user_id, action, entity, detail)
             VALUES ($1, $2, $3, $4::jsonb)`,
            [userId, action, entity, payload]
        );
        return;
    } catch (e) {
        if (e?.code !== "42703") {
            console.warn("[audit] detail insert failed:", e?.message || e);
            return;
        }
    }
    // payload (fallback)
    try {
        await query(
            `INSERT INTO audit_log(user_id, action, entity, payload)
             VALUES ($1, $2, $3, $4::jsonb)`,
            [userId, action, entity, payload]
        );
    } catch (e2) {
        console.warn("[audit] payload insert failed:", e2?.message || e2);
    }
}

/**
 * Возвращает JSON-дерево проекта (мета + сущности)
 */
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

/**
 * Дельта с updated_at > since (ISO)
 */
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
 * - Изменения и инкремент версии делаем в транзакции.
 * - Аудит выносим ВНЕ транзакции и делаем best-effort (не роняет батч).
 *
 * ВАЖНО:
 *  - upsertRooms/Groups/Devices вызываем с (projectId, items) — без userId
 *  - если UPDATE projects ничего не вернул — newVersion = meta.version + 1
 */
export async function applyBatch({ userId, projectId, baseVersion, ops }) {
    const meta = await getProjectMeta({ userId, projectId });
    if (!meta) return { notFound: true };

    const conflicts = [];
    const stale = typeof baseVersion === "number" && baseVersion < meta.version;

    await query("BEGIN");
    let newVersion = meta.version + 1;
    try {
        // LWW: апсерты перезаписывают, delete ставит tombstone.
        if (ops?.rooms?.upsert?.length) await upsertRooms(projectId, ops.rooms.upsert);
        if (ops?.groups?.upsert?.length) await upsertGroups(projectId, ops.groups.upsert);
        if (ops?.devices?.upsert?.length) await upsertDevices(projectId, ops.devices.upsert);

        if (ops?.rooms?.delete?.length) await deleteRooms(projectId, ops.rooms.delete);
        if (ops?.groups?.delete?.length) await deleteGroups(projectId, ops.groups.delete);
        if (ops?.devices?.delete?.length) await deleteDevices(projectId, ops.devices.delete);

        const verRes = await query(
            `UPDATE projects
             SET version = version + 1, updated_at = now()
             WHERE id = $1 AND user_id = $2
             RETURNING version`,
            [projectId, userId]
        );
        newVersion = verRes.rows?.[0]?.version ?? meta.version + 1;

        if (stale) {
            const kind = "Stale baseVersion; server wins (LWW)";
            for (const arr of [
                (ops?.rooms?.upsert || []).map((x) => ["rooms", x.id]),
                (ops?.groups?.upsert || []).map((x) => ["groups", x.id]),
                (ops?.devices?.upsert || []).map((x) => ["devices", x.id]),
                (ops?.rooms?.delete || []).map((id) => ["rooms", id]),
                (ops?.groups?.delete || []).map((id) => ["groups", id]),
                (ops?.devices?.delete || []).map((id) => ["devices", id]),
            ]) {
                for (const [entity, id] of arr) conflicts.push(conflict(kind, entity, id));
            }
        }

        await query("COMMIT");
    } catch (e) {
        await query("ROLLBACK");
        throw e;
    }

    // Аудит — уже вне транзакции; ошибки не мешают основному результату.
    try {
        await tryAuditBestEffort({
            userId,
            action: "batch",
            entity: "projects",
            data: {
                projectId,
                baseVersion,
                newVersion,
                counts: {
                    roomsUpsert: ops?.rooms?.upsert?.length || 0,
                    roomsDelete: ops?.rooms?.delete?.length || 0,
                    groupsUpsert: ops?.groups?.upsert?.length || 0,
                    groupsDelete: ops?.groups?.delete?.length || 0,
                    devicesUpsert: ops?.devices?.upsert?.length || 0,
                    devicesDelete: ops?.devices?.delete?.length || 0,
                },
            },
        });
    } catch (e) {
        // на всякий случай (tryAuditBestEffort и так глотает несовпадение колонок)
        console.warn("[audit] unexpected error:", e?.message || e);
    }

    return { newVersion, conflicts };
}