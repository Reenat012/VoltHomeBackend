// tests/security.test.js
// Изоляция пользователей, атомарность пакета, правило «последний победил по записи», лимиты.
// Контракт: docs/SYNC_CONTRACT.md, разделы 6 и 8.
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
const batch = (uid, projectId, ops, extra = {}) =>
    request(app).post(`/v1/projects/${projectId}/batch`).set(authHeader(uid)).send({ ops, ...extra });
const tree = (uid, projectId) => request(app).get(`/v1/projects/${projectId}`).set(authHeader(uid));

describe("Чужие идентификаторы записей", () => {
    test("комната: id чужого проекта отклоняется 409, данные владельца целы", async () => {
        const a = await newProject("user-a");
        const b = await newProject("user-b");
        const roomA = randomUUID();
        await batch("user-a", a.id, { rooms: { upsert: [{ id: roomA, name: "Кухня" }], delete: [] } }).expect(200);

        const res = await batch("user-b", b.id, { rooms: { upsert: [{ id: roomA, name: "Взлом" }], delete: [] } });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe("ID_CONFLICT");

        const treeA = await tree("user-a", a.id).expect(200);
        expect(treeA.body.rooms.map((r) => r.name)).toEqual(["Кухня"]);
        const treeB = await tree("user-b", b.id).expect(200);
        expect(treeB.body.rooms).toEqual([]);
    });

    test("прибор: id чужого проекта отклоняется 409, данные владельца целы", async () => {
        const a = await newProject("user-a");
        const b = await newProject("user-b");
        const roomA = randomUUID();
        const deviceA = randomUUID();
        await batch("user-a", a.id, {
            rooms: { upsert: [{ id: roomA, name: "Кухня" }], delete: [] },
            devices: { upsert: [{ id: deviceA, name: "Чайник", meta: { room_id: roomA, power: 2000 } }], delete: [] },
        }).expect(200);

        const roomB = randomUUID();
        const res = await batch("user-b", b.id, {
            rooms: { upsert: [{ id: roomB, name: "Моя" }], delete: [] },
            devices: { upsert: [{ id: deviceA, name: "Взлом", meta: { room_id: roomB, power: 1 } }], delete: [] },
        });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe("ID_CONFLICT");

        const dev = (await tree("user-a", a.id).expect(200)).body.devices.find((d) => d.id === deviceA);
        expect(dev.name).toBe("Чайник");
    });

    test("группа: id чужого проекта отклоняется 409", async () => {
        const a = await newProject("user-a");
        const b = await newProject("user-b");
        const roomA = randomUUID();
        const groupA = randomUUID();
        await batch("user-a", a.id, {
            rooms: { upsert: [{ id: roomA, name: "Кухня" }], delete: [] },
            groups: { upsert: [{ id: groupA, room_id: roomA, name: "Линия 1" }], delete: [] },
        }).expect(200);
        const roomB = randomUUID();
        const res = await batch("user-b", b.id, {
            rooms: { upsert: [{ id: roomB, name: "Моя" }], delete: [] },
            groups: { upsert: [{ id: groupA, room_id: roomB, name: "Взлом" }], delete: [] },
        });
        expect(res.status).toBe(409);
        const g = (await tree("user-a", a.id).expect(200)).body.groups.find((x) => x.id === groupA);
        expect(g.name).toBe("Линия 1");
    });

    test("группа с room_id чужого проекта: 422", async () => {
        const a = await newProject("user-a");
        const b = await newProject("user-b");
        const roomA = randomUUID();
        await batch("user-a", a.id, { rooms: { upsert: [{ id: roomA, name: "Кухня" }], delete: [] } }).expect(200);
        const res = await batch("user-b", b.id, { groups: { upsert: [{ room_id: roomA, name: "Взлом" }], delete: [] } });
        expect(res.status).toBe(422);
        expect(res.body.error).toBe("ROOM_PROJECT_MISMATCH");
    });

    test("прибор с group_id чужого проекта: 422", async () => {
        const a = await newProject("user-a");
        const b = await newProject("user-b");
        const roomA = randomUUID();
        const groupA = randomUUID();
        await batch("user-a", a.id, {
            rooms: { upsert: [{ id: roomA, name: "Кухня" }], delete: [] },
            groups: { upsert: [{ id: groupA, room_id: roomA, name: "Линия" }], delete: [] },
        }).expect(200);
        const res = await batch("user-b", b.id, {
            devices: { upsert: [{ name: "x", group_id: groupA, meta: { power: 1 } }], delete: [] },
        });
        expect(res.status).toBe(422);
        expect(res.body.error).toBe("GROUP_PROJECT_MISMATCH");
    });

    test("чужой пользователь не может писать в проект: 404, данные целы", async () => {
        const p = await newProject("owner");
        await batch("stranger", p.id, { rooms: { upsert: [{ name: "Взлом" }], delete: [] } }).expect(404);
        expect((await tree("owner", p.id).expect(200)).body.rooms).toEqual([]);
    });
});

