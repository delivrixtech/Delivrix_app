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

/** Azúcar para leer los tests: todas las mediciones del mismo dominio salvo que se diga otra cosa. */
const de = (dominio: string, ...ps: Placement[]) => ps.map((placement) => ({ dominio, placement }));

test("recentInboxRate: proporción de bandeja, null si vacío", () => {
  assert.equal(recentInboxRate([]), null, "sin muestra es null, NO 0%");
  assert.deepEqual(recentInboxRate(de("a.com", "INBOX", "INBOX")), { tasa: 1, muestra: 2 });
  assert.equal(recentInboxRate(de("a.com", "INBOX", "SPAM"))?.tasa, 0.5);
  // PROMOTIONS cuenta como bandeja. Este test afirmaba lo contrario (`["SPAM","PROMOTIONS"] → 0`)
  // y estaba fijando la regla equivocada: el diseño v1 §10 dice textual que las pestañas cuentan
  // como inbox, y `placement.ts:33` ya lo implementaba así. Con la regla vieja, un dominio sano
  // cuyos correos caen en la pestaña Promociones daba 0% y el gate lo pausaba.
  assert.equal(recentInboxRate(de("a.com", "SPAM", "PROMOTIONS"))?.tasa, 0.5);
  assert.equal(recentInboxRate(de("a.com", "PROMOTIONS", "PROMOTIONS"))?.tasa, 1);
  // OTHER no: archivado o etiquetado por el usuario no es aterrizar en bandeja.
  assert.equal(recentInboxRate(de("a.com", "OTHER", "INBOX"))?.tasa, 0.5);
});

test("recentInboxRate: lo que midió un dominio que hoy NO puede enviar no cuenta", () => {
  // Sin esto, frenar al dominio culpable no destrababa a los sanos: sus muestras seguían pesando
  // en el promedio de la flota y el freno global quedaba puesto igual.
  const mezcla = [...de("sano.com", "INBOX", "INBOX"), ...de("frenado.com", "SPAM", "SPAM")];
  assert.equal(recentInboxRate(mezcla)?.tasa, 0.5, "sin filtro, el frenado arrastra al sano");
  assert.deepEqual(recentInboxRate(mezcla, new Set(["sano.com"])), { tasa: 1, muestra: 2 });
  assert.equal(recentInboxRate(mezcla, new Set(["nadie.com"])), null, "si ninguno cuenta, es null");
});

const base = {
  enabled: true,
  killed: false,
  cyclesToday: 0,
  maxPerDay: 3,
  recentPlacements: [] as { dominio: string; placement: Placement }[],
  placementFloor: 0.5
};

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

test("gate: placement bajo el piso, CON muestra suficiente ⇒ placement-pause", () => {
  const bad = de("x.com", "SPAM", "SPAM", "SPAM", "SPAM", "SPAM", "SPAM", "SPAM", "INBOX", "INBOX", "INBOX"); // 30%
  assert.equal(decideDaemonAction({ ...base, recentPlacements: bad }).action, "placement-pause");
  const ok = de("x.com", "INBOX", "INBOX", "INBOX", "INBOX", "INBOX", "INBOX", "SPAM", "SPAM", "SPAM", "SPAM"); // 60%
  assert.equal(decideDaemonAction({ ...base, recentPlacements: ok }).action, "send");
});

test("gate: sin mediciones aún ⇒ no bloquea por placement (envía)", () => {
  assert.equal(decideDaemonAction({ ...base, recentPlacements: [] }).action, "send");
});

test("gate: con muestra chica NO apaga la fábrica entera", () => {
  // El caso REAL del 2026-08-06, con los datos de producción: el warmup llevaba horas parado con
  // "inbox 33% < piso 50%", y esas seis mediciones eran el único dominio que venía calentando bien
  // (2/2) contra cuatro muestras sueltas de cuatro dominios que recién arrancaban. Que un dominio
  // nuevo caiga en spam el primer día es lo normal, no una degradación de la flota.
  const real = [
    ...de("nationalfiling-infra.com", "MISSING"),
    ...de("corpfiling-infra.com", "INBOX", "INBOX"),
    ...de("annualfilings-ops.com", "SPAM"),
    ...de("annualfilings-control.com", "SPAM"),
    ...de("annualcorp-infra.com", "SPAM")
  ];
  const r = recentInboxRate(real);
  assert.equal(r?.muestra, 6);
  assert.ok((r?.tasa ?? 1) < 0.5, "la tasa SIGUE siendo baja: no se tocó el cálculo, se tocó cuándo manda");
  assert.equal(decideDaemonAction({ ...base, recentPlacements: real }).action, "send", "6 mediciones no alcanzan para apagar 58 nodos");
});

