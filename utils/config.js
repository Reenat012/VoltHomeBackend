// utils/config.js
// Обязательные настройки без «запасных» значений: если секрета нет, сервер не должен стартовать,
// иначе токены можно подделать (раньше подставлялись access_dev_secret и change-me).

/** Значения, которые когда-либо стояли «по умолчанию» в коде. Использовать их как секрет запрещено. */
const FORBIDDEN_SECRETS = new Set(["change-me", "access_dev_secret", "refresh_dev_secret", "very_secret_string"]);

const MIN_SECRET_LENGTH = 16;

function checkSecret(name, value) {
    if (!value) {
        throw new Error(`Не задана обязательная переменная окружения ${name}`);
    }
    // Запасные значения из старого кода и заготовки из env.example (change-me-..., __PUT_LATER__) тоже запрещены
    if (FORBIDDEN_SECRETS.has(value) || /change-me|__put_later__|__заполнить__/i.test(value)) {
        throw new Error(`${name}: нельзя использовать значение по умолчанию`);
    }
    if (value.length < MIN_SECRET_LENGTH) {
        throw new Error(`${name}: секрет короче ${MIN_SECRET_LENGTH} символов`);
    }
    return value;
}

/**
 * Секреты подписи токенов. JWT_ACCESS_SECRET (или старое имя SESSION_JWT_SECRET) и JWT_REFRESH_SECRET.
 * Два секрета должны отличаться: иначе refresh-токен можно было бы использовать как access.
 */
export function getJwtSecrets(env = process.env) {
    const access = checkSecret("JWT_ACCESS_SECRET", env.JWT_ACCESS_SECRET || env.SESSION_JWT_SECRET);
    const refresh = checkSecret("JWT_REFRESH_SECRET", env.JWT_REFRESH_SECRET);
    if (access === refresh) {
        throw new Error("JWT_ACCESS_SECRET и JWT_REFRESH_SECRET должны отличаться");
    }
    return { access, refresh };
}

/** Срок жизни access-токена в минутах (по умолчанию 30). */
export function getAccessTtlMinutes(env = process.env) {
    const min = Number(env.ACCESS_TTL_MIN);
    return Number.isFinite(min) && min > 0 ? Math.floor(min) : 30;
}

/** Срок жизни refresh-сессии в днях (по умолчанию 90, как в контракте). */
export function getRefreshTtlDays(env = process.env) {
    const days = Number(env.REFRESH_TTL_DAYS);
    return Number.isFinite(days) && days > 0 ? Math.floor(days) : 90;
}
