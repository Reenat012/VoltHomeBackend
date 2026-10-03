// Общие помощники для интеграционных тестов.
import jwt from "jsonwebtoken";
import { createApp } from "../server/app.js";
import { pool } from "../db/pool.js";

let appPromise;

/** Приложение Express без реального порта (используется с supertest). */
export function getApp() {
    appPromise ??= createApp();
    return appPromise;
}

/** Заголовок авторизации для тестового пользователя (токен подписан тестовым секретом). */
export function authHeader(uid = "test-user") {
    const token = jwt.sign({ uid }, process.env.JWT_ACCESS_SECRET, {
        algorithm: "HS256",
        expiresIn: "10m",
    });
    return { Authorization: `Bearer ${token}` };
}

export async function closeDb() {
    await pool.end();
}

/** Сбрасывает данные таблиц (схема остаётся), чтобы тесты не зависели друг от друга. */
export async function truncateAll() {
    await pool.query(
        `TRUNCATE devices, "groups", rooms, projects, subscriptions, refresh_sessions RESTART IDENTITY CASCADE`
    );
}
