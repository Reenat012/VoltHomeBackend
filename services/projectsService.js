// File: VoltHomeBackend/services/projectsService.js
import { pool } from "../db/pool.js";

/**
 * Универсальный аудит: сначала пробуем колонку "detail",
 * если её нет (42703) — пробуем колонку "payload".
 * Любые ошибки аудита — логируем и НЕ пробрасываем (чтобы не катить основную транзакцию).
 */
async function tryAudit({ clientOrPool, userId, action, entity, dataObj }) {
    const detailJson = JSON.stringify(dataObj ?? {});
    const c = clientOrPool || pool;

    // Попытка через колонку "detail"
    try {
        await c.query(
            `INSERT INTO audit_log (user_id, action, entity, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
            [userId, action, entity, detailJson]
        );
        return;
    } catch (e) {
        // 42703 — undefined_column
        if (e?.code !== "42703") {
            // Другие ошибки аудита — просто логируем (не мешаем бизнес-логике)
            console.warn("[audit] detail insert failed:", e.message || e);
            return;
        }
    }

    // Фоллбэк через колонку "payload"
    try {
        await c.query(
            `INSERT INTO audit_log (user_id, action, entity, payload)
       VALUES ($1, $2, $3, $4::jsonb)`,
            [userId, action, entity, detailJson]
        );
    } catch (e2) {
        console.warn("[audit] payload insert failed:", e2.message || e2);
    }
}

/**
 * Применение батча изменений к проекту.
 * ВАЖНО: ошибки аудита не катят транзакцию.
 * Здесь показан общий каркас; конкретные операции insert/update для rooms/groups/devices
 * должны соответствовать вашей текущей схеме.
 */
export async function applyBatch({ userId, projectId, operations = [] }) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // Примерная структура применения операций (адаптируйте под свой формат ops)
        for (const op of operations) {
            switch (op.type) {
                case "room.insert": {
                    await client.query(
                        `INSERT INTO rooms (id, project_id, name, icon, note)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id) DO NOTHING`,
                        [op.payload.id, projectId, op.payload.name, op.payload.icon, op.payload.note || null]
                    );
                    break;
                }
                case "room.update": {
                    await client.query(
                        `UPDATE rooms
             SET name = COALESCE($3, name),
                 icon = COALESCE($4, icon),
                 note = COALESCE($5, note),
                 updated_at = NOW()
             WHERE id = $1 AND project_id = $2`,
                        [op.payload.id, projectId, op.payload.name, op.payload.icon, op.payload.note || null]
                    );
                    break;
                }
                case "group.insert": {
                    await client.query(
                        `INSERT INTO groups (id, project_id, room_id, name, phase, note)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO NOTHING`,
                        [
                            op.payload.id,
                            projectId,
                            op.payload.roomId,
                            op.payload.name,
                            op.payload.phase || null,
                            op.payload.note || null,
                        ]
                    );
                    break;
                }
                case "group.update": {
                    await client.query(
                        `UPDATE groups
             SET room_id = COALESCE($3, room_id),
                 name    = COALESCE($4, name),
                 phase   = COALESCE($5, phase),
                 note    = COALESCE($6, note),
                 updated_at = NOW()
             WHERE id = $1 AND project_id = $2`,
                        [
                            op.payload.id,
                            projectId,
                            op.payload.roomId,
                            op.payload.name,
                            op.payload.phase || null,
                            op.payload.note || null,
                        ]
                    );
                    break;
                }
                case "device.insert": {
                    await client.query(
                        `INSERT INTO devices (id, project_id, group_id, name, power, voltage, demand_ratio, power_factor, has_motor, requires_dedicated_circuit, requires_socket_connection, note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (id) DO NOTHING`,
                        [
                            op.payload.id,
                            projectId,
                            op.payload.groupId,
                            op.payload.name,
                            op.payload.power,
                            op.payload.voltage,
                            op.payload.demandRatio,
                            op.payload.powerFactor,
                            op.payload.hasMotor,
                            op.payload.requiresDedicatedCircuit,
                            op.payload.requiresSocketConnection,
                            op.payload.note || null,
                        ]
                    );
                    break;
                }
                case "device.update": {
                    await client.query(
                        `UPDATE devices
             SET group_id = COALESCE($3, group_id),
                 name     = COALESCE($4, name),
                 power    = COALESCE($5, power),
                 voltage  = COALESCE($6, voltage),
                 demand_ratio = COALESCE($7, demand_ratio),
                 power_factor = COALESCE($8, power_factor),
                 has_motor    = COALESCE($9, has_motor),
                 requires_dedicated_circuit = COALESCE($10, requires_dedicated_circuit),
                 requires_socket_connection = COALESCE($11, requires_socket_connection),
                 note = COALESCE($12, note),
                 updated_at = NOW()
             WHERE id = $1 AND project_id = $2`,
                        [
                            op.payload.id,
                            projectId,
                            op.payload.groupId,
                            op.payload.name,
                            op.payload.power,
                            op.payload.voltage,
                            op.payload.demandRatio,
                            op.payload.powerFactor,
                            op.payload.hasMotor,
                            op.payload.requiresDedicatedCircuit,
                            op.payload.requiresSocketConnection,
                            op.payload.note || null,
                        ]
                    );
                    break;
                }
                default:
                    // неизвестная операция — игнорируем или бросаем ошибку по вашему решению
                    break;
            }
        }

        // Обновим версию проекта и updated_at
        await client.query(
            `UPDATE projects
       SET version = version + 1,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
            [projectId, userId]
        );

        await client.query("COMMIT");

        // АУДИТ — намеренно ВНЕ основной транзакции, best-effort.
        try {
            await tryAudit({
                clientOrPool: pool, // отдельный круг
                userId,
                action: "batch.apply",
                entity: "project",
                dataObj: { projectId, opsCount: operations.length },
            });
        } catch (auditErr) {
            // на всякий случай (хотя tryAudit уже сам ловит), не мешаем ответу клиенту
            console.warn("[audit] failed after commit:", auditErr?.message || auditErr);
        }

        // Возвращаем краткую квитанцию (серверные логи показывали 31 байт тела)
        return { applied: true, count: operations.length };
    } catch (e) {
        try {
            await client.query("ROLLBACK");
        } catch { /* no-op */ }
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Получение дельты изменений по проекту после момента `since` (ISO).
 * Предикаты строго ">" — оставляем как было.
 */
export async function getDelta({ userId, projectId, since }) {
    const { rows: rooms } = await pool.query(
        `SELECT id, project_id, name, icon, note, updated_at, is_deleted
     FROM rooms
     WHERE project_id = $1
       AND updated_at > $2::timestamptz
     ORDER BY updated_at ASC`,
        [projectId, since]
    );

    const { rows: groups } = await pool.query(
        `SELECT id, project_id, room_id, name, phase, note, updated_at, is_deleted
     FROM groups
     WHERE project_id = $1
       AND updated_at > $2::timestamptz
     ORDER BY updated_at ASC`,
        [projectId, since]
    );

    const { rows: devices } = await pool.query(
        `SELECT id, project_id, group_id, name, power, voltage, demand_ratio, power_factor,
            has_motor, requires_dedicated_circuit, requires_socket_connection, note,
            updated_at, is_deleted
     FROM devices
     WHERE project_id = $1
       AND updated_at > $2::timestamptz
     ORDER BY updated_at ASC`,
        [projectId, since]
    );

    // Версию проекта (на момент ответа) можно вернуть для согласования
    const { rows: proj } = await pool.query(
        `SELECT id, version, updated_at FROM projects WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [projectId, userId]
    );

    return {
        project: proj[0] || null,
        rooms,
        groups,
        devices,
        next: null, // при необходимости добавьте курсор
    };
}