-- 005_refresh_sessions.sql

CREATE TABLE IF NOT EXISTS refresh_sessions (
                                                id BIGSERIAL PRIMARY KEY,
                                                user_id TEXT NOT NULL,
                                                token_hash TEXT NOT NULL UNIQUE,
                                                user_agent TEXT,
                                                ip TEXT,
                                                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    replaced_by BIGINT REFERENCES refresh_sessions(id) ON DELETE SET NULL
    );

CREATE INDEX IF NOT EXISTS refresh_sessions_user_id_idx ON refresh_sessions (user_id);
CREATE INDEX IF NOT EXISTS refresh_sessions_token_hash_idx ON refresh_sessions (token_hash);
CREATE INDEX IF NOT EXISTS refresh_sessions_expires_at_idx ON refresh_sessions (expires_at);