// utils/jwt.js
// Единое место подписи и проверки токенов. Секреты обязательны (см. utils/config.js).
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { getJwtSecrets, getAccessTtlMinutes } from "./config.js";
import { isAccountDeleted } from "../models/accounts.js";

const { access: ACCESS_SECRET, refresh: REFRESH_SECRET } = getJwtSecrets();

export const ACCESS_TTL_MIN = getAccessTtlMinutes();

/** Подписать access-токен сессии. */
export function signToken(payload) {
    return jwt.sign(payload, ACCESS_SECRET, { expiresIn: `${ACCESS_TTL_MIN}m`, algorithm: "HS256" });
}

/** Проверить access-токен и вернуть payload (или бросить исключение). */
export function verifyToken(token) {
    return jwt.verify(token, ACCESS_SECRET, { algorithms: ["HS256"] });
}

/**
 * Refresh-токен. `jti` делает каждый токен уникальным: без него два токена одного пользователя,
 * выпущенные в одну секунду, совпали бы, и хэш в базе тоже.
 */
export function signRefreshToken(uid) {
    return jwt.sign({ uid, typ: "refresh", jti: randomUUID() }, REFRESH_SECRET, {
        algorithm: "HS256",
        expiresIn: "90d",
    });
}

/** Проверить refresh-токен. Бросает исключение, если подпись неверна или тип не refresh. */
export function verifyRefreshToken(token) {
    const decoded = jwt.verify(token, REFRESH_SECRET, { algorithms: ["HS256"] });
    if (decoded?.typ !== "refresh") throw new Error("wrong_type");
    return decoded;
}

/** Express-middleware: требует валидный Bearer <JWT> от существующего (не удалённого) аккаунта */
export async function authMiddleware(req, res, next) {
    const h = req.header("Authorization") || "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return res.status(401).json({ error: "no_token" });
    let user;
    try {
        user = verifyToken(m[1]);
        if (!user?.uid || typeof user.uid !== "string") throw new Error("no_uid");
    } catch {
        return res.status(401).json({ error: "invalid_token" });
    }
    try {
        // Токен выдан до удаления аккаунта: он ещё не истёк, но больше не действует
        if (await isAccountDeleted(user.uid)) return res.status(401).json({ error: "account_deleted" });
    } catch (e) {
        console.error("[auth] проверка удалённого аккаунта не удалась:", e?.message || e);
        return res.status(503).json({ error: "server_unavailable" });
    }
    req.user = user;
    next();
}
