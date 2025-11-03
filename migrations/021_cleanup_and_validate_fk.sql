-- 021_cleanup_and_validate_fk.sql
BEGIN;

-- 1) Удаляем devices без существующей группы
DELETE FROM public.devices d
WHERE d.group_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public."groups" g WHERE g.id = d.group_id
);

-- 2) Удаляем groups без существующей комнаты
DELETE FROM public."groups" g
WHERE g.room_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.rooms r WHERE r.id = g.room_id
);

-- 3) (Опционально) Мягко помечаем потомков удалёнными, если родитель soft-deleted
--    Это НЕ влияет на валидацию FK, но улучшает согласованность доменной модели.
UPDATE public."groups" g
SET    is_deleted = TRUE,
       updated_at = NOW()
    FROM   public.rooms r
WHERE  g.room_id = r.id
  AND  r.is_deleted = TRUE
  AND  g.is_deleted = FALSE;

UPDATE public.devices d
SET    is_deleted = TRUE,
       updated_at = NOW()
    FROM   public."groups" g
WHERE  d.group_id = g.id
  AND  g.is_deleted = TRUE
  AND  d.is_deleted = FALSE;

-- 4) Валидируем новые FK (лёгкая блокировка; таблицы доступны для чтения/записи)
ALTER TABLE public."groups"  VALIDATE CONSTRAINT groups_room_id_fkey;
ALTER TABLE public.devices   VALIDATE CONSTRAINT devices_group_id_fkey;

COMMIT;