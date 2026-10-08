// tests/documents.test.js
// Документы проекта (щит и 2D CAD и др.): docs/SYNC_CONTRACT.md, разделы 5, 7 и 8.
import request from "supertest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { getApp, authHeader, closeDb, truncateAll } from "./helpers.js";
import { pool } from "../db/pool.js";
import { findOrCreateByIdentity } from "../models/users.js";
import { grantPro, revokePro } from "../services/adminService.js";
import { listVersions } from "../models/documents.js";

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

async function makeUser(externalId, pro = false) {
    const { user } = await findOrCreateByIdentity({ provider: "yandex", externalId, profile: { displayName: "У" } });
    if (pro) await grantPro({ uid: user.uid });
    return user.uid;
}
async function newProject(uid) {
    return (await request(app).post("/v1/projects").set(authHeader(uid)).send({ name: "П" }).expect(201)).body;
}
const put = (uid, pid, kind, body) =>
    request(app).put(`/v1/projects/${pid}/documents/${kind}`).set(authHeader(uid)).send(body);
const get = (uid, pid, kind) => request(app).get(`/v1/projects/${pid}/documents/${kind}`).set(authHeader(uid));
const list = (uid, pid) => request(app).get(`/v1/projects/${pid}/documents`).set(authHeader(uid));
const del = (uid, pid, kind, q = "") =>
    request(app).delete(`/v1/projects/${pid}/documents/${kind}${q}`).set(authHeader(uid));

const panel = (extra = {}) => ({ schemaVersion: 3, rails: [{ id: "r1", modules: 24 }], title: "Щит «Кухня» 🚀", n: 1.5, ...extra });

describe("Запись и чтение документа щита (PRO)", () => {
    test("создание, обновление и чтение: версии растут, данные возвращаются без изменений", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        const d1 = panel();
        const r1 = await put(uid, p.id, "panel_layout", { baseVersion: 0, schemaVersion: 3, data: d1 }).expect(200);
        expect(r1.body.version).toBe(1);
        const d2 = panel({ rails: [{ id: "r1", modules: 36 }] });
        const r2 = await put(uid, p.id, "panel_layout", { baseVersion: 1, schemaVersion: 3, data: d2 }).expect(200);
        expect(r2.body.version).toBe(2);

        const got = await get(uid, p.id, "panel_layout").expect(200);
        expect(got.body).toMatchObject({ kind: "panel_layout", version: 2, schemaVersion: 3, data: d2 });
        expect(got.body.updatedAt).toBeTruthy();
    });

    test("список: версия и признаки, без данных", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        await put(uid, p.id, "panel_layout", { baseVersion: 0, schemaVersion: 3, data: panel() }).expect(200);
        await put(uid, p.id, "setup", { baseVersion: 0, schemaVersion: 1, data: { phaseMode: "THREE" } }).expect(200);
        const res = await list(uid, p.id).expect(200);
        expect(res.body.items.map((i) => i.kind)).toEqual(["panel_layout", "setup"]);
        expect(res.body.items[0]).toMatchObject({ version: 1, schemaVersion: 3, deleted: false, locked: false });
        expect(res.body.items[0].data).toBeUndefined();
    });

    test("повторное создание с baseVersion 0, когда документ уже есть: 409", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        await put(uid, p.id, "panel_layout", { baseVersion: 0, schemaVersion: 3, data: panel() }).expect(200);
        const res = await put(uid, p.id, "panel_layout", { baseVersion: 0, schemaVersion: 3, data: panel() }).expect(409);
        expect(res.body).toMatchObject({ error: "version_conflict", serverVersion: 1 });
    });
});

