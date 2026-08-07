// Tests del evaluador de alertas. Lo que protegen: que la severidad se calcule bien (el umbral
// permanente SIEMPRE crítico), que una bandeja dispare todas las alertas que le corresponden, y
// que "cerca" no duplique a "cruzado".

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OpenClawWorkspace } from "./openclaw-workspace.ts";
import { type CuotaBandeja } from "./sender-quota.ts";
import { TECHO_DURO_POR_DOMINIO } from "../../warmup-engine/src/domain/decision-diaria.ts";
import { MEASUREMENT_FILE, type MedicionFlota } from "./sender-measurement.ts";
import { alertasDeBandeja, alertasDeCap, armarAlertasFlota } from "./sender-alerts.ts";
import { buildDailyCapInstallPlan, CAP_MEASUREMENT_FILE, type CapFlota, type CapNodo } from "./node-daily-cap.ts";

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

// ── Alertas del límite físico ────────────────────────────────────────────────────────────────────

function capNodo(overrides: Partial<CapNodo> = {}): CapNodo {
  return { domain: "a.com", serverSlug: "n1", cap: 2000, consumidoHoy: 0, cableado: true, motivo: null, ...overrides };
}

test("un nodo que tocó el techo es high y dice que lo que llegue se difiere", () => {
  const a = alertasDeCap(capNodo({ consumidoHoy: 2000 }));
  assert.equal(a.length, 1);
  assert.equal(a[0]?.severity, "high");
  assert.equal(a[0]?.kind, "cap_alcanzado");
  assert.match(a[0]?.detail ?? "", /2000\/2000/);
});

test("cerca del cap (>=80%) avisa; por debajo no molesta", () => {
  assert.equal(alertasDeCap(capNodo({ consumidoHoy: 1600 }))[0]?.kind, "cerca_del_cap");
  assert.equal(alertasDeCap(capNodo({ consumidoHoy: 1600 }))[0]?.severity, "warning");
  assert.deepEqual(alertasDeCap(capNodo({ consumidoHoy: 1599 })), [], "79,9% todavía no es noticia");
});

test("un nodo SIN límite físico alerta aunque no esté enviando (regresión de config)", () => {
  const a = alertasDeCap(capNodo({ cableado: false, motivo: "falta restriction en submission (587)", cap: null, consumidoHoy: null }));
  assert.equal(a[0]?.severity, "high");
  assert.equal(a[0]?.kind, "sin_limite_fisico");
  assert.match(a[0]?.detail ?? "", /submission/);
});

test("cableado pero con el cap ILEGIBLE alerta alto: difiere el 100% y nadie se enteraba", () => {
  // El policy service ante un cap ilegible lee 0 ⇒ `n >= 0` siempre ⇒ difiere todo. Devolver []
  // acá dejaba el nodo frenado del todo, invisible en las alertas Y hundido al fondo del panel.
  const a = alertasDeCap(capNodo({ cap: null, consumidoHoy: 5 }));
  assert.equal(a.length, 1);
  assert.equal(a[0]?.severity, "high");
  assert.match(a[0]?.detail ?? "", /difiriendo TODO/);
});

test("un cap ARRIBA DEL TECHO es crítico: lo escribió algo de afuera", () => {
  // INCIDENTE QUE FIJA (2026-08-06, sender-cap.json de producción, medidoEn 14:56:59.863Z, 58 nodos):
  // 10 nodos con cap 15000 y `cableado: true`, contra un techo que el propio código se NIEGA a
  // instalar (`node-daily-cap.ts` tira error si le piden más). `grep -rn "15000"` sobre apps/
  // scripts/ packages/ no encuentra un solo lugar donde este sistema escriba ese número.
  //
  // De esos 10, ocho ya están clasificados como bulk sender PERMANENTE por Google; el noveno,
  // `infranationalreport.com`, está a 0,93 del umbral con la puerta de Gmail todavía abierta — a un
  // día malo de ser irrecuperable. Y `alertasDeCap` sobre ese 15000 devolvía [] o, con el día lleno,
  // un `cap_alcanzado` que suena a "trabajó bien". Mismo modo de falla que el 2026-08-04, cuando 46
  // nodos aparecieron con caps por dominio que ningún código de este lado escribió.
  const a = alertasDeCap(capNodo({ cap: 15000, consumidoHoy: 100 }));
  assert.equal(a.length, 1, "un nodo así tiene UN problema, y no es cuán lleno está el día");
  assert.equal(a[0]?.severity, "critical", "critical se reserva para lo irreversible, y esto lo habilita");
  assert.equal(a[0]?.kind, "cap_ilegal");
  assert.match(a[0]?.detail ?? "", /15000/);
  assert.match(a[0]?.detail ?? "", new RegExp(String(TECHO_DURO_POR_DOMINIO)));
});

