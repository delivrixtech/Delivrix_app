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
  rampaParaCuota,
  resumirCuotaFlota,
  TECHO_ABSOLUTO,
  TECHO_DIARIO_DEFAULT,
  resolverTecho,
  type RampaCuota
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

test("umbral cruzado gana aunque la SALUD sea ilegible y haya rampa: no vende un dominio quemado", () => {
  // El caso real: salud (SSH) falla → estado unreadable, pero volumen (otro SSH) leyó que cruzó
  // Google. Gatearlo tras !== unreadable lo dejaba caer a la rampa y vender cupo. Nunca más.
  const c = evaluarBandeja(
    inv(),
    med({ estado: "unreadable", cruzados: ["google"] }),
    null,
    TECHO,
    rampa()
  );
  assert.equal(c.color, "rojo");
  assert.equal(c.estado, "umbral cruzado");
  assert.equal(c.hoyPuede, 0, "un dominio que cruzó el umbral permanente NO calienta");
});

test("bloqueada por el receptor es roja y vende 0", () => {
  const c = evaluarBandeja(inv(), med({ estado: "blocked_by_provider", cerradoEn: ["yahoo.com", "aol.com"] }), 500, TECHO);
  assert.equal(c.color, "rojo");
  assert.equal(c.estado, "bloqueada");
  assert.match(c.motivo ?? "", /yahoo\.com/);
  assert.equal(c.hoyPuede, 0);
});

