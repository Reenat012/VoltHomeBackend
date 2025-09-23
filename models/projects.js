// models/projects.js
import { query } from "../db/pool.js";

export async function createProject({ id, userId, name, note }) {
    const res = await query(
        `INSERT INTO projects(id, user_id, name, note)
         VALUES (COALESCE($1, uuid_generate_v4()), $2, $3, $4)
             RETURNING id, user_id, name, note, version, updated_at, is_deleted`,
        [id || null, userId, name, note || null]
    );
    return res.rows[0];
}

export async function listProjects({ userId, since, limit }) {
    // ВАЖНО: предикат устойчив к NULL — если since не задан, не фильтруем по updated_at
    const res = await query(
        `SELECT id, name, note, version, updated_at, is_deleted
         FROM projects
         WHERE user_id = $1
           AND ($2::timestamptz IS NULL OR updated_at > $2::timestamptz)
         ORDER BY updated_at ASC
             LIMIT $3`,
        [userId, since || null, limit]
    );
    return res.rows;
}

export async function getProjectMeta({ userId, projectId }) {
    const res = await query(
        `SELECT id, user_id, name, note, version, updated_at, is_deleted
         FROM projects WHERE id=$1 AND user_id=$2 LIMIT 1`,
        [projectId, userId]
    );
    return res.rows[0] || null;
}

export async function updateProjectMeta({ userId, projectId, name, note }) {
    const res = await query(
        `UPDATE projects
         SET name=COALESCE($3, name),
             note=COALESCE($4, note),
             version=version+1,
             updated_at=now()
         WHERE id=$1 AND user_id=$2
             RETURNING id, name, note, version, updated_at, is_deleted`,
        [projectId, userId, name || null, note || null]
    );
    return res.rows[0] || null;
}

export async function softDeleteProject({ userId, projectId }) {
    const res = await query(
        `UPDATE projects
         SET is_deleted=true, version=version+1, updated_at=now()
         WHERE id=$1 AND user_id=$2
             RETURNING id, name, note, version, updated_at, is_deleted`,
        [projectId, userId]
    );
    return res.rows[0] || null;
}