describe("Версии и конфликты", () => {
    test("устаревшая baseVersion: 409 с версией сервера, данные не затронуты", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        await put(uid, p.id, "panel_layout", { baseVersion: 0, schemaVersion: 3, data: panel({ title: "первая" }) }).expect(200);
        await put(uid, p.id, "panel_layout", { baseVersion: 1, schemaVersion: 3, data: panel({ title: "вторая" }) }).expect(200);
        const res = await put(uid, p.id, "panel_layout", { baseVersion: 1, schemaVersion: 3, data: panel({ title: "чужая" }) }).expect(409);
        expect(res.body.error).toBe("version_conflict");
        expect(res.body.serverVersion).toBe(2);
        expect(res.body.serverUpdatedAt).toBeTruthy();
        expect((await get(uid, p.id, "panel_layout").expect(200)).body.data.title).toBe("вторая");
    });

    test("повтор после «Оставить мои»: с новой baseVersion запись проходит", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        await put(uid, p.id, "panel_layout", { baseVersion: 0, schemaVersion: 3, data: panel() }).expect(200);
        await put(uid, p.id, "panel_layout", { baseVersion: 1, schemaVersion: 3, data: panel() }).expect(200);
        const conflict = await put(uid, p.id, "panel_layout", { baseVersion: 1, schemaVersion: 3, data: panel({ title: "мои" }) }).expect(409);
        const ok = await put(uid, p.id, "panel_layout", {
            baseVersion: conflict.body.serverVersion,
            schemaVersion: 3,
            data: panel({ title: "мои" }),
        }).expect(200);
        expect(ok.body.version).toBe(3);
    });

    test("две одновременные записи с одной baseVersion: ровно одна проходит", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        await put(uid, p.id, "panel_layout", { baseVersion: 0, schemaVersion: 3, data: panel() }).expect(200);
        const [a, b] = await Promise.all([
            put(uid, p.id, "panel_layout", { baseVersion: 1, schemaVersion: 3, data: panel({ title: "A" }) }),
            put(uid, p.id, "panel_layout", { baseVersion: 1, schemaVersion: 3, data: panel({ title: "B" }) }),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 409]);
    });

    test("два одновременных создания: ровно одно проходит", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        const [a, b] = await Promise.all([
            put(uid, p.id, "panel_layout", { baseVersion: 0, schemaVersion: 3, data: panel({ title: "A" }) }),
            put(uid, p.id, "panel_layout", { baseVersion: 0, schemaVersion: 3, data: panel({ title: "B" }) }),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 409]);
    });

    test("старый клиент не затирает документ более новой схемы: 409 schema_downgrade", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        await put(uid, p.id, "panel_layout", { baseVersion: 0, schemaVersion: 4, data: panel({ schemaVersion: 4 }) }).expect(200);
        const res = await put(uid, p.id, "panel_layout", { baseVersion: 1, schemaVersion: 3, data: panel() }).expect(409);
        expect(res.body).toMatchObject({ error: "schema_downgrade", serverSchemaVersion: 4 });
        expect((await get(uid, p.id, "panel_layout").expect(200)).body.schemaVersion).toBe(4);
    });

    test("новая схема поверх старой записывается", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        await put(uid, p.id, "panel_layout", { baseVersion: 0, schemaVersion: 3, data: panel() }).expect(200);
        const res = await put(uid, p.id, "panel_layout", { baseVersion: 1, schemaVersion: 4, data: panel({ schemaVersion: 4 }) }).expect(200);
        expect(res.body.schemaVersion).toBe(4);
    });
});

