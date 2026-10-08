// tests/account.test.js
// Удаление аккаунта и данных, блокировка токенов удалённого аккаунта, CORS для сайта.
// Контракт: docs/SYNC_CONTRACT.md, разделы 4 и 5.
import request from "supertest";
import { randomUUID } from "node:crypto";
import { makeApp, fakeYandex, closeDb, truncateAll } from "./helpers.js";
import { pool } from "../db/pool.js";
import { resetRateLimits } from "../utils/rateLimit.js";
import { grantPro } from "../services/adminService.js";

const yandex = fakeYandex({
    "token-anna": { externalId: "1001", profile: { displayName: "Анна", email: "anna@example.com" } },
    "token-boris": { externalId: "1002", profile: { displayName: "Борис" } },
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

const login = async (token) => (await request(app).post("/v1/auth/yandex/exchange").send({ yaAccessToken: token }).expect(200)).body;
const bearer = (s) => ({ Authorization: `Bearer ${s.sessionJwt}` });
const del = (s, body = { confirm: true }) => request(app).post("/v1/profile/delete").set(bearer(s)).send(body);
const count = async (sql, params = []) => (await pool.query(sql, params)).rows[0].n;

async function fillAccount(s) {
    const project = (await request(app).post("/v1/projects").set(bearer(s)).send({ name: "Квартира" }).expect(201)).body;
    const room = randomUUID();
    await request(app)
        .post(`/v1/projects/${project.id}/batch`)
        .set(bearer(s))
        .send({
            ops: {
                rooms: { upsert: [{ id: room, name: "Кухня" }], delete: [] },
                devices: { upsert: [{ name: "Чайник", meta: { room_id: room, power: 2000 } }], delete: [] },
            },
        })
        .expect(200);
    await grantPro({ uid: s.uid });
    await request(app)
        .put(`/v1/projects/${project.id}/documents/panel_layout`)
        .set(bearer(s))
        .send({ baseVersion: 0, schemaVersion: 3, data: { schemaVersion: 3, rails: [] } })
        .expect(200);
    await request(app)
        .put(`/v1/projects/${project.id}/documents/panel_layout`)
        .set(bearer(s))
        .send({ baseVersion: 1, schemaVersion: 3, data: { schemaVersion: 3, rails: [1] } })
        .expect(200);
    return project;
}

describe("Запрос на удаление", () => {
    test("без токена: 401", async () => {
        await request(app).post("/v1/profile/delete").send({ confirm: true }).expect(401);
    });

    test.each([[{}], [{ confirm: false }], [{ confirm: "true" }], [{ confirm: 1 }], [undefined]])(
        "без явного подтверждения %j аккаунт не удаляется",
        async (body) => {
            const s = await login("token-anna");
            await fillAccount(s);
            const res = await request(app).post("/v1/profile/delete").set(bearer(s)).send(body ?? {});
            expect(res.status).toBe(400);
            expect(res.body.error).toBe("invalid_request");
            expect(await count("SELECT count(*)::int n FROM projects")).toBe(1);
            await request(app).get("/v1/profile/me").set(bearer(s)).expect(200);
        }
    );
});

describe("Что удаляется", () => {
    test("проекты со всем содержимым, документы и история, сессии, выдачи PRO, профиль и вход", async () => {
        const s = await login("token-anna");
        await fillAccount(s);
        expect(await count("SELECT count(*)::int n FROM project_document_versions")).toBe(2);

        const res = await del(s).expect(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.deleted.projects).toBe(1);

        for (const table of [
            "projects", "rooms", "devices", '"groups"', "project_documents", "project_document_versions",
            "refresh_sessions", "entitlements", "identities", "users",
        ]) {
            expect({ table, n: await count(`SELECT count(*)::int n FROM ${table}`) }).toEqual({ table, n: 0 });
        }
    });

    test("данные другого пользователя не затрагиваются", async () => {
        const anna = await login("token-anna");
        const boris = await login("token-boris");
        await fillAccount(anna);
        const borisProject = await fillAccount(boris);
        await del(anna).expect(200);

        expect(await count("SELECT count(*)::int n FROM users")).toBe(1);
        expect(await count("SELECT count(*)::int n FROM projects")).toBe(1);
        const tree = await request(app).get(`/v1/projects/${borisProject.id}`).set(bearer(boris)).expect(200);
        expect(tree.body.rooms).toHaveLength(1);
        await request(app).get(`/v1/projects/${borisProject.id}/documents/panel_layout`).set(bearer(boris)).expect(200);
        expect((await request(app).get("/v1/profile/me").set(bearer(boris)).expect(200)).body.plan).toBe("pro");
    });

    test("сведения о подписке и журнал сохраняются (защита прав сторон)", async () => {
        const s = await login("token-anna");
        await pool.query(
            `INSERT INTO subscriptions (user_id, product_id, order_id, purchase_token, purchase_token_hash, status, period_end_at)
             VALUES ($1, 'volthome.pro.monthly', 'order-1', 't', 'h1', 'ACTIVE', now() + interval '10 days')`,
            [s.uid]
        );
        await del(s).expect(200);
        expect(await count("SELECT count(*)::int n FROM subscriptions WHERE user_id = $1", [s.uid])).toBe(1);
        const { rows } = await pool.query(`SELECT user_id, action, detail FROM audit_log WHERE action = 'delete_account'`);
        expect(rows).toHaveLength(1);
        expect(rows[0].detail.uid).toBe(s.uid);
    });
});

describe("После удаления", () => {
    test("выданные токены перестают работать сразу: 401 account_deleted", async () => {
        const s = await login("token-anna");
        await del(s).expect(200);
        for (const path of ["/v1/profile/me", "/v1/projects", "/v1/billing/status"]) {
            const res = await request(app).get(path).set(bearer(s));
            expect({ path, status: res.status, error: res.body.error }).toEqual({
                path,
                status: 401,
                error: "account_deleted",
            });
        }
        await request(app).post("/v1/projects").set(bearer(s)).send({ name: "Новый" }).expect(401);
    });

    test("повторное удаление тем же токеном: 401", async () => {
        const s = await login("token-anna");
        await del(s).expect(200);
        await del(s).expect(401);
    });

    test("токен обновления больше не работает", async () => {
        const s = await login("token-anna");
        await del(s).expect(200);
        const res = await request(app).post("/v1/auth/session/refresh").send({ refreshId: s.refreshId }).expect(401);
        expect(res.body.error).toBe("invalid_refresh");
    });

    test("новый вход тем же Яндекс-аккаунтом создаёт новый пустой аккаунт", async () => {
        const first = await login("token-anna");
        await fillAccount(first);
        await del(first).expect(200);

        const second = await login("token-anna");
        expect(second.uid).not.toBe(first.uid);
        const me = (await request(app).get("/v1/profile/me").set(bearer(second)).expect(200)).body;
        expect(me).toMatchObject({ plan: "free", projectsLimit: 3 });
        const list = (await request(app).get("/v1/projects").set(bearer(second)).expect(200)).body;
        expect(list.items).toEqual([]);
    });
});

describe("CORS для сайта (X-VoltHome-Client)", () => {
    const preflight = (origin, headers) =>
        request(app)
            .options("/v1/projects")
            .set("Origin", origin)
            .set("Access-Control-Request-Method", "POST")
            .set("Access-Control-Request-Headers", headers);

    test("сайт может отправлять заголовок клиента вместе с авторизацией", async () => {
        const res = await preflight("https://volthome.ru", "authorization,content-type,x-volthome-client").expect(204);
        expect(res.headers["access-control-allow-origin"]).toBe("https://volthome.ru");
        const allowed = res.headers["access-control-allow-headers"].toLowerCase();
        for (const h of ["authorization", "content-type", "x-volthome-client"]) expect(allowed).toContain(h);
        expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    });

    test("чужой сайт: 403 в формате JSON, заголовков разрешения нет", async () => {
        const res = await preflight("https://evil.example", "authorization").expect(403);
        expect(res.body.error).toBe("cors_forbidden");
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    test("обычный запрос с сайта получает разрешающий заголовок", async () => {
        const res = await request(app).get("/health").set("Origin", "https://volthome.ru").expect(200);
        expect(res.headers["access-control-allow-origin"]).toBe("https://volthome.ru");
    });

    test("другие заголовки по-прежнему не разрешены", async () => {
        const res = await preflight("https://volthome.ru", "x-secret-admin").expect(204);
        expect(res.headers["access-control-allow-headers"].toLowerCase()).not.toContain("x-secret-admin");
    });
});