test("rechazo parcial (degraded) es rojo y vende 0", () => {
  const c = evaluarBandeja(inv(), med({ estado: "degraded", detalle: "rechazo parcial en gmail.com" }), 500, TECHO);
  assert.equal(c.color, "rojo");
  assert.equal(c.estado, "rechazo parcial");
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

// ── El cable rampa → cuota ───────────────────────────────────────────────────────────────────────

function rampa(overrides: Partial<RampaCuota> = {}): RampaCuota {
  return { estado: "running", cupoHoy: 200, dia: 3, totalDias: 14, schedule: "production-14d", ...overrides };
}

test("mientras calienta, NFC vende 0: la rampa envía el volumen, no NFC encima", () => {
  const c = evaluarBandeja(inv(), med(), 1800, TECHO, rampa());
  assert.equal(c.color, "calentando");
  assert.equal(c.estado, "rampa día 3/14");
  assert.equal(c.hoyPuede, 0, "NFC no manda su tráfico encima del de la rampa: sería doble envío");
  assert.equal(c.editable, false, "el numero manual queda guardado para cuando termine");
  assert.equal(c.asignada, 1800, "la asignada del operador no se pierde");
  assert.equal(c.rampa?.cupoHoy, 200, "el cupo de la rampa queda visible para la pantalla");
});

test("una rampa grande NO puede cruzar el umbral vía NFC: hoyPuede sigue 0", () => {
  // El caso que mataba el cable: rampa día 14 envía 50.000 ella misma; si NFC además consumiera
  // hoyPuede, el dominio cruzaría el umbral permanente. hoyPuede=0 lo hace imposible.
  const c = evaluarBandeja(inv(), med(), null, TECHO, rampa({ cupoHoy: 50_000, dia: 14 }));
  assert.equal(c.color, "calentando");
  assert.equal(c.hoyPuede, 0);
});

test("rojo gana SIEMPRE, incluso a una rampa corriendo", () => {
  const c = evaluarBandeja(inv(), med({ estado: "stalled", diferidos: 920 }), null, TECHO, rampa());
  assert.equal(c.color, "rojo");
  assert.equal(c.estado, "cola atascada");
  assert.equal(c.hoyPuede, 0, "calentar encima de una cola atascada es echar gasolina");
});

test("rampa auto-pausada es roja con el motivo del freno", () => {
  const c = evaluarBandeja(inv(), med(), null, TECHO, rampa({ estado: "auto_paused", pauseReason: "auto_bounce_rate" }));
  assert.equal(c.color, "rojo");
  assert.equal(c.estado, "rampa pausada");
  assert.match(c.motivo ?? "", /auto_bounce_rate/);
  assert.equal(c.hoyPuede, 0);
});

test("rampa pausada a mano es gris, no roja: fue una decision, no un freno", () => {
  const c = evaluarBandeja(inv(), med(), null, TECHO, rampa({ estado: "paused" }));
  assert.equal(c.color, "gris");
  assert.equal(c.hoyPuede, 0);
});

test("la rampa se refleja sin medicion de la fabrica: la bandeja fresca aun no deja huella", () => {
  const c = evaluarBandeja(inv(), null, null, TECHO, rampa({ cupoHoy: 50, dia: 1 }));
  assert.equal(c.color, "calentando");
  assert.equal(c.hoyPuede, 0, "NFC vende 0 mientras calienta; la rampa envía sus 50 ella misma");
  assert.equal(c.rampa?.cupoHoy, 50, "el cupo de la rampa queda visible para la pantalla");
});

test("rampaParaCuota elige el batch vigente: el ultimo cuyo scheduledAt ya paso", () => {
  const inicio = Date.parse("2026-07-29T00:00:00.000Z");
  const batches = [0, 1, 2, 3].map((i) => ({
    batchIndex: i,
    scheduledAt: new Date(inicio + i * 86_400_000).toISOString(),
    emailCount: [50, 100, 200, 400][i]!
  }));
  const r = rampaParaCuota(
    { schedule: "production-14d", state: "running", batches },
    new Date("2026-07-31T12:00:00.000Z") // 2.5 dias despues del inicio
  );
  assert.equal(r.cupoHoy, 200);
  assert.equal(r.dia, 3);
  assert.equal(r.totalDias, 4);
});

test("rampa que arranca en el futuro: el cupo es el del primer batch, no cero inventado", () => {
  const r = rampaParaCuota(
    {
      schedule: "production-14d",
      state: "running",
      batches: [{ batchIndex: 0, scheduledAt: "2026-08-05T00:00:00.000Z", emailCount: 50 }]
    },
    ahora
  );
  assert.equal(r.cupoHoy, 50);
  assert.equal(r.dia, 1);
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

test("una rampa activa en el workspace pone la bandeja en calentando y NFC vende 0 en ella", async () => {
  const ws = await workspaceConFlota();
  await guardarCuota({ workspace: ws, domain: "sana.com", hoyPuede: 1200, techo: TECHO, now: () => ahora });
  // virgen.com no tiene medicion: la rampa es exactamente para esa bandeja.
  await ws.updateInventoryJson("warmup-progress.json", () => ({
    ramps: [
      {
        rampId: "ramp-1",
        domain: "virgen.com",
        serverSlug: "n3",
        serverIp: "3.3.3.3",
        schedule: "production-14d",
        state: "running",
        recipientPool: [],
        totalPlanned: 350,
        totalSent: 150,
        totalBounced: 0,
        startedAt: "2026-07-29T00:00:00.000Z",
        updatedAt: ahora.toISOString(),
        batches: [0, 1, 2].map((i) => ({
          batchIndex: i,
          scheduledAt: new Date(Date.parse("2026-07-29T00:00:00.000Z") + i * 86_400_000).toISOString(),
          emailCount: [50, 100, 200][i]!,
          status: i < 2 ? "sent" : "running"
        })),
        actorId: "test",
        approvalToken: "t"
      }
    ]
  }));

  const flota = await armarCuotaFlota({ workspace: ws, techo: TECHO, now: () => ahora });

  const virgen = flota.bandejas.find((b) => b.domain === "virgen.com");
  assert.equal(virgen?.color, "calentando");
  assert.equal(virgen?.hoyPuede, 0, "NFC no vende sobre una bandeja que la rampa está calentando");
  assert.equal(virgen?.rampa?.cupoHoy, 200, "el cupo del batch vigente (dia 3) queda visible");
  assert.equal(virgen?.rampa?.schedule, "production-14d");
  assert.equal(flota.totalHoyPuede, 1200, "solo la verde con asignada (1200) aporta; la rampa 0");
  assert.deepEqual(
    flota.bandejas.map((b) => b.color),
    ["rojo", "calentando", "verde"],
    "lo que calienta se mira a diario: entre rojo y verde"
  );
});

test("cruce pegajoso: una lectura de volumen fallida NO borra un cruce del umbral permanente", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { medirFlota } = await import("./sender-measurement.ts");
  const dir = await mkdtemp(join(tmpdir(), "sticky-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });

  const salud = `## DELIVERED\n   100 gmail.com\n## BLOCKED\n## DEFERRED\n## END`;
  const volumenCruza = `## VOLUME\n   6000 Jul 30\tgmail.com\n## END`;
  const runner = (vol: string) => ({
    async run(input: { command: string }) {
      return { stdout: input.command.includes("## VOLUME") ? vol : salud, exitCode: 0 };
    }
  });

  // Corrida 1: el volumen lee que cruzó Google (6000 > 5000).
  const c1 = await medirFlota({
    workspace: ws,
    sshRunner: runner(volumenCruza),
    bandejas: [{ domain: "quemado.com", serverSlug: "n1", serverIp: "1.1.1.1" }],
    now: () => ahora
  });
  assert.deepEqual(c1.bandejas[0]?.cruzados, ["google"], "corrida 1 detecta el cruce");

  // Corrida 2: la lectura de volumen falla (sin ## END) → cruzados vendría []. NO debe olvidarse.
  const c2 = await medirFlota({
    workspace: ws,
    sshRunner: runner("## VOLUME\n   6000 Jul 30\tgmail.com"),
    bandejas: [{ domain: "quemado.com", serverSlug: "n1", serverIp: "1.1.1.1" }],
    now: () => new Date(ahora.getTime() + 86_400_000)
  });
  assert.deepEqual(c2.bandejas[0]?.cruzados, ["google"], "el cruce permanente sobrevive a la lectura fallida");
});

test("resumirCuotaFlota entrega la foto completa y compacta (cabe en el límite de tool)", async () => {
  const ws = await workspaceConFlota();
  await guardarCuota({ workspace: ws, domain: "sana.com", hoyPuede: 1200, techo: TECHO, now: () => ahora });
  const flota = await armarCuotaFlota({ workspace: ws, techo: TECHO, now: () => ahora });
  const resumen = resumirCuotaFlota(flota);

  assert.equal(resumen.medidoEn, flota.medidoEn, "NO pierde medidoEn (lo que el crudo truncado sí perdía)");
  assert.equal(resumen.totalHoyPuede, flota.totalHoyPuede);
  assert.equal(resumen.conteos.verde + resumen.conteos.rojo + resumen.conteos.gris + resumen.conteos.calentando, flota.bandejas.length);
  assert.deepEqual(resumen.vendibles, [{ dom: "sana.com", hoyPuede: 1200 }], "vendibles = verdes con cupo");
});

test("resumirCuotaFlota cabe en el límite de tool CON LA FLOTA REAL (58+ bandejas), no solo el fixture chico", () => {
  // El fixture de 4 dominios pasaba < 4096 mientras en vivo daba 5163 — un test que no protegía
  // nada. Esto arma 60 bandejas rojas (el peor caso: nombres largos + estado) y exige que quepa.
  const flota: import("./sender-quota.ts").CuotaFlota = {
    medidoEn: ahora.toISOString(),
    techoDiario: TECHO,
    totalHoyPuede: 0,
    totalBandejas: 60,
    fueraDeMedicion: Array.from({ length: 7 }, (_, i) => `dominio-invisible-numero-${i}.com`),
    enConflicto: ["corpfiling-ops.com"],
    parcial: false,
    motivosParcial: [],
    bandejas: Array.from({ length: 60 }, (_, i) =>
      evaluarBandeja(
        inv({ domain: `unnombredebandejabastante-largo-numero-${i}.com` }),
        med({ estado: "blocked_by_provider", cerradoEn: ["yahoo.com", "aol.com", "bellsouth.net"] }),
        500,
        TECHO
      )
    )
  };
  const bytes = JSON.stringify(resumirCuotaFlota(flota)).length;
  assert.ok(bytes < 4096, `el resumen de la flota real debe caber en 4096; midió ${bytes}`);
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
