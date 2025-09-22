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
        sessionJwt: accessToken,
        expiresAtEpochSeconds: nowEpochSeconds() + ACCESS_TTL_MIN * 60, // секунды!
        refreshId: refreshToken,
    };
}

/** Обёртка таймаута для промисов (быстрый отказ БД) */
function withTimeout(promise, ms, onTimeoutMsg = "timeout") {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(onTimeoutMsg)), ms);
        promise.then(
            (v) => { clearTimeout(t); resolve(v); },
            (e) => { clearTimeout(t); reject(e); }
        );
    });
}

/**
 * ============================
 *  Ручки под контракт клиента
 * ============================
 */

/** POST /v1/auth/yandex/exchange */
router.post("/yandex/exchange", async (req, res) => {
    const { code, uid } = req.body || {};
    if (!code && !uid) return res.status(400).json({ error: "uid_or_code_required" });

    const userId = uid || `ya_${String(code).slice(0, 24)}`;
    const accessToken = issueAccessToken(userId);
    const refreshToken = issueRefreshToken(userId);

    // Быстрый отказ, если БД «лежит»
    try {
        const { userAgent, ip } = getReqMeta(req);
        await withTimeout(
            createSession({ userId, refreshToken, userAgent, ip }),
            2000,
            "db_timeout"
        );
    } catch (e) {
        // Не записали сессию — не отдаём refreshId, чтобы не порождать «битые» сессии
        return res.status(503).json({ error: "server_unavailable", cause: String(e?.message || e) });
    }

    return res.json(buildSessionResponse({ accessToken, refreshToken }));
});

/** POST /v1/auth/session/refresh */
router.post("/session/refresh", async (req, res) => {
    const { refreshId } = req.body || {};
    if (!refreshId) return res.status(400).json({ error: "refresh_required" });

    let decoded;
    try {
        decoded = jwt.verify(refreshId, JWT_REFRESH_SECRET);
        if (decoded?.typ !== "refresh") throw new Error("wrong_type");
    } catch {
        return res.status(401).json({ error: "invalid_refresh" });
    }

    let sess;
    try {
        sess = await withTimeout(getSessionByToken(refreshId), 2000, "db_timeout");
    } catch (e) {
        return res.status(503).json({ error: "server_unavailable", cause: String(e?.message || e) });
    }

    if (!sess) return res.status(401).json({ error: "invalid_refresh" });
    if (sess.revoked_at) return res.status(401).json({ error: "revoked" });
    if (new Date(sess.expires_at).getTime() < Date.now()) {
        await markRevoked(sess.id).catch(() => {});
        return res.status(401).json({ error: "expired" });
    }

    const newRefreshToken = issueRefreshToken(sess.user_id);

    try {
        await withTimeout(
            rotateSession({ oldSessionId: sess.id, userId: sess.user_id, newRefreshToken }),
            2000,
            "db_timeout"
        );
    } catch (e) {
        return res.status(503).json({ error: "server_unavailable", cause: String(e?.message || e) });
    }

    const accessToken = issueAccessToken(sess.user_id);
    return res.json(buildSessionResponse({ accessToken, refreshToken: newRefreshToken }));
});

/** POST /v1/auth/session/logout */
router.post("/session/logout", async (req, res) => {
    const { refreshId } = req.body || {};
    if (!refreshId) return res.status(400).json({ error: "refresh_required" });

    try {
        const sess = await withTimeout(getSessionByToken(refreshId), 2000, "db_timeout");
        if (sess) await withTimeout(markRevoked(sess.id), 2000, "db_timeout");
    } catch (e) {
        return res.status(503).json({ error: "server_unavailable", cause: String(e?.message || e) });
    }

    return res.json({ ok: true });
});

/**
 * ============================
 *  Старые ручки (совм-ть)
 * ============================
 */

router.post("/login", async (req, res) => {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: "user_required" });

    const accessToken = issueAccessToken(userId);
    const refreshToken = issueRefreshToken(userId);

    try {
        const { userAgent, ip } = getReqMeta(req);
        await withTimeout(
            createSession({ userId, refreshToken, userAgent, ip }),
            2000,
            "db_timeout"
        );
    } catch (e) {
        return res.status(503).json({ error: "server_unavailable", cause: String(e?.message || e) });
    }

    return res.json(buildSessionResponse({ accessToken, refreshToken }));
});

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

    let sess;
    try {
        sess = await withTimeout(getSessionByToken(refreshToken), 2000, "db_timeout");
    } catch (e) {
        return res.status(503).json({ error: "server_unavailable", cause: String(e?.message || e) });
    }

    if (!sess) return res.status(401).json({ error: "invalid_refresh" });
    if (sess.revoked_at) return res.status(401).json({ error: "revoked" });
    if (new Date(sess.expires_at).getTime() < Date.now()) {
        await markRevoked(sess.id).catch(() => {});
        return res.status(401).json({ error: "expired" });
    }

    const newRefreshToken = issueRefreshToken(sess.user_id);

    try {
        await withTimeout(
            rotateSession({ oldSessionId: sess.id, userId: sess.user_id, newRefreshToken }),
            2000,
            "db_timeout"
        );
    } catch (e) {
        return res.status(503).json({ error: "server_unavailable", cause: String(e?.message || e) });
    }

    const accessToken = issueAccessToken(sess.user_id);
    return res.json(buildSessionResponse({ accessToken, refreshToken: newRefreshToken }));
});

router.post("/logout", async (req, res) => {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: "refresh_required" });

    try {
        const sess = await withTimeout(getSessionByToken(refreshToken), 2000, "db_timeout");
        if (sess) await withTimeout(markRevoked(sess.id), 2000, "db_timeout");
    } catch (e) {
        return res.status(503).json({ error: "server_unavailable", cause: String(e?.message || e) });
    }

    return res.json({ ok: true });
});

router.post("/logout_all", authMiddleware, async (req, res) => {
    try {
        await withTimeout(revokeAllForUser(req.user.uid), 4000, "db_timeout");
    } catch (e) {
        return res.status(503).json({ error: "server_unavailable", cause: String(e?.message || e) });
    }
    return res.json({ ok: true });
});

export default router;