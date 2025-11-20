// routes/billing.js
// Роуты для подтверждения покупок RuStore и получения статуса подписки.

import express from "express";
import { authMiddleware } from "../auth/authMiddleware.js";
import {
    getActiveSubscriptionForUser,
    derivePlanFromSubscription,
} from "../models/subscriptions.js";
import {
    confirmRustorePurchase,
} from "../services/rustoreBillingService.js";

const router = express.Router();

// Все роуты billing работают только для авторизованных пользователей
router.use(authMiddleware);

/**
 * POST /v1/billing/rustore/confirm
 *
 * Тело:
 * {
 *   "productId": "volthome_pro_monthly",
 *   "orderId": "<rustore-order-id>",
 *   "purchaseToken": "<rustore-purchase-token>"
 * }
 *
 * Логика:
 *  1) Берём userId из авторизации.
 *  2) Вызываем confirmRustorePurchase (внутри: verify + upsert в subscriptions).
 *  3) При ok=true → считаем plan через derivePlanFromSubscription и отдаём:
 *     {
 *       "ok": true,
 *       "plan": "pro",
 *       "status": "ACTIVE",
 *       "productId": "volthome_pro_monthly",
 *       "periodEndEpochSeconds": 1234567890
 *     }
 *  4) При ok=false → 502 с { ok:false, error: "rustore_unavailable" | "invalid_purchase" }.
 */
router.post("/rustore/confirm", async (req, res) => {
    try {
        const userId = req.userId;
        const { productId, orderId, purchaseToken } = req.body || {};

        if (!productId || !orderId || !purchaseToken) {
            return res.status(400).json({
                ok: false,
                error: "missing_required_fields",
            });
        }

        const result = await confirmRustorePurchase({
            userId,
            productId,
            orderId,
            purchaseToken,
        });

        if (!result.ok || !result.subscription) {
            return res.status(502).json({
                ok: false,
                error: result.error || "rustore_unavailable",
            });
        }

        const subscription = result.subscription;
        const planInfo = derivePlanFromSubscription(subscription);

        return res.json({
            ok: true,
            plan: planInfo.plan, // "pro" при успешной покупке
            status: subscription.status,
            productId: subscription.product_id,
            periodEndEpochSeconds: planInfo.planUntilEpochSeconds,
        });
    } catch (err) {
        console.error("POST /v1/billing/rustore/confirm error:", err);
        return res.status(500).json({
            ok: false,
            error: "internal_error",
        });
    }
});

/**
 * GET /v1/billing/status
 *
 * Возвращает текущий план пользователя на основе таблицы subscriptions:
 *
 * {
 *   "ok": true,
 *   "plan": "free" | "pro",
 *   "status": "NONE" | "ACTIVE" | "TRIAL" | "GRACE" | ...,
 *   "productId": "volthome_pro_monthly" | null,
 *   "periodEndEpochSeconds": 1234567890 | null
 * }
 *
 * Если подписки нет или ошибка — считаем пользователя free.
 */
router.get("/status", async (req, res) => {
    try {
        const userId = req.userId;

        const activeSub = await getActiveSubscriptionForUser(userId);
        const planInfo = derivePlanFromSubscription(activeSub);

        return res.json({
            ok: true,
            plan: planInfo.plan,
            status: activeSub?.status || "NONE",
            productId: activeSub?.product_id || null,
            periodEndEpochSeconds: planInfo.planUntilEpochSeconds,
        });
    } catch (err) {
        console.error("GET /v1/billing/status error:", err);
        // В случае любой ошибки: не валим сервер, просто считаем пользователя free
        return res.status(500).json({
            ok: false,
            plan: "free",
            status: "NONE",
            productId: null,
            periodEndEpochSeconds: null,
            error: "internal_error",
        });
    }
});

export default router;