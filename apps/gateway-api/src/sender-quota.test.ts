// Tests de la cuota diaria por bandeja.
//
// Lo que protegen: que el semaforo se calcule y no se elija, que ninguna bandeja venda cuota
// sin una medicion verde detras, y que el techo del umbral permanente no se pueda saltar.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OpenClawWorkspace } from "./openclaw-workspace.ts";
import type { BandejaInventario } from "./sender-inventory.ts";
import { MEASUREMENT_FILE, type MedicionBandeja, type MedicionFlota } from "./sender-measurement.ts";
import {
  armarCuotaFlota,
  evaluarBandeja,
  guardarCuota,
  TECHO_ABSOLUTO,
  TECHO_DIARIO_DEFAULT,
  resolverTecho
} from "./sender-quota.ts";

const ahora = new Date("2026-07-31T12:00:00.000Z");
const TECHO = TECHO_DIARIO_DEFAULT;

function inv(overrides: Partial<BandejaInventario> = {}): BandejaInventario {
  return {
    domain: "a.com",
    serverSlug: "n1",
    serverIp: "1.1.1.1",
    edadDias: 21,
    tieneAccesoOps: true,
    conflicto: null,
    sinMedicion: "nunca_medida",
    ...overrides
  };
}

function med(overrides: Partial<MedicionBandeja> = {}): MedicionBandeja {
  return {
    domain: "a.com",
    serverSlug: "n1",
    estado: "healthy",
    detalle: "1500 entregados, 5 rechazados",
    ventana: "24h",
    entregados: 1500,
    rechazados: 5,
    diferidos: 30,
    cerradoEn: [],
    picos: [],
    cruzados: [],
    cerca: [],
    ...overrides
  };
}

test("verde solo si midio y entrega: healthy + cuota asignada", () => {
  const c = evaluarBandeja(inv(), med(), 1200, TECHO);
  assert.equal(c.color, "verde");
  assert.equal(c.estado, "entrega");
  assert.equal(c.hoyPuede, 1200);
  assert.equal(c.motivo, null);
});

test("verde sin cuota asignada vende 0: nunca un numero por defecto", () => {
  const c = evaluarBandeja(inv(), med(), null, TECHO);
  assert.equal(c.color, "verde");
  assert.equal(c.hoyPuede, 0);
  assert.equal(c.motivo, "sin cuota asignada");
  assert.equal(c.asignada, null, "null no es 0: nunca se asigno");
});

test("cola atascada vende 0 aunque tenga 3.964 asignados: el caso controlcontrolledger", () => {
  const c = evaluarBandeja(inv(), med({ estado: "stalled", diferidos: 920 }), 3964, TECHO);
  assert.equal(c.color, "rojo");
  assert.equal(c.estado, "cola atascada");
  assert.equal(c.hoyPuede, 0, "la asignada NO manda: manda la medicion");
  assert.equal(c.asignada, 3964, "el numero del operador no se pierde, solo no se sirve");
});

test("umbral permanente cruzado es rojo aunque el nodo entregue", () => {
  const c = evaluarBandeja(inv(), med({ cruzados: ["google"] }), 500, TECHO);
  assert.equal(c.color, "rojo");
  assert.equal(c.estado, "umbral cruzado");
  assert.equal(c.hoyPuede, 0);
});

test("sin medicion es gris y no editable: no hay sobre que aplicar el numero", () => {
  const c = evaluarBandeja(inv(), null, 100, TECHO);
  assert.equal(c.color, "gris");
  assert.equal(c.estado, "sin medir");
  assert.equal(c.hoyPuede, 0);
  assert.equal(c.editable, false);
});

test("conflicto de inventario es gris con el conflicto en el motivo", () => {
  const c = evaluarBandeja(
    inv({ conflicto: { enBindings: "n1", enCredencial: "n9" }, sinMedicion: "conflicto_de_inventario" }),
    med(),
    100,
    TECHO
  );
  assert.equal(c.color, "gris");
  assert.equal(c.estado, "en conflicto");
  assert.match(c.motivo ?? "", /n1 ≠ n9/);
  assert.equal(c.hoyPuede, 0, "medir el nodo equivocado no habilita cuota");
});

test("una asignada guardada con un techo viejo se sirve recortada al techo vigente", () => {
  const c = evaluarBandeja(inv(), med(), 3000, TECHO);
  assert.equal(c.hoyPuede, TECHO);
  assert.equal(c.asignada, 3000, "lo guardado no se reescribe; solo lo servido se recorta");
});

test("sin trafico es gris pero editable: el numero espera a que arranque", () => {
  const c = evaluarBandeja(inv(), med({ estado: "no_traffic", detalle: "sin envios" }), 200, TECHO);
  assert.equal(c.color, "gris");
  assert.equal(c.hoyPuede, 0);
  assert.equal(c.editable, true);
});

test("el techo por env respeta el absoluto", () => {
  assert.equal(resolverTecho({}), TECHO_DIARIO_DEFAULT);
  assert.equal(resolverTecho({ SENDER_QUOTA_DAILY_MAX: "1000" }), 1000);
  assert.equal(resolverTecho({ SENDER_QUOTA_DAILY_MAX: "999999" }), TECHO_ABSOLUTO);
  assert.equal(resolverTecho({ SENDER_QUOTA_DAILY_MAX: "que" }), TECHO_DIARIO_DEFAULT);
});

// ── Persistencia y armado contra un workspace real ───────────────────────────────────────────────

