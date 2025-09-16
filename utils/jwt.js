import jwt from "jsonwebtoken";

const SECRET = process.env.SESSION_JWT_SECRET || "change-me";
const TTL = process.env.SESSION_JWT_TTL || "3600s";

/** Подписать новый JWT для клиентской сессии */
export function signToken(payload) {
    return jwt.sign(payload, SECRET, { expiresIn: TTL });
}

/** Проверить JWT и вернуть payload (или кинуть исключение) */
export function verifyToken(token) {
    return jwt.verify(token, SECRET);
}

/** Express-middleware: требует валидный Bearer <JWT> */
export function authMiddleware(req, res, next) {
    const h = req.header("Authorization") || "";
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) return res.status(401).json({ error: "no_token" });
    try {
        req.user = verifyToken(m[1]);
        next();
    } catch {
        return res.status(401).json({ error: "invalid_token" });
    }
}