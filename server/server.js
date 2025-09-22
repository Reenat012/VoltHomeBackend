// server/server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import bodyParser from "body-parser";

// ВАЖНО: из server/ к роутам идём на уровень выше
import projectsRouter from "../routes/projects.js";
import authRouter from "../routes/auth.js";

import swaggerUi from "swagger-ui-express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGINS?.split(",") || "*" }));
app.use(morgan("dev"));
app.use(bodyParser.json({ limit: "2mb" }));

// опциональный аудит-хук
app.locals.audit = async () => {};

// Роуты
app.use("/v1/projects", projectsRouter);
app.use("/v1/auth", authRouter);

// Swagger UI (docs на уровень выше)
const openapiPath = path.join(__dirname, "../docs/openapi.yaml");
if (fs.existsSync(openapiPath)) {
    // динамический импорт, чтобы не падать, если пакета нет
    const yaml = (await import("yaml")).default;
    const spec = yaml.parse(fs.readFileSync(openapiPath, "utf8"));
    app.use("/docs", swaggerUi.serve, swaggerUi.setup(spec));
    console.log("Swagger UI available at /docs");
} else {
    console.warn("OpenAPI spec not found at ../docs/openapi.yaml");
}

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = +(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`VoltHome API listening on :${PORT}`));