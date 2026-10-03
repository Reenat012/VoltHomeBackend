// server/server.js
// Запуск сервера: проверка БД (fail-fast), listen, корректное завершение.
// Само приложение собирается в server/app.js (его же используют тесты).
import "dotenv/config";

// 🔹 Глобальные хэндлеры, чтобы не терять важные ошибки ранней инициализации
process.on("unhandledRejection", (reason, p) => {
    console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err);
    // по желанию — мягкое завершение с прерыванием при повторе
});

import { pool } from "../db/pool.js";
import { createApp, withTimeout } from "./app.js";

const app = await createApp();

async function assertDbIsUp() {
    const maskedHost = (process.env.PGHOST || "").replace(
        /(^[^.]{2})[^@.]*/g,
        "$1***"
    );
    const sslMode = (process.env.PGSSLMODE || "disable").toLowerCase();
    try {
        await withTimeout(pool.query("SELECT 1"), 5000);
        console.log(
            `✅ DB connection ok (host=${maskedHost || "?"}, sslmode=${sslMode})`
        );
    } catch (e) {
        console.error(
            `❌ DB connection failed (host=${maskedHost || "?"}, sslmode=${sslMode}):`,
            e.message
        );
        // Завершаем процесс, чтобы PM2 перезапустил и мы не висели "живыми" без БД
        process.exit(1);
    }
}

/** 🔹 Проверка подключения к БД при старте (fail-fast + таймаут) */
await assertDbIsUp();

// Корректное завершение пула при остановке
for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
        try {
            await pool.end();
            console.log("DB pool closed. Exiting.");
        } finally {
            process.exit(0);
        }
    });
}

/** ---------------- Start ---------------- */
const PORT = +(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
app.listen(PORT, HOST, () =>
    console.log(`VoltHome API listening on ${HOST}:${PORT}`)
);
