// Общие помощники для интеграционных тестов.
import http from "node:http";
import jwt from "jsonwebtoken";
import { createApp } from "../server/app.js";
import { pool } from "../db/pool.js";
import { AuthError } from "../services/yandexAuth.js";

const servers = new Set();

/**
 * Поднимает приложение на сервере, привязанном к 127.0.0.1 (порт выбирает ОС), и возвращает его для supertest.
 * Зачем: supertest по умолчанию делает listen(0) на каждый запрос, а на macOS это адрес `::` (IPv6), при этом
 * клиент подключается к 127.0.0.1. ОС не гарантирует, что выданный порт свободен для IPv4, и запрос иногда попадал
 * в чужую программу на том же порту (случайные 404, "socket hang up", "Parse Error", зависания).
 */
async function listenLocal(appPromise) {
    const server = http.createServer(await appPromise);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.add(server);
    return server;
}

let serverPromise;

/** Приложение с настройками по умолчанию (один сервер на тестовый файл). */
export function getApp() {
    serverPromise ??= listenLocal(createApp());
    return serverPromise;
}

/** Отдельное приложение с подменой клиента Яндекса и лимитом входа (для тестов входа). */
export function makeApp(options) {
    return listenLocal(createApp(options));
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
    for (const server of servers) {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
    servers.clear();
    await pool.end();
}

/** Сбрасывает данные таблиц (схема остаётся), чтобы тесты не зависели друг от друга. */
export async function truncateAll() {
    await pool.query(
        `TRUNCATE devices, "groups", rooms, projects, subscriptions, refresh_sessions,
                  identities, users, entitlements, audit_log, deleted_accounts RESTART IDENTITY CASCADE`
    );
}
