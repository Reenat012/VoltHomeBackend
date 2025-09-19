// db/pool.js
import pg from "pg";
import dotenv from "dotenv";
dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
    host: process.env.PGHOST || "127.0.0.1",
    port: +(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "volthome",
    user: process.env.PGUSER || "volthome",
    password: process.env.PGPASSWORD || "volthome_password",
    ssl: /require|verify-full/i.test(process.env.PGSSLMODE || "") ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30_000
});

export async function query(text, params) {
    const start = Date.now();
    const res = await pool.query(text, params);
    const ms = Date.now() - start;
    if (process.env.NODE_ENV !== "test") {
        // простое логирование latency
        // console.debug(`[pg] ${ms}ms ${text.split('\n')[0]}`);
    }
    return res;
}