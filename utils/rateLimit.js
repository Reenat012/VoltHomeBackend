// utils/rateLimit.js
// Простой in-memory rate limit по ключу uid+route (подойдёт для одного инстанса)
const buckets = new Map();

function key(uid, name) {
    return `${uid}|${name}`;
}

/**
 * tokenBucket — допускает N запросов в минуту.
 */
export function tokenBucket({ limitPerMin, name }) {
    return (req, res, next) => {
        const uid = req.user?.uid || "anonymous";
        const k = key(uid, name);
        const now = Date.now();
        const minute = 60_000;
        const b = buckets.get(k) || { tokens: limitPerMin, ts: now };

        // пополняем
        const elapsed = now - b.ts;
        if (elapsed > minute) {
            b.tokens = limitPerMin;
            b.ts = now;
        }
        if (b.tokens <= 0) {
            return res.status(429).json({ error: "rate_limited", message: "Too many requests" });
        }
        b.tokens -= 1;
        buckets.set(k, b);
        next();
    };
}