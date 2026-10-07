// tests/hardening.test.js
// Заголовки безопасности и настройка доверия к прокси.
import request from "supertest";
import { getApp, closeDb } from "./helpers.js";
import { parseTrustProxy } from "../server/app.js";

let app;
beforeAll(async () => {
    app = await getApp();
});
afterAll(async () => {
    await closeDb();
});

describe("Заголовки ответов", () => {
    test("сервер не сообщает, что это Express", async () => {
        const res = await request(app).get("/health").expect(200);
        expect(res.headers["x-powered-by"]).toBeUndefined();
    });

    test("есть HSTS и запрет угадывания типа содержимого", async () => {
        const res = await request(app).get("/health").expect(200);
        expect(res.headers["strict-transport-security"]).toContain("max-age=31536000");
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });

    test("ошибки тоже в JSON и с теми же заголовками", async () => {
        const res = await request(app).get("/v1/projects").expect(401);
        expect(res.headers["content-type"]).toMatch(/application\/json/);
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
        expect(res.headers["x-powered-by"]).toBeUndefined();
    });
});

describe("TRUST_PROXY", () => {
    test.each([
        [undefined, "loopback"],
        ["", "loopback"],
        ["   ", "loopback"],
        ["loopback", "loopback"],
        ["true", true],
        ["false", false],
        ["1", 1],
        ["2", 2],
        ["10.0.0.0/8", "10.0.0.0/8"],
    ])("значение %j даёт %j", (input, expected) => {
        expect(parseTrustProxy(input)).toBe(expected);
    });

    test("по умолчанию IP из X-Forwarded-For не доверяется чужим соединениям", async () => {
        // В тестах клиент подключается с 127.0.0.1 (это и есть доверенный прокси), поэтому здесь проверяем только значение по умолчанию
        expect(parseTrustProxy(undefined)).not.toBe(true);
    });
});
