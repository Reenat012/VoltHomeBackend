// services/adminService.js
// Управление выдачей PRO вручную. Вызывается ТОЛЬКО из консольного скрипта scripts/admin.js
// на сервере (публичной админ-ручки нет). Каждое действие пишется в audit_log.
import { query } from "../db/pool.js";
import { grantEntitlement, revokeEntitlements, listEntitlements } from "../models/entitlements.js";
import { audit } from "../utils/audit.js";

export class AdminError extends Error {}

/** until: пусто или "forever" = бессрочно; иначе дата (например, 2027-01-31) в будущем. */
export function parseUntil(value, now = new Date()) {
    if (value === undefined || value === null || value === "" || value === "forever") return null;
    const text = String(value).trim();
    // Дата без времени означает конец этого дня по UTC
    const d = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T23:59:59Z`) : new Date(text);
    if (Number.isNaN(d.getTime())) throw new AdminError(`Неверная дата: ${text}`);
    if (d.getTime() <= now.getTime()) throw new AdminError(`Дата уже прошла: ${text}`);
    return d;
}

export async function findUsers({ uid, email, externalId } = {}) {
    if (!uid && !email && !externalId) throw new AdminError("Укажите --uid, --email или --yandex-id");
    const res = await query(
        `SELECT u.uid, u.display_name, u.email, u.created_at,
                COALESCE(json_agg(json_build_object('provider', i.provider, 'external_id', i.external_id))
                         FILTER (WHERE i.uid IS NOT NULL), '[]') AS identities
         FROM users u
         LEFT JOIN identities i ON i.uid = u.uid
         WHERE ($1::text IS NULL OR u.uid = $1)
           AND ($2::text IS NULL OR u.email ILIKE '%' || $2 || '%')
           AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM identities x WHERE x.uid = u.uid AND x.external_id = $3))
         GROUP BY u.uid
         ORDER BY u.created_at DESC
         LIMIT 50`,
        [uid || null, email || null, externalId || null]
    );
    return res.rows;
}

async function requireUser(uid) {
    if (!uid) throw new AdminError("Укажите --uid");
    const res = await query(`SELECT uid FROM users WHERE uid = $1`, [uid]);
    if (!res.rows[0]) throw new AdminError(`Пользователь не найден: ${uid}. Он должен хотя бы раз войти в приложение.`);
}

export async function grantPro({ uid, until, note = null, grantedBy = "cli" }) {
    await requireUser(uid);
    const validUntil = parseUntil(until);
    const row = await grantEntitlement({ userId: uid, validUntil, note, grantedBy });
    await audit(`admin:${grantedBy}`, "grant_pro", "user", null, { uid, validUntil, note, entitlementId: row.id });
    return row;
}

export async function revokePro({ uid, revokedBy = "cli" }) {
    await requireUser(uid);
    const count = await revokeEntitlements(uid);
    await audit(`admin:${revokedBy}`, "revoke_pro", "user", null, { uid, revoked: count });
    return count;
}

export async function listGrants({ uid = null, activeOnly = false } = {}) {
    return listEntitlements({ userId: uid, activeOnly });
}
