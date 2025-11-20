// routes/profile.js

import express from "express";
import { authMiddleware } from "../utils/jwt.js";
import { users, upsertUser } from "../stores/users.js";
import {
    getActiveSubscriptionForUser,
    derivePlanFromSubscription
} from "../models/subscriptions.js";

const router = express.Router();

/**
 * GET /v1/profile/me — получить профиль (защищено)
 *
 * Логика Этапа 3:
 *  - Читаем профиль как раньше (displayName, email, avatarUrl) из in-memory users.
 *  - Дополнительно читаем подписку через getActiveSubscriptionForUser(uid).
 *  - Если подписка активная → plan="pro", план длится до period_end_at.
 *  - Если подписки нет/ошибка → plan="free", planUntil=null.
 *  - В любых ошибках подписки → НЕ падаем, НЕ возвращаем 500 — просто plan="free".
 */
router.get("/me", authMiddleware, async (req, res) => {
    try {
        const uid = req.user?.uid || "yandex-uid-demo";

        // 1. Profile (старый UX)
        const row = users.get(uid);
        const profile = {
            displayName: row?.displayName ?? "Volt User",
            email: row?.email ?? null,
            avatarUrl: row?.avatarUrl ?? null
        };

        // 2. Subscription
        let plan = "free";
        let planUntilEpochSeconds = null;

        try {
            const activeSub = await getActiveSubscriptionForUser(uid);
            const planInfo = derivePlanFromSubscription(activeSub);

            plan = planInfo.plan; // "free" | "pro"
            planUntilEpochSeconds = planInfo.planUntilEpochSeconds;
        } catch (err) {
            console.error("GET /v1/profile/me subscription error:", err);
            // просто считаем free
        }

        return res.json({
            ...profile,
            plan,
            planUntilEpochSeconds,
            uid
        });

    } catch (err) {
        console.error("GET /v1/profile/me fatal:", err);
        // даже в случае катастрофы — не ломаем UX
        return res.json({
            displayName: "Volt User",
            email: null,
            avatarUrl: null,
            plan: "free",
            planUntilEpochSeconds: null,
            uid: req.user?.uid || null
        });
    }
});


/**
 * PUT /v1/profile/me — обновить профиль пользователя
 *
 * Правила Этапа 3:
 *  - Игнорировать любые поля plan и planUntilEpochSeconds в теле запроса.
 *  - Обновлять только:
 *      displayName
 *      email
 *      avatarUrl
 *
 *  Клиент больше не может "сам себе" ставить PRO.
 */
router.put("/me", authMiddleware, (req, res) => {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "unauthorized" });

    const { displayName, email, avatarUrl } = req.body || {};

    const saved = upsertUser(uid, {
        displayName,
        email,
        avatarUrl
        // plan / planUntil игнорируются намеренно
    });

    return res.json({
        ok: true,
        profile: {
            displayName: saved.displayName,
            email: saved.email,
            avatarUrl: saved.avatarUrl,
            // Публичная информация о плане отдаётся только через актуальную подписку,
            // здесь мы её не включаем — чтобы не путать источники истины.
            uid
        }
    });
});

/**
 * POST /v1/profile/me — то же, что PUT (для удобства клиентов)
 *   (это оставляем как есть)
 */
router.post("/me", authMiddleware, (req, res) => {
    return router.handle({ ...req, method: "PUT" }, res);
});

export default router;