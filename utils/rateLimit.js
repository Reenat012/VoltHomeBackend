// utils/rateLimit.js
// Простые in-memory ограничители частоты (подходят для одного экземпляра сервера).
const buckets = new Map();

function take(key, limitPerMin) {
    const now = Date.now();
    const minute = 60_000;
    const b = buckets.get(key) || { tokens: limitPerMin, ts: now };
    if (now - b.ts > minute) {
        b.tokens = limitPerMin;
        b.ts = now;
    }
    if (b.tokens <= 0) {
        buckets.set(key, b);
        return false;
    }
    b.tokens -= 1;
    buckets.set(key, b);
    return true;
}

// Раз в минуту выбрасываем давно не использованные записи, чтобы память не росла
const cleaner = setInterval(() => {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [k, b] of buckets) if (b.ts < cutoff) buckets.delete(k);
}, 60_000);
cleaner.unref();

/** Не более N запросов в минуту на пользователя (uid) и ручку. */
export function tokenBucket({ limitPerMin, name }) {
    return (req, res, next) => {
        const uid = req.user?.uid || "anonymous";
        if (!take(`${uid}|${name}`, limitPerMin)) {
            return res.status(429).json({ error: "rate_limited", message: "Too many requests" });
        }
        next();
    };
}

/** Не более N запросов в минуту с одного IP-адреса (для ручек входа, где пользователь ещё неизвестен). */
export function ipBucket({ limitPerMin, name }) {
    return (req, res, next) => {
        if (!take(`ip:${req.ip}|${name}`, limitPerMin)) {
            return res.status(429).json({ error: "rate_limited", message: "Too many requests" });
        }
        next();
    };
}

/** Только для тестов: сбросить счётчики. */
export function resetRateLimits() {
    buckets.clear();
}
