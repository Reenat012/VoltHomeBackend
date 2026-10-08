// models/accounts.js
// Удаление аккаунта и данных пользователя (docs/SYNC_CONTRACT.md, раздел 4).
import { query, withTransaction } from "../db/pool.js";

/** Удалён ли аккаунт. Проверяется при каждом авторизованном запросе. */
export async function isAccountDeleted(uid) {
    const res = await query(`SELECT 1 FROM deleted_accounts WHERE uid = $1`, [uid]);
    return res.rowCount > 0;
}

/**
 * Безвозвратно удаляет аккаунт и всё, что пользователь вводил: проекты (вместе с помещениями, приборами, документами
 * и их историей), сессии, ручные выдачи PRO, профиль и способы входа. Одной транзакцией.
 *
 * Не удаляются (сохраняются для защиты прав сторон, см. Политику конфиденциальности):
 *  - сведения о подписке RuStore (таблица subscriptions);
 *  - журнал действий (audit_log): он содержит только технические идентификаторы.
 */
export async function deleteAccount(uid) {
    return withTransaction(async () => {
        const projects = await query(`DELETE FROM projects WHERE user_id = $1`, [uid]);
        const sessions = await query(`DELETE FROM refresh_sessions WHERE user_id = $1`, [uid]);
        await query(`DELETE FROM entitlements WHERE user_id = $1`, [uid]);
        await query(`DELETE FROM users WHERE uid = $1`, [uid]); // identities удаляются каскадом
        await query(`INSERT INTO deleted_accounts (uid) VALUES ($1) ON CONFLICT (uid) DO NOTHING`, [uid]);
        return { projects: projects.rowCount, sessions: sessions.rowCount };
    });
}
