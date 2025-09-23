-- 007_unify_refresh_sessions.sql
BEGIN;

-- token_hash: BYTEA -> TEXT(HEX)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name='refresh_sessions'
      AND column_name='token_hash'
      AND data_type='bytea'
  ) THEN
ALTER TABLE refresh_sessions
ALTER COLUMN token_hash TYPE TEXT USING encode(token_hash, 'hex');
END IF;
END $$;

-- ip: INET -> TEXT
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name='refresh_sessions'
      AND column_name='ip'
      AND data_type='inet'
  ) THEN
ALTER TABLE refresh_sessions
ALTER COLUMN ip TYPE TEXT USING host(ip);
END IF;
END $$;

-- уникальность по token_hash
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='refresh_sessions_token_hash_idx'
  ) THEN
CREATE UNIQUE INDEX refresh_sessions_token_hash_idx ON refresh_sessions (token_hash);
END IF;
END $$;

COMMIT;