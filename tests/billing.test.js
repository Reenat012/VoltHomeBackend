// tests/billing.test.js
// Подтверждение покупки RuStore: заглушка без проверки у RuStore не должна работать в production.
import request from "supertest";
import { getApp, authHeader, closeDb, truncateAll } from "./helpers.js";
import { findOrCreateByIdentity } from "../models/users.js";
import { resolvePlan } from "../services/planService.js";

let app;
const saved = {};
const KEYS = ["NODE_ENV", "RUSTORE_VERIFY_STUB", "BILLING_REAL_VERIFY_ENABLED"];

beforeAll(async () => {
    app = await getApp();
});
beforeEach(async () => {
    await truncateAll();
    for (const k of KEYS) saved[k] = process.env[k];
});
afterEach(() => {
    for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});
afterAll(async () => {
    await closeDb();
});

async function makeUser(externalId) {
    const { user } = await findOrCreateByIdentity({ provider: "yandex", externalId, profile: { displayName: "У" } });
    return user.uid;
}

const confirm = (uid, over = {}) =>
    request(app)
        .post("/v1/billing/rustore/confirm")
        .set(authHeader(uid))
        .send({ productId: "volthome_pro_monthly", orderId: `order-${Math.random()}`, purchaseToken: "tok-1", ...over });

describe("Подтверждение покупки: заглушка", () => {
    test("в production заглушка не работает даже при RUSTORE_VERIFY_STUB=true: PRO не выдаётся", async () => {
        process.env.NODE_ENV = "production";
        process.env.RUSTORE_VERIFY_STUB = "true";
        delete process.env.BILLING_REAL_VERIFY_ENABLED;
        const uid = await makeUser("1");

        const res = await confirm(uid);
        expect(res.status).toBeGreaterThanOrEqual(500);
        expect(res.body.ok).toBe(false);
        expect((await resolvePlan(uid)).plan).toBe("free");
    });

    test("в production без переменных (как на боевом сервере) PRO тоже не выдаётся", async () => {
        process.env.NODE_ENV = "production";
        delete process.env.RUSTORE_VERIFY_STUB;
        delete process.env.BILLING_REAL_VERIFY_ENABLED;
        const uid = await makeUser("2");

        const res = await confirm(uid);
        expect(res.status).toBeGreaterThanOrEqual(500);
        expect((await resolvePlan(uid)).plan).toBe("free");
    });

    test("по умолчанию заглушка выключена и вне production", async () => {
        process.env.NODE_ENV = "test";
        delete process.env.RUSTORE_VERIFY_STUB;
        delete process.env.BILLING_REAL_VERIFY_ENABLED;
        const uid = await makeUser("3");

        const res = await confirm(uid);
        expect(res.status).toBeGreaterThanOrEqual(500);
        expect((await resolvePlan(uid)).plan).toBe("free");
    });

    test("для локальной разработки заглушку можно включить явно (не production)", async () => {
        process.env.NODE_ENV = "test";
        process.env.RUSTORE_VERIFY_STUB = "true";
        delete process.env.BILLING_REAL_VERIFY_ENABLED;
        const uid = await makeUser("4");

        const res = await confirm(uid);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect((await resolvePlan(uid)).plan).toBe("pro");
    });

    test("без входа подтверждать нельзя", async () => {
        await request(app)
            .post("/v1/billing/rustore/confirm")
            .send({ productId: "p", orderId: "o", purchaseToken: "t" })
            .expect(401);
    });

    test("включённая настоящая проверка без ключей RuStore не выдаёт PRO", async () => {
        process.env.NODE_ENV = "production";
        process.env.BILLING_REAL_VERIFY_ENABLED = "true";
        delete process.env.RUSTORE_VERIFY_STUB;
        const uid = await makeUser("5");

        const res = await confirm(uid);
        expect(res.status).toBeGreaterThanOrEqual(500);
        expect((await resolvePlan(uid)).plan).toBe("free");
    });
});