async function workspaceConFlota(): Promise<OpenClawWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), "cuota-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });

  await ws.updateInventoryJson("domains.json", () => ({
    bindings: [
      { domain: "sana.com", serverSlug: "n1", serverIp: "1.1.1.1" },
      { domain: "atascada.com", serverSlug: "n2", serverIp: "2.2.2.2" },
      { domain: "virgen.com", serverSlug: "n3", serverIp: "3.3.3.3" },
      { domain: "conflictiva.com", serverSlug: "n4", serverIp: "4.4.4.4" }
    ]
  }));
  await ws.updateInventoryJson("smtp-credentials.json", () => ({
    smtpCredentials: [
      { domain: "sana.com", serverSlug: "n1", status: "configured", createdAt: "2026-07-10T00:00:00Z" },
      { domain: "atascada.com", serverSlug: "n2", status: "configured", createdAt: "2026-07-10T00:00:00Z" },
      { domain: "virgen.com", serverSlug: "n3", status: "configured", createdAt: "2026-07-10T00:00:00Z" },
      { domain: "conflictiva.com", serverSlug: "OTRO", status: "configured", createdAt: "2026-07-10T00:00:00Z" },
      { domain: "invisible.com", status: "configured", createdAt: "2026-07-10T00:00:00Z" }
    ]
  }));
  const medicion: MedicionFlota = {
    medidoEn: ahora.toISOString(),
    duracionMs: 1000,
    pedidas: 2,
    leidas: 2,
    bandejas: [
      med({ domain: "sana.com", serverSlug: "n1" }),
      med({ domain: "atascada.com", serverSlug: "n2", estado: "stalled", diferidos: 920 })
    ]
  };
  await ws.updateInventoryJson(MEASUREMENT_FILE, () => medicion);
  return ws;
}

test("guardarCuota rechaza —no clampa— lo que supere el techo", async () => {
  const ws = await workspaceConFlota();
  const r = await guardarCuota({ workspace: ws, domain: "sana.com", hoyPuede: 3964, techo: TECHO, now: () => ahora });
  assert.deepEqual(r, { ok: false, error: "cuota_supera_techo", techo: TECHO });
});

test("guardarCuota rechaza lo que no sea un entero no negativo", async () => {
  const ws = await workspaceConFlota();
  for (const malo of [-1, 1.5, "800", null, undefined, Number.NaN]) {
    const r = await guardarCuota({ workspace: ws, domain: "sana.com", hoyPuede: malo, techo: TECHO, now: () => ahora });
    assert.equal(r.ok, false, `acepto ${String(malo)}`);
  }
});

test("guardarCuota rechaza dominios fuera del inventario", async () => {
  const ws = await workspaceConFlota();
  const r = await guardarCuota({ workspace: ws, domain: "ajena.com", hoyPuede: 100, techo: TECHO, now: () => ahora });
  assert.deepEqual(r, { ok: false, error: "dominio_desconocido" });
});

test("la cuota guardada se sirve por hoyPuede solo en la bandeja verde", async () => {
  const ws = await workspaceConFlota();
  await guardarCuota({ workspace: ws, domain: "sana.com", hoyPuede: 1200, techo: TECHO, now: () => ahora });
  await guardarCuota({ workspace: ws, domain: "atascada.com", hoyPuede: 500, techo: TECHO, now: () => ahora });

  const flota = await armarCuotaFlota({ workspace: ws, techo: TECHO, now: () => ahora });

  const sana = flota.bandejas.find((b) => b.domain === "sana.com");
  const atascada = flota.bandejas.find((b) => b.domain === "atascada.com");
  assert.equal(sana?.hoyPuede, 1200);
  assert.equal(atascada?.hoyPuede, 0, "roja no sirve su asignada");
  assert.equal(flota.totalHoyPuede, 1200, "la suma solo cuenta lo verde");
});

test("invisibles y conflictos no son filas: van al pie por nombre", async () => {
  const ws = await workspaceConFlota();
  const flota = await armarCuotaFlota({ workspace: ws, techo: TECHO, now: () => ahora });

  const dominios = flota.bandejas.map((b) => b.domain);
  assert.ok(!dominios.includes("invisible.com"));
  assert.ok(!dominios.includes("conflictiva.com"));
  assert.deepEqual(flota.fueraDeMedicion, ["invisible.com"]);
  assert.deepEqual(flota.enConflicto, ["conflictiva.com"]);
  assert.equal(flota.totalBandejas, 5, "el denominador sigue siendo el total real");
});

test("la lista ordena riesgo primero: rojo, verde, gris", async () => {
  const ws = await workspaceConFlota();
  const flota = await armarCuotaFlota({ workspace: ws, techo: TECHO, now: () => ahora });
  assert.deepEqual(
    flota.bandejas.map((b) => b.color),
    ["rojo", "verde", "gris"]
  );
  assert.equal(flota.bandejas[2]?.domain, "virgen.com", "nunca medida cierra la lista");
});

test("nunca medida la flota, la respuesta lo declara en vez de inventar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cuota-v-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });
  await ws.updateInventoryJson("domains.json", () => ({
    bindings: [{ domain: "a.com", serverSlug: "n1", serverIp: "1.1.1.1" }]
  }));
  await ws.updateInventoryJson("smtp-credentials.json", () => ({
    smtpCredentials: [{ domain: "a.com", serverSlug: "n1", status: "configured" }]
  }));

  const flota = await armarCuotaFlota({ workspace: ws, techo: TECHO, now: () => ahora });
  assert.equal(flota.medidoEn, null, "nunca medido NO es medido-hace-cero");
  assert.ok(flota.bandejas.every((b) => b.color === "gris" && b.hoyPuede === 0));
});
