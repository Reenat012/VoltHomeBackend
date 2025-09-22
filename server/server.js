// server/server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import bodyParser from "body-parser";
import swaggerUi from "swagger-ui-express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import YAML from "yaml";

// ⚠️ ВАЖНО: этот файл предполагает, что он лежит в /server/server.js
// а папки /routes и /docs — на уровень ВЫШЕ (../routes, ../docs)
import projectsRouter from "../routes/projects.js";
import authRouter from "../routes/auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Если стоишь за прокси (обычно у хостеров) — доверяем x-forwarded-*
app.set("trust proxy", true);

// ---------- CORS ----------
const corsFromEnv = (process.env.CORS_ORIGINS || "*")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

const corsOptions =
    corsFromEnv.length === 1 && corsFromEnv[0] === "*"
        ? { origin: true, credentials: true }
        : {
            origin(origin, cb) {
                // Разрешаем пустой origin для mobile-app / curl
                if (!origin) return cb(null, true);
                const ok = corsFromEnv.some(allowed => {
                    // поддержка шаблонов вида https://*.example.com
                    if (allowed.includes("*")) {
                        const re = new RegExp(
                            "^" + allowed.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"
                        );
                        return re.test(origin);
                    }
                    return origin === allowed;
                });
                cb(ok ? null : new Error("CORS blocked"), ok);
            },
            credentials: true,
        };

app.use(cors(corsOptions));

// Логи запросов
app.use(morgan("combined"));

// Тело запроса
app.use(bodyParser.json({ limit: "5mb" }));

// Нестрогий аудит-хук (опционально; не должен падать)
app.locals.audit = async () => {};

// ---------- Роуты ----------
app.use("/v1/projects", projectsRouter);
app.use("/v1/auth", authRouter);

// ---------- Swagger UI (/docs) ----------
function resolveOpenApiPath() {
    // пробуем common-варианты: ../docs/openapi.yaml (корень репо)
    // и ./docs/openapi.yaml (если кто-то положит рядом)
    const candidates = [
        path.join(__dirname, "../docs/openapi.yaml"),
        path.join(__dirname, "./docs/openapi.yaml"),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

const openapiPath = resolveOpenApiPath();
if (openapiPath) {
    try {
        const spec = YAML.parse(fs.readFileSync(openapiPath, "utf8"));
        app.use("/docs", swaggerUi.serve, swaggerUi.setup(spec));
        console.log(`Swagger UI available at /docs (spec: ${openapiPath})`);
    } catch (e) {
        console.warn("Failed to load OpenAPI spec:", e.message);
    }
} else {
    console.warn("OpenAPI spec not found (looked for ../docs/openapi.yaml).");
}

// Healthcheck
app.get("/health", (_req, res) => res.json({ ok: true }));

// 404 заглушка для прочих путей
app.use((_req, res) => res.status(404).json({ error: "not_found" }));

// Глобальный обработчик ошибок (чтобы не ронять процесс)
app.use((err, _req, res, _next) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "internal_error" });
});

// ---------- Старт ----------
const HOST = process.env.HOST || "0.0.0.0";
const PORT = +(process.env.PORT || 3000);

app.listen(PORT, HOST, () => {
    console.log(`VoltHome API listening on http://${HOST}:${PORT}`);
});