describe("Атомарность пакета", () => {
    test("ошибка в середине пакета откатывает всё: комната не создаётся, версия не растёт", async () => {
        const p = await newProject("user-a");
        const room = randomUUID();
        const res = await batch("user-a", p.id, {
            rooms: { upsert: [{ id: room, name: "Не должна появиться" }], delete: [] },
            devices: { upsert: [{ name: "x", meta: { room_id: randomUUID(), power: 1 } }], delete: [] },
        });
        expect(res.status).toBe(422);
        const t = (await tree("user-a", p.id).expect(200)).body;
        expect(t.rooms).toEqual([]);
        expect(t.project.version).toBe(1);
    });

    test("успешный пакет увеличивает версию ровно на 1", async () => {
        const p = await newProject("user-a");
        const res = await batch("user-a", p.id, {
            rooms: { upsert: [{ id: randomUUID(), name: "А" }, { id: randomUUID(), name: "Б" }], delete: [] },
        }).expect(200);
        expect(res.body.newVersion).toBe(2);
    });
});

describe("Последний победил по записи (clientUpdatedAt)", () => {
    const T1 = "2026-10-01T10:00:00Z";
    const T2 = "2026-10-01T11:00:00Z";
    const T3 = "2026-10-01T12:00:00Z";

    async function setup() {
        const p = await newProject("user-a");
        const room = randomUUID();
        await batch("user-a", p.id, {
            rooms: { upsert: [{ id: room, name: "Версия T2", clientUpdatedAt: T2 }], delete: [] },
        }).expect(200);
        return { p, room };
    }
    const names = async (p) => (await tree("user-a", p.id).expect(200)).body.rooms.map((r) => r.name);

    test("более старая запись пропускается и попадает в conflicts", async () => {
        const { p, room } = await setup();
        const res = await batch("user-a", p.id, {
            rooms: { upsert: [{ id: room, name: "Версия T1", clientUpdatedAt: T1 }], delete: [] },
        }).expect(200);
        expect(res.body.conflicts).toEqual([{ entity: "rooms", id: room, reason: "server_newer" }]);
        expect(await names(p)).toEqual(["Версия T2"]);
    });

    test("более новая запись применяется", async () => {
        const { p, room } = await setup();
        const res = await batch("user-a", p.id, {
            rooms: { upsert: [{ id: room, name: "Версия T3", clientUpdatedAt: T3 }], delete: [] },
        }).expect(200);
        expect(res.body.conflicts).toEqual([]);
        expect(await names(p)).toEqual(["Версия T3"]);
    });

    test("повтор той же записи (то же время) применяется: пакет идемпотентен", async () => {
        const { p, room } = await setup();
        const res = await batch("user-a", p.id, {
            rooms: { upsert: [{ id: room, name: "Версия T2", clientUpdatedAt: T2 }], delete: [] },
        }).expect(200);
        expect(res.body.conflicts).toEqual([]);
    });

    test("без clientUpdatedAt запись применяется всегда", async () => {
        const { p, room } = await setup();
        await batch("user-a", p.id, { rooms: { upsert: [{ id: room, name: "Без времени" }], delete: [] } }).expect(200);
        expect(await names(p)).toEqual(["Без времени"]);
    });

    test("для приборов правило работает так же", async () => {
        const p = await newProject("user-a");
        const room = randomUUID();
        const dev = randomUUID();
        await batch("user-a", p.id, {
            rooms: { upsert: [{ id: room, name: "К" }], delete: [] },
            devices: { upsert: [{ id: dev, name: "Новый", clientUpdatedAt: T2, meta: { room_id: room, power: 1 } }], delete: [] },
        }).expect(200);
        const res = await batch("user-a", p.id, {
            devices: { upsert: [{ id: dev, name: "Старый", clientUpdatedAt: T1, meta: { room_id: room, power: 2 } }], delete: [] },
        }).expect(200);
        expect(res.body.conflicts).toEqual([{ entity: "devices", id: dev, reason: "server_newer" }]);
        const d = (await tree("user-a", p.id).expect(200)).body.devices.find((x) => x.id === dev);
        expect(d.name).toBe("Новый");
    });

    test("неверная дата: 400", async () => {
        const p = await newProject("user-a");
        const res = await batch("user-a", p.id, {
            rooms: { upsert: [{ id: randomUUID(), name: "К", clientUpdatedAt: "не-дата" }], delete: [] },
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("bad_value");
    });

    test("время из далёкого будущего ограничивается: запись применяется, но не блокирует следующие навсегда", async () => {
        const p = await newProject("user-a");
        const room = randomUUID();
        await batch("user-a", p.id, {
            rooms: { upsert: [{ id: room, name: "Из будущего", clientUpdatedAt: "2099-01-01T00:00:00Z" }], delete: [] },
        }).expect(200);
        const later = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // через 10 минут: позже допустимого запаса
        const res = await batch("user-a", p.id, {
            rooms: { upsert: [{ id: room, name: "Позже", clientUpdatedAt: later }], delete: [] },
        }).expect(200);
        expect(res.body.conflicts).toEqual([]);
        expect(await names(p)).toEqual(["Позже"]);
    });

    test("удаление новее правки: старая правка не воскрешает комнату", async () => {
        const { p, room } = await setup();
        await batch("user-a", p.id, { rooms: { upsert: [], delete: [room] } }).expect(200);
        const res = await batch("user-a", p.id, {
            rooms: { upsert: [{ id: room, name: "Воскрешение", clientUpdatedAt: T1 }], delete: [] },
        }).expect(200);
        expect(res.body.conflicts).toHaveLength(1);
        expect(await names(p)).toEqual([]);
    });
});

describe("Устаревшая baseVersion", () => {
    test("не влияет на запись: применяется и конфликтов нет", async () => {
        const p = await newProject("user-a");
        await request(app).put(`/v1/projects/${p.id}/meta`).set(authHeader("user-a")).send({ name: "Новое" }).expect(200);
        const res = await batch(
            "user-a",
            p.id,
            { rooms: { upsert: [{ id: randomUUID(), name: "К" }], delete: [] } },
            { baseVersion: 1 }
        ).expect(200);
        expect(res.body.conflicts).toEqual([]);
        expect((await tree("user-a", p.id).expect(200)).body.rooms).toHaveLength(1);
    });
});

describe("Ограничения пакета", () => {
    test("не более 500 операций: 501 отвечает 413", async () => {
        const p = await newProject("user-a");
        const rooms = Array.from({ length: 501 }, (_, i) => ({ id: randomUUID(), name: `К${i}` }));
        const res = await batch("user-a", p.id, { rooms: { upsert: rooms, delete: [] } });
        expect(res.status).toBe(413);
        expect(res.body.error).toBe("payload_too_large");
    });

    test("ровно 500 операций проходят", async () => {
        const p = await newProject("user-a");
        const rooms = Array.from({ length: 500 }, (_, i) => ({ id: randomUUID(), name: `К${i}` }));
        await batch("user-a", p.id, { rooms: { upsert: rooms, delete: [] } }).expect(200);
    });
});
