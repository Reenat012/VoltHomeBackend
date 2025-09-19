// routes/projects.js
import express from "express";
import { authMiddleware } from "../utils/jwt.js";
import {
    createProject,
    listProjects,
    getProjectMeta,
    updateProjectMeta,
    softDeleteProject
} from "../models/projects.js";
import { getProjectTree, getDelta, applyBatch } from "../services/projectsService.js";
import { isUuidV4, requiredString, optionalString, isIsoDate, parseLimit } from "../utils/validation.js";
import { tokenBucket } from "../utils/rateLimit.js";

const router = express.Router();

// Все ручки ниже — только под авторизацией
router.use(authMiddleware);

/**
 * GET /v1/projects?since=timestamp&limit=50
 */
router.get("/", async (req, res) => {
    const uid = req.user.uid;
    const since = req.query.since && isIsoDate(req.query.since) ? req.query.since : "1970-01-01T00:00:00Z";
    const limit = parseLimit(req.query.limit, 50, 200);

    const items = await listProjects({ userId: uid, since, limit });
    // pagination token по updated_at: если получили limit элементов — вернём next = updated_at последнего
    const next = items.length === limit ? items[items.length - 1].updated_at : null;
    res.json({ items, next });
});

/**
 * POST /v1/projects
 * Body: { id? (uuid), name, note? }
 */
router.post("/", async (req, res) => {
    const uid = req.user.uid;
    const { id, name, note } = req.body || {};
    if (id && !isUuidV4(id)) return res.status(400).json({ error: "invalid_id" });
    if (!requiredString(name, 200)) return res.status(400).json({ error: "invalid_name" });
    if (!optionalString(note, 2000)) return res.status(400).json({ error: "invalid_note" });

    const row = await createProject({ id, userId: uid, name, note });
    // аудит необязателен, не должен ломать запрос
    try { await req.app.locals?.audit?.(uid, "create_project", "projects", row.id, { name, note }); } catch {}
    res.status(201).json(row);
});

/**
 * GET /v1/projects/:id — JSON-дерево проекта
 */
router.get("/:id", async (req, res) => {
    const uid = req.user.uid;
    const id = req.params.id;
    if (!isUuidV4(id)) return res.status(400).json({ error: "invalid_id" });

    const tree = await getProjectTree({ userId: uid, projectId: id });
    if (!tree) return res.status(404).json({ error: "not_found" });
    res.json(tree);
});

/**
 * PUT /v1/projects/:id — { name?, note? }
 */
router.put("/:id", async (req, res) => {
    const uid = req.user.uid;
    const id = req.params.id;
    if (!isUuidV4(id)) return res.status(400).json({ error: "invalid_id" });

    const { name, note } = req.body || {};
    if (name != null && !requiredString(name, 200)) return res.status(400).json({ error: "invalid_name" });
    if (note != null && !optionalString(note, 2000)) return res.status(400).json({ error: "invalid_note" });

    const row = await updateProjectMeta({ userId: uid, projectId: id, name, note });
    if (!row) return res.status(404).json({ error: "not_found" });

    try { await req.app.locals?.audit?.(uid, "update_project", "projects", id, { name, note }); } catch {}
    res.json(row);
});

/**
 * DELETE /v1/projects/:id — мягкое удаление
 */
router.delete("/:id", async (req, res) => {
    const uid = req.user.uid;
    const id = req.params.id;
    if (!isUuidV4(id)) return res.status(400).json({ error: "invalid_id" });

    const row = await softDeleteProject({ userId: uid, projectId: id });
    if (!row) return res.status(404).json({ error: "not_found" });

    try { await req.app.locals?.audit?.(uid, "delete_project", "projects", id, {}); } catch {}
    res.json(row);
});

/**
 * GET /v1/projects/:id/delta?since=timestamp
 */
router.get(
    "/:id/delta",
    tokenBucket({ limitPerMin: +(process.env.RATE_LIMIT_DELTA_PER_MIN || 60), name: "delta" }),
    async (req, res) => {
        const uid = req.user.uid;
        const id = req.params.id;
        if (!isUuidV4(id)) return res.status(400).json({ error: "invalid_id" });

        const since = req.query.since && isIsoDate(req.query.since) ? req.query.since : "1970-01-01T00:00:00Z";
        const delta = await getDelta({ userId: uid, projectId: id, since });
        if (!delta) return res.status(404).json({ error: "not_found" });
        res.json(delta);
    }
);

/**
 * POST /v1/projects/:id/batch
 * Body:
 * {
 *   "baseVersion": 12,
 *   "ops": {
 *     "rooms":   {"upsert": [...], "delete": ["uuid1"]},
 *     "groups":  {"upsert": [...], "delete": [...]},
 *     "devices": {"upsert": [...], "delete": [...]}
 *   }
 * }
 */
router.post(
    "/:id/batch",
    tokenBucket({ limitPerMin: +(process.env.RATE_LIMIT_BATCH_PER_MIN || 30), name: "batch" }),
    async (req, res) => {
        const uid = req.user.uid;
        const id = req.params.id;
        if (!isUuidV4(id)) return res.status(400).json({ error: "invalid_id" });

        const { baseVersion, ops } = req.body || {};
        if (baseVersion != null && typeof baseVersion !== "number") {
            return res.status(400).json({ error: "invalid_baseVersion" });
        }
        if (ops && typeof ops !== "object") return res.status(400).json({ error: "invalid_ops" });

        const result = await applyBatch({ userId: uid, projectId: id, baseVersion, ops });
        if (result.notFound) return res.status(404).json({ error: "not_found" });
        res.json({ newVersion: result.newVersion, conflicts: result.conflicts });
    }
);

export default router;