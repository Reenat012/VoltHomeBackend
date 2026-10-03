// models/sessions.js
import { query, withTransaction } from "../db/pool.js";
import crypto from "crypto";
import { getRefreshTtlDays } from "../utils/config.js";

const REFRESH_TTL_DAYS = getRefreshTtlDays();

/** Хэш refresh-токена как hex-строка (в базе хранится только хэш). */
export function sha256Hex(token) {
    return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export async function createSession({ userId, refreshToken, userAgent, ip, now = new Date() }) {
    const expiresAt = new Date(now.getTime() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
    const tokenHash = sha256Hex(refreshToken);
    const res = await query(
        `INSERT INTO refresh_sessions (user_id, token_hash, user_agent, ip, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, user_id, created_at, expires_at`,
        [userId, tokenHash, userAgent || null, ip || null, expiresAt]
    );
    return res.rows[0];
}

export async function getSessionByToken(refreshToken) {
    const tokenHash = sha256Hex(refreshToken);
    const res = await query(`SELECT * FROM refresh_sessions WHERE token_hash = $1 LIMIT 1`, [tokenHash]);
    return res.rows[0] || null;
}

export async function markRevoked(sessionId) {
    await query(
        `UPDATE refresh_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
        [sessionId]
    );
}

/**
 * Ротация одной транзакцией: старая сессия отзывается только если она ещё действует.
 * Возвращает id новой сессии или null, если старую уже использовали (повторное или одновременное использование).
 */
export async function rotateSession({ oldSessionId, userId, newRefreshToken, userAgent, ip }) {
    const tokenHash = sha256Hex(newRefreshToken);
    return withTransaction(async (client) => {
        const old = await client.query(
            `UPDATE refresh_sessions SET revoked_at = now()
             WHERE id = $1 AND revoked_at IS NULL
             RETURNING id`,
            [oldSessionId]
        );
        if (old.rowCount === 0) return null;
        const ins = await client.query(
            `INSERT INTO refresh_sessions (user_id, token_hash, user_agent, ip, expires_at)
             VALUES ($1, $2, $3, $4, now() + ($5 || ' days')::interval)
             RETURNING id`,
            [userId, tokenHash, userAgent || null, ip || null, String(REFRESH_TTL_DAYS)]
        );
        const newId = ins.rows[0].id;
        await client.query(`UPDATE refresh_sessions SET replaced_by = $1 WHERE id = $2`, [newId, oldSessionId]);
        return newId;
    });
}

export async function revokeAllForUser(userId) {
    await query(
        `UPDATE refresh_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
    );
}

export async function pruneExpired() {
    await query(
        `DELETE FROM refresh_sessions
         WHERE (expires_at < now() OR revoked_at IS NOT NULL)
           AND created_at < now() - interval '90 days'`
    );
}
