// services/planService.js
// Единое место, где решается «PRO или нет». Источники: действующая подписка RuStore ИЛИ ручная выдача.
// Контракт: docs/SYNC_CONTRACT.md, раздел 5. Имена прав такие же, как в Android (PlanCapabilities).
import { getActiveSubscriptionForUser } from "../models/subscriptions.js";
import { getActiveEntitlementForUser } from "../models/entitlements.js";

export const FREE_PROJECT_LIMIT = Number(process.env.FREE_PROJECT_LIMIT || "3");

export const CAPABILITY_NAMES = [
    "pdfExport",
    "professionalReportSections",
    "phaseDragAndDrop",
    "extendedDeviceEditor",
    "panelVisualization",
    "unlimitedProjects",
    "cableLineCalculation",
    "projectEstimate",
    "existingInputConfiguration",
];

/** Права по плану. Сейчас PRO открывает всё; состав можно менять здесь, не трогая клиентов. */
export function buildCapabilities(plan) {
    const pro = plan === "pro";
    return Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, pro]));
}

export function projectsLimitFor(plan) {
    return plan === "pro" ? null : FREE_PROJECT_LIMIT;
}

const FREE = {
    plan: "free",
    planUntilEpochSeconds: null,
    planSource: "none",
    status: "NONE",
    productId: null,
};

function endMs(date) {
    return date ? new Date(date).getTime() : Infinity; // нет срока = бессрочно
}

/**
 * Определяет план пользователя. Если действуют и подписка, и ручная выдача, берётся та, что дольше;
 * при равенстве приоритет у подписки.
 */
export async function resolvePlan(userId, context = {}) {
    const [sub, ent] = await Promise.all([
        getActiveSubscriptionForUser(userId, context),
        getActiveEntitlementForUser(userId),
    ]);
    if (!sub && !ent) return { ...FREE };

    const useManual = ent && (!sub || endMs(ent.valid_until) > endMs(sub.period_end_at));
    const winner = useManual ? ent.valid_until : sub.period_end_at;
    return {
        plan: "pro",
        planUntilEpochSeconds: winner ? Math.floor(new Date(winner).getTime() / 1000) : null,
        planSource: useManual ? "manual" : "rustore",
        status: useManual ? "MANUAL" : sub.status,
        productId: useManual ? null : sub.product_id ?? null,
    };
}
