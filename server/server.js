// server/server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import morgan from "morgan";

// ВАЖНО: путь из server/ к соседним папкам
import authRoutes from "../routes/auth.js";
import { authMiddleware } from "../utils/jwt.js";

dotenv.config();

const app = express();

// Если сервер будет стоять за прокси/балансировщиком (Timeweb, Nginx)
app.set("trust proxy", 1);

// ---- Middleware
app.use(express.json());

// CORS
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
        credentials: true,
    })
);

// Логи HTTP-запросов
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ---- Health & ping
app.get("/", (_req, res) => res.json({ ok: true, service: "VoltHome API" }));
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---- Auth API (/auth/*)
app.use("/auth", authRoutes);

// ---- Профиль (защищённый): GET /profile/me
app.get("/profile/me", authMiddleware, (req, res) => {
    // uid приходит из проверенного JWT (authMiddleware)
    const uid = req.user?.uid || "demo-uid";
    res.json({
        displayName: "Volt User",
        email: "user@example.com",
        avatarUrl: null,
        plan: "free", // позже переключим на "pro" по серверной логике
        planUntilEpochSeconds: null,
        uid,
    });
});

// ---- 404
app.use((req, res) => {
    res.status(404).json({ error: "Not Found", path: req.originalUrl });
});

// ---- Start
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