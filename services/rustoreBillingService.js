// services/rustoreBillingService.js
// Сервис для работы с RuStore: реальная verify-интеграция + compatibility mode.
//
// Commit 4A:
// - вводим compatibility mode;
// - real verify transport включается флагом BILLING_REAL_VERIFY_ENABLED;
// - strict mismatch enforcement пока не включаем;
// - старый stub оставляем только как fallback-режим;
// - используем keyId + privateKey для получения Public-Token;
// - verify подписки идёт через Public API V4.

import crypto from "crypto";
import { upsertSubscriptionFromRustore } from "../models/subscriptions.js";

const {
    // Новый режим Commit 4A
    BILLING_REAL_VERIFY_ENABLED = "false",
    BILLING_STRICT_CONFIRM_VALIDATION_ENABLED = "false",

    // Старый dev fallback оставляем, но он больше не главный переключатель
    RUSTORE_VERIFY_STUB = "true",

    // Реальные параметры RuStore API
    RUSTORE_KEY_ID,
    RUSTORE_PRIVATE_KEY,
    RUSTORE_CONSOLE_APP_ID,
    RUSTORE_PACKAGE_NAME = "ru.mugalimov.volthome",

    // Отдельный флаг sandbox, чтобы не зашивать среду намертво
    RUSTORE_USE_SANDBOX = "false",
} = process.env;

const RUSTORE_PUBLIC_API_BASE = "https://public-api.rustore.ru";

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

function isRealVerifyEnabled() {
    return BILLING_REAL_VERIFY_ENABLED === "true";
}

function isStrictConfirmValidationEnabled() {
    return BILLING_STRICT_CONFIRM_VALIDATION_ENABLED === "true";
}

function isSandboxMode() {
    return RUSTORE_USE_SANDBOX === "true";
}

function isStubMode() {
    return RUSTORE_VERIFY_STUB === "true";
}

function requireRustoreVerifyConfig() {
    const missing = [];

    if (!RUSTORE_KEY_ID) missing.push("RUSTORE_KEY_ID");
    if (!RUSTORE_PRIVATE_KEY) missing.push("RUSTORE_PRIVATE_KEY");
    if (!RUSTORE_CONSOLE_APP_ID) missing.push("RUSTORE_CONSOLE_APP_ID");
    if (!RUSTORE_PACKAGE_NAME) missing.push("RUSTORE_PACKAGE_NAME");

    if (missing.length > 0) {
        const err = new Error(`RuStore verify config is missing: ${missing.join(", ")}`);
        err.code = "RUSTORE_CONFIG_MISSING";
        throw err;
    }
}

/**
 * Нормализуем приватный ключ из .env:
 * - срезаем внешние кавычки;
 * - восстанавливаем \n;
 * - если пришёл голый base64 PKCS8 — заворачиваем в PEM.
 */
function normalizePrivateKey(raw) {
    if (!raw) return raw;

    let value = String(raw).trim();

    // Убираем внешние кавычки, если они есть.
    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
    ) {
        value = value.slice(1, -1);
    }

    // Восстанавливаем переносы строк, если ключ записан в одну строку.
    value = value.replace(/\\n/g, "\n");

    // Если это уже PEM — возвращаем как есть.
    if (value.includes("BEGIN PRIVATE KEY") || value.includes("BEGIN RSA PRIVATE KEY")) {
        return value;
    }

    // Если это голый base64 — собираем PEM.
    return [
        "-----BEGIN PRIVATE KEY-----",
        value.match(/.{1,64}/g)?.join("\n") ?? value,
        "-----END PRIVATE KEY-----",
    ].join("\n");
}

/**
 * Временная метка для RuStore auth.
 */
function makeRustoreTimestamp() {
    return new Date().toISOString();
}

/**
 * Подпись auth payload для получения Public-Token.
 *
 * ВАЖНО:
 * - сейчас используем рабочую гипотезу: подписываем строку keyId + timestamp;
 * - если RuStore вернёт Signature encode error / auth failed,
 *   будем корректировать именно этот участок, а не ломать остальную интеграцию.
 */
function signRustoreAuthPayload({ keyId, timestamp, privateKeyPem }) {
    const signer = crypto.createSign("RSA-SHA512");
    signer.update(`${keyId}${timestamp}`, "utf8");
    signer.end();

    return signer.sign(privateKeyPem, "base64");
}

/**
 * Получение Public-Token для вызова Public API RuStore.
 */
