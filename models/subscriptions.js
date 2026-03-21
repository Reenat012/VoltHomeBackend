// models/subscriptions.js
// Работа с таблицей subscriptions: чтение активной подписки, апсерт по данным из RuStore.

import { query } from "../db/pool.js";

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
 * Унифицированный model/db-лог.
 */
function logModel(level, marker, operation, billingTraceId, outcome, extra) {
    const parts = [
        marker,
        `op=${operation}`,
        `billingTraceId=${billingTraceId ?? "db-no-trace"}`,
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
 * Возвращает самую "свежую" активную подписку пользователя
 * (ACTIVE / TRIAL / GRACE и с ненаступившим или пустым period_end_at).
 *
 * @param {string} userId - идентификатор пользователя
 * @param {object} context
 * @param {string} context.billingTraceId
 * @returns {Promise<object|null>}
 */
export async function getActiveSubscriptionForUser(userId, context = {}) {
    const { billingTraceId } = context;

    logModel(
        "log",
        "BEGIN",
        "getActiveSubscriptionForUser",
        billingTraceId,
        null,
        `userId=${maskValue(userId)}`
    );

    let finalOutcome = "ROW_NOT_FOUND";

    try {
        if (!userId) {
            finalOutcome = "NO_USER_ID";
            return null;
        }

        const res = await query(
            `
            SELECT
                id,
                user_id,
                product_id,
                order_id,
                purchase_token,
                status,
                period_end_at,
                created_at,
                updated_at
            FROM subscriptions
            WHERE user_id = $1
              AND status IN ('ACTIVE', 'TRIAL', 'GRACE')
              AND (period_end_at IS NULL OR period_end_at > now())
            ORDER BY
                period_end_at DESC NULLS LAST,
                created_at  DESC
            LIMIT 1
            `,
            [userId]
        );

        const row = res.rows[0] || null;
        finalOutcome = row ? "ROW_FOUND" : "ROW_NOT_FOUND";

        return row;
    } catch (e) {
        finalOutcome = "FAILED";
        console.error(
            `MID op=getActiveSubscriptionForUser billingTraceId=${billingTraceId} errorClass=${e?.constructor?.name} errorMessage=${e?.message}`,
            e
        );
        throw e;
    } finally {
        logModel(
            finalOutcome === "ROW_FOUND" || finalOutcome === "ROW_NOT_FOUND" ? "log" : "warn",
            "END",
            "getActiveSubscriptionForUser",
            billingTraceId,
            finalOutcome
        );
    }
}

/**
 * Апсерт подписки по данным RuStore.
 * Ключ — order_id: если такой заказ уже есть, обновляем данные, иначе создаём запись.
 *
 * @param {object} params
 * @param {object} context
 * @returns {Promise<object>}
 */
export async function upsertSubscriptionFromRustore(
    {
        userId,
        productId,
        orderId,
        purchaseToken,
        status,
        periodEndAt,
    },
    context = {}
) {
    const { billingTraceId } = context;

    logModel(
        "log",
        "BEGIN",
        "upsertSubscriptionFromRustore",
        billingTraceId,
        null,
        [
            `userId=${maskValue(userId)}`,
            `productId=${maskValue(productId)}`,
            `orderId=${maskValue(orderId)}`,
            `purchaseToken=${maskValue(purchaseToken)}`,
            `status=${status}`,
            `periodEndAt=${periodEndAt ? periodEndAt.toISOString() : "null"}`,
        ].join(", ")
    );

    let finalOutcome = "FAILED";

    try {
        if (!userId) {
            finalOutcome = "MISSING_USER_ID";
            throw new Error("upsertSubscriptionFromRustore: userId is required");
        }

        if (!orderId) {
            finalOutcome = "MISSING_ORDER_ID";
            throw new Error("upsertSubscriptionFromRustore: orderId is required");
        }

        const res = await query(
            `
            INSERT INTO subscriptions (
                user_id,
                product_id,
                order_id,
                purchase_token,
                status,
                period_end_at
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (order_id) DO UPDATE SET
                product_id     = EXCLUDED.product_id,
                purchase_token = EXCLUDED.purchase_token,
                status         = EXCLUDED.status,
                period_end_at  = EXCLUDED.period_end_at,
                updated_at     = now()
            RETURNING
                id,
                user_id,
                product_id,
                order_id,
                purchase_token,
                status,
                period_end_at,
                created_at,
                updated_at
            `,
            [
                userId,
                productId,
                orderId,
                purchaseToken,
                status,
                periodEndAt || null,
            ]
        );

        finalOutcome = "UPSERT_OK";
        return res.rows[0];
    } catch (e) {
        console.error(
            `MID op=upsertSubscriptionFromRustore billingTraceId=${billingTraceId} errorClass=${e?.constructor?.name} errorMessage=${e?.message}`,
            e
        );
        throw e;
    } finally {
        logModel(
            finalOutcome === "UPSERT_OK" ? "log" : "warn",
            "END",
            "upsertSubscriptionFromRustore",
            billingTraceId,
            finalOutcome
        );
    }
}

/**
 * Утилита для вычисления логического плана пользователя из записи subscriptions.
 */
export function derivePlanFromSubscription(subscription) {
    if (!subscription) {
        return {
            plan: "free",
            planUntilEpochSeconds: null,
        };
    }

    const { status, period_end_at: periodEndAt } = subscription;

    const isActive =
        status === "ACTIVE" ||
        status === "TRIAL" ||
        status === "GRACE";

    if (!isActive) {
        return {
            plan: "free",
            planUntilEpochSeconds: null,
        };
    }

    const until = periodEndAt
        ? Math.floor(new Date(periodEndAt).getTime() / 1000)
        : null;

    return {
        plan: "pro",
        planUntilEpochSeconds: until,
    };
}