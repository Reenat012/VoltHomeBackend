-- 030_project_documents.sql
-- Документы проекта (docs/SYNC_CONTRACT.md, раздел 7): данные, которые правятся целиком
-- (щит и 2D CAD, настройки, выбранные аппараты и т. д.). Сервер хранит JSON как есть и ничего в нём
-- не интерпретирует; версию схемы ведут клиенты.
-- Таблица версий хранит историю для отката (последние N версий, см. models/documents.js).

BEGIN;

CREATE TABLE IF NOT EXISTS project_documents (
    project_id     UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind           TEXT        NOT NULL,
    version        INT         NOT NULL,
    schema_version INT         NOT NULL,
    data           JSONB       NOT NULL,
    is_deleted     BOOLEAN     NOT NULL DEFAULT FALSE,
    updated_by     TEXT        NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, kind)
);

CREATE TABLE IF NOT EXISTS project_document_versions (
    project_id     UUID        NOT NULL,
    kind           TEXT        NOT NULL,
    version        INT         NOT NULL,
    schema_version INT         NOT NULL,
    data           JSONB       NOT NULL,
    is_deleted     BOOLEAN     NOT NULL DEFAULT FALSE,
    updated_by     TEXT        NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, kind, version),
    FOREIGN KEY (project_id, kind) REFERENCES project_documents(project_id, kind) ON DELETE CASCADE
);

COMMIT;

-- DOWN
DROP TABLE IF EXISTS project_document_versions;
DROP TABLE IF EXISTS project_documents;
