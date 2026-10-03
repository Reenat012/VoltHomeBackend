// tests/entitlements.test.js
// Ручная выдача PRO и единое решение «PRO или нет» (docs/SYNC_CONTRACT.md, раздел 5).
import request from "supertest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { getApp, authHeader, closeDb, truncateAll } from "./helpers.js";
import { pool } from "../db/pool.js";
import { findOrCreateByIdentity } from "../models/users.js";
import { grantPro, revokePro, listGrants, findUsers, parseUntil, AdminError } from "../services/adminService.js";

const run = promisify(execFile);
let app;

beforeAll(async () => {
    app = await getApp();
});
beforeEach(async () => {
    await truncateAll();
});
afterAll(async () => {
    await closeDb();
});

async function makeUser(externalId = "1001", email = "anna@example.com") {
    const { user } = await findOrCreateByIdentity({
        provider: "yandex",
        externalId,
        profile: { displayName: "Анна", email },
    });
    return user.uid;
}

const profile = async (uid) => (await request(app).get("/v1/profile/me").set(authHeader(uid)).expect(200)).body;

async function addSubscription(uid, periodEnd, status = "ACTIVE") {
    await pool.query(
        `INSERT INTO subscriptions (user_id, product_id, order_id, purchase_token, purchase_token_hash, status, period_end_at)
         VALUES ($1, 'volthome.pro.monthly', $2, 't', $3, $4, $5)`,
        [uid, `order-${randomUUID()}`, `hash-${randomUUID()}`, status, periodEnd]
    );
}

const inDays = (n) => new Date(Date.now() + n * 86400_000);

describe("Ручная выдача PRO", () => {
    test("бессрочная выдача открывает PRO: права, лимит проектов снят", async () => {
        const uid = await makeUser();
        await grantPro({ uid, note: "тест" });
        const me = await profile(uid);
        expect(me.plan).toBe("pro");
        expect(me.planSource).toBe("manual");
        expect(me.planUntilEpochSeconds).toBeNull();
        expect(me.projectsLimit).toBeNull();
        expect(Object.values(me.capabilities).every(Boolean)).toBe(true);

        for (let i = 0; i < 4; i++) {
            await request(app).post("/v1/projects").set(authHeader(uid)).send({ name: `П${i}` }).expect(201);
        }
    });

    test("выдача до даты: срок виден клиенту", async () => {
        const uid = await makeUser();
        const until = inDays(10);
        await grantPro({ uid, until: until.toISOString() });
        const me = await profile(uid);
        expect(me.plan).toBe("pro");
        expect(Math.abs(me.planUntilEpochSeconds - Math.floor(until.getTime() / 1000))).toBeLessThanOrEqual(1);
    });

    test("истёкшая выдача больше не действует", async () => {
        const uid = await makeUser();
        await pool.query(
            `INSERT INTO entitlements (user_id, valid_until, granted_by) VALUES ($1, now() - interval '1 day', 'cli')`,
            [uid]
        );
        expect((await profile(uid)).plan).toBe("free");
    });

    test("отзыв возвращает бесплатный план и лимит 3", async () => {
        const uid = await makeUser();
        await grantPro({ uid });
        expect(await revokePro({ uid })).toBe(1);
        const me = await profile(uid);
        expect(me.plan).toBe("free");
        expect(me.projectsLimit).toBe(3);
        expect(await revokePro({ uid })).toBe(0);
    });

    test("выдача одному не открывает PRO другому", async () => {
        const a = await makeUser("1", "a@example.com");
        const b = await makeUser("2", "b@example.com");
        await grantPro({ uid: a });
        expect((await profile(b)).plan).toBe("free");
    });

    test("клиент не может выдать PRO себе через профиль", async () => {
        const uid = await makeUser();
        await request(app).put("/v1/profile/me").set(authHeader(uid)).send({ plan: "pro" }).expect(200);
        expect((await profile(uid)).plan).toBe("free");
    });

    test("действие записывается в журнал", async () => {
        const uid = await makeUser();
        await grantPro({ uid, note: "по просьбе", grantedBy: "cli" });
        await revokePro({ uid });
        const { rows } = await pool.query(`SELECT action, detail FROM audit_log ORDER BY id`);
        expect(rows.map((r) => r.action)).toEqual(["grant_pro", "revoke_pro"]);
        expect(rows[0].detail.uid).toBe(uid);
    });

    test("список выдач: все и только действующие", async () => {
        const uid = await makeUser();
        await grantPro({ uid });
        await revokePro({ uid });
        await grantPro({ uid, until: inDays(5).toISOString() });
        expect(await listGrants({ uid })).toHaveLength(2);
        expect(await listGrants({ uid, activeOnly: true })).toHaveLength(1);
    });
});

