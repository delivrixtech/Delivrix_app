import { readFileSync } from "node:fs";
import { runPsql, seedFile } from "./common.mjs";
import { runMigrations } from "./migrate.mjs";

runMigrations();
runPsql(readFileSync(seedFile, "utf8"));
console.log("db:seed complete");
