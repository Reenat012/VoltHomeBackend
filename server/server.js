// server/server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
// используем встроенный парсер Express вместо body-parser

import swaggerUi from "swagger-ui-express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ВАЖНО: из server/ к роутам идём на уровень выше
import projectsRouter from "../routes/projects.js";
import authRouter from "../routes/auth.js";
import { pool } from "../db/pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// CORS: поддержка списка через запятую или "*"
const corsOrigins =
    process.env.CORS_ORIGINS && process.env.CORS_ORIGINS.trim() !== ""
        ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim())
        : "*";
app.use(cors({ origin: corsOrigins }));

app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));

// опциональный аудит-хук
app.locals.audit = async () => {};

// Роуты
app.use("/v1/projects", projectsRouter);
app.use("/v1/auth", authRouter);

// Swagger UI (docs на уровень выше)
const openapiPath = path.join(__dirname, "../docs/openapi.yaml");
if (fs.existsSync(openapiPath)) {
    try {
        // динамический импорт yaml; при отсутствии пакета /docs отключается, а сервер не падает
        const yaml = (await import("yaml")).default;
        const spec = yaml.parse(fs.readFileSync(openapiPath, "utf8"));
        app.use("/docs", swaggerUi.serve, swaggerUi.setup(spec));
        console.log("Swagger UI available at /docs");
    } catch (e) {
        console.warn(
            "OpenAPI spec detected but failed to load 'yaml'. Skipping /docs. Hint: add dependency `yaml@^2`.",
            e?.message || e
        );
    }
} else {
    console.warn("OpenAPI spec not found at ../docs/openapi.yaml");
}

// Базовый health
app.get("/health", (_req, res) => res.json({ ok: true }));

// Health БД (онлайн проверка)
app.get("/health/db", async (_req, res) => {
    try {
        const r = await withTimeout(pool.query("SELECT 1 AS ok"), 5000);
        res.json({ db: "ok", result: r.rows[0] });
    } catch (e) {
        res.status(500).json({ db: "error", message: e.message });
    }
});

// 🔹 Проверка подключения к БД при старте (fail-fast + таймаут)
await assertDbIsUp();

/** -------- helpers -------- */
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`DB check timed out after ${ms}ms`)), ms)),
    ]);
}

async function assertDbIsUp() {
    const maskedHost = (process.env.PGHOST || "").replace(/(^[^.]{2})[^@.]*/g, "$1***");
    const sslMode = (process.env.PGSSLMODE || "disable").toLowerCase();
    try {
        await withTimeout(pool.query("SELECT 1"), 5000);
        console.log(`✅ DB connection ok (host=${maskedHost || "?"}, sslmode=${sslMode})`);
    } catch (e) {
        console.error(`❌ DB connection failed (host=${maskedHost || "?"}, sslmode=${sslMode}):`, e.message);
        // Завершаем процесс, чтобы PM2 перезапустил и мы не висели "живыми" без БД
        process.exit(1);
    }
}

// Корректное завершение пула при остановке
for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
        try {
            await pool.end();
            // eslint-disable-next-line no-console
            console.log("DB pool closed. Exiting.");
        } finally {
            process.exit(0);
        }
    });
}
/** -------- /helpers -------- */

const PORT = +(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
app.listen(PORT, HOST, () =>
    console.log(`VoltHome API listening on ${HOST}:${PORT}`)
);