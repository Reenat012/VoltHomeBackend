// tests/auth.test.js
// Вход и сессии (docs/SYNC_CONTRACT.md, раздел 4). Яндекс подменяется поддельным клиентом.
import request from "supertest";
import jwt from "jsonwebtoken";
import { makeApp, fakeYandex, closeDb, truncateAll } from "./helpers.js";
import { createYandexClient } from "../services/yandexAuth.js";
import { resetRateLimits } from "../utils/rateLimit.js";
import { query } from "../db/pool.js";

const yandex = fakeYandex({
    "token-anna": { externalId: "1001", profile: { displayName: "Анна", email: "anna@example.com" } },
    "token-boris": { externalId: "1002", profile: { displayName: "Борис" } },
    "token-down": { externalId: "1003", unavailable: true },
});

let app;

beforeAll(async () => {
    app = await makeApp({ yandex, rateLimitPerMin: 1000 });
});
beforeEach(async () => {
    await truncateAll();
    resetRateLimits();
});
afterAll(async () => {
    await closeDb();
});

const exchange = (body, a = app) => request(a).post("/v1/auth/yandex/exchange").send(body);

describe("Вход через Яндекс", () => {
    test("токен Яндекса даёт сессию; uid создаёт сервер", async () => {
        const res = await exchange({ yaAccessToken: "token-anna", platform: "android" }).expect(200);
        expect(res.body.uid).toMatch(/^u_[0-9a-f-]{36}$/);
        expect(res.body.sessionJwt).toBeTruthy();
        expect(res.body.refreshId).toBeTruthy();
        expect(res.body.expiresAtEpochSeconds).toBeGreaterThan(Math.floor(Date.now() / 1000));

        const me = await request(app)
            .get("/v1/profile/me")
            .set({ Authorization: `Bearer ${res.body.sessionJwt}` })
            .expect(200);
        expect(me.body.uid).toBe(res.body.uid);
        expect(me.body.displayName).toBe("Анна");
        expect(me.body.email).toBe("anna@example.com");
    });

    test("тот же человек получает тот же uid, другой человек другой", async () => {
        const a1 = await exchange({ yaAccessToken: "token-anna" }).expect(200);
        const a2 = await exchange({ yaAccessToken: "token-anna" }).expect(200);
        const b = await exchange({ yaAccessToken: "token-boris" }).expect(200);
        expect(a2.body.uid).toBe(a1.body.uid);
        expect(b.body.uid).not.toBe(a1.body.uid);
    });

    test("uid и profile из тела запроса игнорируются", async () => {
        const res = await exchange({
            yaAccessToken: "token-anna",
            uid: "victim",
            profile: { displayName: "Подмена", email: "evil@example.com" },
        }).expect(200);
        expect(res.body.uid).not.toBe("victim");
        const me = await request(app)
            .get("/v1/profile/me")
            .set({ Authorization: `Bearer ${res.body.sessionJwt}` })
            .expect(200);
        expect(me.body.displayName).toBe("Анна");
    });

    test("только uid без токена Яндекса: 400, сессии нет", async () => {
        const res = await exchange({ uid: "victim" }).expect(400);
        expect(res.body.error).toBe("invalid_request");
    });

    test("токен, который Яндекс не знает: 401", async () => {
        const res = await exchange({ yaAccessToken: "левый-токен" }).expect(401);
        expect(res.body.error).toBe("invalid_yandex_token");
        expect(res.body.sessionJwt).toBeUndefined();
    });

    test("Яндекс недоступен: 503", async () => {
        const res = await exchange({ yaAccessToken: "token-down" }).expect(503);
        expect(res.body.error).toBe("yandex_unavailable");
    });

    test.each(["/v1/auth/login", "/v1/auth/refresh", "/v1/auth/logout"])(
        "старая ручка %s удалена",
        async (path) => {
            await request(app).post(path).send({ userId: "victim", refreshToken: "x" }).expect(404);
        }
    );
});

