// utils/jwt.js
import jwt from "jsonwebtoken";

/**
 * Унифицированные секреты и TTL
 * - Подпись/проверка access-JWT выполняется ОДНИМ секретом:
 *   сначала JWT_ACCESS_SECRET, иначе fallback к SESSION_JWT_SECRET.
 * - TTL берём из ACCESS_TTL_MIN (в минутах), иначе из SESSION_JWT_TTL (например, "3600s").
 */
const ACCESS_SECRET =
    process.env.JWT_ACCESS_SECRET ||
    process.env.SESSION_JWT_SECRET || // fallback для совместимости
    "change-me";

// ACCESS_TTL_MIN имеет приоритет (минуты). Иначе используем строковый TTL из старой переменной.
function resolveTtl() {
    const min = Number(process.env.ACCESS_TTL_MIN);
    if (Number.isFinite(min) && min > 0) {
        return `${Math.floor(min)}m`;
    }
    return process.env.SESSION_JWT_TTL || "3600s";
}

const TTL = resolveTtl();

/** Подписать новый JWT для клиентской сессии */
export function signToken(payload) {
    // Явно укажем алгоритм для предсказуемости
    return jwt.sign(payload, ACCESS_SECRET, { expiresIn: TTL, algorithm: "HS256" });
}

/** Проверить JWT и вернуть payload (или кинуть исключение) */
export function verifyToken(token) {
    return jwt.verify(token, ACCESS_SECRET);
}

/** Проверить JWT, игнорируя истечение (нужно только для refresh-ручки) */
export function verifyTokenAllowExpired(token) {
    return jwt.verify(token, ACCESS_SECRET, { ignoreExpiration: true });
}

/** Express-middleware: требует валидный Bearer <JWT> */
export function authMiddleware(req, res, next) {
    const h = req.header("Authorization") || "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return res.status(401).json({ error: "no_token" });
    try {
        req.user = verifyToken(m[1]);
        next();
    } catch {
        return res.status(401).json({ error: "invalid_token" });
    }
}