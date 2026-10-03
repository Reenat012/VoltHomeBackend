// services/yandexAuth.js
// Проверка входа через Яндекс ID. Сервер НЕ доверяет идентификатору пользователя от клиента:
// он получает токен (обменом кода или от клиента), спрашивает у Яндекса, кто это, и берёт id оттуда.
// Контракт: docs/SYNC_CONTRACT.md, раздел 4.

const TOKEN_URL = "https://oauth.yandex.ru/token";
const INFO_URL = "https://login.yandex.ru/info?format=json";
const TIMEOUT_MS = 5000;

export class AuthError extends Error {
    constructor(status, code, message) {
        super(message || code);
        this.status = status;
        this.code = code;
    }
}

function bestName(info) {
    return info?.real_name || info?.display_name || info?.login || null;
}

function avatarUrlFrom(info) {
    const id = info?.default_avatar_id;
    return id ? `https://avatars.yandex.net/get-yapic/${id}/islands-200` : null;
}

async function request(fetchImpl, url, init) {
    try {
        return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
        throw new AuthError(503, "yandex_unavailable", "Яндекс не отвечает");
    }
}

/**
 * Клиент Яндекса. fetchImpl и env можно подменить в тестах.
 * Настройки: YANDEX_CLIENT_ID, YANDEX_CLIENT_SECRET, YANDEX_ALLOWED_REDIRECT_URIS (через запятую).
 */
export function createYandexClient({ fetchImpl = globalThis.fetch, env = process.env } = {}) {
    async function exchangeCode({ code, redirectUri, codeVerifier }) {
        const clientId = env.YANDEX_CLIENT_ID;
        const clientSecret = env.YANDEX_CLIENT_SECRET;
        const allowed = (env.YANDEX_ALLOWED_REDIRECT_URIS || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        if (!clientId || !clientSecret || allowed.length === 0) {
            throw new AuthError(501, "oauth_not_configured", "Вход по коду не настроен на сервере");
        }
        if (typeof redirectUri !== "string" || !allowed.includes(redirectUri)) {
            throw new AuthError(400, "invalid_redirect_uri", "Недопустимый адрес возврата");
        }
        const body = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: clientId,
            client_secret: clientSecret,
        });
        if (codeVerifier) body.set("code_verifier", String(codeVerifier));

        const res = await request(fetchImpl, TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
        });
        if (res.status >= 500) throw new AuthError(503, "yandex_unavailable", "Яндекс недоступен");
        if (!res.ok) throw new AuthError(401, "invalid_code", "Код не принят Яндексом");
        const json = await res.json().catch(() => null);
        if (!json?.access_token) throw new AuthError(401, "invalid_code", "Яндекс не вернул токен");
        return String(json.access_token);
    }

    async function fetchInfo(accessToken) {
        const res = await request(fetchImpl, INFO_URL, {
            headers: { Authorization: `OAuth ${accessToken}` },
        });
        if (res.status >= 500) throw new AuthError(503, "yandex_unavailable", "Яндекс недоступен");
        if (!res.ok) throw new AuthError(401, "invalid_yandex_token", "Токен Яндекса не принят");
        const info = await res.json().catch(() => null);
        if (!info?.id) throw new AuthError(401, "invalid_yandex_token", "Яндекс не вернул пользователя");
        return info;
    }

    /**
     * По коду (веб) или токену (Android) возвращает идентификатор у Яндекса и профиль.
     * @returns {{ externalId: string, profile: { displayName, email, avatarUrl } }}
     */
    async function resolveIdentity({ code, redirectUri, codeVerifier, yaAccessToken }) {
        let token = null;
        if (typeof yaAccessToken === "string" && yaAccessToken) token = yaAccessToken;
        else if (typeof code === "string" && code) token = await exchangeCode({ code, redirectUri, codeVerifier });
        if (!token) throw new AuthError(400, "invalid_request", "Нужен code или yaAccessToken");

        const info = await fetchInfo(token);
        return {
            externalId: String(info.id),
            profile: {
                displayName: bestName(info),
                email: info.default_email ?? null,
                avatarUrl: avatarUrlFrom(info),
            },
        };
    }

    return { resolveIdentity };
}
