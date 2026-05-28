import { readFileSync } from "node:fs";
import { runPsql, seedFile } from "./common.mjs";
import "./migrate.mjs";

runPsql(readFileSync(seedFile, "utf8"));
console.log("db:seed complete");
