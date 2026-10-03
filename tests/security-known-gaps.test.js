// tests/security-known-gaps.test.js
// Известные дыры безопасности (см. docs/PLAN_BACKEND_CAD.md, этап 22). Пока дыра есть, тест
// помечен test.failing: он «проходит», пока безопасное поведение НЕ достигнуто, и начнёт падать,
// когда дыру закроют. Тогда на этапе 22 нужно убрать `.failing` у соответствующего теста.
import request from "supertest";
import { randomUUID } from "node:crypto";
import { getApp, authHeader, closeDb, truncateAll } from "./helpers.js";

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

async function newProject(uid, name = "П") {
    const res = await request(app).post("/v1/projects").set(authHeader(uid)).send({ name }).expect(201);
    return res.body;
}

async function putBatch(uid, projectId, ops) {
    return request(app).post(`/v1/projects/${projectId}/batch`).set(authHeader(uid)).send({ baseVersion: 1, ops });
}

describe("Изоляция записей между пользователями", () => {
    test("прибор чужого пользователя нельзя перезаписать через свой проект (уже защищено)", async () => {
        const a = await newProject("user-a");
        const b = await newProject("user-b");
        const roomA = randomUUID();
        const deviceA = randomUUID();
        await putBatch("user-a", a.id, {
            rooms: { upsert: [{ id: roomA, name: "Кухня" }], delete: [] },
            devices: { upsert: [{ id: deviceA, name: "Чайник", meta: { room_id: roomA, power: 2000 } }], delete: [] },
        }).then((r) => expect(r.status).toBe(200));

        const roomB = randomUUID();
        await putBatch("user-b", b.id, {
            rooms: { upsert: [{ id: roomB, name: "Моя" }], delete: [] },
            devices: { upsert: [{ id: deviceA, name: "Взлом", meta: { room_id: roomB, power: 1 } }], delete: [] },
        });

        const treeA = await request(app).get(`/v1/projects/${a.id}`).set(authHeader("user-a")).expect(200);
        const dev = treeA.body.devices.find((d) => d.id === deviceA);
        expect(dev.name).toBe("Чайник");
    });

    // ДЫРА 22.2: в models/rooms.js нет проверки владельца при ON CONFLICT (id).
    test.failing("[дыра 22.2] комнату чужого пользователя нельзя перезаписать через свой проект", async () => {
        const a = await newProject("user-a");
        const b = await newProject("user-b");
        const roomA = randomUUID();
        await putBatch("user-a", a.id, { rooms: { upsert: [{ id: roomA, name: "Кухня" }], delete: [] } }).then(
            (r) => expect(r.status).toBe(200)
        );

        await putBatch("user-b", b.id, { rooms: { upsert: [{ id: roomA, name: "Взлом" }], delete: [] } });

        const treeA = await request(app).get(`/v1/projects/${a.id}`).set(authHeader("user-a")).expect(200);
        expect(treeA.body.rooms.map((r) => r.name)).toEqual(["Кухня"]);
    });
});

describe("Вход", () => {
    // ДЫРА 22.1: сервер принимает uid от клиента и выдаёт сессию без проверки.
    test.failing("[дыра 22.1] нельзя получить сессию на чужой uid без проверки у Яндекса", async () => {
        const victim = await newProject("victim", "Проект жертвы");
        const res = await request(app).post("/v1/auth/yandex/exchange").send({ uid: "victim" });
        expect([400, 401, 403]).toContain(res.status);
        expect(victim.id).toBeTruthy();
    });

    test.failing("[дыра 22.1] старый /v1/auth/login с произвольным userId удалён", async () => {
        const res = await request(app).post("/v1/auth/login").send({ userId: "victim" });
        expect([404, 410]).toContain(res.status);
    });
});
