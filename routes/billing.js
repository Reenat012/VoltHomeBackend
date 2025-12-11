// routes/billing.js
import express from "express";
import { authMiddleware } from "../utils/jwt.js";
import {
    getActiveSubscriptionForUser,
    upsertSubscriptionFromRustore,
    derivePlanFromSubscription,
} from "../models/subscriptions.js";
import { confirmRustorePurchase } from "../services/rustoreBillingService.js";

const router = express.Router();

/**
 * GET /v1/billing/status
 *
 * Возвращает текущий план/статус подписки для авторизованного пользователя.
 *
 * Формат ответа:
 * {
 *   "plan": "free" | "pro",
 *   "status": "NONE" | "ACTIVE" | "TRIAL" | "GRACE" | ...,
 *   "productId": "volthome_pro_monthly" | null,
 *   "periodEndEpochSeconds": 1234567890 | null
 * }
 *
 * Если подписки нет или ошибка — считаем пользователя free.
 */
router.get("/status", authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.uid;
        if (!userId) {
            return res.status(401).json({ error: "unauthorized" });
        }

        const activeSub = await getActiveSubscriptionForUser(userId);
        const { plan, planUntilEpochSeconds } =
            derivePlanFromSubscription(activeSub);

        return res.json({
            plan,
            status: activeSub?.status ?? "NONE",
            productId: activeSub?.product_id ?? null,
            periodEndEpochSeconds: planUntilEpochSeconds,
        });
    } catch (e) {
        console.error("[GET /v1/billing/status] error:", e);

        return res.status(500).json({
            plan: "free",
            status: "NONE",
            productId: null,
            periodEndEpochSeconds: null,
            error: "internal_error",
        });
    }
});

/**
 * POST /v1/billing/rustore/confirm
 *
 * Подтверждение покупки из RuStore.
 *
 * Ожидает в body:
 * {
 *   "productId": "volthome_pro_monthly",
 *   "orderId": "xxx",
 *   "purchaseToken": "yyy"
 * }
 *
 * В dev-режиме (RUSTORE_VERIFY_STUB=true) confirmRustorePurchase
 * сам подставляет фиктивный ACTIVE-период.
 */
router.post("/rustore/confirm", authMiddleware, async (req, res) => {
    try {
        const userId = req.user?.uid;
        if (!userId) {
            return res.status(401).json({ error: "unauthorized" });
        }

        const { productId, orderId, purchaseToken } = req.body || {};

        if (!productId || !orderId || !purchaseToken) {
            return res.status(400).json({ ok: false, error: "invalid_request" });
        }

        const result = await confirmRustorePurchase({
            userId,
            productId,
            orderId,
            purchaseToken,
        });

        if (!result.ok) {
            const status = result.httpStatus ?? 502;
            return res.status(status).json({
                ok: false,
                error: result.errorCode ?? "rustore_unavailable",
            });
        }

        const { subscription } = result;
        const { plan, planUntilEpochSeconds } =
            derivePlanFromSubscription(subscription);

        return res.json({
            ok: true,
            plan,
            status: subscription.status,
            productId: subscription.product_id,
            periodEndEpochSeconds: planUntilEpochSeconds,
        });
    } catch (e) {
        console.error("[POST /v1/billing/rustore/confirm] error:", e);
        return res.status(500).json({
            ok: false,
            error: "internal_error",
        });
    }
});

// Чтобы можно было импортировать как именованный router
export { router };
// И как default, если где-то будешь подключать по-старому
export default router;