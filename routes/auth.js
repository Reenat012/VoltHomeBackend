import express from "express";
import { signToken, authMiddleware } from "../utils/jwt.js";

const router = express.Router();

// Очень простой in-memory store для refresh-токенов (мок для разработки)
const refreshStore = new Map();

function issueSession(uid) {
    const sessionJwt = signToken({ uid });
    // высчитываем expiresAt как epoch-seconds (удобно для мобилки)
    const ttl = process.env.SESSION_JWT_TTL || "3600s";
    const seconds = typeof ttl === "string" && ttl.endsWith("s") ? parseInt(ttl) : 3600;
    const expiresAt = Math.floor(Date.now() / 1000) + (Number.isFinite(seconds) ? seconds : 3600);
    return { sessionJwt, expiresAt };
}

/**
 * Универсальный "мок"-логин (на замену реальному обмену Яндекс-кода/токена).
 * POST /auth/login
 * body: { uid?: string, email?: string }
 */
router.post("/login", (req, res) => {
    const { uid = "yandex-uid-demo" } = req.body || {};
    const { sessionJwt, expiresAt } = issueSession(uid);
    const refreshId = Math.random().toString(36).slice(2);
    refreshStore.set(refreshId, { uid, valid: true });
    res.json({ sessionJwt, expiresAt, refreshId });
});

/**
 * Совместимость с будущим клиентом:
 * POST /auth/yandex/exchange  -> возвращает sessionJwt/refreshId как /login
 */
router.post("/yandex/exchange", (req, res) => {
    const { uid = "yandex-uid-demo" } = req.body || {};
    const { sessionJwt, expiresAt } = issueSession(uid);
    const refreshId = Math.random().toString(36).slice(2);
    refreshStore.set(refreshId, { uid, valid: true });
    res.json({ sessionJwt, expiresAt, refreshId });
});

/**
 * Рефреш серверной сессии
 * POST /auth/session/refresh
 * body: { refreshId: string }
 */
router.post("/session/refresh", (req, res) => {
    const { refreshId } = req.body || {};
    const row = refreshStore.get(refreshId);
    if (!row || !row.valid) {
        return res.status(401).json({ error: "invalid_refresh" });
    }
    const { sessionJwt, expiresAt } = issueSession(row.uid);
    res.json({ sessionJwt, expiresAt });
});

/**
 * Logout: инвалидирует refreshId (если передан). Требует валидный Bearer.
 * POST /auth/session/logout
 * body: { refreshId?: string }
 */
router.post("/session/logout", authMiddleware, (req, res) => {
    const { refreshId } = req.body || {};
    if (refreshId && refreshStore.has(refreshId)) {
        const prev = refreshStore.get(refreshId);
        refreshStore.set(refreshId, { ...prev, valid: false });
    }
    res.status(204).end();
});

/**
 * Для удобства разработки: GET /auth/me (аналог /profile/me)
 */
router.get("/me", authMiddleware, (req, res) => {
    const uid = req.user?.uid || "yandex-uid-demo";
    res.json({
        displayName: "Volt User",
        email: "user@example.com",
        plan: "free",
        planUntilEpochSeconds: null,
        uid
    });
});

export default router;