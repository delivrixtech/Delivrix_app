import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveLiveDaemonConfig,
  decideDaemonAction,
  recentInboxRate,
  pickBox,
  elegirSemillaDelRegistro,
  puedeMedir,
  type SeedDelDaemon
} from "./live-warmup-daemon.ts";
import type { Placement } from "../live/warmup-live-cycle.ts";

test("resolveLiveDaemonConfig: defaults conservadores + OFF por defecto", () => {
  const cfg = resolveLiveDaemonConfig({} as NodeJS.ProcessEnv);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.maxPerDay, 3);
  assert.equal(cfg.intervalMs, 4 * 60 * 60 * 1000);
  assert.equal(cfg.placementFloor, 0.5);
  assert.equal(cfg.seedInbox, "infradelivrixdemo@gmail.com");
  assert.ok(cfg.boxes.length >= 6);
});

test("resolveLiveDaemonConfig: overrides del entorno", () => {
  const cfg = resolveLiveDaemonConfig({
    WARMUP_LIVE_ENABLE: "true",
    WARMUP_LIVE_MAX_PER_DAY: "2",
    WARMUP_LIVE_INTERVAL_MS: "1000",
    WARMUP_LIVE_PLACEMENT_FLOOR: "0.8",
    WARMUP_LIVE_BOXES: "a.com, b.com",
    WARMUP_GMAIL_SEED_USER: "seed@x.com"
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.maxPerDay, 2);
  assert.equal(cfg.intervalMs, 1000);
  assert.equal(cfg.placementFloor, 0.8);
  assert.deepEqual(cfg.boxes, ["a.com", "b.com"]);
  assert.equal(cfg.seedInbox, "seed@x.com");
});

test("recentInboxRate: proporción de INBOX, null si vacío", () => {
  assert.equal(recentInboxRate([]), null);
  assert.equal(recentInboxRate(["INBOX", "INBOX"]), 1);
  assert.equal(recentInboxRate(["INBOX", "SPAM"]), 0.5);
  assert.equal(recentInboxRate(["SPAM", "PROMOTIONS"]), 0);
});

const base = { enabled: true, killed: false, cyclesToday: 0, maxPerDay: 3, recentPlacements: [] as Placement[], placementFloor: 0.5 };

test("gate: flag OFF ⇒ inert (por encima de todo)", () => {
  assert.equal(decideDaemonAction({ ...base, enabled: false }).action, "inert");
});

test("gate: kill-file ⇒ killed", () => {
  assert.equal(decideDaemonAction({ ...base, killed: true }).action, "killed");
});

test("gate: tope diario alcanzado ⇒ cap-reached", () => {
  assert.equal(decideDaemonAction({ ...base, cyclesToday: 3 }).action, "cap-reached");
  assert.equal(decideDaemonAction({ ...base, cyclesToday: 2 }).action, "send");
});

test("gate: placement bajo el piso ⇒ placement-pause", () => {
  const bad: Placement[] = ["SPAM", "SPAM", "INBOX"]; // inbox 33% < 50%
  assert.equal(decideDaemonAction({ ...base, recentPlacements: bad }).action, "placement-pause");
  const ok: Placement[] = ["INBOX", "INBOX", "SPAM"]; // 66% > 50%
  assert.equal(decideDaemonAction({ ...base, recentPlacements: ok }).action, "send");
});

test("gate: sin mediciones aún ⇒ no bloquea por placement (envía)", () => {
  assert.equal(decideDaemonAction({ ...base, recentPlacements: [] }).action, "send");
});

test("gate: orden de precedencia flag > kill > cap > placement", () => {
  // aunque el placement esté mal y el tope alcanzado, si está killed ⇒ killed
  const r = decideDaemonAction({ ...base, killed: true, cyclesToday: 5, recentPlacements: ["SPAM"] });
  assert.equal(r.action, "killed");
});

test("pickBox rota estable por índice", () => {
  const boxes = ["a", "b", "c"];
  assert.equal(pickBox(boxes, 0), "a");
  assert.equal(pickBox(boxes, 3), "a");
  assert.equal(pickBox(boxes, 4), "b");
  assert.throws(() => pickBox([], 0));
});

// ── Semillas del registro ────────────────────────────────────────────────────────────────────────

test("la rotación de semillas reparte y respeta las apagadas", () => {
  const seeds: SeedDelDaemon[] = [
    { address: "a@gmail.com", provider: "gmail", enabled: true, auth: "gmail_oauth" },
    { address: "b@gmail.com", provider: "gmail", enabled: true, auth: "none" },
    { address: "muerta@gmail.com", provider: "gmail", enabled: false, auth: "none" }
  ];
  const usadas = new Set<string>();
  for (let v = 0; v < 8; v += 1) usadas.add(elegirSemillaDelRegistro(seeds, "dominio.com", v)!.address);
  assert.deepEqual([...usadas].sort(), ["a@gmail.com", "b@gmail.com"], "la apagada nunca se usa");
  assert.equal(elegirSemillaDelRegistro([], "x.com", 0), null, "sin semillas no se inventa una");
});

test("solo se MIDE en la semilla del refresh token: en las demás sería un dato falso", () => {
  const oauth: SeedDelDaemon = { address: "medidora@gmail.com", provider: "gmail", enabled: true, auth: "gmail_oauth" };
  const otra: SeedDelDaemon = { address: "otra@gmail.com", provider: "gmail", enabled: true, auth: "none" };
  assert.equal(puedeMedir(oauth, "medidora@gmail.com"), true);
  assert.equal(puedeMedir(oauth, "MEDIDORA@gmail.com"), true, "case-insensitive");
  assert.equal(puedeMedir(otra, "medidora@gmail.com"), false, "sin lector no se mide");
  // Una semilla OAuth que NO es la cuenta del token tampoco: las ops apuntan a una sola casilla.
  assert.equal(puedeMedir({ ...oauth, address: "tercera@gmail.com" }, "medidora@gmail.com"), false);
});
