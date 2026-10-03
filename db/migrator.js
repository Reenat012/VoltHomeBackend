// db/migrator.js
// Логика миграций отдельно от запуска из консоли: её используют и db/migrate.js, и тесты.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");

export function listMigrationFiles(dir = MIGRATIONS_DIR) {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
}

async function ensureTable(query) {
    await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/** Применяет недостающие миграции по порядку имён файлов. Бросает исключение при ошибке. */
export async function migrateUp(query, { log = console.log, dir = MIGRATIONS_DIR } = {}) {
    await ensureTable(query);
    const files = listMigrationFiles(dir);
    const res = await query(`SELECT name FROM schema_migrations ORDER BY name ASC;`);
    const done = new Set(res.rows.map((r) => r.name));
    const applied = [];

    for (const f of files) {
        if (done.has(f)) continue;
        // Секция `-- DOWN` относится к откату и при применении не выполняется
        // (раньше выполнялся файл целиком, и 001_init.sql сразу удалял свои же таблицы).
        const sql = fs.readFileSync(path.join(dir, f), "utf-8").split("-- DOWN")[0];
        log(`Applying ${f}...`);
        await query("BEGIN");
        try {
            await query(sql);
            await query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
            await query("COMMIT");
            log(`OK ${f}`);
            applied.push(f);
        } catch (e) {
            await query("ROLLBACK");
            e.migration = f;
            throw e;
        }
    }
    return applied;
}

/** Откатывает последнюю применённую миграцию (секция `-- DOWN`). */
export async function migrateDown(query, { log = console.log, dir = MIGRATIONS_DIR } = {}) {
    await ensureTable(query);
    const res = await query(`SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1;`);
    if (res.rows.length === 0) {
        log("No migrations to rollback");
        return null;
    }
    const f = res.rows[0].name;
    const sql = fs.readFileSync(path.join(dir, f), "utf-8");
    const downSection = sql.split("-- DOWN")[1];
    if (!downSection) {
        const e = new Error(`Migration ${f} has no -- DOWN section`);
        e.migration = f;
        throw e;
    }
    log(`Rolling back ${f}...`);
    await query("BEGIN");
    try {
        await query(downSection);
        await query("DELETE FROM schema_migrations WHERE name=$1", [f]);
        await query("COMMIT");
        log(`OK rollback ${f}`);
        return f;
    } catch (e) {
        await query("ROLLBACK");
        e.migration = f;
        throw e;
    }
}
