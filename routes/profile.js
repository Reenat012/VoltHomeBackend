// routes/profile.js
// Профиль и тариф пользователя. Контракт: docs/SYNC_CONTRACT.md, раздел 5.
import express from "express";
import { authMiddleware } from "../utils/jwt.js";
import { getUser, updateProfile } from "../models/users.js";
import { deleteAccount } from "../models/accounts.js";
import { tokenBucket } from "../utils/rateLimit.js";
import { resolvePlan, buildCapabilities, projectsLimitFor } from "../services/planService.js";

const router = express.Router();

async function currentPlan(uid) {
    try {
        return await resolvePlan(uid);
    } catch (err) {
        console.error("GET /v1/profile/me plan error:", err?.message || err);
        return { plan: "free", planUntilEpochSeconds: null, planSource: "none" };
    }
}

/** GET /v1/profile/me: профиль, тариф и права (capabilities). */
router.get("/me", authMiddleware, async (req, res) => {
    const uid = req.user.uid;
    try {
        const [user, planInfo] = await Promise.all([getUser(uid), currentPlan(uid)]);
        return res.json({
            uid,
            displayName: user?.display_name ?? "Volt User",
            email: user?.email ?? null,
            avatarUrl: user?.avatar_url ?? null,
            plan: planInfo.plan,
            planUntilEpochSeconds: planInfo.planUntilEpochSeconds,
            planSource: planInfo.planSource,
            capabilities: buildCapabilities(planInfo.plan),
            projectsLimit: projectsLimitFor(planInfo.plan),
        });
    } catch (err) {
        console.error("GET /v1/profile/me error:", err?.message || err);
        return res.status(500).json({ error: "server_error" });
    }
});

/**
 * PUT и POST /v1/profile/me: обновить displayName и email (avatarUrl принимается и игнорируется: аватар не храним).
 * Поля плана игнорируются: клиент не может выдать себе PRO.
 */
async function saveProfile(req, res) {
    const uid = req.user.uid;
    const { displayName, email } = req.body || {};
    try {
        const saved = await updateProfile(uid, { displayName, email });
        if (!saved) return res.status(404).json({ error: "not_found" });
        return res.json({
            ok: true,
            profile: {
                displayName: saved.display_name,
                email: saved.email,
                avatarUrl: saved.avatar_url,
                uid,
            },
        });
    } catch (err) {
        console.error("PUT /v1/profile/me error:", err?.message || err);
        return res.status(500).json({ error: "server_error" });
    }
}

router.put("/me", authMiddleware, saveProfile);
router.post("/me", authMiddleware, saveProfile);

/**
 * POST /v1/profile/delete  { "confirm": true }
 * Удаляет аккаунт и данные пользователя безвозвратно (см. models/accounts.js, что сохраняется по закону).
 * Токены после удаления сразу перестают работать (401 account_deleted).
 */
router.post(
    "/delete",
    authMiddleware,
    tokenBucket({ limitPerMin: 5, name: "delete-account" }),
    async (req, res) => {
        if (req.body?.confirm !== true) {
            return res.status(400).json({ error: "invalid_request", message: "Нужно подтверждение: { \"confirm\": true }" });
        }
        const uid = req.user.uid;
        try {
            const deleted = await deleteAccount(uid);
            await req.app.locals?.audit?.(`deleted:${uid}`, "delete_account", "user", null, { uid, ...deleted });
            return res.json({ ok: true, deleted });
        } catch (err) {
            console.error("POST /v1/profile/delete error:", err?.message || err);
            return res.status(500).json({ error: "server_error" });
        }
    }
);

export default router;
