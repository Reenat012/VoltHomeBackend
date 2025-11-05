-- 024_uuid_pgcrypto.sql
BEGIN;

-- На случай отсутствия: включаем pgcrypto
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Переключаем дефолты на gen_random_uuid()
ALTER TABLE projects ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE rooms    ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE groups   ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE devices  ALTER COLUMN id SET DEFAULT gen_random_uuid();

COMMIT;

-- DOWN (необязателен; оставляем gen_random_uuid)