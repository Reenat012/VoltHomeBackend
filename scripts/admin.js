// scripts/admin.js
// Консольные команды администратора. Запускаются на сервере, где лежит боевой .env:
//   npm run admin:find-user -- --email name@example.com
//   npm run admin:grant-pro -- --uid u_... [--until 2027-01-31] [--note "почему"]
//   npm run admin:revoke-pro -- --uid u_...
//   npm run admin:list-grants -- [--uid u_...] [--active]
import { pool } from "../db/pool.js";
import { findUsers, grantPro, revokePro, listGrants, AdminError } from "../services/adminService.js";

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) out[key] = true;
        else {
            out[key] = next;
            i++;
        }
    }
    return out;
}

const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "бессрочно");

async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    const args = parseArgs(rest);

    switch (cmd) {
        case "find-user": {
            const users = await findUsers({ uid: args.uid, email: args.email, externalId: args["yandex-id"] });
            if (!users.length) console.log("Никого не найдено");
            for (const u of users) {
                console.log(`${u.uid}  ${u.email ?? "-"}  ${u.display_name ?? "-"}  вход: ${u.identities.map((i) => i.provider).join(",")}`);
            }
            break;
        }
        case "grant-pro": {
            const row = await grantPro({ uid: args.uid, until: args.until, note: args.note || null, grantedBy: "cli" });
            console.log(`PRO выдан: ${row.user_id}, до ${fmt(row.valid_until)} (выдача ${row.id})`);
            break;
        }
        case "revoke-pro": {
            const n = await revokePro({ uid: args.uid, revokedBy: "cli" });
            console.log(n ? `Отозвано выдач: ${n}` : "Действующих ручных выдач не было");
            break;
        }
        case "list-grants": {
            const rows = await listGrants({ uid: args.uid || null, activeOnly: Boolean(args.active) });
            if (!rows.length) console.log("Выдач нет");
            for (const r of rows) {
                const state = r.revoked_at ? "отозвана" : r.valid_until && new Date(r.valid_until) < new Date() ? "истекла" : "действует";
                console.log(`${r.user_id}  до ${fmt(r.valid_until)}  ${state}  ${r.note ?? ""}`);
            }
            break;
        }
        default:
            console.error("Команды: find-user, grant-pro, revoke-pro, list-grants");
            process.exitCode = 1;
    }
}

main()
    .catch((e) => {
        console.error(e instanceof AdminError ? `Ошибка: ${e.message}` : e);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
