// Prescribe the first user (+ base objects) on a coordinator database.
//
//   npx tsx tools/bootstrap.ts                       # local .dev.sqlite
//   npx tsx tools/bootstrap.ts --reset               # clean derived tables first
//   npx tsx tools/bootstrap.ts --sql --reset | bash tools/d1-apply.sh  # apply to remote D1
//
// The SQL mode exists so the same prescription can be applied to the deployed D1
// without a Node binding to it: wrangler runs the file.
import { readFileSync } from "node:fs";
import { SqliteStore } from "../src/store.js";
import {
  DEFAULT_FIRST_USER, bootstrapFirstUser, bootstrapStatements, resetStatements, firstUserExists,
  type Statement,
} from "../src/bootstrap.js";

const literal = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

function render(s: Statement): string {
  let i = 0;
  return s.sql.replace(/\?/g, () => literal(s.params[i++]));
}

async function main() {
  const argv = process.argv.slice(2);
  const sqlMode = argv.includes("--sql");
  const reset = argv.includes("--reset");
  const user = DEFAULT_FIRST_USER;

  if (sqlMode) {
    const stmts = [...(reset ? resetStatements() : []), ...bootstrapStatements(user)];
    console.log(stmts.map(render).join("\n"));
    return;
  }

  const dbPath = process.env.COORD_DB ?? new URL("../.dev.sqlite", import.meta.url).pathname;
  const existed = await firstUserExists(await SqliteStore.open(":memory:")).catch(() => false);
  const db = await SqliteStore.open(dbPath);
  await db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  if (reset) for (const s of resetStatements()) await db.run(s.sql, s.params);
  const report = await bootstrapFirstUser(db, user);
  console.log(`bootstrap ok: ${JSON.stringify(report)}  (db=${dbPath}, reset=${reset}, preexisting=${existed})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
