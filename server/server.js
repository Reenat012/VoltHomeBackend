import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import morgan from "morgan";
import authRoutes from "./routes/auth.js";
import { authMiddleware } from "./utils/jwt.js";

dotenv.config();

const app = express();

// ---- Middleware
app.use(express.json());
const corsOrigins =
    process.env.CORS_ORIGINS === "*"
        ? undefined
        : (process.env.CORS_ORIGINS || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
app.use(cors({ origin: corsOrigins || true }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ---- Health
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---- Auth API (/auth/*)
app.use("/auth", authRoutes);

// ---- Профиль (совместимо с клиентом: GET /profile/me, защищённый)
app.get("/profile/me", authMiddleware, (req, res) => {
    // Здесь можно доставать uid из req.user, приходит из JWT
    const uid = req.user?.uid || "yandex-uid-demo";
    res.json({
        displayName: "Volt User",
        email: "user@example.com",
        avatarUrl: null,
        plan: "free", // или "pro"
        planUntilEpochSeconds: null,
        uid
    });
});

// ---- Start
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, HOST, () => {
    console.log(`🚀 VoltHome API listening on http://${HOST}:${PORT}`);
});