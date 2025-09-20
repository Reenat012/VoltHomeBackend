-- 004_sessions.sql
-- Таблица рефреш-сессий: хранение хэша токена, ротация, ревокация.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS refresh_sessions (
                                                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id TEXT NOT NULL,
    token_hash BYTEA NOT NULL,             -- SHA-256(refreshToken)
    user_agent TEXT,
    ip INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    replaced_by UUID,
    CONSTRAINT fk_replaced_by FOREIGN KEY (replaced_by) REFERENCES refresh_sessions(id) ON DELETE SET NULL
    );

CREATE INDEX IF NOT EXISTS idx_refresh_sessions_user ON refresh_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_tokenhash ON refresh_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_expires ON refresh_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_revoked ON refresh_sessions(revoked_at);

COMMIT;

-- DOWN
-- DROP TABLE IF EXISTS refresh_sessions;