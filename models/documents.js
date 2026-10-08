// models/documents.js
// Документы проекта с оптимистичной блокировкой (docs/SYNC_CONTRACT.md, разделы 7 и 8).
import { query, withTransaction } from "../db/pool.js";

/** Допустимые виды документов и право (capability), которое нужно для доступа. null = свободный. */
export const DOCUMENT_KINDS = {
    setup: null,
    cable_defaults: "cableLineCalculation",
    phase_overrides: "phaseDragAndDrop",
    apparatus_selections: "projectEstimate",
    estimate_items: "projectEstimate",
    panel_layout: "panelVisualization",
};

/** Сколько последних версий каждого документа хранится для отката. */
export const HISTORY_LIMIT = Number(process.env.DOCUMENT_HISTORY_LIMIT || 20);

function conflictError(code, extra) {
    const err = new Error(code);
    err.status = 409;
    err.code = code;
    err.expose = true;
    err.extra = extra;
    return err;
}

const DOC_COLUMNS = "project_id, kind, version, schema_version, data, is_deleted, updated_by, updated_at";

export async function getDocument(projectId, kind) {
    const res = await query(`SELECT ${DOC_COLUMNS} FROM project_documents WHERE project_id = $1 AND kind = $2`, [
        projectId,
        kind,
    ]);
    return res.rows[0] || null;
}

/** Список документов проекта без самих данных (включая удалённые: так другие устройства узнают об удалении). */
export async function listDocuments(projectId) {
    const res = await query(
        `SELECT kind, version, schema_version, is_deleted, updated_at
         FROM project_documents WHERE project_id = $1 ORDER BY kind`,
        [projectId]
    );
    return res.rows;
}

/** Поднимает версию и время проекта, чтобы клиенты увидели изменение при опросе списка проектов. */
async function touchProject(client, projectId) {
    await client.query(`UPDATE projects SET version = version + 1, updated_at = now() WHERE id = $1`, [projectId]);
}

async function recordVersion(client, row, historyLimit) {
    await client.query(
        `INSERT INTO project_document_versions (project_id, kind, version, schema_version, data, is_deleted, updated_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [row.project_id, row.kind, row.version, row.schema_version, JSON.stringify(row.data), row.is_deleted, row.updated_by]
    );
    await client.query(
        `DELETE FROM project_document_versions WHERE project_id = $1 AND kind = $2 AND version <= $3`,
        [row.project_id, row.kind, row.version - historyLimit]
    );
}

/**
 * Запись документа. baseVersion = 0 создаёт документ, иначе должен совпадать с текущей версией.
 * Бросает 409 version_conflict (устаревшая версия) или schema_downgrade (старый клиент не затирает новую схему).
 */
export async function putDocument({ projectId, kind, baseVersion, schemaVersion, data, userId, historyLimit = HISTORY_LIMIT }) {
    return withTransaction(async (client) => {
        const cur = (
            await client.query(
                `SELECT ${DOC_COLUMNS} FROM project_documents WHERE project_id = $1 AND kind = $2 FOR UPDATE`,
                [projectId, kind]
            )
        ).rows[0];

        let row;
        if (!cur) {
            if (baseVersion !== 0) throw conflictError("version_conflict", { serverVersion: 0, serverUpdatedAt: null });
            const ins = await client.query(
                `INSERT INTO project_documents (project_id, kind, version, schema_version, data, updated_by)
                 VALUES ($1, $2, 1, $3, $4::jsonb, $5)
                 ON CONFLICT (project_id, kind) DO NOTHING
                 RETURNING ${DOC_COLUMNS}`,
                [projectId, kind, schemaVersion, JSON.stringify(data), userId]
            );
            if (ins.rowCount === 0) {
                // одновременное создание: победил другой запрос
                throw conflictError("version_conflict", { serverVersion: 1, serverUpdatedAt: null });
            }
            row = ins.rows[0];
        } else {
            if (baseVersion !== cur.version) {
                throw conflictError("version_conflict", {
                    serverVersion: cur.version,
                    serverUpdatedAt: cur.updated_at,
                });
            }
            if (schemaVersion < cur.schema_version) {
                throw conflictError("schema_downgrade", { serverSchemaVersion: cur.schema_version });
            }
            const upd = await client.query(
                `UPDATE project_documents
                 SET version = version + 1, schema_version = $3, data = $4::jsonb, is_deleted = FALSE,
                     updated_by = $5, updated_at = now()
                 WHERE project_id = $1 AND kind = $2
                 RETURNING ${DOC_COLUMNS}`,
                [projectId, kind, schemaVersion, JSON.stringify(data), userId]
            );
            row = upd.rows[0];
        }
        await recordVersion(client, row, historyLimit);
        await touchProject(client, projectId);
        return row;
    });
}

/** Мягкое удаление: данные и история остаются, версия растёт, другие устройства увидят is_deleted. */
export async function deleteDocument({ projectId, kind, baseVersion = null, userId, historyLimit = HISTORY_LIMIT }) {
    return withTransaction(async (client) => {
        const cur = (
            await client.query(
                `SELECT ${DOC_COLUMNS} FROM project_documents WHERE project_id = $1 AND kind = $2 FOR UPDATE`,
                [projectId, kind]
            )
        ).rows[0];
        if (!cur || cur.is_deleted) return null;
        if (baseVersion !== null && baseVersion !== cur.version) {
            throw conflictError("version_conflict", { serverVersion: cur.version, serverUpdatedAt: cur.updated_at });
        }
        const upd = await client.query(
            `UPDATE project_documents SET version = version + 1, is_deleted = TRUE, updated_by = $3, updated_at = now()
             WHERE project_id = $1 AND kind = $2
             RETURNING ${DOC_COLUMNS}`,
            [projectId, kind, userId]
        );
        await recordVersion(client, upd.rows[0], historyLimit);
        await touchProject(client, projectId);
        return upd.rows[0];
    });
}

export async function listVersions(projectId, kind) {
    const res = await query(
        `SELECT version, schema_version, is_deleted, updated_by, updated_at
         FROM project_document_versions WHERE project_id = $1 AND kind = $2 ORDER BY version DESC`,
        [projectId, kind]
    );
    return res.rows;
}

export async function getVersion(projectId, kind, version) {
    const res = await query(
        `SELECT project_id, kind, version, schema_version, data, is_deleted, updated_by, updated_at
         FROM project_document_versions WHERE project_id = $1 AND kind = $2 AND version = $3`,
        [projectId, kind, version]
    );
    return res.rows[0] || null;
}
