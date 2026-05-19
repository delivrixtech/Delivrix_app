#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const auditFile = resolve(process.env.AUDIT_FILE ?? resolve(process.env.AUDIT_DIR ?? ".audit", "audit-events.jsonl"));
const lines = readFileSync(auditFile, "utf8").split("\n").filter(Boolean);
const index = Math.min(2, Math.max(0, lines.length - 1));
const event = JSON.parse(lines[index]!) as { metadata?: Record<string, unknown> };
event.metadata = { ...(event.metadata ?? {}), tamperedBySmoke: true };
lines[index] = JSON.stringify(event);
writeFileSync(auditFile, `${lines.join("\n")}\n`, "utf8");
console.log(`tampered_line=${index + 1}`);
