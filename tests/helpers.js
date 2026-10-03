// Общие помощники для интеграционных тестов.
import jwt from "jsonwebtoken";
import { createApp } from "../server/app.js";
import { pool } from "../db/pool.js";
import { AuthError } from "../services/yandexAuth.js";

let appPromise;

/** Приложение Express без реального порта (используется с supertest). */
export function getApp() {
    appPromise ??= createApp();
    return appPromise;
}

/** Отдельное приложение с подменой клиента Яндекса и лимитом входа (для тестов входа). */
export function makeApp(options) {
    return createApp(options);
}

/** Заголовок авторизации для тестового пользователя (токен подписан тестовым секретом). */
export function authHeader(uid = "test-user") {
    const token = jwt.sign({ uid }, process.env.JWT_ACCESS_SECRET, {
        algorithm: "HS256",
        expiresIn: "10m",
    });
    return { Authorization: `Bearer ${token}` };
}

/**
 * Поддельный Яндекс: токен -> пользователь. Неизвестный токен отвечает как настоящий Яндекс (401).
 * Пример: fakeYandex({ "token-a": { externalId: "100", profile: { displayName: "Анна" } } })
 */
export function fakeYandex(tokens = {}) {
    return {
        async resolveIdentity({ yaAccessToken, code }) {
            const token = yaAccessToken || code;
            if (!token) throw new AuthError(400, "invalid_request", "Нужен code или yaAccessToken");
            const found = tokens[token];
            if (!found) throw new AuthError(401, "invalid_yandex_token", "Токен Яндекса не принят");
            if (found.unavailable) throw new AuthError(503, "yandex_unavailable", "Яндекс недоступен");
            return { externalId: found.externalId, profile: found.profile ?? {} };
        },
    };
}

export async function closeDb() {
    await pool.end();
}

/** Сбрасывает данные таблиц (схема остаётся), чтобы тесты не зависели друг от друга. */
export async function truncateAll() {
    await pool.query(
        `TRUNCATE devices, "groups", rooms, projects, subscriptions, refresh_sessions,
                  identities, users, entitlements, audit_log RESTART IDENTITY CASCADE`
    );
}
