BEGIN;

-- Гарантируем уникальность ровно одной дефолтной группы на комнату в проекте.
-- Частичный уникальный индекс (живые группы с именем '__default__').
CREATE UNIQUE INDEX IF NOT EXISTS ux_groups_project_room_default
    ON public."groups"(project_id, room_id)
    WHERE is_deleted = FALSE AND name = '__default__';

COMMIT;