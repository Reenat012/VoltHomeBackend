// routes/projects.js
import express from "express";
import crypto from "crypto";
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

// 👇 работа с устройствами (не меняли)
import {
    getDevicesByProject,
    getDevicesByNameCI,
    upsertDevices,
    deleteDevices,
} from "../models/devices.js";

const router = express.Router();

// Все ручки требуют Bearer
router.use(authMiddleware);

/* ============================================
 * GET /v1/projects — список с пагинацией
 * ============================================ */
router.get("/", async (req, res) => {
    try {
        const uid = req.user.uid;
        const since = req.query.since && isIsoDate(req.query.since) ? req.query.since : null;
        const limit = parseLimit(req.query.limit, 100);
        const items = await listProjects({ userId: uid, since, limit });
        const next = items.length === limit ? items[items.length - 1].updated_at : null;
        res.json({ items, next });
    } catch (err) {
        const isTimeout = err?.code === "57014" || /statement timeout/i.test(err?.message || "");
        console.error("[GET /v1/projects] error:", err?.message || err, "| code:", err?.code);
        res.status(isTimeout ? 503 : 500).json({ error: isTimeout ? "db_timeout" : "server_error" });
    }
});

/* ============================================
 * GET /v1/projects/:id/tree — snapshot проекта
 * ============================================ */
router.get("/:id/tree", async (req, res) => {
    const uid = req.user.uid;
    const id = req.params.id;
    if (!isUuidV4(id)) return res.status(400).json({ error: "invalid_id" });
    try {
        const tree = await getProjectTree({ userId: uid, projectId: id });
        if (tree?.notFound) return res.status(404).json({ error: "not_found" });
        res.json(tree);
    } catch (err) {
        const isTimeout = err?.code === "57014" || /statement timeout/i.test(err?.message || "");
        console.error("[GET /v1/projects/:id/tree] error:", err?.message || err, "| code:", err?.code);
        res.status(isTimeout ? 503 : 500).json({ error: isTimeout ? "db_timeout" : "server_error" });
    }
});

/* =========================================================
 * POST /v1/projects/:id/batch — ПАТЧ С НОРМАЛИЗАЦИЕЙ ID
 * ========================================================= */
router.post("/:id/batch", async (req, res) => {
    const uid = req.user.uid;
    const id = req.params.id;
    if (!isUuidV4(id)) return res.status(400).json({ error: "invalid_id" });

    // МЯГКАЯ нормализация входа: devices.upsert[*].id → всегда валидный UUID
    // + поверхностная валидация name
    const body = req.body || {};
    const ops = body.ops && typeof body.ops === "object" ? { ...body.ops } : null;

    if (ops?.devices?.upsert?.length) {
        const norm = [];
        for (let i = 0; i < ops.devices.upsert.length; i++) {
            const d = ops.devices.upsert[i] || {};
            const idOk = typeof d.id === "string" && d.id.length > 0 && isUuidV4(d.id);
            const ensuredId = idOk ? d.id : crypto.randomUUID(); // снимаем зависимость от SQL-функций
            if (typeof d.name !== "string" || !d.name.trim()) {
                return res.status(400).json({
                    error: "bad_request",
                    message: `devices.upsert[${i}].name is required`,
                });
            }
            norm.push({ ...d, id: ensuredId });
        }
        ops.devices = { ...ops.devices, upsert: norm };
    }

    const baseVersion = typeof body.baseVersion === "number" ? body.baseVersion : null;

    try {
        const result = await applyBatch({ userId: uid, projectId: id, baseVersion, ops });

        // best-effort аудит
        try {
            const opsCount =
                ops && typeof ops === "object"
                    ? Object.values(ops).reduce(
                        (n, v) => n + (v?.upsert?.length || 0) + (v?.delete?.length || 0),
                        0
                    )
                    : 0;
            await req.app.locals?.audit?.(uid, "apply_batch", "projects", id, { baseVersion, opsCount });
        } catch {}

        return res.json(result);
    } catch (err) {
        const isTimeout = err?.code === "57014" || /statement timeout/i.test(err?.message || "");

        // Развёрнутый лог + correlation id
        const cid = crypto.randomUUID();
        console.error(
            "[POST /v1/projects/:id/batch] error:",
            err?.message || err,
            "| code:", err?.code,
            "| detail:", err?.detail,
            "| constraint:", err?.constraint,
            "| table:", err?.table,
            "| cid:", cid
        );

        // PG → 400
        if (err?.code === "23502") {
            return res.status(400).json({ error: "bad_request", message: err?.detail || "not_null_violation", cid });
        }
        if (err?.code === "23503") {
            return res.status(400).json({ error: "bad_request", message: err?.detail || "foreign_key_violation", cid });
        }
        if (err?.code === "23505") {
            return res.status(400).json({ error: "bad_request", message: err?.detail || "unique_violation", cid });
        }

        return res.status(isTimeout ? 503 : 500).json({
            error: isTimeout ? "db_timeout" : "server_error",
            cid,
        });
    }
});

/* остальной код роутера (GET delta, meta и т.д.) без изменений */

export default router;