async function getRustorePublicToken({ billingTraceId }) {
    requireRustoreVerifyConfig();

    const privateKeyPem = normalizePrivateKey(RUSTORE_PRIVATE_KEY);
    const timestamp = makeRustoreTimestamp();
    const signature = signRustoreAuthPayload({
        keyId: RUSTORE_KEY_ID,
        timestamp,
        privateKeyPem,
    });

    logService(
        "log",
        "MID",
        "getRustorePublicToken",
        billingTraceId,
        "AUTH_REQUEST",
        [
            `keyId=${maskValue(RUSTORE_KEY_ID)}`,
            `consoleAppId=${maskValue(RUSTORE_CONSOLE_APP_ID)}`,
            `timestamp=${timestamp}`,
        ].join(", ")
    );

    const response = await fetch(`${RUSTORE_PUBLIC_API_BASE}/public/auth`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            keyId: String(RUSTORE_KEY_ID),
            timestamp,
            signature,
        }),
    });

    const rawText = await response.text();

    let json = null;
    try {
        json = rawText ? JSON.parse(rawText) : null;
    } catch {
        json = null;
    }

    logService(
        response.ok ? "log" : "warn",
        "MID",
        "getRustorePublicToken",
        billingTraceId,
        response.ok ? "AUTH_HTTP_OK" : "AUTH_HTTP_NOT_OK",
        `status=${response.status}, code=${json?.code ?? "null"}, message=${json?.message ?? rawText ?? "null"}`
    );

    if (!response.ok || json?.code !== "OK" || !json?.body?.jwe) {
        const err = new Error(
            `RuStore auth failed: status=${response.status}, code=${json?.code ?? "null"}, message=${json?.message ?? rawText ?? "null"}`
        );
        err.code = "RUSTORE_AUTH_FAILED";
        err.httpStatus = response.status;
        throw err;
    }

    return json.body.jwe;
}

/**
 * Собираем URL verify подписки V4.
 */
function buildRustoreSubscriptionVerifyUrl({ subscriptionId, purchaseId }) {
    const prefix = isSandboxMode()
        ? "/public/sandbox/v4/subscription"
        : "/public/v4/subscription";

    return `${RUSTORE_PUBLIC_API_BASE}${prefix}/${encodeURIComponent(RUSTORE_PACKAGE_NAME)}/${encodeURIComponent(subscriptionId)}/${encodeURIComponent(purchaseId)}`;
}

/**
 * Универсальный HTTP-вызов RuStore JSON API.
 */
async function callRustoreJson({
                                   url,
                                   publicToken,
                                   method = "GET",
                                   billingTraceId,
                               }) {
    const response = await fetch(url, {
        method,
        headers: {
            "Content-Type": "application/json",
            "Public-Token": publicToken,
        },
    });

    const rawText = await response.text();

    let json = null;
    try {
        json = rawText ? JSON.parse(rawText) : null;
    } catch {
        json = null;
    }

    logService(
        response.ok ? "log" : "warn",
        "MID",
        "callRustoreJson",
        billingTraceId,
        response.ok ? "HTTP_OK" : "HTTP_NOT_OK",
        `status=${response.status}, code=${json?.code ?? "null"}, message=${json?.message ?? rawText ?? "null"}`
    );

    return {
        httpStatus: response.status,
        ok: response.ok,
        json,
        rawText,
    };
}

/**
 * Маппинг статуса подписки RuStore V4 в нашу доменную модель.
 */
function mapRustoreSubscriptionStatus(v4Body) {
    const expiryMs = Number(v4Body?.expiryTimeMillis ?? 0);
    const paymentState = v4Body?.paymentState;
    const acknowledgementState = v4Body?.acknowledgementState;
    const nowMs = Date.now();

    if (!expiryMs || Number.isNaN(expiryMs)) {
        return {
            status: acknowledgementState === 0 ? "PENDING" : "ACTIVE",
            periodEndAt: null,
            acknowledgementState,
        };
    }

    const periodEndAt = new Date(expiryMs);

    if (expiryMs <= nowMs) {
        return {
            status: "EXPIRED",
            periodEndAt,
            acknowledgementState,
        };
    }

    if (paymentState === 0 || acknowledgementState === 0) {
        return {
            status: "PENDING",
            periodEndAt,
            acknowledgementState,
        };
    }

    return {
        status: "ACTIVE",
        periodEndAt,
        acknowledgementState,
    };
}

