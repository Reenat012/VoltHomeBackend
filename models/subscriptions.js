// models/subscriptions.js
// Работа с таблицей subscriptions: чтение активной подписки, апсерт по данным из RuStore.

import { query } from "../db/pool.js";

/**
 * Возвращает самую "свежую" активную подписку пользователя
 * (ACTIVE / TRIAL / GRACE и с ненаступившим или пустым period_end_at).
 *
 * @param {string} userId - идентификатор пользователя (Yandex UID / user_id)
 * @returns {Promise<object|null>}
 */
export async function getActiveSubscriptionForUser(userId) {
    if (!userId) {
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

    return res.rows[0] || null;
}

/**
 * Апсерт подписки по данным RuStore.
 * Ключ — order_id: если такой заказ уже есть, обновляем данные, иначе создаём запись.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.productId
 * @param {string} params.orderId
 * @param {string} params.purchaseToken
 * @param {string} params.status        - ACTIVE / TRIAL / GRACE / PAUSED / EXPIRED / CANCELLED
 * @param {Date|null} params.periodEndAt - JS Date или null
 * @returns {Promise<object>} - актуальная запись subscriptions.*
 */
export async function upsertSubscriptionFromRustore({
                                                        userId,
                                                        productId,
                                                        orderId,
                                                        purchaseToken,
                                                        status,
                                                        periodEndAt,
                                                    }) {
    if (!userId) {
        throw new Error("upsertSubscriptionFromRustore: userId is required");
    }
    if (!orderId) {
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

    return res.rows[0];
}

/**
 * Утилита для вычисления "логического" плана пользователя из записи subscriptions.
 * На этом этапе только каркас, дальше будем использовать в /profile/me и /billing/status.
 *
 * @param {object|null} subscription
 * @returns {{ plan: "free" | "pro", planUntilEpochSeconds: number | null }}
 */
export function derivePlanFromSubscription(subscription) {
    if (!subscription) {
        return {
            plan: "free",
            planUntilEpochSeconds: null,
        };
    }

    const { status, period_end_at: periodEndAt } = subscription;

    // В этой функции мы считаем, что наличие активной подписки = PRO.
    // Точные правила по статусам можно потом докрутить.
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

    const until = periodEndAt ? Math.floor(new Date(periodEndAt).getTime() / 1000) : null;

    return {
        plan: "pro",
        planUntilEpochSeconds: until,
    };
}