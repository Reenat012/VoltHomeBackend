// server/server.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import bodyParser from "body-parser";
import swaggerUi from "swagger-ui-express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// .env лежит в корне репозитория, а этот файл — в /server/
// Явно укажем путь, чтобы pm2 точно подхватил переменные.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

// Маршруты лежат уровнем ВЫШЕ
import projectsRouter from "../routes/projects.js";
import authRouter from "../routes/auth.js";

const app = express();
app.set("trust proxy", true);

// CORS из CORS_ORIGINS, поддержка '*' и шаблонов
const corsOrigins = (process.env.CORS_ORIGINS || "*")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

app.use(
    cors(
        corsOrigins.length === 1 && corsOrigins[0] === "*"
            ? { origin: true, credentials: true }
            : {
                origin(origin, cb) {
                    if (!origin) return cb(null, true);
                    const ok = corsOrigins.some(allowed => {
                        if (allowed.includes("*")) {
                            const re = new RegExp("^" + allowed.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
                            return re.test(origin);
                        }
                        return origin === allowed;
                    });
                    cb(ok ? null : new Error("CORS blocked"), ok);
                },
                credentials: true,
            }
    )
);

app.use(morgan("combined"));
app.use(bodyParser.json({ limit: "5mb" }));

// опциональный аудит — не должен падать
app.locals.audit = async () => {};

// API
app.use("/v1/projects", projectsRouter);
app.use("/v1/auth", authRouter);

// Swagger UI без зависимости от 'yaml': отдаем файл и указываем ссылку
const candidates = [
    path.join(__dirname, "../docs/openapi.yaml"),
    path.join(__dirname, "./docs/openapi.yaml"),
];
let specPath = null;
for (const p of candidates) if (fs.existsSync(p)) { specPath = p; break; }

if (specPath) {
    app.get("/openapi.yaml", (_req, res) => res.sendFile(specPath));
    app.use("/docs", swaggerUi.serve, swaggerUi.setup(null, { swaggerUrl: "/openapi.yaml" }));
    console.log(`Swagger UI available at /docs (spec: ${specPath})`);
} else {
    console.warn("OpenAPI spec not found (looked for ../docs/openapi.yaml).");
}

// healthcheck + базовые обработчики
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use((_req, res) => res.status(404).json({ error: "not_found" }));
app.use((err, _req, res, _next) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "internal_error" });
});

const HOST = process.env.HOST || "0.0.0.0";
const PORT = +(process.env.PORT || 3000);
app.listen(PORT, HOST, () => {
    console.log(`VoltHome API listening on http://${HOST}:${PORT}`);
});