test("gate: el freno global no puede ser un candado", () => {
  // Parado no se mide, sin medir la tasa no cambia, y sin que la tasa cambie no se destraba: la
  // única salida era un humano a mano. Con el filtro por elegibles, frenar al dominio culpable
  // destraba a los sanos en la vuelta siguiente — que es lo que el agente ya sabe hacer solo.
  const mezcla = [
    ...de("culpable.com", "SPAM", "SPAM", "SPAM", "SPAM", "SPAM", "SPAM", "SPAM", "SPAM"),
    ...de("sano.com", "INBOX", "INBOX")
  ];
  assert.equal(decideDaemonAction({ ...base, recentPlacements: mezcla }).action, "placement-pause");
  assert.equal(
    decideDaemonAction({ ...base, recentPlacements: mezcla, elegibles: new Set(["sano.com"]) }).action,
    "send",
    "sacado el culpable del pool, el sano vuelve a calentar sin que nadie toque nada"
  );
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

test("la rotación PRIORIZA las que miden, y reparte entre ellas", () => {
  // Cazado en la primera prueba real: con la mayoría de las semillas sin credencial, la rotación
  // mandaba el correo a una que no mide y la vuelta no producía placement — el dato que gatea la
  // rampa. Ahora las solo-destino son reserva, no sorteo.
  const seeds: SeedDelDaemon[] = [
    { address: "mide@gmail.com", provider: "gmail", enabled: true, auth: "gmail_oauth" },
    { address: "destino@gmail.com", provider: "gmail", enabled: true, auth: "none" },
    { address: "muerta@gmail.com", provider: "gmail", enabled: false, auth: "none" }
  ];
  for (let v = 0; v < 6; v += 1) {
    assert.equal(elegirSemillaDelRegistro(seeds, "dominio.com", v)?.address, "mide@gmail.com");
  }

  const dos: SeedDelDaemon[] = [...seeds, { address: "mide2@yahoo.com", provider: "yahoo", enabled: true, auth: "imap_password" }];
  const usadas = new Set<string>();
  for (let v = 0; v < 8; v += 1) usadas.add(elegirSemillaDelRegistro(dos, "dominio.com", v)!.address);
  assert.deepEqual([...usadas].sort(), ["mide2@yahoo.com", "mide@gmail.com"], "reparte entre las que miden");

  const soloDestino: SeedDelDaemon[] = [{ address: "d@gmail.com", provider: "gmail", enabled: true, auth: "none" }];
  assert.equal(elegirSemillaDelRegistro(soloDestino, "x.com", 0)?.address, "d@gmail.com", "sin ninguna que mida, cae a destino");
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

// Los tests del POOL viven ahora en `plan-diario.test.ts`, junto a la función. Estaban acá cuando
// `elegirPool` era del daemon; al extraerla al módulo compartido quedaron probando una firma que ya
// no existe — y un test que se queda atrás de su código es peor que no tenerlo.

// ── El CUERPO del loop, que nunca tuvo un test ───────────────────────────────────────────────────
//
// Acá es donde sale el correo real, y hasta hoy no se ejercitaba en ningún test: el daemon creaba
// su propio Pool, sus mailers y su cliente IMAP adentro. La costura `dobles` existe para esto.

import { startLiveWarmupDaemon } from "./live-warmup-daemon.ts";

/** Postgres falso: responde por la forma de la consulta y puede fallar cuando se le pida. */
function pgFalso(opts: { fallaEn?: RegExp; desdeLaLlamada?: number } = {}) {
  const consultas: string[] = [];
  let coincidencias = 0;
  const pg = {
    async query(sql: string) {
      consultas.push(sql);
      if (opts.fallaEn?.test(sql)) {
        coincidencias += 1;
        // `desdeLaLlamada` importa: la PRIMERA llamada a countCyclesToday es el sembrado de `seq`
        // en el arranque, que está fuera del try a propósito (morir ruidoso al arrancar es
        // correcto, el operador está mirando). Lo que se prueba acá es el fallo EN EL CUERPO.
        if (coincidencias >= (opts.desdeLaLlamada ?? 1)) {
          throw new Error("57P01 terminating connection due to administrator command");
        }
      }
      if (/COUNT\(DISTINCT cycle_id\)/.test(sql)) return { rows: [{ n: 0 }] };
      if (/kind = 'measured'/.test(sql)) return { rows: [] };
      if (/COUNT\(\*\)::int/.test(sql)) return { rows: [] };
      if (/kind = 'error'/.test(sql)) return { rows: [] };
      if (/MIN\(occurred_at\)/.test(sql)) return { rows: [] };
      if (/seed_inbox, occurred_at/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    async end() {}
  };
  return { pg: pg as never, consultas };
}

const ENV_BASE = {
  WARMUP_LIVE_ENABLE: "true",
  // Llave de juguete: el daemon la exige en el ARRANQUE (y ahí morir ruidoso es correcto, el
  // operador está mirando). Sin ella el test nunca llegaría al cuerpo del loop, que es lo que
  // queremos ejercitar.
  CREDENTIAL_ENCRYPTION_KEY: "0".repeat(64),
  WARMUP_LIVE_INTERVAL_MS: "50",
  WARMUP_LIVE_BOXES: "solo.com",
  WARMUP_CAP_FILE: "/no/existe/cap.json",
  WARMUP_SALUD_FILE: "/no/existe/salud.json",
  WARMUP_SEEDS_FILE: "/no/existe/seeds.json",
  WARMUP_LIVE_KILL_FILE: "/no/existe/kill"
} as unknown as NodeJS.ProcessEnv;

function capturarLog() {
  const lineas: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lineas.push(a.join(" ")); };
  return { lineas, restaurar: () => { console.log = orig; } };
}

test("INERTE sin el flag: no toca la base ni manda nada", async () => {
  const { pg, consultas } = pgFalso();
  const c = capturarLog();
  try {
    await startLiveWarmupDaemon({ env: {} as NodeJS.ProcessEnv, argv: ["n", "d", "--once"], dobles: { pg, saltearMigraciones: true } });
  } finally { c.restaurar(); }
  assert.equal(consultas.length, 0, "cero consultas: el flag apagado es inerte de verdad");
  assert.ok(c.lineas.some((l) => /INERTE/.test(l)));
});

test("una vuelta fallida NO mata el daemon: loguea y sigue", async () => {
  // Antes, cualquier excepción del cuerpo terminaba el proceso 24/7 para siempre y ningún lanzador
  // lo levantaba: el correo dejaba de salir sin que nadie se enterara.
  const { pg } = pgFalso({ fallaEn: /COUNT\(DISTINCT cycle_id\)/, desdeLaLlamada: 2 });
  const c = capturarLog();
  try {
    await assert.doesNotReject(
      startLiveWarmupDaemon({ env: ENV_BASE, argv: ["n", "d", "--once"], dobles: { pg, saltearMigraciones: true } })
    );
  } finally { c.restaurar(); }
  assert.ok(c.lineas.some((l) => /vuelta fallida, sigo/.test(l)), "se declara la vuelta perdida");
});

test("el pool de pg tiene listener de 'error': un socket ocioso roto no tumba el proceso", async () => {
  // pg-pool emite 'error' en clientes ociosos FUERA de todo await: sin listener, EventEmitter lanza
  // y ningún try/catch lo ve. Es el caso normal cuando Postgres se reinicia durante las 4h de espera.
  const { resolvePool } = (await import("./live-warmup-daemon.ts")) as unknown as {
    resolvePool?: (env: NodeJS.ProcessEnv) => { listenerCount(e: string): number; end(): Promise<void> };
  };
  if (!resolvePool) return; // no exportado: el contrato se cubre por lectura del fuente abajo
  const p = resolvePool({} as NodeJS.ProcessEnv);
  assert.ok(p.listenerCount("error") > 0);
  await p.end();
});

test("CONTRATO: todos los Pool de pg del warmup registran listener de 'error'", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const f of ["apps/warmup-engine/src/service/live-warmup-daemon.ts", "scripts/ops/warmup-monitor.ts"]) {
    const src = await readFile(f, "utf8");
    if (!/new Pool\(/.test(src)) continue;
    assert.match(src, /\.on\("error"/, `${f}: Pool sin listener 'error' — un socket ocioso mata el proceso`);
  }
});
