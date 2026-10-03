// tests/projects.int.test.js
// Интеграционные тесты проектов на локальной БД (npm run testdb:start, затем npm test).
// Фиксируют ТЕКУЩЕЕ поведение API: на их основе безопасно менять код на следующих этапах.
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

async function createProject(uid = "test-user", name = "Квартира") {
    const res = await request(app).post("/v1/projects").set(authHeader(uid)).send({ name, note: "Черновик" });
    expect(res.status).toBe(201);
    return res.body;
}

describe("Служебные ручки и авторизация", () => {
    test("GET /health отвечает ok", async () => {
        const res = await request(app).get("/health").expect(200);
        expect(res.body).toEqual({ ok: true });
    });

    test("GET /health/db видит базу", async () => {
        const res = await request(app).get("/health/db").expect(200);
        expect(res.body.db).toBe("ok");
    });

    test("без токена /v1/projects отвечает 401", async () => {
        const res = await request(app).get("/v1/projects").expect(401);
        expect(res.body.error).toBe("no_token");
    });

    test("с неверным токеном отвечает 401", async () => {
        const res = await request(app)
            .get("/v1/projects")
            .set({ Authorization: "Bearer not-a-jwt" })
            .expect(401);
        expect(res.body.error).toBe("invalid_token");
    });
});

describe("Проекты: создание, чтение, изменение, удаление", () => {
    test("создание: версия 1, не удалён", async () => {
        const p = await createProject();
        expect(p.id).toBeTruthy();
        expect(p.version).toBe(1);
        expect(p.is_deleted).toBe(false);
    });

    test("список содержит созданный проект", async () => {
        const p = await createProject();
        const res = await request(app)
            .get("/v1/projects?since=1970-01-01T00:00:00Z&limit=50")
            .set(authHeader())
            .expect(200);
        expect(res.body.items.map((x) => x.id)).toContain(p.id);
    });

    test("снимок проекта содержит списки комнат, групп и приборов", async () => {
        const p = await createProject();
        const res = await request(app).get(`/v1/projects/${p.id}`).set(authHeader()).expect(200);
        expect(res.body.project.id).toBe(p.id);
        expect(res.body.rooms).toEqual([]);
        expect(res.body.groups).toEqual([]);
        expect(res.body.devices).toEqual([]);
    });

    test("изменение названия через /meta увеличивает версию", async () => {
        const p = await createProject();
        const res = await request(app)
            .put(`/v1/projects/${p.id}/meta`)
            .set(authHeader())
            .send({ name: "Квартира 2" })
            .expect(200);
        expect(res.body.name).toBe("Квартира 2");
        expect(res.body.version).toBe(2);
    });

    test("мягкое удаление: проект помечается удалённым", async () => {
        const p = await createProject();
        await request(app).delete(`/v1/projects/${p.id}`).set(authHeader()).expect(200);
        const list = await request(app)
            .get("/v1/projects?since=1970-01-01T00:00:00Z&limit=50")
            .set(authHeader())
            .expect(200);
        expect(list.body.items.find((x) => x.id === p.id).is_deleted).toBe(true);
    });

    test("неверный идентификатор отвечает 400", async () => {
        const res = await request(app).get("/v1/projects/not-a-uuid").set(authHeader()).expect(400);
        expect(res.body.error).toBe("invalid_id");
    });

    test("чужой проект недоступен: 404", async () => {
        const p = await createProject("owner");
        await request(app).get(`/v1/projects/${p.id}`).set(authHeader("stranger")).expect(404);
        await request(app).delete(`/v1/projects/${p.id}`).set(authHeader("stranger")).expect(404);
    });

    test("бесплатный лимит: четвёртый проект отвечает 402", async () => {
        for (let i = 0; i < 3; i++) await createProject("limited", `П${i}`);
        const res = await request(app)
            .post("/v1/projects")
            .set(authHeader("limited"))
            .send({ name: "Четвёртый" })
            .expect(402);
        expect(res.body.error).toBe("pro_required_projects_limit");
        expect(res.body.limit).toBe(3);
    });
});

