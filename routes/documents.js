// routes/documents.js
// Документы проекта: GET/PUT/DELETE /v1/projects/:id/documents[/:kind]
// Контракт: docs/SYNC_CONTRACT.md, разделы 5, 7 и 8. Сервер хранит JSON как есть и не интерпретирует.
import express from "express";
import { getProjectMeta } from "../models/projects.js";
import { DOCUMENT_KINDS, getDocument, listDocuments, putDocument, deleteDocument } from "../models/documents.js";
import { resolvePlan, buildCapabilities } from "../services/planService.js";
import { isUuidV4 } from "../utils/validation.js";

const router = express.Router({ mergeParams: true });

function httpError(status, code, message, extra) {
    const err = new Error(message || code);
    err.status = status;
    err.code = code;
    err.expose = true;
    err.extra = extra;
    return err;
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Для каждого запроса: проект существует, принадлежит пользователю и не удалён; считаем права по плану. */
router.use(async (req, res, next) => {
    try {
        const projectId = req.params.id;
        if (!isUuidV4(projectId)) throw httpError(400, "invalid_id");
        const meta = await getProjectMeta({ userId: req.user.uid, projectId });
        if (!meta || meta.is_deleted) throw httpError(404, "not_found");

        let plan = "free";
        try {
            plan = (await resolvePlan(req.user.uid)).plan;
        } catch (e) {
            console.error("[documents] plan error:", e?.message || e);
        }
        req.projectId = projectId;
        req.capabilities = buildCapabilities(plan);
        next();
    } catch (err) {
        next(err);
    }
});

function checkKind(req) {
    const { kind } = req.params;
    if (!Object.prototype.hasOwnProperty.call(DOCUMENT_KINDS, kind)) {
        throw httpError(400, "invalid_kind", `Неизвестный вид документа: ${kind}`);
    }
    const feature = DOCUMENT_KINDS[kind];
    if (feature && !req.capabilities[feature]) {
        throw httpError(402, "pro_required", "Нужна подписка PRO", { feature });
    }
    return kind;
}

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

const present = (row) => ({
    kind: row.kind,
    version: row.version,
    schemaVersion: row.schema_version,
    updatedAt: row.updated_at,
});

/** GET /documents: список без данных. locked = нет права (данные сохранены, но недоступны), deleted = удалён. */
router.get(
    "/",
    wrap(async (req, res) => {
        const rows = await listDocuments(req.projectId);
        res.json({
            items: rows.map((r) => {
                const feature = DOCUMENT_KINDS[r.kind];
                return {
                    kind: r.kind,
                    version: r.version,
                    schemaVersion: r.schema_version,
                    updatedAt: r.updated_at,
                    deleted: r.is_deleted,
                    locked: Boolean(feature && !req.capabilities[feature]),
                };
            }),
        });
    })
);

router.get(
    "/:kind",
    wrap(async (req, res) => {
        const kind = checkKind(req);
        const doc = await getDocument(req.projectId, kind);
        if (!doc || doc.is_deleted) throw httpError(404, "not_found");
        res.json({ ...present(doc), data: doc.data });
    })
);

router.put(
    "/:kind",
    wrap(async (req, res) => {
        const kind = checkKind(req);
        const { baseVersion, schemaVersion, data } = req.body || {};
        if (!Number.isInteger(baseVersion) || baseVersion < 0) {
            throw httpError(400, "invalid_request", "baseVersion: целое число, 0 для нового документа");
        }
        if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 10000) {
            throw httpError(400, "invalid_request", "schemaVersion: целое число от 1");
        }
        if (!isPlainObject(data)) {
            throw httpError(422, "invalid_document", "data должен быть объектом JSON");
        }
        if (kind === "panel_layout") {
            if (!Number.isInteger(data.schemaVersion)) {
                throw httpError(422, "invalid_document", "В data щита нужно целое поле schemaVersion");
            }
            if (data.schemaVersion !== schemaVersion) {
                throw httpError(422, "invalid_document", "schemaVersion в data и в запросе должны совпадать");
            }
        }
        const row = await putDocument({
            projectId: req.projectId,
            kind,
            baseVersion,
            schemaVersion,
            data,
            userId: req.user.uid,
        });
        await req.app.locals?.audit?.(req.user.uid, "put_document", "projects", req.projectId, {
            kind,
            version: row.version,
        });
        res.json({ version: row.version, schemaVersion: row.schema_version, updatedAt: row.updated_at });
    })
);

router.delete(
    "/:kind",
    wrap(async (req, res) => {
        const kind = checkKind(req);
        let baseVersion = null;
        if (req.query.baseVersion !== undefined) {
            baseVersion = Number(req.query.baseVersion);
            if (!Number.isInteger(baseVersion) || baseVersion < 0) {
                throw httpError(400, "invalid_request", "baseVersion: целое число");
            }
        }
        const row = await deleteDocument({ projectId: req.projectId, kind, baseVersion, userId: req.user.uid });
        if (!row) throw httpError(404, "not_found");
        await req.app.locals?.audit?.(req.user.uid, "delete_document", "projects", req.projectId, {
            kind,
            version: row.version,
        });
        res.json({ version: row.version });
    })
);

/** Ошибки этого роутера: прикладные (expose) и ошибки данных PostgreSQL. */
router.use((err, req, res, next) => {
    if (err?.expose && err?.status) {
        return res.status(err.status).json({ error: err.code, message: err.message, ...(err.extra || {}) });
    }
    if (err?.code === "22P05" || err?.code === "22P02") {
        return res.status(422).json({ error: "invalid_document", message: "Данные содержат недопустимые символы" });
    }
    console.error("[documents] error:", err?.message || err);
    return res.status(500).json({ error: "server_error" });
});

export default router;
