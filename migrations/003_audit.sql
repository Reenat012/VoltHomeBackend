-- 003_audit.sql
-- Простой аудит изменений по ключевым операциям.

BEGIN;

CREATE TABLE IF NOT EXISTS audit_log
(
    id
    BIGSERIAL
    PRIMARY
    KEY,
    user_id
    TEXT
    NOT
    NULL,
    action
    TEXT
    NOT
    NULL, -- create_project | update_project | delete_project | batch | ...
    entity
    TEXT, -- projects | rooms | groups | devices
    entity_id
    UUID,
    detail
    JSONB,
    created_at
    TIMESTAMPTZ
    NOT
    NULL
    DEFAULT
    now
(
)
    );

-- DOWN
DROP TABLE IF EXISTS audit_log;