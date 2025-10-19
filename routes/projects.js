import express from "express";
import { authMiddleware } from "../utils/jwt.js";
import {
    createProject,
    listProjects,
    getProjectMeta,
    updateProjectMeta,
    softDeleteProject,
} from "../models/projects.js";
import { getProjectTree, getDelta, applyBatch } from "../services/projectsService.js";
import {
    isUuidV4,
    requiredString,
    optionalString,
    isIsoDate,
    parseLimit,
} from "../utils/validation.js";
import { tokenBucket } from "../utils/rateLimit.js";

const router = express.Router();

// Все ручки требуют Bearer
router.use(authMiddleware);

/**
 * GET /v1/projects
 * Список проектов с пагинацией по updated_at.
 */
router.get(
    "/",
    tokenBucket({ limitPerMin: 120, name: "projects.list" }),
    async (req, res) => {
        try {
            const uid = req.user?.uid;
            if (!uid) return res.status(401).json({ error: "invalid_token" });

            const limit = parseLimit(req.query.limit, 100);
            const since =
                req.query.since && isIsoDate(req.query.since) ? req.query.since : null;

            const items = await listProjects({ userId: uid, since, limit });
            // Простая пагинация по updated_at: если набрали ровно limit, отдаём next как updated_at последнего
            const next = items.length === limit ? items[items.length - 1].updated_at : null;

            res.json({ items, next });
        } catch (err) {
            // Если это statement timeout — отдаём 503, чтобы клиент не висел до своего таймаута
            const isTimeout =
                err?.code === "57014" || /statement timeout/i.test(err?.message || "");

            console.error(
                "[GET /v1/projects] error:",
                err?.message || err,
                "| code:", err?.code,
                "| detail:", err?.detail,
                "| constraint:", err?.constraint,
                "| table:", err?.table
            );

            if (isTimeout) {
                return res.status(503).json({ error: "db_timeout" });
            }
            return res.status(500).json({ error: "server_error" });
        }
    }
);

/**
 * POST /v1/projects
 * Создание проекта.
 */
router.post("/", async (req, res) => {
    const uid = req.user.uid;
    const { id, name, note } = req.body || {};
    if (id && !isUuidV4(id)) return res.status(400).json({ error: "invalid_id" });
    if (!requiredString(name, 200)) return res.status(400).json({ error: "invalid_name" });
    if (!optionalString(note, 2000)) return res.status(400).json({ error: "invalid_note" });

    try {
        const row = await createProject({ id, userId: uid, name, note });
        try {
            await req.app.locals?.audit?.(uid, "create_project", "projects", row.id, { name, note });
        } catch {}
        return res.status(201).json(row);
    } catch (err) {
        console.error(
            "[POST /v1/projects] error:",
            err?.message || err,
            "| code:", err?.code,
            "| detail:", err?.detail,
            "| constraint:", err?.constraint,
            "| table:", err?.table
        );
        return res.status(500).json({ error: "server_error" });
    }
});

/**
 * GET /v1/projects/:id
 * Получение JSON-дерева проекта.
 */
router.get("/:id", async (req, res) => {
    const uid = req.user.uid;
    const id = req.params.id;
    if (!isUuidV4(id)) return res.status(400).json({ error: "invalid_id" });

    try {
        const tree = await getProjectTree({ userId: uid, projectId: id });
        if (!tree) return res.status(404).json({ error: "not_found" });
        return res.json(tree);
    } catch (err) {
        console.error(
            "[GET /v1/projects/:id] error:",
            err?.message || err,
            "| code:", err?.code,
            "| detail:", err?.detail,
            "| constraint:", err?.constraint,
            "| table:", err?.table
        );
        return res.status(500).json({ error: "server_error" });
    }
});

/**
 * GET /v1/projects/:id/meta
 * Метаданные проекта.
 */
router.get("/:id/meta", async (req, res) => {
    const uid = req.user.uid;
    const id = req.params.id;
    if (!isUuidV4(id)) return res.status(400).json({ error: "invalid_id" });

    try {
        const meta = await getProjectMeta({ userId: uid, projectId: id });
        if (!meta) return res.status(404).json({ error: "not_found" });
        return res.json(meta);
    } catch (err) {
        console.error(
            "[GET /v1/projects/:id/meta] error:",
            err?.message || err,
            "| code:", err?.code,
            "| detail:", err?.detail,
            "| constraint:", err?.constraint,
            "| table:", err?.table
        );
        return res.status(500).json({ error: "server_error" });
    }
});

