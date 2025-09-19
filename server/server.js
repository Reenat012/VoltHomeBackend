// server/server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import morgan from "morgan";
import YAML from "yamljs";
import swaggerUi from "swagger-ui-express";

import authRoutes from "../routes/auth.js";
import profileRoutes from "../routes/profile.js";
import projectsRoutes from "../routes/projects.js";
import { authMiddleware } from "../utils/jwt.js";
import { users } from "../stores/users.js";
import { pool, query } from "../db/pool.js";

dotenv.config();

const app = express();
app.set("trust proxy", 1);

// application/json guard
app.use((req, res, next) => {
    const ct = req.get("content-type");
    if (req.method !== "GET" && ct && !ct.startsWith("application/json")) {
        return res.status(415).json({ error: "unsupported_media_type" });
    }
    next();
});

const origins = (process.env.CORS_ORIGINS || "*").split(",").map(s => s.trim());
app.use(cors({ origin: origins, credentials: true }));

app.use(express.json({ limit: "2mb" }));
app.use(morgan("combined"));

// healthcheck
app.get("/healthz", async (req, res) => {
    try {
        await query("SELECT 1 as ok");
        res.json({ ok: true, ts: Date.now() });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});
app.get("/health", (req, res) => res.redirect("/healthz"));

// Swagger
try {
    const openapi = YAML.load(new URL("../docs/openapi.yaml", import.meta.url).pathname);
    app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapi));
} catch (e) {
    console.warn("OpenAPI not loaded:", e.message);
}

// audit helper
app.locals.audit = async (userId, action, entity, entityId, detail) => {
    try {
        await query(
            `INSERT INTO audit_log(user_id, action, entity, entity_id, detail)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
            [userId, action, entity, entityId || null, JSON.stringify(detail || {})]
        );
    } catch (e) {
        // не падаем из-за аудита
        console.error("audit failed:", e.message);
    }
};

// routes
app.use("/auth", authRoutes);
app.use("/profile", profileRoutes);
app.use("/v1/projects", projectsRoutes);

// start
const host = process.env.HOST || "0.0.0.0";
const port = +(process.env.PORT || 3000);

app.listen(port, host, () => {
    console.log(`VoltHome API listening on http://${host}:${port}`);
});