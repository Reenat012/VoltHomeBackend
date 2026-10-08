// routes/auth.js
// Вход и сессии. Контракт: docs/SYNC_CONTRACT.md, раздел 4.
// Старые ручки /login, /refresh, /logout (с произвольным userId) удалены: клиентов, которые ими пользуются, нет.
import express from "express";
import {
    authMiddleware,
    signToken,
    signRefreshToken,
    verifyRefreshToken,
    ACCESS_TTL_MIN,
} from "../utils/jwt.js";
import { ipBucket } from "../utils/rateLimit.js";
import {
    createSession,
    getSessionByToken,
    rotateSession,
    markRevoked,
    revokeAllForUser,
} from "../models/sessions.js";
import { findOrCreateByIdentity } from "../models/users.js";
import { createYandexClient, AuthError } from "../services/yandexAuth.js";

function nowEpochSeconds() {
    return Math.floor(Date.now() / 1000);
}

function getReqMeta(req) {
    return { userAgent: req.get("User-Agent") || null, ip: req.ip || null };
}

function buildSessionResponse({ accessToken, refreshToken, uid }) {
    return {
        sessionJwt: accessToken,
        expiresAtEpochSeconds: nowEpochSeconds() + ACCESS_TTL_MIN * 60,
        refreshId: refreshToken,
        uid,
    };
}

function sendError(res, err) {
    if (err instanceof AuthError) {
        return res.status(err.status).json({ error: err.code, message: err.message });
    }
    console.error("[auth] error:", err?.message || err);
    return res.status(503).json({ error: "server_unavailable" });
}

/**
 * @param {{ yandex?: object, rateLimitPerMin?: number }} deps
 *   yandex: клиент Яндекса (в тестах подменяется), rateLimitPerMin: лимит запросов с одного IP.
 */
export function createAuthRouter({
    yandex = createYandexClient(),
    rateLimitPerMin = Number(process.env.AUTH_RATE_LIMIT_PER_MIN || 30),
} = {}) {
    const router = express.Router();
    const limiter = ipBucket({ limitPerMin: rateLimitPerMin, name: "auth" });

    /**
     * POST /v1/auth/yandex/exchange
     * Веб: { code, redirectUri, codeVerifier?, platform }  Android: { yaAccessToken, platform }
     * Поля uid и profile из тела запроса игнорируются.
     */
    router.post("/yandex/exchange", limiter, async (req, res) => {
        const { code, redirectUri, codeVerifier, yaAccessToken } = req.body || {};
        try {
            const { externalId, profile } = await yandex.resolveIdentity({
                code,
                redirectUri,
                codeVerifier,
                yaAccessToken,
            });
            const { user } = await findOrCreateByIdentity({ provider: "yandex", externalId, profile });

            const accessToken = signToken({ uid: user.uid });
            const refreshToken = signRefreshToken(user.uid);
            const { userAgent, ip } = getReqMeta(req);
            await createSession({ userId: user.uid, refreshToken, userAgent, ip });

            return res.json(buildSessionResponse({ accessToken, refreshToken, uid: user.uid }));
        } catch (err) {
            return sendError(res, err);
        }
    });

    /**
     * POST /v1/auth/session/refresh  { refreshId }
     * Ротация: старый токен отзывается. Повторное использование уже отозванного (заменённого) токена
     * означает возможную кражу, поэтому отзываются все сессии пользователя.
     */
    router.post("/session/refresh", limiter, async (req, res) => {
        const { refreshId } = req.body || {};
        if (!refreshId || typeof refreshId !== "string") {
            return res.status(400).json({ error: "refresh_required" });
        }

        try {
            verifyRefreshToken(refreshId);
        } catch {
            return res.status(401).json({ error: "invalid_refresh" });
        }

        try {
            const sess = await getSessionByToken(refreshId);
            if (!sess) return res.status(401).json({ error: "invalid_refresh" });

            if (sess.revoked_at) {
                if (sess.replaced_by) await revokeAllForUser(sess.user_id); // повторное использование
                return res.status(401).json({ error: "revoked" });
            }
            if (new Date(sess.expires_at).getTime() < Date.now()) {
                await markRevoked(sess.id);
                return res.status(401).json({ error: "expired" });
            }

            const { userAgent, ip } = getReqMeta(req);
            const newRefreshToken = signRefreshToken(sess.user_id);
            const newId = await rotateSession({
                oldSessionId: sess.id,
                userId: sess.user_id,
                newRefreshToken,
                userAgent,
                ip,
            });
            if (!newId) {
                // токен использовали одновременно или уже заменили
                await revokeAllForUser(sess.user_id);
                return res.status(401).json({ error: "revoked" });
            }

            const accessToken = signToken({ uid: sess.user_id });
            return res.json(buildSessionResponse({ accessToken, refreshToken: newRefreshToken, uid: sess.user_id }));
        } catch (err) {
            return sendError(res, err);
        }
    });

    /** POST /v1/auth/session/logout  { refreshId } */
    router.post("/session/logout", limiter, async (req, res) => {
        const { refreshId } = req.body || {};
        if (!refreshId || typeof refreshId !== "string") {
            return res.status(400).json({ error: "refresh_required" });
        }
        try {
            const sess = await getSessionByToken(refreshId);
            if (sess) await markRevoked(sess.id);
            return res.json({ ok: true });
        } catch (err) {
            return sendError(res, err);
        }
    });

    /** POST /v1/auth/logout_all  (с Bearer): выйти на всех устройствах */
    router.post("/logout_all", authMiddleware, async (req, res) => {
        try {
            await revokeAllForUser(req.user.uid);
            return res.json({ ok: true });
        } catch (err) {
            return sendError(res, err);
        }
    });

    return router;
}
