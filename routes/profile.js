import express from "express";
import { authMiddleware } from "../utils/jwt.js";
import { users, upsertUser } from "../stores/users.js";

const router = express.Router();

/**
 * GET /v1/profile/me — получить профиль (защищено)
 */
router.get("/me", authMiddleware, (req, res) => {
    const uid = req.user?.uid || "yandex-uid-demo";
    const row = users.get(uid);
    if (row) {
        const { displayName, email, avatarUrl, plan, planUntilEpochSeconds } = row;
        return res.json({ displayName, email, avatarUrl, plan, planUntilEpochSeconds, uid });
    }
    // нет сохранённого профиля — отдаём дефолты
    return res.json({
        displayName: "Volt User",
        email: null,
        avatarUrl: null,
        plan: "free",
        planUntilEpochSeconds: null,
        uid
    });
});

/**
 * PUT /v1/profile/me — апсертом обновить профиль (защищено)
 * body: { displayName?, email?, avatarUrl?, plan? , planUntilEpochSeconds? }
 */
router.put("/me", authMiddleware, (req, res) => {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "unauthorized" });

    const {
        displayName,
        email,
        avatarUrl,
        plan,
        planUntilEpochSeconds
    } = req.body || {};

    const saved = upsertUser(uid, {
        displayName,
        email,
        avatarUrl,
        plan,
        planUntilEpochSeconds
    });

    return res.json({
        ok: true,
        profile: {
            displayName: saved.displayName,
            email: saved.email,
            avatarUrl: saved.avatarUrl,
            plan: saved.plan,
            planUntilEpochSeconds: saved.planUntilEpochSeconds,
            uid
        }
    });
});

/**
 * POST /v1/profile/me — то же, что PUT (для удобства клиентов)
 */
router.post("/me", authMiddleware, (req, res) => {
    // проксируем на PUT
    return router.handle({ ...req, method: "PUT" }, res);
});

export default router;