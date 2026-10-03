-- 027_users_identities.sql
-- Аккаунты отдельно от способа входа (docs/SYNC_CONTRACT.md, раздел 4).
-- uid создаёт сервер (u_<uuid>); способы входа лежат в identities, поэтому позже можно добавить
-- другой способ входа без переноса проектов и подписок.

BEGIN;

CREATE TABLE IF NOT EXISTS users (
    uid          TEXT PRIMARY KEY,
    display_name TEXT,
    email        TEXT,
    avatar_url   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identities (
    provider    TEXT        NOT NULL,           -- например: yandex
    external_id TEXT        NOT NULL,           -- идентификатор у провайдера
    uid         TEXT        NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, external_id)
);

CREATE INDEX IF NOT EXISTS identities_uid_idx ON identities(uid);
CREATE INDEX IF NOT EXISTS users_email_idx ON users(lower(email));

COMMIT;

-- DOWN
DROP TABLE IF EXISTS identities;
DROP TABLE IF EXISTS users;
