// utils/validation.js
import { validate as uuidValidate, version as uuidVersion } from "uuid";

export function isUuidV4(v) {
    return uuidValidate(v) && uuidVersion(v) === 4;
}

export function requiredString(v, maxLen = 256) {
    return typeof v === "string" && v.length > 0 && v.length <= maxLen;
}

export function optionalString(v, maxLen = 2000) {
    return v == null || (typeof v === "string" && v.length <= maxLen);
}

export function isIsoDate(s) {
    if (typeof s !== "string") return false;
    const d = new Date(s);
    return !isNaN(d.getTime());
}

export function parseLimit(q, def = 50, max = 200) {
    const n = Number(q);
    if (!Number.isFinite(n)) return def;
    return Math.min(Math.max(1, Math.floor(n)), max);
}