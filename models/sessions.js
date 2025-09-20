// models/sessions.js
import { query } from "../db/pool.js";
import crypto from "crypto";

const REFRESH_TTL_DAYS = +(process.env.REFRESH_TTL_DAYS || 30);

export function sha256Buf(token) {
    return Buffer.from(crypto.createHash("sha256").update(token, "utf8").digest("hex"), "hex");
}

export async function createSession({ userId, refreshToken, userAgent, ip, now = new Date() }) {
    const expiresAt = new Date(now.getTime() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
    const tokenHash = sha256Buf(refreshToken);
    const res = await query(
        `INSERT INTO refresh_sessions (user_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, user_id, created_at, expires_at`,
        [userId, tokenHash, userAgent || null, ip || null, expiresAt]
    );
    return res.rows[0];
}

export async function getSessionByToken(refreshToken) {
    const tokenHash = sha256Buf(refreshToken);
    const res = await query(
        `SELECT * FROM refresh_sessions WHERE token_hash=$1 LIMIT 1`,
        [tokenHash]
    );
    return res.rows[0] || null;
}

export async function markRevoked(sessionId) {
    await query(
        `UPDATE refresh_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
        [sessionId]
    );
}

export async function rotateSession({ oldSessionId, userId, newRefreshToken }) {
    const tokenHash = sha256Buf(newRefreshToken);
    const res = await query(
        `WITH ins AS (
        INSERT INTO refresh_sessions (user_id, token_hash, expires_at)
        VALUES ($1, $2, now() + ($3 || ' days')::interval)
        RETURNING id
      )
      UPDATE refresh_sessions
         SET revoked_at = now(), replaced_by = (SELECT id FROM ins)
       WHERE id = $4
       RETURNING (SELECT id FROM ins) AS new_id`,
        [userId, tokenHash, REFRESH_TTL_DAYS, oldSessionId]
    );
    return res.rows[0]?.new_id || null;
}

export async function revokeAllForUser(userId) {
    await query(
        `UPDATE refresh_sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
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