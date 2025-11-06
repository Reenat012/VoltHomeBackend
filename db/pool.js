// db/pool.js
import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const {
    PGHOST,
    PGPORT,
    PGDATABASE,
    PGUSER,
    PGPASSWORD,
    PGSSLMODE,
    PG_POOL_MAX,
    PG_IDLE_TIMEOUT_MS,
    PG_CONNECT_TIMEOUT_MS,
    PG_STATEMENT_TIMEOUT_MS,
} = process.env;

if (!PGHOST || !PGDATABASE || !PGUSER || !PGPASSWORD) {
    throw new Error("Database config is missing. Set PGHOST, PGDATABASE, PGUSER, PGPASSWORD in .env");
}

const ssl =
    PGSSLMODE && PGSSLMODE.toLowerCase() !== "disable"
        ? { rejectUnauthorized: false } // для Timeweb managed PG достаточно require/false
        : false;

export const pool = new Pool({
    host: PGHOST,
    port: Number(PGPORT || 5432),
    database: PGDATABASE,
    user: PGUSER,
    password: PGPASSWORD,
    ssl,

    // стабильность пула
    max: Number(PG_POOL_MAX ?? 10),
    idleTimeoutMillis: Number(PG_IDLE_TIMEOUT_MS ?? 10_000),         // 10s idle
    connectionTimeoutMillis: Number(PG_CONNECT_TIMEOUT_MS ?? 4_000), // 4s на выдачу коннекта
});

// При выдаче соединения — задаём statement_timeout на уровне сессии
pool.on("connect", async (client) => {
    const stTimeoutMs = Number(PG_STATEMENT_TIMEOUT_MS ?? 8_000); // 8s по умолчанию
    try {
        await client.query(`SET statement_timeout = ${stTimeoutMs}`);
    } catch (e) {
        console.warn("[db] failed to SET statement_timeout:", e?.message || e);
    }
});

// Единый helper: всегда используем pool.query (без manual connect/release)
export async function query(text, params) {
    try {
        return await pool.query(text, params);
    } catch (err) {
        console.error("[db.query] error:", {
            message: err?.message,
            code: err?.code,
            detail: err?.detail,
            where: err?.where,
            routine: err?.routine,
        });
        throw err;
    }
}

/**
 * Реальная транзакция на ОДНОМ соединении.
 * Все запросы внутри fn(client) выполняйте через client.query(...)
 */
export async function withTransaction(fn) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const res = await fn(client);
        await client.query("COMMIT");
        return res;
    } catch (e) {
        try { await client.query("ROLLBACK"); } catch {}
        throw e;
    } finally {
        client.release();
    }
}