// server/server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";

import swaggerUi from "swagger-ui-express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// 🔹 Глобальные хэндлеры, чтобы не терять важные ошибки ранней инициализации
process.on("unhandledRejection", (reason, p) => {
    console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err);
    // по желанию — мягкое завершение с прерыванием при повторе
});

// ВАЖНО: из server/ к роутам идём на уровень выше
import projectsRouter from "../routes/projects.js";
import authRouter from "../routes/auth.js";
import { pool } from "../db/pool.js";
import profileRouter from "../routes/profile.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/** ---------------- Core security / proxy ---------------- */
app.set("trust proxy", true);

/**
 * Принудительный редирект HTTP -> HTTPS (TLS завершается на балансировщике).
 * Отключить можно установив DISABLE_HTTPS_REDIRECT=true (например, для локалки)
 */
const httpsRedirectDisabled =
    String(process.env.DISABLE_HTTPS_REDIRECT || "").toLowerCase() === "true";

if (!httpsRedirectDisabled) {
    app.use((req, res, next) => {
        // За прокси признак HTTPS приходит в X-Forwarded-Proto
        const xfp = (req.headers["x-forwarded-proto"] || "").toString().toLowerCase();
        if (xfp === "http") {
            return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
        }
        next();
    });
}

/** Включаем HSTS, чтобы браузер всегда ходил по HTTPS */
app.use((req, res, next) => {
    res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains; preload"
    );
    next();
});

/** ---------------- CORS (строго по списку) ---------------- */
/**
 * CORS_ORIGINS — список через запятую, например:
 *   CORS_ORIGINS=https://volthome.ru,https://api.volthome.ru
 * Если переменная не задана — используем безопасный дефолт.
 */
const envOrigins =
    process.env.CORS_ORIGINS && process.env.CORS_ORIGINS.trim() !== ""
        ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim())
        : ["https://volthome.ru", "https://api.volthome.ru"];

const allowedOrigins = new Set(envOrigins);

const corsOptions = {
    origin(origin, cb) {
        // Разрешаем запросы без Origin (healthchecks, curl) и из списка
        if (!origin || allowedOrigins.has(origin)) return cb(null, true);
        return cb(new Error(`CORS: origin not allowed: ${origin}`), false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false, // куки не используем
    optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
// на всякий случай корректно отвечаем на preflight
app.options("*", cors(corsOptions));

/** ---------------- Parsers / logging ---------------- */
app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));

// опциональный аудит-хук
app.locals.audit = async () => {};

/** ---------------- Routes ---------------- */
app.use("/v1/projects", projectsRouter);
app.use("/v1/auth", authRouter);
app.use("/v1/profile", profileRouter);

/** ---------------- Swagger UI ---------------- */
const openapiPath = path.join(__dirname, "../docs/openapi.yaml");
if (fs.existsSync(openapiPath)) {
    try {
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

/** ---------------- Health ---------------- */
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

/** 🔹 Проверка подключения к БД при старте (fail-fast + таймаут) */
await assertDbIsUp();

/** ---------------- Helpers ---------------- */
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, rej) =>
            setTimeout(() => rej(new Error(`DB check timed out after ${ms}ms`)), ms)
        ),
    ]);
}

async function assertDbIsUp() {
    const maskedHost = (process.env.PGHOST || "").replace(/(^[^.]{2})[^@.]*/g, "$1***");
    const sslMode = (process.env.PGSSLMODE || "disable").toLowerCase();
    try {
        await withTimeout(pool.query("SELECT 1"), 5000);
        console.log(`✅ DB connection ok (host=${maskedHost || "?"}, sslmode=${sslMode})`);
    } catch (e) {
        console.error(
            `❌ DB connection failed (host=${maskedHost || "?"}, sslmode=${sslMode}):`,
            e.message
        );
        // Завершаем процесс, чтобы PM2 перезапустил и мы не висели "живыми" без БД
        process.exit(1);
    }
}

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