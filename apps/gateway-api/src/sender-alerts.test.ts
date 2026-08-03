// Tests del evaluador de alertas. Lo que protegen: que la severidad se calcule bien (el umbral
// permanente SIEMPRE crítico), que una bandeja dispare todas las alertas que le corresponden, y
// que "cerca" no duplique a "cruzado".

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OpenClawWorkspace } from "./openclaw-workspace.ts";
import type { CuotaBandeja } from "./sender-quota.ts";
import { MEASUREMENT_FILE, type MedicionFlota } from "./sender-measurement.ts";
import { alertasDeBandeja, armarAlertasFlota } from "./sender-alerts.ts";

const ahora = new Date("2026-07-31T12:00:00.000Z");

function band(overrides: Partial<CuotaBandeja> = {}): CuotaBandeja {
  return {
    domain: "a.com",
    serverSlug: "n1",
    color: "verde",
    estado: "entrega",
    motivo: null,
    asignada: null,
    hoyPuede: 0,
    editable: true,
    edadDias: 20,
    cruzados: [],
    cerca: [],
    rampa: null,
    sinLectura: null,
    ...overrides
  };
}

test("el umbral permanente cruzado es SIEMPRE crítico e irreversible", () => {
  const a = alertasDeBandeja(band({ cruzados: ["google"] }));
  assert.equal(a.length, 1);
  assert.equal(a[0]?.severity, "critical");
  assert.equal(a[0]?.kind, "umbral_cruzado");
  assert.match(a[0]?.detail ?? "", /irreversible/);
});

test("cerca del umbral NO se emite si ya cruzó (la crítica lo cubre)", () => {
  const a = alertasDeBandeja(band({ cruzados: ["google"], cerca: ["yahoo_aol"] }));
  assert.equal(a.length, 1, "solo la crítica del cruce, no el aviso de cerca");
  assert.equal(a[0]?.kind, "umbral_cruzado");
});

test("cerca del umbral sin cruce es warning", () => {
  const a = alertasDeBandeja(band({ cerca: ["google"] }));
  assert.equal(a.length, 1);
  assert.equal(a[0]?.severity, "warning");
  assert.equal(a[0]?.kind, "cerca_umbral");
});

test("cola atascada y bloqueada son high", () => {
  assert.equal(alertasDeBandeja(band({ estado: "cola atascada", color: "rojo" }))[0]?.severity, "high");
  assert.equal(alertasDeBandeja(band({ estado: "bloqueada", color: "rojo" }))[0]?.severity, "high");
});

test("rampa auto-pausada es high con el motivo del freno", () => {
  const a = alertasDeBandeja(band({ rampa: { estado: "auto_paused", pauseReason: "auto_bounce_rate", cupoHoy: 0, dia: 3, totalDias: 14, schedule: "production-14d" } }));
  assert.equal(a[0]?.severity, "high");
  assert.equal(a[0]?.kind, "rampa_pausada");
  assert.match(a[0]?.detail ?? "", /auto_bounce_rate/);
});

test("nodo incomunicado (sin lectura) es high, con el motivo de la sonda", () => {
  const a = alertasDeBandeja(band({ estado: "sin lectura", color: "gris", sinLectura: { motivo: "ssh: connection timed out" } }));
  assert.equal(a.length, 1);
  assert.equal(a[0]?.severity, "high");
  assert.equal(a[0]?.kind, "sin_lectura");
  assert.match(a[0]?.detail ?? "", /timed out/);
  const sinMotivo = alertasDeBandeja(band({ estado: "sin lectura", color: "gris", sinLectura: { motivo: "" } }));
  assert.equal(sinMotivo[0]?.detail, "la medición no pudo leer el nodo");
});

test("nodo incomunicado CALENTANDO alerta igual: la rampa tapa el estado, no el flag", () => {
  // El gap que cazó el gate: una rampa running gana el semáforo ("rampa día X/N"), así que el
  // estado nunca dice "sin lectura" — pero el nodo incomunicado que está enviando volumen es el
  // que MÁS urge mirar. La alerta sale del flag, no del string de display.
  const a = alertasDeBandeja(band({
    estado: "rampa día 3/14",
    color: "calentando",
    sinLectura: { motivo: "ssh: connection timed out" },
    rampa: { estado: "running", cupoHoy: 200, dia: 3, totalDias: 14, schedule: "production-14d" }
  }));
  assert.equal(a.length, 1);
  assert.equal(a[0]?.kind, "sin_lectura");
  assert.equal(a[0]?.severity, "high");
});

