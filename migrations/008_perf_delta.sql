-- 008_perf_delta.sql

-- для /delta и /tree
CREATE INDEX IF NOT EXISTS idx_rooms_project_updated
    ON rooms(project_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_devices_project_updated
    ON devices(project_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_groups_project_updated
    ON groups(project_id, updated_at);

-- для идемпотентного поиска устройств по room_id в meta
CREATE INDEX IF NOT EXISTS idx_devices_project_room_name_live
    ON devices (project_id, (meta->>'room_id'), name)
    WHERE is_deleted = false;

-- (опционально) для комнат по имени
CREATE INDEX IF NOT EXISTS idx_rooms_project_name_live
    ON rooms (project_id, name)
    WHERE is_deleted = false;