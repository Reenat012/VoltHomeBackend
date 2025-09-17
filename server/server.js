// server/server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import morgan from "morgan";

import authRoutes from "../routes/auth.js";
import { authMiddleware } from "../utils/jwt.js";

dotenv.config();

const app = express();

// Если сервер за прокси/балансировщиком (Timeweb, Nginx)
app.set("trust proxy", 1);

// Body parser
app.use(express.json());

// CORS (используем Bearer, cookie не нужны)
const corsOrigins =
    process.env.CORS_ORIGINS === "*"
        ? "*"
        : (process.env.CORS_ORIGINS || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

app.use(
    cors({
        origin: corsOrigins === "*" ? true : corsOrigins,
        credentials: false
    })
);

// Логи HTTP-запросов
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Health & ping
app.get("/", (_req, res) => res.json({ ok: true, service: "VoltHome API" }));
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Auth API
app.use("/auth", authRoutes);

// Профиль (защищённый)
app.get("/profile/me", authMiddleware, (req, res) => {
    const uid = req.user?.uid || "demo-uid";
    res.json({
        displayName: "Volt User",
        email: "user@example.com",
        avatarUrl: null,
        plan: "free",
        planUntilEpochSeconds: null,
        uid
    });
});

// 404
app.use((req, res) => {
    res.status(404).json({ error: "Not Found", path: req.originalUrl });
});

// Start
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, HOST, () => {
    console.log(`🚀 VoltHome API listening on http://${HOST}:${PORT}`);
    if (corsOrigins === "*") {
        console.log("🔓 CORS: * (dev only). Set CORS_ORIGINS in .env for production.");
    } else {
        console.log(`🔐 CORS origins: ${corsOrigins.join(", ") || "(none)"}`);
    }
});