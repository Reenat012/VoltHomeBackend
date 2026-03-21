// services/rustoreBillingService.js
// Сервис для работы с RuStore: валидация покупок и создание/обновление подписок.
//
// На Этапе 1 здесь только каркас + dev-стаб через переменную окружения RUSTORE_VERIFY_STUB.

import { upsertSubscriptionFromRustore } from "../models/subscriptions.js";

const {
    RUSTORE_VERIFY_STUB = "true",
    // На следующих этапах сюда добавим реальные креды RuStore:
    // RUSTORE_CLIENT_ID,
    // RUSTORE_CLIENT_SECRET,
} = process.env;

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
 * Унифицированный service-лог.
 */
function logService(level, marker, operation, billingTraceId, outcome, extra) {
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
 * Верификация покупки в RuStore.
 *
 * На Этапе 1:
 *  - если RUSTORE_VERIFY_STUB === "true" → считаем все покупки валидными на 30 дней;
 *  - иначе бросаем ошибку, чтобы не было "тихого" перехода в прод без реализации.
 */
export async function verifyRustorePurchase({
                                                userId,
                                                productId,
                                                orderId,
                                                purchaseToken,
                                                billingTraceId = "verify-no-trace",
                                            }) {
    logService(
        "log",
        "BEGIN",
        "verifyRustorePurchase",
        billingTraceId,
        null,
        [
            `stubMode=${RUSTORE_VERIFY_STUB}`,
            `userId=${maskValue(userId)}`,
            `productId=${maskValue(productId)}`,
            `orderId=${maskValue(orderId)}`,
            `purchaseToken=${maskValue(purchaseToken)}`,
        ].join(", ")
    );

    let finalOutcome = "VERIFY_FAILED";

    try {
        if (RUSTORE_VERIFY_STUB === "true") {
            // Dev-режим: эмулируем успешную покупку с периодом 30 дней.
            const now = new Date();
            const periodEndAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

            finalOutcome = "VERIFY_STUB_OK";

            return {
                ok: true,
                status: "ACTIVE",
                periodEndAt,
            };
        }

        finalOutcome = "VERIFY_REAL_NOT_IMPLEMENTED";
        throw new Error("verifyRustorePurchase: real RuStore API call is not implemented yet");
    } finally {
        logService(
            finalOutcome === "VERIFY_STUB_OK" ? "log" : "warn",
            "END",
            "verifyRustorePurchase",
            billingTraceId,
            finalOutcome
        );
    }
}

/**
 * Высокоуровневая операция "подтвердить покупку RuStore и обновить подписку".
 */
export async function confirmRustorePurchase({
                                                 userId,
                                                 productId,
                                                 orderId,
                                                 purchaseToken,
                                                 billingTraceId = "confirm-no-trace",
                                             }) {
    logService(
        "log",
        "BEGIN",
        "confirmRustorePurchase",
        billingTraceId,
        null,
        [
            `userId=${maskValue(userId)}`,
            `productId=${maskValue(productId)}`,
            `orderId=${maskValue(orderId)}`,
            `purchaseToken=${maskValue(purchaseToken)}`,
        ].join(", ")
    );

    let finalOutcome = "CONFIRM_FAILED";

    try {
        const verification = await verifyRustorePurchase({
            userId,
            productId,
            orderId,
            purchaseToken,
            billingTraceId,
        });

        if (!verification.ok) {
            finalOutcome = verification.error || "VERIFICATION_FAILED";

            return {
                ok: false,
                error: verification.error || "verification_failed",
            };
        }

        const subscription = await upsertSubscriptionFromRustore(
            {
                userId,
                productId,
                orderId,
                purchaseToken,
                status: verification.status || "ACTIVE",
                periodEndAt: verification.periodEndAt || null,
            },
            {
                billingTraceId,
            }
        )

        finalOutcome = "UPSERT_OK"

        return {
            ok: true,
            subscription,
        };
    } catch (e) {
        console.error(
            `MID op=confirmRustorePurchase billingTraceId=${billingTraceId} errorClass=${e?.constructor?.name} errorMessage=${e?.message}`,
            e
        );
        throw e;
    } finally {
        logService(
            finalOutcome === "UPSERT_OK" ? "log" : "warn",
            "END",
            "confirmRustorePurchase",
            billingTraceId,
            finalOutcome
        );
    }
}