describe("Вход по коду (веб) с настоящим клиентом и подставным fetch", () => {
    const env = {
        YANDEX_CLIENT_ID: "client-id-123",
        YANDEX_CLIENT_SECRET: "client-secret-456",
        YANDEX_ALLOWED_REDIRECT_URIS: "https://volthome.ru/auth/callback.html",
    };

    function stubFetch(calls) {
        return async (url, init) => {
            calls.push({ url: String(url), init });
            if (String(url).includes("oauth.yandex.ru/token")) {
                return { ok: true, status: 200, json: async () => ({ access_token: "ya-token" }) };
            }
            return { ok: true, status: 200, json: async () => ({ id: "777", real_name: "Вера", default_email: "vera@example.com" }) };
        };
    }

    test("код обменивается на токен, секрет не попадает в ответ", async () => {
        const calls = [];
        const web = await makeApp({
            yandex: createYandexClient({ fetchImpl: stubFetch(calls), env }),
            rateLimitPerMin: 1000,
        });
        const res = await exchange(
            { code: "abc", redirectUri: "https://volthome.ru/auth/callback.html", codeVerifier: "ver", platform: "web" },
            web
        ).expect(200);
        expect(res.body.uid).toMatch(/^u_/);
        expect(JSON.stringify(res.body)).not.toContain("client-secret-456");
        const tokenCall = calls.find((c) => c.url.includes("oauth.yandex.ru/token"));
        expect(tokenCall.init.body.get("client_secret")).toBe("client-secret-456");
        expect(tokenCall.init.body.get("code_verifier")).toBe("ver");
        const infoCall = calls.find((c) => c.url.includes("login.yandex.ru/info"));
        expect(infoCall.init.headers.Authorization).toBe("OAuth ya-token");
    });

    test("аватар из профиля Яндекса не сохраняется (в Политике его нет), клиент не может его записать", async () => {
        const withAvatar = async (url) =>
            String(url).includes("oauth.yandex.ru/token")
                ? { ok: true, status: 200, json: async () => ({ access_token: "ya-token" }) }
                : {
                      ok: true,
                      status: 200,
                      json: async () => ({
                          id: "888",
                          real_name: "Глеб",
                          default_email: "gleb@example.com",
                          default_avatar_id: "abc123",
                      }),
                  };
        const web = await makeApp({
            yandex: createYandexClient({ fetchImpl: withAvatar, env }),
            rateLimitPerMin: 1000,
        });
        const res = await exchange(
            { code: "abc", redirectUri: "https://volthome.ru/auth/callback.html", platform: "web" },
            web
        ).expect(200);
        const bearer = { Authorization: `Bearer ${res.body.sessionJwt}` };

        const stored = await query(`SELECT avatar_url FROM users WHERE uid = $1`, [res.body.uid]);
        expect(stored.rows[0].avatar_url).toBeNull();
        expect((await request(web).get("/v1/profile/me").set(bearer).expect(200)).body.avatarUrl).toBeNull();

        const put = await request(web)
            .put("/v1/profile/me")
            .set(bearer)
            .send({ displayName: "Глеб Н.", avatarUrl: "https://tracker.example/pixel.png" })
            .expect(200);
        expect(put.body.profile.avatarUrl).toBeNull();
        expect(put.body.profile.displayName).toBe("Глеб Н.");
        const again = await query(`SELECT avatar_url FROM users WHERE uid = $1`, [res.body.uid]);
        expect(again.rows[0].avatar_url).toBeNull();
    });

    test("чужой адрес возврата отклоняется: 400", async () => {
        const calls = [];
        const web = await makeApp({
            yandex: createYandexClient({ fetchImpl: stubFetch(calls), env }),
            rateLimitPerMin: 1000,
        });
        const res = await exchange({ code: "abc", redirectUri: "https://evil.example/cb" }, web).expect(400);
        expect(res.body.error).toBe("invalid_redirect_uri");
        expect(calls).toHaveLength(0);
    });

    test("вход по коду не настроен на сервере: 501", async () => {
        const web = await makeApp({
            yandex: createYandexClient({ fetchImpl: stubFetch([]), env: {} }),
            rateLimitPerMin: 1000,
        });
        const res = await exchange({ code: "abc", redirectUri: "https://volthome.ru/auth/callback.html" }, web).expect(501);
        expect(res.body.error).toBe("oauth_not_configured");
    });

    test("Яндекс отклонил код: 401", async () => {
        const web = await makeApp({
            yandex: createYandexClient({
                fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({}) }),
                env,
            }),
            rateLimitPerMin: 1000,
        });
        const res = await exchange({ code: "bad", redirectUri: "https://volthome.ru/auth/callback.html" }, web).expect(401);
        expect(res.body.error).toBe("invalid_code");
    });

    test("только uid при настоящем клиенте: до Яндекса даже не доходит", async () => {
        const calls = [];
        const web = await makeApp({
            yandex: createYandexClient({ fetchImpl: stubFetch(calls), env }),
            rateLimitPerMin: 1000,
        });
        await exchange({ uid: "victim" }, web).expect(400);
        expect(calls).toHaveLength(0);
    });
});

