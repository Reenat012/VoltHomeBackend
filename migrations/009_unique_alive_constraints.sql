-- 009_unique_alive_constraints.sql
-- ИСПРАВЛЕНО (этап 21 плана): раньше ниже шли блоки `ADD CONSTRAINT ... UNIQUE USING INDEX`, но PostgreSQL не позволяет
-- превращать в ограничение индексы с выражением и условием, поэтому миграция не применялась на чистую базу.
-- Уникальные индексы остаются; код использует их без ON CONSTRAINT.
-- Уникальные ограничения для UPSERT по "живым" сущностям

BEGIN;

-- ROOMS: уникальность имени в проекте среди не удалённых
CREATE UNIQUE INDEX IF NOT EXISTS ux_rooms_project_name_alive
    ON rooms (project_id, lower(name))
    WHERE is_deleted = false;


-- DEVICES: уникальность (project_id, meta->>'room_id', lower(name)) среди не удалённых
CREATE UNIQUE INDEX IF NOT EXISTS ux_devices_project_room_name_alive
    ON devices (project_id, (meta->>'room_id'), lower(name))
    WHERE is_deleted = false;


COMMIT;