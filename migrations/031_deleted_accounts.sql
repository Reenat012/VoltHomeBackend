-- 031_deleted_accounts.sql
-- Удалённые аккаунты (этап 24: «Удалить аккаунт и данные»). Нужны, чтобы выданный до удаления access-токен
-- (живёт до 30 минут) перестал работать сразу, а не только по истечении. uid не используются повторно.

BEGIN;

CREATE TABLE IF NOT EXISTS deleted_accounts (
    uid        TEXT        PRIMARY KEY,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;

-- DOWN
DROP TABLE IF EXISTS deleted_accounts;
