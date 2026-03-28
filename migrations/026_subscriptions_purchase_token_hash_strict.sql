BEGIN;

ALTER TABLE public.subscriptions
    ADD COLUMN IF NOT EXISTS purchase_token_hash TEXT;

UPDATE public.subscriptions
SET purchase_token_hash = encode(digest(purchase_token, 'sha256'), 'hex')
WHERE purchase_token IS NOT NULL
  AND purchase_token_hash IS NULL;

ALTER TABLE public.subscriptions
    ALTER COLUMN purchase_token_hash SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_purchase_token_hash_uniq
    ON public.subscriptions(purchase_token_hash);

COMMIT;

-- DOWN
BEGIN;

DROP INDEX IF EXISTS public.subscriptions_purchase_token_hash_uniq;

ALTER TABLE public.subscriptions
DROP COLUMN IF EXISTS purchase_token_hash;

COMMIT;