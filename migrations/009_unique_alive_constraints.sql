-- 009_unique_alive_constraints.sql
-- Уникальные ограничения для UPSERT по "живым" сущностям

BEGIN;

-- ROOMS: уникальность имени в проекте среди не удалённых
CREATE UNIQUE INDEX IF NOT EXISTS ux_rooms_project_name_alive
    ON rooms (project_id, lower(name))
    WHERE is_deleted = false;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ux_rooms_project_name_alive'
    ) THEN
ALTER TABLE rooms
    ADD CONSTRAINT ux_rooms_project_name_alive
        UNIQUE USING INDEX ux_rooms_project_name_alive;
END IF;
END$$;

-- DEVICES: уникальность (project_id, meta->>'room_id', lower(name)) среди не удалённых
CREATE UNIQUE INDEX IF NOT EXISTS ux_devices_project_room_name_alive
    ON devices (project_id, (meta->>'room_id'), lower(name))
    WHERE is_deleted = false;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ux_devices_project_room_name_alive'
    ) THEN
ALTER TABLE devices
    ADD CONSTRAINT ux_devices_project_room_name_alive
        UNIQUE USING INDEX ux_devices_project_room_name_alive;
END IF;
END$$;

COMMIT;