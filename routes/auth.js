// routes/auth.js
import express from "express";
import { signToken, authMiddleware, verifyTokenAllowExpired } from "../utils/jwt.js";
import { users } from "../stores/users.js";

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
 *
 * Примечание: клиент присылает сюда access_token от Yandex SDK в поле "code".
 * Здесь дергаем login.yandex.ru/info, сохраняем профиль в памяти и выдаём серверную сессию.
 */
router.post("/yandex/exchange", async (req, res) => {
    const { code, uid: uidRaw } = req.body || {};

    let resolvedUid = null;

    // Пытаемся получить профиль от Яндекса (если пришёл access_token)
    if (code) {
        try {
            const accessToken = String(code);
            const url = process.env.YA_INFO_URL || "https://login.yandex.ru/info?format=json";
            const r = await fetch(url, {
                headers: {
                    "Authorization": `OAuth ${accessToken}`,
                    "Accept": "application/json"
                }
            });
            if (!r.ok) {
                const text = await r.text().catch(() => "");
                throw new Error(`yandex_info_http_${r.status} ${text}`);
            }
            const data = await r.json();

            const yaId = data.id || data.uid || data.default_uid || null;
            resolvedUid = (uidRaw && String(uidRaw)) || (yaId ? `ya:${yaId}` : null);

            const displayName =
                data.display_name || data.real_name || data.login || "Yandex User";
            const email =
                data.default_email || (Array.isArray(data.emails) ? data.emails[0] : null) || null;
            const avatarUrl = data.default_avatar_id
                ? `https://avatars.yandex.net/get-yapic/${data.default_avatar_id}/islands-200`
                : null;

            const profile = {
                uid: resolvedUid || (uidRaw && String(uidRaw)) || "yandex-uid-demo",
                displayName,
                email,
                avatarUrl,
                plan: "free",
                planUntilEpochSeconds: null
            };
            users.set(profile.uid, profile);
        } catch (e) {
            console.error("[auth/yandex/exchange] fetch profile failed:", e?.message || e);
        }
    }

    // Если профиль не удалось получить — формируем uid из тела/токена/фолбек
    const uid =
        resolvedUid ||
        (uidRaw && String(uidRaw)) ||
        (code ? `ya:${Buffer.from(String(code)).toString("hex").slice(0, 12)}` : "yandex-uid-demo");

    // Если профиля всё ещё нет — создаём заготовку, чтобы /profile/me не был пустым
    if (!users.has(uid)) {
        users.set(uid, {
            uid,
            displayName: "Volt User",
            email: null,
            avatarUrl: null,
            plan: "free",
            planUntilEpochSeconds: null
        });
    }

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
            // читаем uid даже из истёкшего токена
            const payload = verifyTokenAllowExpired(m[1]);
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
 * Возвращает: 200 { ok: true }
 */
router.post("/session/logout", authMiddleware, (req, res) => {
    const { refreshId } = req.body || {};
    if (refreshId && refreshStore.has(refreshId)) {
        const prev = refreshStore.get(refreshId);
        refreshStore.set(refreshId, { ...prev, valid: false });
    }
    res.json({ ok: true });
});

/**
 * GET /auth/me — dev-хелпер (аналог /profile/me)
 * Требует валидный Bearer.
 */
router.get("/me", authMiddleware, (req, res) => {
    const uid = req.user?.uid || "yandex-uid-demo";
    const row = users.get(uid);
    if (row) {
        const { displayName, email, avatarUrl, plan, planUntilEpochSeconds } = row;
        return res.json({ displayName, email, avatarUrl, plan, planUntilEpochSeconds, uid });
    }
    res.json({
        displayName: "Volt User",
        email: null,
        avatarUrl: null,
        plan: "free",
        planUntilEpochSeconds: null,
        uid
    });
});

export default router;