/**
 * Верификация покупки в RuStore.
 *
 * Commit 4A:
 * - если BILLING_REAL_VERIFY_ENABLED=false и RUSTORE_VERIFY_STUB=true → fallback stub;
 * - если BILLING_REAL_VERIFY_ENABLED=true → идём в реальный verify transport;
 * - mismatch пока только логируем, а не рубим жёстко, пока strict=false.
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
            `realVerify=${BILLING_REAL_VERIFY_ENABLED}`,
            `strictValidation=${BILLING_STRICT_CONFIRM_VALIDATION_ENABLED}`,
            `stubMode=${RUSTORE_VERIFY_STUB}`,
            `sandboxMode=${RUSTORE_USE_SANDBOX}`,
            `userId=${maskValue(userId)}`,
            `productId=${maskValue(productId)}`,
            `orderId=${maskValue(orderId)}`,
            `purchaseToken=${maskValue(purchaseToken)}`,
        ].join(", ")
    );

    let finalOutcome = "VERIFY_FAILED";

    try {
        // Fallback-режим: оставляем только как совместимую аварийную ветку.
        if (!isRealVerifyEnabled()) {
            if (isStubMode()) {
                const now = new Date();
                const periodEndAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

                finalOutcome = "VERIFY_STUB_OK";

                return {
                    ok: true,
                    verificationSource: "stub",
                    status: "ACTIVE",
                    periodEndAt,
                    rustoreResponseCode: "STUB_OK",
                    mismatch: null,
                };
            }

            finalOutcome = "VERIFY_DISABLED";

            return {
                ok: false,
                error: "real_verify_disabled",
                httpStatus: 503,
            };
        }

        const publicToken = await getRustorePublicToken({ billingTraceId });

        const url = buildRustoreSubscriptionVerifyUrl({
            subscriptionId: productId,
            purchaseId: purchaseToken,
        });

        logService(
            "log",
            "MID",
            "verifyRustorePurchase",
            billingTraceId,
            "VERIFY_REQUEST",
            `url=${url}`
        );

        const apiResult = await callRustoreJson({
            url,
            publicToken,
            method: "GET",
            billingTraceId,
        });

        if (!apiResult.ok || !apiResult.json) {
            finalOutcome = "VERIFY_HTTP_FAILED";

            return {
                ok: false,
                error: "rustore_verify_http_failed",
                httpStatus: apiResult.httpStatus || 502,
                rustoreMessage: apiResult.json?.message ?? apiResult.rawText ?? null,
            };
        }

        const rustoreCode = apiResult.json?.code;
        const rustoreBody = apiResult.json?.body ?? null;

        if (rustoreCode !== "OK" || !rustoreBody) {
            finalOutcome = "VERIFY_API_NOT_OK";

            return {
                ok: false,
                error: "rustore_verify_not_ok",
                httpStatus: 502,
                rustoreResponseCode: rustoreCode ?? "UNKNOWN",
                rustoreMessage: apiResult.json?.message ?? null,
            };
        }

        const mapped = mapRustoreSubscriptionStatus(rustoreBody);

        // compatibility mode:
        // mismatch пока только логируем.
        const mismatches = [];

        if (rustoreBody.orderId && orderId && rustoreBody.orderId !== orderId) {
            mismatches.push("ORDER_ID_MISMATCH");
        }

        if (
            rustoreBody.productId &&
            productId &&
            rustoreBody.productId !== productId
        ) {
            mismatches.push("PRODUCT_ID_MISMATCH");
        }

        if (
            rustoreBody.packageName &&
            RUSTORE_PACKAGE_NAME &&
            rustoreBody.packageName !== RUSTORE_PACKAGE_NAME
        ) {
            mismatches.push("PACKAGE_NAME_MISMATCH");
        }

        const mismatch = mismatches.length > 0 ? mismatches.join(",") : null;

        if (mismatch) {
            logService(
                isStrictConfirmValidationEnabled() ? "warn" : "log",
                "MID",
                "verifyRustorePurchase",
                billingTraceId,
                "VERIFY_MISMATCH",
                [
                    `mismatch=${mismatch}`,
                    `rustoreOrderId=${maskValue(rustoreBody.orderId)}`,
                    `clientOrderId=${maskValue(orderId)}`,
                    `rustoreProductId=${maskValue(rustoreBody.productId)}`,
                    `clientProductId=${maskValue(productId)}`,
                    `rustorePackageName=${rustoreBody.packageName ?? "null"}`,
                    `clientPackageName=${RUSTORE_PACKAGE_NAME}`,
                ].join(", ")
            );

            if (isStrictConfirmValidationEnabled()) {
                finalOutcome = "VERIFY_STRICT_MISMATCH";

                return {
                    ok: false,
                    error: "rustore_verify_mismatch",
                    httpStatus: 409,
                    rustoreResponseCode: rustoreCode,
                    mismatch,
                };
            }
        }

        finalOutcome = "VERIFY_REAL_OK";

        return {
            ok: true,
            verificationSource: "rustore_v4",
            status: mapped.status,
            periodEndAt: mapped.periodEndAt,
            rustoreResponseCode: rustoreCode,
            mismatch,
            raw: rustoreBody,
        };
    } finally {
        logService(
            finalOutcome === "VERIFY_STUB_OK" || finalOutcome === "VERIFY_REAL_OK"
                ? "log"
                : "warn",
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
                httpStatus: verification.httpStatus ?? 502,
                rustoreResponseCode: verification.rustoreResponseCode ?? null,
                rustoreMessage: verification.rustoreMessage ?? null,
                mismatch: verification.mismatch ?? null,
            };
        }

        logService(
            "log",
            "MID",
            "confirmRustorePurchase",
            billingTraceId,
            "VERIFY_PASSED",
            [
                `verificationSource=${verification.verificationSource ?? "unknown"}`,
                `status=${verification.status ?? "null"}`,
                `periodEndAt=${verification.periodEndAt ? verification.periodEndAt.toISOString() : "null"}`,
                `mismatch=${verification.mismatch ?? "null"}`,
            ].join(", ")
        );

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
        );

        finalOutcome = "UPSERT_OK";

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