// models/users.js
// Пользователи и способы входа (identities). uid создаёт сервер и не зависит от провайдера входа.
import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../db/pool.js";

const COLUMNS = "uid, display_name, email, avatar_url, created_at, updated_at";

export function newUid() {
    return `u_${randomUUID()}`;
}

function clean(v) {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
}

// Аватар не сохраняем: его нет в перечне обрабатываемых данных (Политика, Согласие). Колонка avatar_url осталась
// ради совместимости схемы и ответов API (поле avatarUrl всегда null), миграция 032 очистила прежние значения.
/**
 * Находит пользователя по способу входа или создаёт нового.
 * Профиль обновляется только непустыми значениями (пустое не затирает сохранённое).
 */
export async function findOrCreateByIdentity({ provider, externalId, profile = {} }) {
    const displayName = clean(profile.displayName);
    const email = clean(profile.email);

    return withTransaction(async (client) => {
        const found = await client.query(
            `SELECT uid FROM identities WHERE provider = $1 AND external_id = $2`,
            [provider, externalId]
        );
        if (found.rows[0]) {
            const upd = await client.query(
                `UPDATE users SET
                    display_name = COALESCE($2, display_name),
                    email        = COALESCE($3, email),
                    updated_at   = now()
                 WHERE uid = $1
                 RETURNING ${COLUMNS}`,
                [found.rows[0].uid, displayName, email]
            );
            return { user: upd.rows[0], created: false };
        }

        const uid = newUid();
        await client.query(
            `INSERT INTO users (uid, display_name, email) VALUES ($1, $2, $3)`,
            [uid, displayName, email]
        );
        const ins = await client.query(
            `INSERT INTO identities (provider, external_id, uid) VALUES ($1, $2, $3)
             ON CONFLICT (provider, external_id) DO NOTHING
             RETURNING uid`,
            [provider, externalId, uid]
        );
        if (ins.rowCount === 0) {
            // одновременный первый вход: победила другая транзакция; наш пользователь не нужен
            await client.query(`DELETE FROM users WHERE uid = $1`, [uid]);
            const again = await client.query(
                `SELECT ${COLUMNS} FROM users WHERE uid = (SELECT uid FROM identities WHERE provider = $1 AND external_id = $2)`,
                [provider, externalId]
            );
            return { user: again.rows[0], created: false };
        }
        const row = await client.query(`SELECT ${COLUMNS} FROM users WHERE uid = $1`, [uid]);
        return { user: row.rows[0], created: true };
    });
}

export async function getUser(uid) {
    const res = await query(`SELECT ${COLUMNS} FROM users WHERE uid = $1`, [uid]);
    return res.rows[0] || null;
}

export async function updateProfile(uid, { displayName, email }) {
    const res = await query(
        `UPDATE users SET
            display_name = COALESCE($2, display_name),
            email        = COALESCE($3, email),
            updated_at   = now()
         WHERE uid = $1
         RETURNING ${COLUMNS}`,
        [uid, clean(displayName), clean(email)]
    );
    return res.rows[0] || null;
}
