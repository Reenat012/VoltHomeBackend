-- 029_client_updated_at.sql
-- Время изменения записи на клиенте (UTC). Нужно для правила «последний победил по записи»
-- (docs/SYNC_CONTRACT.md, раздел 8). updated_at по-прежнему время прихода на сервер (по нему считается дельта).

BEGIN;

ALTER TABLE rooms   ADD COLUMN IF NOT EXISTS client_updated_at TIMESTAMPTZ NULL;
ALTER TABLE "groups" ADD COLUMN IF NOT EXISTS client_updated_at TIMESTAMPTZ NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS client_updated_at TIMESTAMPTZ NULL;

COMMIT;

-- DOWN
ALTER TABLE devices DROP COLUMN IF EXISTS client_updated_at;
ALTER TABLE "groups" DROP COLUMN IF EXISTS client_updated_at;
ALTER TABLE rooms   DROP COLUMN IF EXISTS client_updated_at;
