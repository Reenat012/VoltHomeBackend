// db/migrate.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { query } from "./pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");

async function ensureTable() {
    await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function listMigrations() {
    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith(".sql"))
        .sort();
    return files;
}

async function applied() {
    const res = await query(`SELECT name FROM schema_migrations ORDER BY name ASC;`);
    return res.rows.map(r => r.name);
}

async function up() {
    await ensureTable();
    const files = await listMigrations();
    const done = new Set(await applied());

    for (const f of files) {
        if (done.has(f)) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8");
        console.log(`Applying ${f}...`);
        await query("BEGIN");
        try {
            await query(sql);
            await query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
            await query("COMMIT");
            console.log(`OK ${f}`);
        } catch (e) {
            await query("ROLLBACK");
            console.error(`FAILED ${f}:`, e.message);
            process.exit(1);
        }
    }
}

async function down() {
    await ensureTable();
    const res = await query(`SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1;`);
    if (res.rows.length === 0) {
        console.log("No migrations to rollback");
        return;
    }
    const f = res.rows[0].name;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8");
    const downSection = sql.split("-- DOWN")[1];
    if (!downSection) {
        console.error(`Migration ${f} has no -- DOWN section`);
        process.exit(1);
    }
    console.log(`Rolling back ${f}...`);
    await query("BEGIN");
    try {
        await query(downSection);
        await query("DELETE FROM schema_migrations WHERE name=$1", [f]);
        await query("COMMIT");
        console.log(`OK rollback ${f}`);
    } catch (e) {
        await query("ROLLBACK");
        console.error(`FAILED rollback ${f}:`, e.message);
        process.exit(1);
    }
}

const cmd = process.argv[2] || "up";
if (cmd === "up") up().then(() => process.exit(0));
else if (cmd === "down") down().then(() => process.exit(0));
else {
    console.error("Usage: node db/migrate.js up|down");
    process.exit(1);
}