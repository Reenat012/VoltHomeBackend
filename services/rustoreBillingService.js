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
 * Верификация покупки в RuStore.
 *
 * На Этапе 1:
 *  - если RUSTORE_VERIFY_STUB === "true" → считаем все покупки валидными на 30 дней;
 *  - иначе бросаем ошибку, чтобы не было "тихого" перехода в прод без реализации.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.productId
 * @param {string} params.orderId
 * @param {string} params.purchaseToken
 * @returns {Promise<{ ok: boolean, status?: string, periodEndAt?: Date, error?: string }>}
 */
export async function verifyRustorePurchase({ userId, productId, orderId, purchaseToken }) {
    if (RUSTORE_VERIFY_STUB === "true") {
        // Dev-режим: эмулируем успешную покупку с периодом 30 дней
        const now = new Date();
        const periodEndAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        return {
            ok: true,
            status: "ACTIVE",
            periodEndAt,
        };
    }

    // TODO: Реализовать реальный вызов RuStore API согласно документации.
    // Здесь намеренно бросаем ошибку, чтобы не было "тихого" использования в проде
    // без корректной интеграции с RuStore.
    throw new Error("verifyRustorePurchase: real RuStore API call is not implemented yet");
}

/**
 * Высокоуровневая операция "подтвердить покупку RuStore и обновить подписку".
 *
 * Этап 1:
 *  - вызывает verifyRustorePurchase (dev-стаб),
 *  - при ok=true делает апсерт в таблицу subscriptions,
 *  - возвращает нормализованный результат (ok, subscription, plan...).
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.productId
 * @param {string} params.orderId
 * @param {string} params.purchaseToken
 * @returns {Promise<{ ok: boolean, subscription?: object, error?: string }>}
 */
export async function confirmRustorePurchase({ userId, productId, orderId, purchaseToken }) {
    const verification = await verifyRustorePurchase({
        userId,
        productId,
        orderId,
        purchaseToken,
    });

    if (!verification.ok) {
        return {
            ok: false,
            error: verification.error || "verification_failed",
        };
    }

    const subscription = await upsertSubscriptionFromRustore({
        userId,
        productId,
        orderId,
        purchaseToken,
        status: verification.status || "ACTIVE",
        periodEndAt: verification.periodEndAt || null,
    });

    return {
        ok: true,
        subscription,
    };
}