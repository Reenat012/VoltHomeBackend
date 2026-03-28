// models/subscriptions.js
// Работа с таблицей subscriptions:
// - чтение активной подписки;
// - strict/idempotent lookup по order_id и purchase_token_hash;
// - insert/update записей по данным RuStore.

import crypto from "crypto";
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
 * Хэш purchaseToken для strict/idempotency политики.
 * Сырым токеном в логике конфликтов больше не опираемся.
 */
function hashPurchaseToken(purchaseToken) {
    return crypto
        .createHash("sha256")
        .update(String(purchaseToken), "utf8")
        .digest("hex");
}

/**
 * Поиск подписки по order_id.
 * Нужен для conflict matrix:
 * - same orderId + same user/product/token -> idempotent replay
 * - same orderId + mismatch -> hard reject
 */
export async function findSubscriptionByOrderId(orderId, context = {}) {
    const { billingTraceId } = context;

    logModel(
        "log",
        "BEGIN",
        "findSubscriptionByOrderId",
        billingTraceId,
        null,
        `orderId=${maskValue(orderId)}`
    );

    let finalOutcome = "ROW_NOT_FOUND";

    try {
        if (!orderId) {
            finalOutcome = "MISSING_ORDER_ID";
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
                purchase_token_hash,
                status,
                period_end_at,
                created_at,
                updated_at
            FROM subscriptions
            WHERE order_id = $1
            LIMIT 1
            `,
            [orderId]
        );

        const row = res.rows[0] || null;
        finalOutcome = row ? "ROW_FOUND" : "ROW_NOT_FOUND";
        return row;
    } catch (e) {
        finalOutcome = "FAILED";
        console.error(
            `MID op=findSubscriptionByOrderId billingTraceId=${billingTraceId} errorClass=${e?.constructor?.name} errorMessage=${e?.message}`,
            e
        );
        throw e;
    } finally {
        logModel(
            finalOutcome === "ROW_FOUND" || finalOutcome === "ROW_NOT_FOUND" ? "log" : "warn",
            "END",
            "findSubscriptionByOrderId",
            billingTraceId,
            finalOutcome
        );
    }
}

/**
 * Поиск подписки по purchase_token_hash.
 * Нужен для кейса:
 * - same token + different orderId -> TOKEN_REUSE_MISMATCH
 */
export async function findSubscriptionByPurchaseTokenHash(purchaseTokenHash, context = {}) {
    const { billingTraceId } = context;

    logModel(
        "log",
        "BEGIN",
        "findSubscriptionByPurchaseTokenHash",
        billingTraceId,
        null,
        `purchaseTokenHash=${maskValue(purchaseTokenHash)}`
    );

    let finalOutcome = "ROW_NOT_FOUND";

    try {
        if (!purchaseTokenHash) {
            finalOutcome = "MISSING_PURCHASE_TOKEN_HASH";
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
                    purchase_token_hash,
                    status,
                    period_end_at,
                    created_at,
                    updated_at
                FROM subscriptions
                WHERE purchase_token_hash = $1
                    LIMIT 1
            `,
            [purchaseTokenHash]
        );

        const row = res.rows[0] || null;
        finalOutcome = row ? "ROW_FOUND" : "ROW_NOT_FOUND";
        return row;
    } catch (e) {
        finalOutcome = "FAILED";
        console.error(
            `MID op=findSubscriptionByPurchaseTokenHash billingTraceId=${billingTraceId} errorClass=${e?.constructor?.name} errorMessage=${e?.message}`,
            e
        );
        throw e;
    } finally {
        logModel(
            finalOutcome === "ROW_FOUND" || finalOutcome === "ROW_NOT_FOUND" ? "log" : "warn",
            "END",
            "findSubscriptionByPurchaseTokenHash",
            billingTraceId,
            finalOutcome
        );
    }
}

/**
 * Возвращает самую "свежую" активную подписку пользователя
 * (ACTIVE / TRIAL / GRACE и с ненаступившим или пустым period_end_at).
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
                    purchase_token_hash,
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
                    created_at DESC
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
 * Вставка новой подписки RuStore.
 * В strict-режиме это отдельная операция, а не слепой upsert.
 */
