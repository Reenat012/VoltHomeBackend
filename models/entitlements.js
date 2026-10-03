// models/entitlements.js
// Ручные выдачи PRO. Подписки RuStore хранятся отдельно (models/subscriptions.js).
import { query } from "../db/pool.js";

const COLUMNS = "id, user_id, plan, source, valid_until, note, granted_by, created_at, revoked_at";

/** Действующая выдача пользователя с самым поздним сроком (бессрочная считается самой поздней). */
export async function getActiveEntitlementForUser(userId) {
    if (!userId) return null;
    const res = await query(
        `SELECT ${COLUMNS} FROM entitlements
         WHERE user_id = $1 AND revoked_at IS NULL
           AND (valid_until IS NULL OR valid_until > now())
         ORDER BY valid_until DESC NULLS FIRST, created_at DESC
         LIMIT 1`,
        [userId]
    );
    return res.rows[0] || null;
}

export async function grantEntitlement({ userId, validUntil = null, note = null, grantedBy }) {
    const res = await query(
        `INSERT INTO entitlements (user_id, plan, source, valid_until, note, granted_by)
         VALUES ($1, 'pro', 'manual', $2, $3, $4)
         RETURNING ${COLUMNS}`,
        [userId, validUntil, note, grantedBy]
    );
    return res.rows[0];
}

/** Отзывает все действующие выдачи пользователя. Возвращает число отозванных. */
export async function revokeEntitlements(userId) {
    const res = await query(
        `UPDATE entitlements SET revoked_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
    );
    return res.rowCount;
}

export async function listEntitlements({ userId = null, activeOnly = false } = {}) {
    const res = await query(
        `SELECT ${COLUMNS} FROM entitlements
         WHERE ($1::text IS NULL OR user_id = $1)
           AND (NOT $2::boolean OR (revoked_at IS NULL AND (valid_until IS NULL OR valid_until > now())))
         ORDER BY created_at DESC`,
        [userId, activeOnly]
    );
    return res.rows;
}