describe("Проверка запроса и данных", () => {
    let uid, pid;
    beforeEach(async () => {
        uid = await makeUser("1", true);
        pid = (await newProject(uid)).id;
    });

    test.each([
        ["нет baseVersion", { schemaVersion: 3, data: { schemaVersion: 3 } }],
        ["baseVersion не число", { baseVersion: "0", schemaVersion: 3, data: { schemaVersion: 3 } }],
        ["baseVersion отрицательный", { baseVersion: -1, schemaVersion: 3, data: { schemaVersion: 3 } }],
        ["нет schemaVersion", { baseVersion: 0, data: { schemaVersion: 3 } }],
        ["schemaVersion дробный", { baseVersion: 0, schemaVersion: 1.5, data: { schemaVersion: 3 } }],
    ])("400 invalid_request: %s", async (_name, body) => {
        const res = await put(uid, pid, "panel_layout", body).expect(400);
        expect(res.body.error).toBe("invalid_request");
    });

    test.each([
        ["data массив", { baseVersion: 0, schemaVersion: 3, data: [1, 2] }],
        ["data null", { baseVersion: 0, schemaVersion: 3, data: null }],
        ["data строка", { baseVersion: 0, schemaVersion: 3, data: "щит" }],
        ["нет data", { baseVersion: 0, schemaVersion: 3 }],
        ["в data щита нет schemaVersion", { baseVersion: 0, schemaVersion: 3, data: { rails: [] } }],
        ["schemaVersion в data не число", { baseVersion: 0, schemaVersion: 3, data: { schemaVersion: "3" } }],
        ["schemaVersion в data и в запросе разные", { baseVersion: 0, schemaVersion: 3, data: { schemaVersion: 2 } }],
    ])("422 invalid_document: %s", async (_name, body) => {
        const res = await put(uid, pid, "panel_layout", body).expect(422);
        expect(res.body.error).toBe("invalid_document");
        expect((await list(uid, pid).expect(200)).body.items).toEqual([]);
    });

    test("сообщение об ошибке подсказывает, что не так с schemaVersion в data щита", async () => {
        const missing = await put(uid, pid, "panel_layout", { baseVersion: 0, schemaVersion: 3, data: { rails: [] } }).expect(422);
        expect(missing.body.message).toContain("нужно целое поле schemaVersion");
        const differs = await put(uid, pid, "panel_layout", { baseVersion: 0, schemaVersion: 3, data: { schemaVersion: 2 } }).expect(422);
        expect(differs.body.message).toContain("должны совпадать");
    });

    test("для других видов schemaVersion в data не требуется", async () => {
        await put(uid, pid, "estimate_items", { baseVersion: 0, schemaVersion: 1, data: { items: [] } }).expect(200);
    });

    test("символ \\u0000 в данных: 422, а не 500", async () => {
        const res = await put(uid, pid, "panel_layout", {
            baseVersion: 0,
            schemaVersion: 3,
            data: { schemaVersion: 3, bad: "a\u0000b" },
        }).expect(422);
        expect(res.body.error).toBe("invalid_document");
    });

    test("тело больше 2 МБ: 413 в формате JSON", async () => {
        const res = await put(uid, pid, "panel_layout", {
            baseVersion: 0,
            schemaVersion: 3,
            data: { schemaVersion: 3, blob: "x".repeat(2.1 * 1024 * 1024) },
        });
        expect(res.status).toBe(413);
        expect(res.body.error).toBe("payload_too_large");
    });

    test("битый JSON: 400 invalid_json", async () => {
        const res = await request(app)
            .put(`/v1/projects/${pid}/documents/setup`)
            .set(authHeader(uid))
            .set("Content-Type", "application/json")
            .send("{не json");
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("invalid_json");
    });

    test.each(["unknown", "manual_edits", "__proto__", "constructor"])("неизвестный вид %s: 400 invalid_kind", async (kind) => {
        const res = await get(uid, pid, kind).expect(400);
        expect(res.body.error).toBe("invalid_kind");
    });

    test("неверный идентификатор проекта: 400", async () => {
        await request(app).get("/v1/projects/not-a-uuid/documents").set(authHeader(uid)).expect(400);
    });

    test("неизвестный адрес отвечает JSON 404", async () => {
        const res = await request(app).post(`/v1/projects/${pid}/documents`).set(authHeader(uid)).send({}).expect(404);
        expect(res.body.error).toBe("not_found");
    });

    test("документ, которого нет: 404", async () => {
        await get(uid, pid, "panel_layout").expect(404);
    });
});

describe("Доступ: чужие проекты и вход", () => {
    test("без токена: 401", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        await request(app).get(`/v1/projects/${p.id}/documents`).expect(401);
    });

    test("чужой проект: 404 на чтение, запись и удаление, данные владельца целы", async () => {
        const owner = await makeUser("1", true);
        const stranger = await makeUser("2", true);
        const p = await newProject(owner);
        await put(owner, p.id, "panel_layout", { baseVersion: 0, schemaVersion: 3, data: panel({ title: "мой" }) }).expect(200);
        await get(stranger, p.id, "panel_layout").expect(404);
        await list(stranger, p.id).expect(404);
        await put(stranger, p.id, "panel_layout", { baseVersion: 1, schemaVersion: 3, data: panel({ title: "взлом" }) }).expect(404);
        await del(stranger, p.id, "panel_layout").expect(404);
        expect((await get(owner, p.id, "panel_layout").expect(200)).body.data.title).toBe("мой");
    });

    test("удалённый проект: документы недоступны (404)", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        await put(uid, p.id, "setup", { baseVersion: 0, schemaVersion: 1, data: {} }).expect(200);
        await request(app).delete(`/v1/projects/${p.id}`).set(authHeader(uid)).expect(200);
        await get(uid, p.id, "setup").expect(404);
        await put(uid, p.id, "setup", { baseVersion: 1, schemaVersion: 1, data: {} }).expect(404);
    });

    test("несуществующий проект: 404", async () => {
        await list(await makeUser("1"), randomUUID()).expect(404);
    });
});

