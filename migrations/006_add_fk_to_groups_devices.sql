-- 006_add_fk_to_groups_devices.sql
-- Вариант B: 001 уже применялась, столбцы есть, навешиваем FK.
BEGIN;

-- 1) Санитация: обнуляем "висячие" ссылки, чтобы ALTER не упал
-- groups.room_id → rooms(id)
UPDATE groups g
SET room_id = NULL
WHERE room_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.id = g.room_id);

-- devices.group_id → groups(id)
UPDATE devices d
SET group_id = NULL
WHERE group_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = d.group_id);

-- 2) FK для groups.room_id → rooms(id) ON DELETE CASCADE
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'groups'
      AND constraint_type = 'FOREIGN KEY'
      AND constraint_name = 'groups_room_id_fkey'
  ) THEN
ALTER TABLE groups
    ADD CONSTRAINT groups_room_id_fkey
        FOREIGN KEY (room_id) REFERENCES rooms(id)
            ON DELETE CASCADE;
END IF;
END $$;

-- 3) FK для devices.group_id → groups(id) ON DELETE SET NULL
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'devices'
      AND constraint_type = 'FOREIGN KEY'
      AND constraint_name = 'devices_group_id_fkey'
  ) THEN
ALTER TABLE devices
    ADD CONSTRAINT devices_group_id_fkey
        FOREIGN KEY (group_id) REFERENCES groups(id)
            ON DELETE SET NULL;
END IF;
END $$;

COMMIT;

-- DOWN (опционально)
-- ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_group_id_fkey;
-- ALTER TABLE groups  DROP CONSTRAINT IF EXISTS groups_room_id_fkey;