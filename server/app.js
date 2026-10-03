// server/app.js
// Сборка Express-приложения без запуска (listen, проверка БД, обработчики сигналов остаются в server/server.js).
// Так приложение можно поднимать в тестах через supertest(app) без реального порта.
import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";

import swaggerUi from "swagger-ui-express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ВАЖНО: из server/ к роутам идём на уровень выше
import projectsRouter from "../routes/projects.js";
import { createAuthRouter } from "../routes/auth.js";
import profileRouter from "../routes/profile.js";
import { router as billingRouter } from "../routes/billing.js";
import { pool } from "../db/pool.js";
import { audit } from "../utils/audit.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`DB check timed out after ${ms}ms`)), ms);
    });
    // Таймер снимаем, иначе он держит процесс (и тесты) ещё до ms миллисекунд
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {{ yandex?: object, rateLimitPerMin?: number }} options
 *   yandex: клиент проверки входа через Яндекс (в тестах подменяется), rateLimitPerMin: лимит запросов входа с IP.
 */
export async function createApp({ yandex, rateLimitPerMin } = {}) {
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
            const xfp = (req.headers["x-forwarded-proto"] || "")
                .toString()
                .toLowerCase();
            if (xfp === "http") {
                return res.redirect(
                    301,
                    `https://${req.headers.host}${req.originalUrl}`
                );
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
    // В тестах не засоряем вывод построчными логами запросов
    if (process.env.NODE_ENV !== "test") app.use(morgan("dev"));
    app.use(express.json({ limit: "2mb" }));

    // журнал действий (audit_log)
    app.locals.audit = audit;

    /** ---------------- Routes ---------------- */
    app.use("/v1/projects", projectsRouter);
    app.use("/v1/auth", createAuthRouter({ yandex, rateLimitPerMin }));
    app.use("/v1/profile", profileRouter);
    app.use("/v1/billing", billingRouter);

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

    return app;
}
