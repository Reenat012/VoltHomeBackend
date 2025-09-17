// routes/auth.js
import express from "express";
import { signToken, authMiddleware, verifyTokenAllowExpired } from "../utils/jwt.js";

const router = express.Router();

// Простейшее in-memory хранилище refreshId (dev-мок)
const refreshStore = new Map();

function issueSession(uid) {
    const sessionJwt = signToken({ uid });
    const ttl = process.env.SESSION_JWT_TTL || "3600s";
    const seconds = typeof ttl === "string" && ttl.endsWith("s") ? parseInt(ttl) : 3600;
    const expiresAtEpochSeconds =
        Math.floor(Date.now() / 1000) + (Number.isFinite(seconds) ? seconds : 3600);
    // для совместимости со старыми клиентами оставляем expiresAt = expiresAtEpochSeconds
    const expiresAt = expiresAtEpochSeconds;
    return { sessionJwt, expiresAtEpochSeconds, expiresAt };
}

/**
 * POST /auth/login
 * body: { uid?: string }
 * Возвращает: { sessionJwt, expiresAtEpochSeconds, (expiresAt), refreshId }
 */
router.post("/login", (req, res) => {
    const { uid = "yandex-uid-demo" } = req.body || {};
    const session = issueSession(uid);
    const refreshId = Math.random().toString(36).slice(2);
    refreshStore.set(refreshId, { uid, valid: true });
    res.json({ ...session, refreshId });
});

/**
 * POST /auth/yandex/exchange
 * body: { code?: string, uid?: string }
 * Возвращает: { sessionJwt, expiresAtEpochSeconds, (expiresAt), refreshId }
 */
router.post("/yandex/exchange", (req, res) => {
    const { code, uid: uidRaw } = req.body || {};
    // В реале здесь: обмен code -> профиль Яндекса -> uid
    const uid =
        (uidRaw && String(uidRaw)) ||
        (code ? `ya:${Buffer.from(String(code)).toString("hex").slice(0, 12)}` : "yandex-uid-demo");

    const session = issueSession(uid);
    const refreshId = Math.random().toString(36).slice(2);
    refreshStore.set(refreshId, { uid, valid: true });
    res.json({ ...session, refreshId });
});

/**
 * POST /auth/session/refresh
 * Режимы:
 *   1) Рекомендуемый: Authorization: Bearer <jwt> (может быть истёкшим)
 *   2) Legacy: body { refreshId }
 * Возвращает: { sessionJwt, expiresAtEpochSeconds, (expiresAt) }
 */
router.post("/session/refresh", (req, res) => {
    // 1) Bearer-путь
    const auth = req.header("Authorization") || "";
    const m = /^Bearer (.+)$/.exec(auth);
    if (m) {
        try {
            const payload = verifyTokenAllowExpired(m[1]); // читаем uid даже из истёкшего токена
            const uid = payload?.uid || "unknown";
            const session = issueSession(uid);
            return res.json(session);
        } catch {
            // если Bearer невалиден — попробуем legacy-путь
        }
    }

    // 2) Legacy по refreshId
    const { refreshId } = req.body || {};
    const row = refreshStore.get(refreshId);
    if (!row || !row.valid) {
        return res.status(401).json({ error: "invalid_refresh" });
    }
    const session = issueSession(row.uid);
    return res.json(session);
});

/**
 * POST /auth/session/logout
 * body: { refreshId?: string }
 * Требует валидный Bearer.
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
 * GET /auth/me — dev-хелпер (аналог /profile/me)
 * Требует валидный Bearer.
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