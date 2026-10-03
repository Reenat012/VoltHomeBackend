// db/migrate.js
// Запуск миграций из консоли: node db/migrate.js up|down
import { query } from "./pool.js";
import { migrateUp, migrateDown } from "./migrator.js";

const cmd = process.argv[2] || "up";

async function main() {
    if (cmd === "up") {
        await migrateUp(query);
    } else if (cmd === "down") {
        await migrateDown(query);
    } else {
        console.error("Usage: node db/migrate.js up|down");
        process.exit(1);
    }
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(`FAILED ${e.migration ? e.migration + ": " : ""}${e.message}`);
        process.exit(1);
    });
