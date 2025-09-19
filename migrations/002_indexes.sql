-- 002_indexes.sql
-- Индексы под дельта-синхронизацию и выборки.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_projects_user_updated ON projects(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_user_deleted ON projects(user_id, is_deleted);

CREATE INDEX IF NOT EXISTS idx_rooms_project_updated ON rooms(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_rooms_project_deleted ON rooms(project_id, is_deleted);

CREATE INDEX IF NOT EXISTS idx_groups_project_updated ON groups(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_groups_project_deleted ON groups(project_id, is_deleted);

CREATE INDEX IF NOT EXISTS idx_devices_project_updated ON devices(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_devices_project_deleted ON devices(project_id, is_deleted);

-- DOWN
DROP INDEX IF EXISTS idx_devices_project_deleted;
DROP INDEX IF EXISTS idx_devices_project_updated;
DROP INDEX IF EXISTS idx_groups_project_deleted;
DROP INDEX IF EXISTS idx_groups_project_updated;
DROP INDEX IF EXISTS idx_rooms_project_deleted;
DROP INDEX IF EXISTS idx_rooms_project_updated;
DROP INDEX IF EXISTS idx_projects_user_deleted;
DROP INDEX IF EXISTS idx_projects_user_updated;