/**
 * PUT /v1/projects/:id/meta
 * Обновление метаданных проекта.
 */
router.put("/:id/meta", async (req, res) => {
    const uid = req.user.uid;
    const id = req.params.id;
    if (!isUuidV4(id)) return res.status(400).json({ error: "invalid_id" });

    const { name, note } = req.body || {};
    if (name && !requiredString(name, 200))
        return res.status(400).json({ error: "invalid_name" });
    if (note && !optionalString(note, 2000))
        return res.status(400).json({ error: "invalid_note" });

    try {
        const row = await updateProjectMeta({ userId: uid, projectId: id, name, note });
        if (!row) return res.status(404).json({ error: "not_found" });
        return res.json(row);
    } catch (err) {
        console.error(
            "[PUT /v1/projects/:id/meta] error:",
            err?.message || err,
            "| code:", err?.code,
            "| detail:", err?.detail,
            "| constraint:", err?.constraint,
            "| table:", err?.table
        );
        return res.status(500).json({ error: "server_error" });
    }
});

/**
 * DELETE /v1/projects/:id
 * Мягкое удаление проекта.
 */
router.delete("/:id", async (req, res) => {
    const uid = req.user.uid;
    const id = req.params.id;
    if (!isUuidV4(id)) return res.status(400).json({ error: "invalid_id" });

    try {
        const row = await softDeleteProject({ userId: uid, projectId: id });
        if (!row) return res.status(404).json({ error: "not_found" });

        try {
            await req.app.locals?.audit?.(uid, "delete_project", "projects", id, {});
        } catch {}
        return res.json(row);
    } catch (err) {
        console.error(
            "[DELETE /v1/projects/:id] error:",
            err?.message || err,
            "| code:", err?.code,
            "| detail:", err?.detail,
            "| constraint:", err?.constraint,
            "| table:", err?.table
        );
        return res.status(500).json({ error: "server_error" });
    }
});

/**
 * GET /v1/projects/:id/delta
 * Дельты по проекту с момента since (ISO).
 */
router.get("/:id/delta", async (req, res) => {
    const uid = req.user.uid;
    const id = req.params.id;
    if (!isUuidV4(id)) return res.status(400).json({ error: "invalid_id" });

    const since =
        req.query.since && isIsoDate(req.query.since)
            ? req.query.since
            : "1970-01-01T00:00:00Z";
    try {
        const delta = await getDelta({ userId: uid, projectId: id, since });
        if (!delta) return res.status(404).json({ error: "not_found" });
        return res.json(delta);
    } catch (err) {
        console.error(
            "[GET /v1/projects/:id/delta] error:",
            err?.message || err,
            "| code:", err?.code,
            "| detail:", err?.detail,
            "| constraint:", err?.constraint,
            "| table:", err?.table
        );
        return res.status(500).json({ error: "server_error" });
    }
});

/**
 * POST /v1/projects/:id/batch
 * Пакетная запись (LWW), с расширенным логированием ошибок.
 */
router.post("/:id/batch", async (req, res) => {
    const uid = req.user.uid;
    const id = req.params.id;
    if (!isUuidV4(id)) return res.status(400).json({ error: "invalid_id" });

    const { baseVersion, ops } = req.body || {};
    try {
        const result = await applyBatch({ userId: uid, projectId: id, baseVersion, ops });

        // Аудит — best effort
        try {
            const opsCount =
                ops && typeof ops === "object"
                    ? Object.values(ops).reduce(
                        (n, v) => n + (v?.upsert?.length || 0) + (v?.delete?.length || 0),
                        0
                    )
                    : 0;
            await req.app.locals?.audit?.(uid, "apply_batch", "projects", id, {
                baseVersion,
                opsCount,
            });
        } catch {}

        return res.json(result);
    } catch (err) {
        const isTimeout =
            err?.code === "57014" || /statement timeout/i.test(err?.message || "");

        // Расширенное логирование: код/детали/ограничение/таблица
        console.error(
            "[POST /v1/projects/:id/batch] error:",
            err?.message || err,
            "| code:", err?.code,
            "| detail:", err?.detail,
            "| constraint:", err?.constraint,
            "| table:", err?.table
        );

        return res.status(isTimeout ? 503 : 500).json({
            error: isTimeout ? "db_timeout" : "server_error",
        });
    }
});

export default router;