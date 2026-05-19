#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  computeAuditHash,
  GENESIS_PREV_HASH
} from "../../apps/gateway-api/src/audit/hash-chain.ts";

const auditDir = resolve(process.env.AUDIT_DIR ?? ".audit");
const current = resolve(auditDir, "audit-events.jsonl");
const legacy = resolve(auditDir, "audit-events.legacy.jsonl");
const legacyRuntimeJson = resolve("runtime", "audit-events.legacy.json");
const runtimeJson = resolve("runtime", "audit-events.json");

mkdirSync(auditDir, { recursive: true });

if (existsSync(legacy) && existsSync(current)) {
  console.log("ok: audit-events.legacy.jsonl ya existe y chain actual ya esta inicializada.");
  process.exit(0);
}

let legacyCount = 0;
if (!existsSync(legacy)) {
  if (existsSync(current)) {
    renameSync(current, legacy);
    legacyCount = countJsonlEvents(legacy);
    console.log(`Movido ${current} -> ${legacy}`);
  } else if (existsSync(runtimeJson)) {
    const raw = readFileSync(runtimeJson, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const events = Array.isArray(parsed) ? parsed : [];
    writeFileSync(legacy, events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : ""), "utf8");
    renameSync(runtimeJson, legacyRuntimeJson);
    legacyCount = events.length;
    console.log(`Preservado runtime/audit-events.json como ${legacy} (${legacyCount} eventos).`);
    console.log(`Movido original JSON a ${legacyRuntimeJson}`);
  } else {
    writeFileSync(legacy, "", "utf8");
    console.log(`Creado ${legacy} vacio; no habia audit log previo.`);
  }
}

if (existsSync(current)) {
  console.log(`ok: ${current} ya existe; no se reescribe genesis.`);
  process.exit(0);
}

const genesis = {
  id: randomUUID(),
  occurredAt: new Date().toISOString(),
  actorType: "system",
  actorId: "gateway-api",
  action: "oc.audit.chain_started",
  targetType: "audit_log",
  targetId: "audit-events.jsonl",
  riskLevel: "low",
  decision: "n/a",
  rejectReason: null,
  humanApproved: false,
  approverIds: [],
  killSwitchState: "armed",
  rollbackToken: null,
  schemaVersion: "2026-05-18.v1",
  promptVersion: null,
  modelVersion: null,
  evidenceRefs: [],
  metadata: {
    reason: "Hito 5.11.B D+5 AM — start hash chain. Eventos legacy preservados en audit-events.legacy.jsonl.",
    legacyEventsPreserved: true,
    legacyEventCount: legacyCount
  },
  prevHash: GENESIS_PREV_HASH,
  hash: ""
};
const genesisWithHash = {
  ...genesis,
  hash: computeAuditHash(genesis, GENESIS_PREV_HASH)
};

mkdirSync(dirname(current), { recursive: true });
writeFileSync(current, `${JSON.stringify(genesisWithHash)}\n`, "utf8");
console.log(`Genesis event creado en ${current}: ${genesisWithHash.hash}`);

function countJsonlEvents(path: string): number {
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).length;
}
