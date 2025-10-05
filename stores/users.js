/**
 * Простейшее in-memory хранилище профилей.
 * Для продакшена стоит вынести в БД.
 */
export const users = new Map();

/**
 * upsertUser(uid, data)
 *  - сливает данные с существующей записью
 *  - не перетирает значениями undefined
 */
export function upsertUser(uid, data) {
    const prev = users.get(uid) || {};
    const next = {
        displayName: data.displayName ?? prev.displayName ?? "Volt User",
        email: data.email ?? prev.email ?? null,
        avatarUrl: data.avatarUrl ?? prev.avatarUrl ?? null,
        plan: data.plan ?? prev.plan ?? "free",
        planUntilEpochSeconds: data.planUntilEpochSeconds ?? prev.planUntilEpochSeconds ?? null,
        uid,
    };
    users.set(uid, next);
    return next;
}