// routes/auth.js
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

const ACCESS_TTL_MIN = +(process.env.ACCESS_TTL_MIN || 30);
const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "access_dev_secret";
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "refresh_dev_secret";

function issueAccessToken(uid) {
    return jwt.sign({ uid }, JWT_ACCESS_SECRET, {
        algorithm: "HS256",
        expiresIn: `${ACCESS_TTL_MIN}m`,
    });
}

function issueRefreshToken(uid) {
    // exp в JWT для подстраховки; реальный TTL контролируется в БД
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

/**
 * POST /v1/auth/login
 * Body: { userId }
 * Выдаёт пару токенов и создаёт refresh-сессию. Предполагается, что userId уже провалидирован.
 */
router.post("/login", async (req, res) => {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: "user_required" });

    const accessToken = issueAccessToken(userId);
    const refreshToken = issueRefreshToken(userId);

    const { userAgent, ip } = getReqMeta(req);
    await createSession({ userId, refreshToken, userAgent, ip });

    return res.json({ accessToken, refreshToken });
});

/**
 * POST /v1/auth/refresh
 * Body: { refreshToken }
 * Ротация refresh-токена, возврат новой пары.
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
    const newSessionId = await rotateSession({
        oldSessionId: sess.id,
        userId: sess.user_id,
        newRefreshToken
    });

    const accessToken = issueAccessToken(sess.user_id);
    return res.json({ accessToken, refreshToken: newRefreshToken, sessionId: newSessionId });
});

/**
 * POST /v1/auth/logout
 * Body: { refreshToken }
 * Ревокация конкретной сессии.
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