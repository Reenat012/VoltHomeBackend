// utils/audit.js
// Журнал действий (таблица audit_log). Ошибка записи журнала не должна ломать основное действие.
import { query } from "../db/pool.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function audit(userId, action, entity = null, entityId = null, detail = null) {
    try {
        await query(
            `INSERT INTO audit_log (user_id, action, entity, entity_id, detail)
             VALUES ($1, $2, $3, $4, $5)`,
            [
                String(userId ?? "unknown"),
                action,
                entity,
                entityId && UUID_RE.test(String(entityId)) ? entityId : null,
                detail === null || detail === undefined ? null : JSON.stringify(detail),
            ]
        );
    } catch (e) {
        console.error("[audit] не удалось записать:", e?.message || e);
    }
}
