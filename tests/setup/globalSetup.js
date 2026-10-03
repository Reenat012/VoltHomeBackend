// Один раз перед всеми тестами: чистая схема тестовой БД и все миграции.
// Работает ТОЛЬКО на локальной БД: иначе отказывается (схема стирается целиком).
import dotenv from "dotenv";
import pg from "pg";
import { migrateUp } from "../../db/migrator.js";

export default async function globalSetup() {
    dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || ".env.test" });

    const host = process.env.PGHOST;
    if (!host || !["localhost", "127.0.0.1", "::1"].includes(host)) {
        throw new Error(
            `Тесты разрешены только на локальной БД (PGHOST=127.0.0.1). Получено: ${host || "<пусто>"}. ` +
                `Запустите локальную БД: npm run testdb:start`
        );
    }

    const client = new pg.Client({
        host,
        port: Number(process.env.PGPORT || 5432),
        database: process.env.PGDATABASE,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
    });
    try {
        await client.connect();
    } catch (e) {
        throw new Error(
            `Не удалось подключиться к тестовой БД (${host}:${process.env.PGPORT}): ${e.message}. ` +
                `Запустите её: npm run testdb:start`
        );
    }
    try {
        await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
        await migrateUp((text, params) => client.query(text, params), { log: () => {} });
    } finally {
        await client.end();
    }
}