describe("Пакет изменений (batch) и дельта", () => {
    test("комната и прибор: версия растёт, служебная группа создаётся", async () => {
        const p = await createProject();
        const roomId = randomUUID();
        const deviceId = randomUUID();
        const res = await request(app)
            .post(`/v1/projects/${p.id}/batch`)
            .set(authHeader())
            .send({
                baseVersion: 1,
                ops: {
                    rooms: { upsert: [{ id: roomId, name: "Кухня", meta: { room_type: "KITCHEN" } }], delete: [] },
                    devices: {
                        upsert: [
                            {
                                id: deviceId,
                                name: "Варочная панель",
                                meta: { room_id: roomId, device_type: "ELECTRIC_STOVE", power: 7000 },
                            },
                        ],
                        delete: [],
                    },
                },
            })
            .expect(200);
        expect(res.body.newVersion).toBe(2);
        expect(res.body.conflicts).toEqual([]);

        const tree = await request(app).get(`/v1/projects/${p.id}`).set(authHeader()).expect(200);
        expect(tree.body.rooms.map((r) => r.id)).toEqual([roomId]);
        expect(tree.body.devices.map((d) => d.id)).toEqual([deviceId]);
        expect(tree.body.groups.some((g) => g.room_id === roomId && g.name === "__default__")).toBe(true);
    });

    test("прибор без группы и без room_id отвечает 400 GROUP_UNRESOLVED", async () => {
        const p = await createProject();
        const res = await request(app)
            .post(`/v1/projects/${p.id}/batch`)
            .set(authHeader())
            .send({ baseVersion: 1, ops: { devices: { upsert: [{ name: "x", meta: { power: 1 } }], delete: [] } } })
            .expect(400);
        expect(res.body.error).toBe("GROUP_UNRESOLVED");
    });

    test("прибор с room_id чужого проекта отвечает 422 ROOM_PROJECT_MISMATCH", async () => {
        const mine = await createProject("user-a", "Мой");
        const other = await createProject("user-b", "Чужой");
        const foreignRoom = randomUUID();
        await request(app)
            .post(`/v1/projects/${other.id}/batch`)
            .set(authHeader("user-b"))
            .send({ baseVersion: 1, ops: { rooms: { upsert: [{ id: foreignRoom, name: "Чужая" }], delete: [] } } })
            .expect(200);
        const res = await request(app)
            .post(`/v1/projects/${mine.id}/batch`)
            .set(authHeader("user-a"))
            .send({
                baseVersion: 1,
                ops: { devices: { upsert: [{ name: "x", meta: { room_id: foreignRoom } }], delete: [] } },
            })
            .expect(422);
        expect(res.body.error).toBe("ROOM_PROJECT_MISMATCH");
    });

    test("устаревшая baseVersion: сейчас операции применяются, конфликт только сообщается", async () => {
        // Фиксируем текущее поведение. Контракт (docs/SYNC_CONTRACT.md, раздел 8) его изменит на этапе 22.
        const p = await createProject();
        await request(app)
            .put(`/v1/projects/${p.id}/meta`)
            .set(authHeader())
            .send({ name: "Новая" })
            .expect(200); // версия стала 2
        const res = await request(app)
            .post(`/v1/projects/${p.id}/batch`)
            .set(authHeader())
            .send({ baseVersion: 1, ops: { rooms: { upsert: [{ id: randomUUID(), name: "Комната" }], delete: [] } } })
            .expect(200);
        expect(res.body.conflicts.length).toBeGreaterThan(0);
        const tree = await request(app).get(`/v1/projects/${p.id}`).set(authHeader()).expect(200);
        expect(tree.body.rooms.length).toBe(1);
    });

    test("дельта возвращает добавленное и удалённое", async () => {
        const p = await createProject();
        const roomId = randomUUID();
        await request(app)
            .post(`/v1/projects/${p.id}/batch`)
            .set(authHeader())
            .send({ baseVersion: 1, ops: { rooms: { upsert: [{ id: roomId, name: "Ванная" }], delete: [] } } })
            .expect(200);
        const added = await request(app)
            .get(`/v1/projects/${p.id}/delta?since=1970-01-01T00:00:00Z`)
            .set(authHeader())
            .expect(200);
        expect(added.body.rooms.upsert.map((r) => r.id)).toContain(roomId);

        await request(app)
            .post(`/v1/projects/${p.id}/batch`)
            .set(authHeader())
            .send({ baseVersion: 2, ops: { rooms: { upsert: [], delete: [roomId] } } })
            .expect(200);
        const removed = await request(app)
            .get(`/v1/projects/${p.id}/delta?since=1970-01-01T00:00:00Z`)
            .set(authHeader())
            .expect(200);
        expect(removed.body.rooms.delete).toContain(roomId);
    });

    test("300 приборов за один пакет", async () => {
        const p = await createProject();
        const roomId = randomUUID();
        const devices = Array.from({ length: 300 }, (_, i) => ({
            name: `d${i}`,
            meta: { room_id: roomId, power: i },
        }));
        const res = await request(app)
            .post(`/v1/projects/${p.id}/batch`)
            .set(authHeader())
            .send({
                baseVersion: 1,
                ops: {
                    rooms: { upsert: [{ id: roomId, name: "Большая" }], delete: [] },
                    devices: { upsert: devices, delete: [] },
                },
            })
            .expect(200);
        expect(res.body.newVersion).toBe(2);
    });
});

describe("Изоляция пользователей (текущее состояние)", () => {
    test("чужой пользователь не видит и не меняет проект через batch", async () => {
        const p = await createProject("owner");
        await request(app)
            .post(`/v1/projects/${p.id}/batch`)
            .set(authHeader("stranger"))
            .send({ baseVersion: 1, ops: { rooms: { upsert: [{ name: "Взлом" }], delete: [] } } })
            .expect((res) => {
                // сервис возвращает notFound-объект; важно, что данные владельца не изменились
                expect([200, 404]).toContain(res.status);
            });
        const tree = await request(app).get(`/v1/projects/${p.id}`).set(authHeader("owner")).expect(200);
        expect(tree.body.rooms).toEqual([]);
    });
});
