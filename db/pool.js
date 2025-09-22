// db/pool.js
import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const { PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE } = process.env;

if (!PGHOST || !PGDATABASE || !PGUSER || !PGPASSWORD) {
    throw new Error("Database config is missing. Set PGHOST, PGDATABASE, PGUSER, PGPASSWORD in .env");
}

const ssl =
    PGSSLMODE && PGSSLMODE.toLowerCase() !== "disable"
        ? { rejectUnauthorized: false } // для Timeweb Managed PG достаточно require/false
        : false;

export const pool = new Pool({
    host: PGHOST,
    port: Number(PGPORT || 5432),
    database: PGDATABASE,
    user: PGUSER,
    password: PGPASSWORD,
    ssl
});

export async function query(text, params) {
    const res = await pool.query(text, params);
    return res;
}