describe("Проверки команд", () => {
    test("неизвестный пользователь: ошибка с подсказкой", async () => {
        await expect(grantPro({ uid: "u_нет-такого" })).rejects.toThrow(AdminError);
        await expect(grantPro({ uid: "u_нет-такого" })).rejects.toThrow(/хотя бы раз войти/);
    });

    test("дата в прошлом и неверная дата отклоняются", async () => {
        const uid = await makeUser();
        await expect(grantPro({ uid, until: "2020-01-01" })).rejects.toThrow(/уже прошла/);
        await expect(grantPro({ uid, until: "завтра" })).rejects.toThrow(/Неверная дата/);
        expect(await listGrants({ uid })).toHaveLength(0);
    });

    test("parseUntil: пусто и forever = бессрочно, дата без времени = конец дня UTC", () => {
        expect(parseUntil(undefined)).toBeNull();
        expect(parseUntil("forever")).toBeNull();
        const d = parseUntil("2099-03-04");
        expect(d.toISOString()).toBe("2099-03-04T23:59:59.000Z");
    });

    test("поиск пользователя по почте, uid и идентификатору Яндекса", async () => {
        const uid = await makeUser("555", "Search@Example.com");
        expect((await findUsers({ email: "search@example" }))[0].uid).toBe(uid);
        expect((await findUsers({ uid }))[0].email).toBe("Search@Example.com");
        const byYandex = await findUsers({ externalId: "555" });
        expect(byYandex[0].identities).toEqual([{ provider: "yandex", external_id: "555" }]);
        expect(await findUsers({ email: "нет@такого" })).toEqual([]);
        await expect(findUsers({})).rejects.toThrow(AdminError);
    });
});

describe("Подписка RuStore и ручная выдача вместе", () => {
    test("действующая подписка даёт PRO с источником rustore", async () => {
        const uid = await makeUser();
        await addSubscription(uid, inDays(20));
        const me = await profile(uid);
        expect(me.plan).toBe("pro");
        expect(me.planSource).toBe("rustore");
    });

    test("просроченная подписка PRO не даёт", async () => {
        const uid = await makeUser();
        await addSubscription(uid, inDays(-1));
        expect((await profile(uid)).plan).toBe("free");
    });

    test("если ручная выдача дольше подписки, источник manual", async () => {
        const uid = await makeUser();
        await addSubscription(uid, inDays(5));
        await grantPro({ uid, until: inDays(60).toISOString() });
        const me = await profile(uid);
        expect(me.planSource).toBe("manual");
        expect(Math.abs(me.planUntilEpochSeconds - Math.floor(inDays(60).getTime() / 1000))).toBeLessThanOrEqual(2);
    });

    test("если подписка дольше ручной выдачи, источник rustore", async () => {
        const uid = await makeUser();
        await addSubscription(uid, inDays(60));
        await grantPro({ uid, until: inDays(5).toISOString() });
        expect((await profile(uid)).planSource).toBe("rustore");
    });

    test("бессрочная выдача дольше любой подписки", async () => {
        const uid = await makeUser();
        await addSubscription(uid, inDays(365));
        await grantPro({ uid });
        const me = await profile(uid);
        expect(me.planSource).toBe("manual");
        expect(me.planUntilEpochSeconds).toBeNull();
    });

    test("GET /v1/billing/status показывает ручную выдачу", async () => {
        const uid = await makeUser();
        await grantPro({ uid });
        const res = await request(app).get("/v1/billing/status").set(authHeader(uid)).expect(200);
        expect(res.body).toMatchObject({ plan: "pro", status: "MANUAL", planSource: "manual", productId: null });
    });

    test("без выдач и подписок billing/status: free и NONE", async () => {
        const uid = await makeUser();
        const res = await request(app).get("/v1/billing/status").set(authHeader(uid)).expect(200);
        expect(res.body).toMatchObject({ plan: "free", status: "NONE", planSource: "none" });
    });
});

describe("Консольный скрипт scripts/admin.js", () => {
    const env = { ...process.env, NODE_ENV: "test", DOTENV_CONFIG_PATH: ".env.test" };
    const cli = (...args) => run("node", ["scripts/admin.js", ...args], { env, cwd: process.cwd() });

    test("grant-pro, list-grants, revoke-pro работают из консоли", async () => {
        const uid = await makeUser();
        const granted = await cli("grant-pro", "--uid", uid, "--until", "2099-12-31", "--note", "консоль");
        expect(granted.stdout).toContain("PRO выдан");
        expect((await profile(uid)).plan).toBe("pro");

        const list = await cli("list-grants", "--uid", uid, "--active");
        expect(list.stdout).toContain(uid);
        expect(list.stdout).toContain("действует");

        const revoked = await cli("revoke-pro", "--uid", uid);
        expect(revoked.stdout).toContain("Отозвано выдач: 1");
        expect((await profile(uid)).plan).toBe("free");
    });

    test("find-user находит по почте", async () => {
        const uid = await makeUser("9", "cli@example.com");
        const res = await cli("find-user", "--email", "cli@example");
        expect(res.stdout).toContain(uid);
    });

    test("ошибка команды: ненулевой код выхода и понятное сообщение", async () => {
        await expect(cli("grant-pro", "--uid", "u_нет")).rejects.toMatchObject({
            code: 1,
            stderr: expect.stringContaining("Пользователь не найден"),
        });
        await expect(cli("неизвестная")).rejects.toMatchObject({ code: 1 });
    });
});
