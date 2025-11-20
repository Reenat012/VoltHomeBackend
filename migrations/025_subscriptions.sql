-- 025_subscriptions.sql
-- Таблица подписок RuStore для пользователей VoltHome.
-- На этом этапе таблица никем не используется, просто создаём инфраструктуру.

BEGIN;

CREATE TABLE IF NOT EXISTS subscriptions (
                                             id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         TEXT        NOT NULL,        -- Yandex UID / user_id из текущей системы
    product_id      TEXT        NOT NULL,        -- например: "volthome_pro_monthly"
    order_id        TEXT        NOT NULL,        -- идентификатор заказа RuStore
    purchase_token  TEXT        NOT NULL,        -- токен/квитанция RuStore
    status          TEXT        NOT NULL,        -- ACTIVE / TRIAL / GRACE / PAUSED / EXPIRED / CANCELLED
    period_end_at   TIMESTAMPTZ NULL,           -- окончание оплаченного периода (UTC) или NULL для бессрочных
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );

-- Защита от дублей по одному и тому же заказу RuStore
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_order_id_uniq
    ON subscriptions(order_id);

-- Быстрый поиск активной подписки пользователя
CREATE INDEX IF NOT EXISTS subscriptions_user_status_period_idx
    ON subscriptions(user_id, status, period_end_at);

COMMIT;

-- DOWN-миграцию не пишем (как и в остальных поздних миграциях)