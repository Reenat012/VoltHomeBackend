import express from "express";
import jwt from "jsonwebtoken";
import { authMiddleware } from "../utils/jwt.js";
import {
    createSession,
    getSessionByToken,
    rotateSession,
    markRevoked,
    revokeAllForUser
} from "../models/sessions.js";

const router = express.Router();

/**
 * Конфиг
 */
const ACCESS_TTL_MIN = +(process.env.ACCESS_TTL_MIN || 30); // срок жизни access в минутах
const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "access_dev_secret";
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "refresh_dev_secret";

/**
 * Утилиты
 */
function issueAccessToken(uid) {
    return jwt.sign({ uid }, JWT_ACCESS_SECRET, {
        algorithm: "HS256",
        expiresIn: `${ACCESS_TTL_MIN}m`,
    });
}

function issueRefreshToken(uid) {
    // exp внутри JWT — подстраховка; реальный TTL и ротация контролируются на уровне таблицы refresh_sessions
    return jwt.sign({ uid, typ: "refresh" }, JWT_REFRESH_SECRET, {
        algorithm: "HS256",
        expiresIn: "90d",
    });
}

function getReqMeta(req) {
    const userAgent = req.get("User-Agent") || null;
    const ip = (req.headers["x-forwarded-for"] || req.connection?.remoteAddress || req.ip || null);
    return { userAgent, ip };
}

function nowEpochSeconds() {
    return Math.floor(Date.now() / 1000);
}

function buildSessionResponse({ accessToken, refreshToken }) {
    return {
        // Имена полей — под клиент VoltHome
        sessionJwt: accessToken,
        expiresAtEpochSeconds: nowEpochSeconds() + ACCESS_TTL_MIN * 60, // секундах!
        refreshId: refreshToken, // opaque-строка; в БД хранится хеш/сама строка — зависит от models/sessions.js
    };
}

/**
 * ============================
 *  Совместимость с клиентом:
 *  /v1/auth/yandex/exchange
 *  /v1/auth/session/refresh
 *  /v1/auth/session/logout
 * ============================
 */

/**
 * POST /v1/auth/yandex/exchange
 * Body: { code?: string, uid?: string }
 *
 * Клиент после Яндекс-ID шлёт сюда code или uid.
 * В этой реализации:
 *  - если есть uid — считаем что userId = uid (в бою здесь должна быть валидация у Яндекса).
 *  - если есть code — можно извлечь userId из результата обмена с Яндексом; тут — упрощённо мапим code -> pseudo userId.
 */
router.post("/yandex/exchange", async (req, res) => {
    const { code, uid } = req.body || {};

    // Простая валидация входа
    if (!code && !uid) {
        return res.status(400).json({ error: "uid_or_code_required" });
    }

    // NOTE: здесь должна быть реальная валидация code через Яндекс OAuth.
    // Для упрощения: используем uid напрямую, а если пришёл только code — делаем детерминированный псевдо-uid.
    const userId = uid || `ya_${String(code).slice(0, 24)}`;

    const accessToken = issueAccessToken(userId);
    const refreshToken = issueRefreshToken(userId);

    const { userAgent, ip } = getReqMeta(req);
    await createSession({ userId, refreshToken, userAgent, ip });

    return res.json(buildSessionResponse({ accessToken, refreshToken }));
});

/**
 * POST /v1/auth/session/refresh
 * Body: { refreshId: string }
 *
 * Клиентский Authenticator шлёт сюда refreshId для ротации.
 * Возвращаем объект строго формата SessionResponse (sessionJwt, expiresAtEpochSeconds, refreshId).
 */
