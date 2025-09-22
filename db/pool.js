// db/pool.js
import pg from "pg";

const {
    PGHOST,
    PGPORT,
    PGDATABASE,
    PGUSER,
    PGPASSWORD,
    PGSSLMODE = "require",
} = process.env;

// Никаких молчаливых дефолтов на localhost — лучше упасть сразу.
if (!PGHOST || !PGDATABASE || !PGUSER || !PGPASSWORD) {
    throw new Error(
        "Database config is missing. Set PGHOST, PGDATABASE, PGUSER, PGPASSWORD in .env"
    );
}

const ssl =
    (PGSSLMODE || "").toLowerCase() === "require"
        ? { rejectUnauthorized: false }
        : false;

export const pool = new pg.Pool({
    host: PGHOST,
    port: +(PGPORT || 5432),
    database: PGDATABASE,
    user: PGUSER,
    password: PGPASSWORD,
    ssl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

export async function query(text, params) {
    const client = await pool.connect();
    try {
        return await client.query(text, params);
    } finally {
        client.release();
    }
}