describe("PRO на сервере", () => {
    const gated = [
        ["cable_defaults", "cableLineCalculation"],
        ["phase_overrides", "phaseDragAndDrop"],
        ["apparatus_selections", "projectEstimate"],
        ["estimate_items", "projectEstimate"],
        ["panel_layout", "panelVisualization"],
    ];

    test.each(gated)("бесплатный пользователь: %s даёт 402 с правом %s на чтение и запись", async (kind, feature) => {
        const uid = await makeUser("1");
        const p = await newProject(uid);
        const w = await put(uid, p.id, kind, { baseVersion: 0, schemaVersion: 1, data: { schemaVersion: 1 } }).expect(402);
        expect(w.body).toMatchObject({ error: "pro_required", feature });
        const r = await get(uid, p.id, kind).expect(402);
        expect(r.body).toMatchObject({ error: "pro_required", feature });
        await del(uid, p.id, kind).expect(402);
    });

    test("свободный документ setup доступен без PRO", async () => {
        const uid = await makeUser("1");
        const p = await newProject(uid);
        await put(uid, p.id, "setup", { baseVersion: 0, schemaVersion: 1, data: { phaseMode: "SINGLE" } }).expect(200);
        expect((await get(uid, p.id, "setup").expect(200)).body.data.phaseMode).toBe("SINGLE");
    });

    test("PRO закончился: данные сохранены, список показывает locked, чтение и запись 402", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        await put(uid, p.id, "panel_layout", { baseVersion: 0, schemaVersion: 3, data: panel({ title: "сохранён" }) }).expect(200);
        await revokePro({ uid });

        const items = (await list(uid, p.id).expect(200)).body.items;
        expect(items).toEqual([expect.objectContaining({ kind: "panel_layout", locked: true })]);
        await get(uid, p.id, "panel_layout").expect(402);
        await put(uid, p.id, "panel_layout", { baseVersion: 1, schemaVersion: 3, data: panel() }).expect(402);

        await grantPro({ uid });
        expect((await get(uid, p.id, "panel_layout").expect(200)).body.data.title).toBe("сохранён");
    });

    test("клиент не может обойти проверку заголовками или телом", async () => {
        const uid = await makeUser("1");
        const p = await newProject(uid);
        const res = await request(app)
            .put(`/v1/projects/${p.id}/documents/panel_layout`)
            .set(authHeader(uid))
            .set("X-VoltHome-Plan", "pro")
            .send({ baseVersion: 0, schemaVersion: 3, plan: "pro", capabilities: { panelVisualization: true }, data: panel() });
        expect(res.status).toBe(402);
    });
});

describe("Удаление документа", () => {
    test("мягкое удаление: чтение 404, в списке deleted, версия выросла", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        await put(uid, p.id, "panel_layout", { baseVersion: 0, schemaVersion: 3, data: panel() }).expect(200);
        const res = await del(uid, p.id, "panel_layout").expect(200);
        expect(res.body.version).toBe(2);
        await get(uid, p.id, "panel_layout").expect(404);
        expect((await list(uid, p.id).expect(200)).body.items[0]).toMatchObject({ version: 2, deleted: true });
    });

    test("повторное удаление и удаление несуществующего: 404", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        await del(uid, p.id, "panel_layout").expect(404);
        await put(uid, p.id, "panel_layout", { baseVersion: 0, schemaVersion: 3, data: panel() }).expect(200);
        await del(uid, p.id, "panel_layout").expect(200);
        await del(uid, p.id, "panel_layout").expect(404);
    });

    test("удаление с устаревшей baseVersion: 409, документ остаётся", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        await put(uid, p.id, "panel_layout", { baseVersion: 0, schemaVersion: 3, data: panel() }).expect(200);
        await put(uid, p.id, "panel_layout", { baseVersion: 1, schemaVersion: 3, data: panel() }).expect(200);
        const res = await del(uid, p.id, "panel_layout", "?baseVersion=1").expect(409);
        expect(res.body.serverVersion).toBe(2);
        await get(uid, p.id, "panel_layout").expect(200);
    });

    test("после удаления документ можно создать заново с baseVersion = версия удаления", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        await put(uid, p.id, "panel_layout", { baseVersion: 0, schemaVersion: 3, data: panel({ title: "старый" }) }).expect(200);
        await del(uid, p.id, "panel_layout").expect(200);
        const res = await put(uid, p.id, "panel_layout", { baseVersion: 2, schemaVersion: 3, data: panel({ title: "новый" }) }).expect(200);
        expect(res.body.version).toBe(3);
        expect((await get(uid, p.id, "panel_layout").expect(200)).body.data.title).toBe("новый");
    });
});

