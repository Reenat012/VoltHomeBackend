-- 010_drop_device_name_uniques.sql

-- Удаляем частичный уникальный индекс по имени для devices, если он остался
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  c.relkind = 'i'
      AND  c.relname = 'ux_devices_project_room_name_alive'
  ) THEN
    EXECUTE 'DROP INDEX ux_devices_project_room_name_alive';
END IF;
END $$;

-- На будущее: ставим НЕуникальный индекс для быстрых поисков по имени
-- (lower(name) + project_id), чтобы не тормозить GET /devices?name=
CREATE INDEX IF NOT EXISTS ix_devices_project_lower_name
    ON devices (project_id, lower(name));

-- Можно добавить индекс по meta->>'room_id', если часто фильтруешь по комнате:
-- CREATE INDEX IF NOT EXISTS ix_devices_project_room
--   ON devices (project_id, (meta->>'room_id'));