test("EL TECHO ES UNO SOLO: lo que no se puede instalar tampoco puede pasar callado", () => {
  // EL DEFECTO QUE ESTE TEST IMPIDE, y ya se había shipeado. `buildDailyCapInstallPlan` se movió de
  // TECHO_ABSOLUTO (4000) a TECHO_DURO_POR_DOMINIO (2000) —bien, porque un techo duplicado deja de
  // ser un techo el día que alguien sube uno solo— y este archivo se quedó con el viejo. Quedó una
  // franja 2001-4000 donde el cap está por encima de lo que este sistema acepta instalar, el
  // alertador CALLA y el nodo se lee legal. De tres copias del techo se movió una.
  //
  // El invariante, y no el número: si el instalador lo rechaza, el alertador tiene que verlo.
  for (const cap of [TECHO_DURO_POR_DOMINIO + 1, 2500, 3000, 3999, 4000, 4001, 15000]) {
    let instala = true;
    try {
      buildDailyCapInstallPlan({ cap });
    } catch {
      instala = false;
    }
    const alerta = alertasDeCap(capNodo({ cap, consumidoHoy: 0 })).some((x) => x.kind === "cap_ilegal");
    assert.equal(alerta, !instala, `cap ${cap}: el instalador ${instala ? "lo acepta" : "lo rechaza"} y el alertador ${alerta ? "alerta" : "calla"}`);
  }
});

test("el borde EXACTO del techo es legal, y el cap ilegal no caduca con el día", () => {
  // Mismo borde que ya fija node-daily-cap.test.ts: `> TECHO_DURO_POR_DOMINIO`, no `>=`. 2000 se instala.
  assert.deepEqual(
    alertasDeCap(capNodo({ cap: TECHO_DURO_POR_DOMINIO, consumidoHoy: 0 })).filter((x) => x.kind === "cap_ilegal"),
    []
  );
  assert.equal(alertasDeCap(capNodo({ cap: TECHO_DURO_POR_DOMINIO + 1, consumidoHoy: 0 }))[0]?.kind, "cap_ilegal");
  // El contador se reinicia a medianoche UTC; el CAP no. Una lectura de ayer no puede afirmar
  // consumo, pero la puerta de 15.000 sigue abierta hoy — igual que `sin_limite_fisico`.
  assert.equal(
    alertasDeCap(capNodo({ cap: 15000, consumidoHoy: null }), { contadorDelDia: false })[0]?.kind,
    "cap_ilegal"
  );
  // Y el orden de las ramas no se toca: sin límite físico gana, porque no hay puerta que medir.
  assert.equal(
    alertasDeCap(capNodo({ cap: 15000, cableado: false, motivo: "falta la restriction" }))[0]?.kind,
    "sin_limite_fisico"
  );
});

test("sin contador NO se inventa un porcentaje", () => {
  assert.deepEqual(alertasDeCap(capNodo({ consumidoHoy: null })), []);
});

test("una lectura de OTRO día no afirma consumo, pero sí delata un nodo sin límite", () => {
  // El contador se reinicia a medianoche UTC: "tocó el techo" sobre datos de ayer es falso, no
  // viejo. Lo que no depende del día es si la puerta está puesta.
  assert.deepEqual(alertasDeCap(capNodo({ consumidoHoy: 2000 }), { contadorDelDia: false }), []);
  assert.deepEqual(alertasDeCap(capNodo({ consumidoHoy: 1900 }), { contadorDelDia: false }), []);
  const sinLimite = alertasDeCap(capNodo({ cableado: false, motivo: "falta la restriction" }), { contadorDelDia: false });
  assert.equal(sinLimite[0]?.kind, "sin_limite_fisico", "esto no caduca con el día");
});

test("el nodo tapado gana a su propio aviso de cercanía (una sola alerta)", () => {
  const a = alertasDeCap(capNodo({ consumidoHoy: 5000, cap: 2000 }));
  assert.equal(a.length, 1);
  assert.equal(a[0]?.kind, "cap_alcanzado");
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
  assert.equal(flota.capMedidoEn, null, "sin corrida de límite físico se declara, no se asume");
});

test("las alertas del cap se fusionan con las de entrega, desde su propio JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alerts-cap-"));
  const ws = new OpenClawWorkspace({ rootDir: join(dir, "workspace") });
  await ws.updateInventoryJson("domains.json", () => ({
    bindings: [{ domain: "sana.com", serverSlug: "n1", serverIp: "1.1.1.1" }]
  }));
  await ws.updateInventoryJson("smtp-credentials.json", () => ({
    smtpCredentials: [{ domain: "sana.com", serverSlug: "n1", status: "configured", createdAt: "2026-07-10T00:00:00Z" }]
  }));
  await ws.updateInventoryJson(MEASUREMENT_FILE, () => ({
    medidoEn: ahora.toISOString(),
    duracionMs: 1,
    pedidas: 1,
    leidas: 1,
    bandejas: [
      { domain: "sana.com", serverSlug: "n1", estado: "healthy", detalle: "ok", ventana: "24h", entregados: 100, rechazados: 0, diferidos: 0, cerradoEn: [], picos: [], cruzados: [], cerca: [] }
    ]
  }));
  // Una bandeja que ENTREGA perfecto pero agotó su cupo: son dos familias distintas de alerta y
  // por eso la de cap tiene que aparecer igual.
  const cap: CapFlota = {
    medidoEn: ahora.toISOString(),
    ilegibles: 0,
    nodos: [{ domain: "sana.com", serverSlug: "n1", cap: 2000, consumidoHoy: 2000, cableado: true, motivo: null }]
  };
  await ws.updateInventoryJson(CAP_MEASUREMENT_FILE, () => cap);

  const flota = await armarAlertasFlota({ workspace: ws, techo: 2000, now: () => ahora });
  assert.equal(flota.capMedidoEn, ahora.toISOString());
  assert.equal(flota.conteos.high, 1);
  assert.equal(flota.alerts[0]?.kind, "cap_alcanzado", "la bandeja verde igual alerta por su cupo");
});
