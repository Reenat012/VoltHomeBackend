-- 020_add_fk_cascade_not_valid.sql
BEGIN;

-- 1) Удаляем старые FK groups -> rooms и devices -> groups (если есть), не зная точных имён.
DO $$
DECLARE
rec RECORD;
BEGIN
  -- Все FK у таблицы groups, которые ссылаются на rooms(id)
FOR rec IN
SELECT c.conname
FROM   pg_constraint c
           JOIN   pg_class     tc ON tc.oid = c.conrelid   -- table (child)
           JOIN   pg_namespace ns ON ns.oid = tc.relnamespace
           JOIN   pg_class     rc ON rc.oid = c.confrelid  -- referenced (parent)
WHERE  ns.nspname = 'public'
  AND tc.relname = 'groups'
  AND rc.relname = 'rooms'
  AND c.contype = 'f'
    LOOP
    EXECUTE format('ALTER TABLE public."groups" DROP CONSTRAINT %I;', rec.conname);
END LOOP;

  -- Все FK у таблицы devices, которые ссылаются на groups(id)
FOR rec IN
SELECT c.conname
FROM   pg_constraint c
           JOIN   pg_class     tc ON tc.oid = c.conrelid
           JOIN   pg_namespace ns ON ns.oid = tc.relnamespace
           JOIN   pg_class     rc ON rc.oid = c.confrelid
WHERE  ns.nspname = 'public'
  AND tc.relname = 'devices'
  AND rc.relname = 'groups'
  AND c.contype = 'f'
    LOOP
    EXECUTE format('ALTER TABLE public.devices DROP CONSTRAINT %I;', rec.conname);
END LOOP;
END $$;

-- 2) Добавляем новые FK с каскадом (NOT VALID — чтобы не блокировать DML и дать время на очистку)
ALTER TABLE public."groups"
    ADD CONSTRAINT groups_room_id_fkey
        FOREIGN KEY (room_id) REFERENCES public.rooms(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.devices
    ADD CONSTRAINT devices_group_id_fkey
        FOREIGN KEY (group_id) REFERENCES public."groups"(id) ON DELETE CASCADE NOT VALID;

COMMIT;