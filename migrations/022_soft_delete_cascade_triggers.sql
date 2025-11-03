-- 022_soft_delete_cascade_triggers.sql
BEGIN;

-- Функция: каскад soft-delete от rooms к groups и devices
CREATE OR REPLACE FUNCTION public.soft_cascade_from_rooms()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Срабатывает только при переходе is_deleted: false -> true
  IF (NEW.is_deleted = TRUE AND COALESCE(OLD.is_deleted, FALSE) = FALSE) THEN
    -- 1) Помечаем группы комнаты
UPDATE public."groups"
SET is_deleted = TRUE,
    updated_at = NOW()
WHERE room_id = NEW.id
  AND is_deleted = FALSE;

-- 2) Помечаем устройства всех групп этой комнаты
UPDATE public.devices d
SET is_deleted = TRUE,
    updated_at = NOW()
WHERE d.group_id IN (
    SELECT g.id FROM public."groups" g WHERE g.room_id = NEW.id
)
  AND d.is_deleted = FALSE;
END IF;

RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_soft_cascade_from_rooms ON public.rooms;
CREATE TRIGGER trg_soft_cascade_from_rooms
    AFTER UPDATE ON public.rooms
    FOR EACH ROW
    EXECUTE FUNCTION public.soft_cascade_from_rooms();



-- Функция: каскад soft-delete от groups к devices
CREATE OR REPLACE FUNCTION public.soft_cascade_from_groups()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.is_deleted = TRUE AND COALESCE(OLD.is_deleted, FALSE) = FALSE) THEN
UPDATE public.devices
SET is_deleted = TRUE,
    updated_at = NOW()
WHERE group_id = NEW.id
  AND is_deleted = FALSE;
END IF;

RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_soft_cascade_from_groups ON public."groups";
CREATE TRIGGER trg_soft_cascade_from_groups
    AFTER UPDATE ON public."groups"
    FOR EACH ROW
    EXECUTE FUNCTION public.soft_cascade_from_groups();

COMMIT;