router.post("/session/refresh", async (req, res) => {
    const { refreshId } = req.body || {};
    if (!refreshId) {
        return res.status(400).json({ error: "refresh_required" });
    }

    // Проверяем подпись refresh JWT
    let decoded;
    try {
        decoded = jwt.verify(refreshId, JWT_REFRESH_SECRET);
        if (decoded?.typ !== "refresh") throw new Error("wrong_type");
    } catch {
        return res.status(401).json({ error: "invalid_refresh" });
    }

    // Проверка сессии в БД
    const sess = await getSessionByToken(refreshId);
    if (!sess) return res.status(401).json({ error: "invalid_refresh" });
    if (sess.revoked_at) return res.status(401).json({ error: "revoked" });
    if (new Date(sess.expires_at).getTime() < Date.now()) {
        await markRevoked(sess.id);
        return res.status(401).json({ error: "expired" });
    }

    // Ротация refresh
    const newRefreshToken = issueRefreshToken(sess.user_id);
    await rotateSession({
        oldSessionId: sess.id,
        userId: sess.user_id,
        newRefreshToken
    });

    // Новый access
    const accessToken = issueAccessToken(sess.user_id);

    return res.json(buildSessionResponse({
        accessToken,
        refreshToken: newRefreshToken
    }));
});

/**
 * POST /v1/auth/session/logout
 * Body: { refreshId: string }
 *
 * Ревокация конкретной сессии клиента.
 */
router.post("/session/logout", async (req, res) => {
    const { refreshId } = req.body || {};
    if (!refreshId) return res.status(400).json({ error: "refresh_required" });

    const sess = await getSessionByToken(refreshId);
    if (sess) await markRevoked(sess.id);

    return res.json({ ok: true });
});

/**
 * ============================
 *  Старые/совместимые ручки
 *  (оставлены для обратной совместимости)
 * ============================
 */

/**
 * POST /v1/auth/login
 * Body: { userId }
 * Выдаёт пару токенов и создаёт refresh-сессию.
 */
router.post("/login", async (req, res) => {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: "user_required" });

    const accessToken = issueAccessToken(userId);
    const refreshToken = issueRefreshToken(userId);

    const { userAgent, ip } = getReqMeta(req);
    await createSession({ userId, refreshToken, userAgent, ip });

    // Возвращаем в новом формате тоже, чтобы фронты не путались
    return res.json(buildSessionResponse({ accessToken, refreshToken }));
});

/**
 * POST /v1/auth/refresh
 * Body: { refreshToken }
 * Ротация refresh-токена (старое имя поля).
 */
router.post("/refresh", async (req, res) => {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: "refresh_required" });

    let decoded;
    try {
        decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
        if (decoded?.typ !== "refresh") throw new Error("wrong_type");
    } catch {
        return res.status(401).json({ error: "invalid_refresh" });
    }

    const sess = await getSessionByToken(refreshToken);
    if (!sess) return res.status(401).json({ error: "invalid_refresh" });
    if (sess.revoked_at) return res.status(401).json({ error: "revoked" });
    if (new Date(sess.expires_at).getTime() < Date.now()) {
        await markRevoked(sess.id);
        return res.status(401).json({ error: "expired" });
    }

    const newRefreshToken = issueRefreshToken(sess.user_id);
    await rotateSession({
        oldSessionId: sess.id,
        userId: sess.user_id,
        newRefreshToken
    });

    const accessToken = issueAccessToken(sess.user_id);

    // Ответ — в новом формате
    return res.json(buildSessionResponse({
        accessToken,
        refreshToken: newRefreshToken
    }));
});

/**
 * POST /v1/auth/logout
 * Body: { refreshToken }
 * Ревокация конкретной сессии (старое имя поля).
 */
router.post("/logout", async (req, res) => {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: "refresh_required" });
    const sess = await getSessionByToken(refreshToken);
    if (sess) await markRevoked(sess.id);
    return res.json({ ok: true });
});

/**
 * POST /v1/auth/logout_all
 * Требует Bearer access. Ревокация всех активных сессий пользователя.
 */
router.post("/logout_all", authMiddleware, async (req, res) => {
    await revokeAllForUser(req.user.uid);
    return res.json({ ok: true });
});

export default router;