test("una bandeja verde sana no dispara ninguna alerta", () => {
  assert.deepEqual(alertasDeBandeja(band()), []);
});

test("un motivo vacío cae al texto genérico, nunca un detail en blanco", () => {
  const a = alertasDeBandeja(band({ estado: "cola atascada", color: "rojo", motivo: "" }));
  assert.equal(a[0]?.detail, "la cola se acumula");
});

test("una bandeja puede disparar varias alertas a la vez", () => {
  // Cruzó google (crítica) y cerca en yahoo NO cuenta (cubierta), pero sí una rampa pausada.
  const a = alertasDeBandeja(band({
    cruzados: ["google"],
    rampa: { estado: "auto_paused", pauseReason: "auto_placement", cupoHoy: 0, dia: 2, totalDias: 14, schedule: "production-14d" }
  }));
  assert.equal(a.length, 2);
  assert.deepEqual(a.map((x) => x.kind).sort(), ["rampa_pausada", "umbral_cruzado"]);
});

test("armarAlertasFlota ordena por severidad y cuenta, desde JSON local", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alerts-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });
  await ws.updateInventoryJson("domains.json", () => ({
    bindings: [
      { domain: "sana.com", serverSlug: "n1", serverIp: "1.1.1.1" },
      { domain: "atascada.com", serverSlug: "n2", serverIp: "2.2.2.2" },
      { domain: "quemada.com", serverSlug: "n3", serverIp: "3.3.3.3" },
      { domain: "muda.com", serverSlug: "n4", serverIp: "4.4.4.4" }
    ]
  }));
  await ws.updateInventoryJson("smtp-credentials.json", () => ({
    smtpCredentials: [
      { domain: "sana.com", serverSlug: "n1", status: "configured", createdAt: "2026-07-10T00:00:00Z" },
      { domain: "atascada.com", serverSlug: "n2", status: "configured", createdAt: "2026-07-10T00:00:00Z" },
      { domain: "quemada.com", serverSlug: "n3", status: "configured", createdAt: "2026-07-10T00:00:00Z" },
      { domain: "muda.com", serverSlug: "n4", status: "configured", createdAt: "2026-07-10T00:00:00Z" }
    ]
  }));
  const medicion: MedicionFlota = {
    medidoEn: ahora.toISOString(),
    duracionMs: 1,
    pedidas: 3,
    leidas: 3,
    bandejas: [
      { domain: "sana.com", serverSlug: "n1", estado: "healthy", detalle: "ok", ventana: "24h", entregados: 100, rechazados: 0, diferidos: 0, cerradoEn: [], picos: [], cruzados: [], cerca: [] },
      { domain: "atascada.com", serverSlug: "n2", estado: "stalled", detalle: "la cola se acumula", ventana: "24h", entregados: 0, rechazados: 0, diferidos: 900, cerradoEn: [], picos: [], cruzados: [], cerca: [] },
      { domain: "quemada.com", serverSlug: "n3", estado: "healthy", detalle: "ok", ventana: "24h", entregados: 50, rechazados: 0, diferidos: 0, cerradoEn: [], picos: [], cruzados: ["google"], cerca: [] },
      { domain: "muda.com", serverSlug: "n4", estado: "unreadable", detalle: "ssh: connection timed out", ventana: "24h", entregados: 0, rechazados: 0, diferidos: 0, cerradoEn: [], picos: [], cruzados: [], cerca: [] }
    ]
  };
  await ws.updateInventoryJson(MEASUREMENT_FILE, () => medicion);

  const flota = await armarAlertasFlota({ workspace: ws, techo: 2000, now: () => ahora });
  assert.equal(flota.medidoEn, ahora.toISOString());
  assert.equal(flota.conteos.critical, 1, "quemada.com");
  // muda.com verifica por el camino REAL (cuota → alerta) que el string "sin lectura" de
  // evaluarBandeja y el del evaluador de alertas siguen matcheando byte por byte.
  assert.equal(flota.conteos.high, 2, "atascada.com + muda.com incomunicada");
  const muda = flota.alerts.find((x) => x.domain === "muda.com");
  assert.equal(muda?.kind, "sin_lectura");
  assert.match(muda?.detail ?? "", /timed out/, "el motivo de la sonda viaja hasta el operador");
  assert.equal(flota.alerts[0]?.severity, "critical", "lo irreversible primero");
  assert.equal(flota.alerts[0]?.domain, "quemada.com");
});