export async function insertSubscriptionFromRustore(
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
        "insertSubscriptionFromRustore",
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
            throw new Error("insertSubscriptionFromRustore: userId is required");
        }

        if (!productId) {
            finalOutcome = "MISSING_PRODUCT_ID";
            throw new Error("insertSubscriptionFromRustore: productId is required");
        }

        if (!orderId) {
            finalOutcome = "MISSING_ORDER_ID";
            throw new Error("insertSubscriptionFromRustore: orderId is required");
        }

        if (!purchaseToken) {
            finalOutcome = "MISSING_PURCHASE_TOKEN";
            throw new Error("insertSubscriptionFromRustore: purchaseToken is required");
        }

        const purchaseTokenHash = hashPurchaseToken(purchaseToken);

        const res = await query(
            `
            INSERT INTO subscriptions (
                user_id,
                product_id,
                order_id,
                purchase_token,
                purchase_token_hash,
                status,
                period_end_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING
                id,
                user_id,
                product_id,
                order_id,
                purchase_token,
                purchase_token_hash,
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
                purchaseTokenHash,
                status,
                periodEndAt || null,
            ]
        );

        finalOutcome = "INSERT_OK";
        return res.rows[0] || null;
    } catch (e) {
        console.error(
            `MID op=insertSubscriptionFromRustore billingTraceId=${billingTraceId} errorClass=${e?.constructor?.name} errorMessage=${e?.message}`,
            e
        );
        throw e;
    } finally {
        logModel(
            finalOutcome === "INSERT_OK" ? "log" : "warn",
            "END",
            "insertSubscriptionFromRustore",
            billingTraceId,
            finalOutcome
        );
    }
}

/**
 * Обновление существующей записи подписки по id.
 * Используем только после того, как service-слой уже принял детерминированное решение,
 * что update допустим и не нарушает conflict matrix.
 */
export async function updateSubscriptionById(
    id,
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
        "updateSubscriptionById",
        billingTraceId,
        null,
        [
            `id=${maskValue(id)}`,
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
        if (!id) {
            finalOutcome = "MISSING_ID";
            throw new Error("updateSubscriptionById: id is required");
        }

        if (!userId) {
            finalOutcome = "MISSING_USER_ID";
            throw new Error("updateSubscriptionById: userId is required");
        }

        if (!productId) {
            finalOutcome = "MISSING_PRODUCT_ID";
            throw new Error("updateSubscriptionById: productId is required");
        }

        if (!orderId) {
            finalOutcome = "MISSING_ORDER_ID";
            throw new Error("updateSubscriptionById: orderId is required");
        }

        if (!purchaseToken) {
            finalOutcome = "MISSING_PURCHASE_TOKEN";
            throw new Error("updateSubscriptionById: purchaseToken is required");
        }

        const purchaseTokenHash = hashPurchaseToken(purchaseToken);

        const res = await query(
            `
            UPDATE subscriptions
            SET
                user_id = $2,
                product_id = $3,
                order_id = $4,
                purchase_token = $5,
                purchase_token_hash = $6,
                status = $7,
                period_end_at = $8,
                updated_at = now()
            WHERE id = $1
            RETURNING
                id,
                user_id,
                product_id,
                order_id,
                purchase_token,
                purchase_token_hash,
                status,
                period_end_at,
                created_at,
                updated_at
            `,
            [
                id,
                userId,
                productId,
                orderId,
                purchaseToken,
                purchaseTokenHash,
                status,
                periodEndAt || null,
            ]
        );

        const row = res.rows[0] || null;
        finalOutcome = row ? "UPDATE_OK" : "ROW_NOT_FOUND";
        return row;
    } catch (e) {
        console.error(
            `MID op=updateSubscriptionById billingTraceId=${billingTraceId} errorClass=${e?.constructor?.name} errorMessage=${e?.message}`,
            e
        );
        throw e;
    } finally {
        logModel(
            finalOutcome === "UPDATE_OK" || finalOutcome === "ROW_NOT_FOUND" ? "log" : "warn",
            "END",
            "updateSubscriptionById",
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