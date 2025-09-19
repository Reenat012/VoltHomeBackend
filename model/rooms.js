// models/rooms.js
import { query } from "../db/pool.js";

export async function upsertRooms(projectId, userId, items) {
    if (!items?.length) return [];
    const values = [];
    const params = [];
    let i = 1;
    for (const r of items) {
        values.push(`(COALESCE($${i++}, uuid_generate_v4()), $${i++}, $${i++}, $${i++}, now(), false)`);
        params.push(r.id || null, projectId, r.name, r.meta ? JSON.stringify(r.meta) : null);
    }
    const sql = `
    INSERT INTO rooms(id, project_id, name, meta, updated_at, is_deleted)
    VALUES ${values.join(",")}
    ON CONFLICT (id) DO UPDATE SET
      project_id=EXCLUDED.project_id,
      name=COALESCE(EXCLUDED.name, rooms.name),
      meta=COALESCE(EXCLUDED.meta, rooms.meta),
      updated_at=now(),
      is_deleted=false
    RETURNING id, project_id, name, meta, updated_at, is_deleted;
  `;
    const res = await query(sql, params);
    return res.rows;
}

export async function deleteRooms(projectId, ids) {
    if (!ids?.length) return [];
    const res = await query(
        `UPDATE rooms SET is_deleted=true, updated_at=now()
     WHERE project_id=$1 AND id = ANY($2::uuid[])
     RETURNING id`,
        [projectId, ids]
    );
    return res.rows.map(r => r.id);
}

export async function deltaRooms(projectId, sinceIso) {
    const res = await query(
        `SELECT id, project_id, name, meta, updated_at, is_deleted
     FROM rooms WHERE project_id=$1 AND updated_at > $2
     ORDER BY updated_at ASC`,
        [projectId, sinceIso]
    );
    return res.rows;
}

export async function getRoomsByProject(projectId) {
    const res = await query(
        `SELECT id, name, meta, updated_at, is_deleted
     FROM rooms WHERE project_id=$1`,
        [projectId]
    );
    return res.rows;
}