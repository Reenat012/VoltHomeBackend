// tests/projects.int.test.js
import request from "supertest";
import dotenv from "dotenv";
dotenv.config();

import { signToken } from "../utils/jwt.js";
import "../server/server.js"; // запускает сервер по конфигу
// В реальном проекте лучше экспортировать app и использовать server = app.listen(...)

const base = `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 3000}`;

function auth() {
    const sessionJwt = signToken({ uid: "test-user" });
    return { Authorization: `Bearer ${sessionJwt}` };
}

describe("Projects CRUD/Delta/Batch", () => {
    let projectId;

    test("Create project", async () => {
        const res = await request(base)
            .post("/v1/projects")
            .set(auth())
            .send({ name: "Квартира", note: "Черновик" })
            .expect(201);
        expect(res.body.id).toBeTruthy();
        expect(res.body.version).toBe(1);
        projectId = res.body.id;
    });

    test("List projects", async () => {
        const res = await request(base)
            .get("/v1/projects?since=1970-01-01T00:00:00Z&limit=50")
            .set(auth())
            .expect(200);
        expect(res.body.items.length).toBeGreaterThan(0);
    });

    test("Get project tree", async () => {
        const res = await request(base)
            .get(`/v1/projects/${projectId}`)
            .set(auth())
            .expect(200);
        expect(res.body.project.id).toBe(projectId);
        expect(res.body.rooms).toBeDefined();
    });

    test("Update name increments version", async () => {
        const res = await request(base)
            .put(`/v1/projects/${projectId}`)
            .set(auth())
            .send({ name: "Квартира 2" })
            .expect(200);
        expect(res.body.version).toBe(2);
    });

    test("Delta initially empty", async () => {
        const res = await request(base)
            .get(`/v1/projects/${projectId}/delta?since=1970-01-01T00:00:00Z`)
            .set(auth())
            .expect(200);
        expect(res.body.rooms.upsert).toBeDefined();
    });

    test("Batch upsert 300 devices ok", async () => {
        const devs = Array.from({ length: 300 }, (_, i) => ({
            id: undefined,
            name: `d${i}`,
            meta: { p: i },
        }));
        const res = await request(base)
            .post(`/v1/projects/${projectId}/batch`)
            .set(auth())
            .send({
                baseVersion: 2,
                ops: { devices: { upsert: devs, delete: [] } },
            })
            .expect(200);
        expect(res.body.newVersion).toBe(3);
    });

    test("Batch with stale baseVersion => conflicts", async () => {
        const res = await request(base)
            .post(`/v1/projects/${projectId}/batch`)
            .set(auth())
            .send({
                baseVersion: 1,
                ops: { rooms: { upsert: [{ name: "Room A" }] } },
            })
            .expect(200);
        expect(res.body.conflicts.length).toBeGreaterThan(0);
    });

    test("Soft delete", async () => {
        const res = await request(base)
            .delete(`/v1/projects/${projectId}`)
            .set(auth())
            .expect(200);
        expect(res.body.is_deleted).toBe(true);
    });
});