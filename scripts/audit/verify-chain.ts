#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeAuditHash,
  GENESIS_PREV_HASH
} from "../../apps/gateway-api/src/audit/hash-chain.ts";

const args = process.argv.slice(2);
const auditFileArg = argValue("--audit-file");
const fromArg = argValue("--from");
const toArg = argValue("--to");
const auditFile = resolve(auditFileArg ?? process.env.AUDIT_FILE ?? resolve(process.env.AUDIT_DIR ?? ".audit", "audit-events.jsonl"));

const lines = readFileSync(auditFile, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

let total = 0;
let chainOk = 0;
let chainBroken = 0;
let missingPrevHash = 0;
let prevHash = GENESIS_PREV_HASH;
const brokenLines: number[] = [];

for (let i = 0; i < lines.length; i += 1) {
  const event = JSON.parse(lines[i]!) as Record<string, unknown>;
  if (fromArg && typeof event.occurredAt === "string" && event.occurredAt < fromArg) {
    continue;
  }
  if (toArg && typeof event.occurredAt === "string" && event.occurredAt > toArg) {
    continue;
  }

  total += 1;
  if (typeof event.prevHash !== "string") {
    missingPrevHash += 1;
    brokenLines.push(i + 1);
    continue;
  }
  if (event.prevHash !== prevHash) {
    chainBroken += 1;
    brokenLines.push(i + 1);
    prevHash = typeof event.hash === "string" ? event.hash : prevHash;
    continue;
  }

  const expectedHash = computeAuditHash(event, prevHash);
  if (event.hash !== expectedHash) {
    chainBroken += 1;
    brokenLines.push(i + 1);
    prevHash = typeof event.hash === "string" ? event.hash : prevHash;
    continue;
  }

  chainOk += 1;
  prevHash = event.hash;
}

console.log(`events_total=${total}`);
console.log(`chain_ok=${chainOk}`);
console.log(`chain_broken=${chainBroken}`);
console.log(`missing_prev_hash=${missingPrevHash}`);

if (chainBroken === 0 && missingPrevHash === 0) {
  console.log("OK");
  process.exit(0);
}

console.error(`BROKEN at lines: ${brokenLines.slice(0, 10).join(", ")}${brokenLines.length > 10 ? "..." : ""}`);
process.exit(1);

function argValue(name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}