describe("Обновление и выход", () => {
    async function login() {
        return (await exchange({ yaAccessToken: "token-anna" }).expect(200)).body;
    }
    const refresh = (refreshId) => request(app).post("/v1/auth/session/refresh").send({ refreshId });

    test("обновление выдаёт новые токены и отзывает старый refresh", async () => {
        const s1 = await login();
        const r = await refresh(s1.refreshId).expect(200);
        expect(r.body.uid).toBe(s1.uid);
        expect(r.body.refreshId).not.toBe(s1.refreshId);
        expect(r.body.sessionJwt).toBeTruthy();
    });

    test("повторное использование старого refresh отзывает все сессии пользователя", async () => {
        const s1 = await login();
        const r = await refresh(s1.refreshId).expect(200);
        const reuse = await refresh(s1.refreshId).expect(401);
        expect(reuse.body.error).toBe("revoked");
        // новый refresh, выданный при ротации, тоже перестал работать
        await refresh(r.body.refreshId).expect(401);
    });

    test("два одновременных обновления: проходит не больше одного", async () => {
        const s1 = await login();
        const [a, b] = await Promise.all([refresh(s1.refreshId), refresh(s1.refreshId)]);
        expect([a.status, b.status].filter((s) => s === 200).length).toBeLessThanOrEqual(1);
    });

    test("мусор вместо refresh: 401; access вместо refresh: 401", async () => {
        const s1 = await login();
        await refresh("garbage").expect(401);
        await refresh(s1.sessionJwt).expect(401);
        await request(app).post("/v1/auth/session/refresh").send({}).expect(400);
    });

    test("после logout refresh не работает", async () => {
        const s1 = await login();
        await request(app).post("/v1/auth/session/logout").send({ refreshId: s1.refreshId }).expect(200);
        await refresh(s1.refreshId).expect(401);
    });

    test("logout_all отзывает все устройства", async () => {
        const s1 = await login();
        const s2 = await login();
        await request(app)
            .post("/v1/auth/logout_all")
            .set({ Authorization: `Bearer ${s1.sessionJwt}` })
            .expect(200);
        await refresh(s1.refreshId).expect(401);
        await refresh(s2.refreshId).expect(401);
    });

    test("два refresh-токена, выпущенных в одну секунду, различаются", async () => {
        const s1 = await login();
        const s2 = await login();
        expect(s2.refreshId).not.toBe(s1.refreshId);
    });
});

describe("Проверка access-токена", () => {
    test("токен, подписанный чужим секретом: 401", async () => {
        const forged = jwt.sign({ uid: "victim" }, "совсем-другой-секрет-для-проверки", { expiresIn: "10m" });
        await request(app).get("/v1/profile/me").set({ Authorization: `Bearer ${forged}` }).expect(401);
    });

    test("refresh-токен нельзя использовать как access", async () => {
        const s = (await exchange({ yaAccessToken: "token-anna" }).expect(200)).body;
        await request(app).get("/v1/profile/me").set({ Authorization: `Bearer ${s.refreshId}` }).expect(401);
    });

    test("токен без uid: 401", async () => {
        const noUid = jwt.sign({ hello: "world" }, process.env.JWT_ACCESS_SECRET, { expiresIn: "10m" });
        await request(app).get("/v1/profile/me").set({ Authorization: `Bearer ${noUid}` }).expect(401);
    });
});

describe("Ограничение частоты входа", () => {
    test("после лимита запросов с одного IP отвечает 429", async () => {
        const limited = await makeApp({ yandex, rateLimitPerMin: 2 });
        await exchange({ yaAccessToken: "token-anna" }, limited).expect(200);
        await exchange({ yaAccessToken: "token-anna" }, limited).expect(200);
        const res = await exchange({ yaAccessToken: "token-anna" }, limited).expect(429);
        expect(res.body.error).toBe("rate_limited");
    });
});

describe("Профиль", () => {
    async function token() {
        return (await exchange({ yaAccessToken: "token-anna" }).expect(200)).body.sessionJwt;
    }

    test("бесплатный пользователь: права выключены, лимит проектов 3", async () => {
        const me = await request(app)
            .get("/v1/profile/me")
            .set({ Authorization: `Bearer ${await token()}` })
            .expect(200);
        expect(me.body.plan).toBe("free");
        expect(me.body.planSource).toBe("none");
        expect(me.body.projectsLimit).toBe(3);
        expect(Object.values(me.body.capabilities).every((v) => v === false)).toBe(true);
        expect(Object.keys(me.body.capabilities).sort()).toEqual(
            [
                "cableLineCalculation", "existingInputConfiguration", "extendedDeviceEditor", "panelVisualization",
                "pdfExport", "phaseDragAndDrop", "professionalReportSections", "projectEstimate", "unlimitedProjects",
            ].sort()
        );
    });

    test("PUT и POST обновляют профиль, поля плана игнорируются", async () => {
        const t = await token();
        const put = await request(app)
            .put("/v1/profile/me")
            .set({ Authorization: `Bearer ${t}` })
            .send({ displayName: "Анна К.", plan: "pro", planUntilEpochSeconds: 9999999999 })
            .expect(200);
        expect(put.body.profile.displayName).toBe("Анна К.");
        await request(app)
            .post("/v1/profile/me")
            .set({ Authorization: `Bearer ${t}` })
            .send({ email: "new@example.com" })
            .expect(200);
        const me = await request(app).get("/v1/profile/me").set({ Authorization: `Bearer ${t}` }).expect(200);
        expect(me.body.displayName).toBe("Анна К.");
        expect(me.body.email).toBe("new@example.com");
        expect(me.body.plan).toBe("free");
    });
});
