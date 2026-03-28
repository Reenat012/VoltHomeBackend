// routes/billing.js
import express from "express";
import { authMiddleware } from "../utils/jwt.js";
import {
    getActiveSubscriptionForUser,
    derivePlanFromSubscription,
} from "../models/subscriptions.js";
import { confirmRustorePurchase } from "../services/rustoreBillingService.js";

const router = express.Router();

/**
 * Локальный backend trace id для billing-логов.
 * Это отдельный backend trace, не client purchaseFlowId.
 */
function newBillingTraceId(prefix = "billing") {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Маскирование чувствительных значений для логов.
 */
function maskValue(value) {
    if (!value) return "null";
    if (value.length <= 4) return `***${value}`;
    if (value.length <= 8) return `${value.slice(0, 1)}***${value.slice(-2)}`;
    return `${value.slice(0, 3)}***${value.slice(-4)}`;
}

/**
 * Унифицированный route-лог.
 */
function logRoute(level, marker, operation, billingTraceId, outcome, extra) {
    const parts = [
        marker,
        `op=${operation}`,
        `billingTraceId=${billingTraceId}`,
    ];

    if (outcome) {
        parts.push(`outcome=${outcome}`);
    }

    if (extra) {
        parts.push(extra);
    }

    const message = parts.join(" ");

    if (level === "error") {
        console.error(message);
    } else if (level === "warn") {
        console.warn(message);
    } else {
        console.log(message);
    }
}

/**
 * GET /v1/billing/status
 *
 * Возвращает текущий план/статус подписки для авторизованного пользователя.
 */
router.get("/status", authMiddleware, async (req, res) => {
    const billingTraceId = newBillingTraceId("status");
    const userId = req.user?.uid;

    logRoute(
        "log",
        "BEGIN",
        "GET /v1/billing/status",
        billingTraceId,
        null,
        `userId=${maskValue(userId)}`
    );

    let finalOutcome = "STATUS_INTERNAL_ERROR";

    try {
        if (!userId) {
            finalOutcome = "UNAUTHORIZED";

            return res.status(401).json({ error: "unauthorized" });
        }

        const activeSub = await getActiveSubscriptionForUser(userId, {
            billingTraceId,
        });

        const { plan, planUntilEpochSeconds } =
            derivePlanFromSubscription(activeSub);

        finalOutcome = "STATUS_OK";

        return res.json({
            plan,
            status: activeSub?.status ?? "NONE",
            productId: activeSub?.product_id ?? null,
            periodEndEpochSeconds: planUntilEpochSeconds,
        });
    } catch (e) {
        console.error(
            `MID op=GET /v1/billing/status billingTraceId=${billingTraceId} errorClass=${e?.constructor?.name} errorMessage=${e?.message}`,
            e
        );

        return res.status(500).json({
            plan: "free",
            status: "NONE",
            productId: null,
            periodEndEpochSeconds: null,
            error: "internal_error",
        });
    } finally {
        logRoute(
            finalOutcome === "STATUS_OK" ? "log" : "warn",
            "END",
            "GET /v1/billing/status",
            billingTraceId,
            finalOutcome
        );
    }
});

/**
 * POST /v1/billing/rustore/confirm
 *
 * Подтверждение покупки из RuStore.
 */
router.post("/rustore/confirm", authMiddleware, async (req, res) => {
    const billingTraceId = newBillingTraceId("confirm");
    const userId = req.user?.uid;
    const { productId, orderId, purchaseToken } = req.body || {};

    logRoute(
        "log",
        "BEGIN",
        "POST /v1/billing/rustore/confirm",
        billingTraceId,
        null,
        [
            `userId=${maskValue(userId)}`,
            `productId=${maskValue(productId)}`,
            `orderId=${maskValue(orderId)}`,
            `purchaseToken=${maskValue(purchaseToken)}`,
        ].join(", ")
    );

    let finalOutcome = "CONFIRM_INTERNAL_ERROR";

    try {
        if (!userId) {
            finalOutcome = "UNAUTHORIZED";
            return res.status(401).json({ error: "unauthorized" });
        }

        if (!productId || !orderId || !purchaseToken) {
            finalOutcome = "INVALID_REQUEST";
            return res.status(400).json({
                ok: false,
                error: "invalid_request",
                outcomeCode: "INVALID_REQUEST",
            });
        }

        const result = await confirmRustorePurchase({
            userId,
            productId,
            orderId,
            purchaseToken,
            billingTraceId,
        });

        if (!result.ok) {
            const status = result.httpStatus ?? 502;
            finalOutcome = result.errorCode ?? "RUSTORE_UNAVAILABLE";

            return res.status(status).json({
                ok: false,
                error: result.errorCode ?? "rustore_unavailable",
                outcomeCode: result.errorCode ?? "RUSTORE_UNAVAILABLE",
            });
        }

        const { subscription } = result;
        const { plan, planUntilEpochSeconds } =
            derivePlanFromSubscription(subscription);

        finalOutcome = result.outcomeCode ?? "CONFIRM_OK";

        return res.json({
            ok: true,
            outcomeCode: result.outcomeCode ?? "CONFIRM_OK",
            plan,
            status: subscription.status,
            productId: subscription.product_id,
            periodEndEpochSeconds: planUntilEpochSeconds,
        });
    } catch (e) {
        console.error(
            `MID op=POST /v1/billing/rustore/confirm billingTraceId=${billingTraceId} errorClass=${e?.constructor?.name} errorMessage=${e?.message}`,
            e
        );

        return res.status(500).json({
            ok: false,
            error: "internal_error",
            outcomeCode: "INTERNAL_ERROR",
        });
    } finally {
        logRoute(
            finalOutcome === "CONFIRM_OK" || finalOutcome === "IDEMPOTENT_REPLAY"
                ? "log"
                : "warn",
            "END",
            "POST /v1/billing/rustore/confirm",
            billingTraceId,
            finalOutcome
        );
    }
});

export { router };
export default router;