describe("Проект и история", () => {
    test("запись документа обновляет проект: клиенты увидят изменение при опросе списка проектов", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        await new Promise((r) => setTimeout(r, 20));
        const marker = new Date().toISOString();
        await new Promise((r) => setTimeout(r, 20));
        let items = (await request(app).get(`/v1/projects?since=${marker}`).set(authHeader(uid)).expect(200)).body.items;
        expect(items).toEqual([]);
        await put(uid, p.id, "setup", { baseVersion: 0, schemaVersion: 1, data: {} }).expect(200);
        items = (await request(app).get(`/v1/projects?since=${marker}`).set(authHeader(uid)).expect(200)).body.items;
        expect(items.map((i) => i.id)).toEqual([p.id]);
        expect(items[0].version).toBeGreaterThan(p.version);
    });

    test("хранятся последние 20 версий", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        for (let v = 0; v < 25; v++) {
            await put(uid, p.id, "estimate_items", { baseVersion: v, schemaVersion: 1, data: { n: v + 1 } }).expect(200);
        }
        const versions = await listVersions(p.id, "estimate_items");
        expect(versions).toHaveLength(20);
        expect(versions[0].version).toBe(25);
        expect(versions.at(-1).version).toBe(6);
    });

    test("запись попадает в журнал", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        await put(uid, p.id, "setup", { baseVersion: 0, schemaVersion: 1, data: {} }).expect(200);
        await del(uid, p.id, "setup").expect(200);
        const { rows } = await pool.query(`SELECT action FROM audit_log WHERE action LIKE '%document' ORDER BY id`);
        expect(rows.map((r) => r.action)).toEqual(["put_document", "delete_document"]);
    });

    test("удаление проекта из базы удаляет документы и историю", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        await put(uid, p.id, "setup", { baseVersion: 0, schemaVersion: 1, data: {} }).expect(200);
        await pool.query(`DELETE FROM projects WHERE id = $1`, [p.id]);
        expect((await pool.query(`SELECT 1 FROM project_documents`)).rowCount).toBe(0);
        expect((await pool.query(`SELECT 1 FROM project_document_versions`)).rowCount).toBe(0);
    });
});

describe("Восстановление версии на сервере (scripts/admin.js)", () => {
    const env = { ...process.env, NODE_ENV: "test", DOTENV_CONFIG_PATH: ".env.test" };
    const cli = (...args) => run("node", ["scripts/admin.js", ...args], { env, cwd: process.cwd() });

    test("история и восстановление создают новую версию с данными старой", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        for (let v = 0; v < 3; v++) {
            await put(uid, p.id, "panel_layout", {
                baseVersion: v,
                schemaVersion: 3,
                data: panel({ title: `версия ${v + 1}` }),
            }).expect(200);
        }
        const hist = await cli("doc-versions", "--project", p.id, "--kind", "panel_layout");
        expect(hist.stdout).toContain("версия 3");
        expect(hist.stdout).toContain("версия 1");

        const restored = await cli("doc-restore", "--project", p.id, "--kind", "panel_layout", "--version", "1");
        expect(restored.stdout).toContain("создана версия 4");

        const got = (await get(uid, p.id, "panel_layout").expect(200)).body;
        expect(got.version).toBe(4);
        expect(got.data.title).toBe("версия 1");
        const { rows } = await pool.query(`SELECT detail FROM audit_log WHERE action = 'restore_document'`);
        expect(rows[0].detail).toMatchObject({ kind: "panel_layout", restoredFrom: 1, newVersion: 4 });
    });

    test("ошибки: нет версии, неверный вид, нет проекта", async () => {
        const uid = await makeUser("1", true);
        const p = await newProject(uid);
        await put(uid, p.id, "setup", { baseVersion: 0, schemaVersion: 1, data: {} }).expect(200);
        await expect(cli("doc-restore", "--project", p.id, "--kind", "setup", "--version", "99")).rejects.toMatchObject({
            code: 1,
            stderr: expect.stringContaining("не найдена"),
        });
        await expect(cli("doc-versions", "--project", p.id, "--kind", "nope")).rejects.toMatchObject({ code: 1 });
        await expect(cli("doc-versions", "--kind", "setup")).rejects.toMatchObject({ code: 1 });
    });
});
