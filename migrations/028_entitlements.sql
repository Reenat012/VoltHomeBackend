-- 028_entitlements.sql
-- Ручная выдача PRO (этап 22.9 плана). Подписки RuStore остаются в subscriptions и здесь не подделываются.
-- Управляется только консольными командами на сервере (scripts/admin.js).

BEGIN;

CREATE TABLE IF NOT EXISTS entitlements (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     TEXT        NOT NULL,
    plan        TEXT        NOT NULL DEFAULT 'pro',
    source      TEXT        NOT NULL DEFAULT 'manual',
    valid_until TIMESTAMPTZ NULL,               -- NULL = бессрочно
    note        TEXT,
    granted_by  TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at  TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS entitlements_user_active_idx
    ON entitlements(user_id) WHERE revoked_at IS NULL;

COMMIT;

-- DOWN
DROP TABLE IF EXISTS entitlements;
