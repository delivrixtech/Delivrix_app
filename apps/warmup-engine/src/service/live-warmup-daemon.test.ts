import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveLiveDaemonConfig,
  decideDaemonAction,
  recentInboxRate,
  pickBox,
  elegirBoxDeLaVuelta,
  lineaDeArranque,
  avisoDeSobre,
  poolSinSalud,
  lineaDeSemillas,
  elegirSemillaDelRegistro,
  puedeMedir,
  intervaloConJitter,
  dentroDeVentana,
  instrumentoDeMedicion,
  type SeedDelDaemon
} from "./live-warmup-daemon.ts";
import type { Placement } from "../live/warmup-live-cycle.ts";
import { esInbox, TECHO_DURO_POR_DOMINIO } from "../domain/decision-diaria.ts";

test("resolveLiveDaemonConfig: defaults conservadores + OFF por defecto", () => {
  const cfg = resolveLiveDaemonConfig({} as NodeJS.ProcessEnv);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.maxPerDay, 3);
  assert.equal(cfg.intervalMs, 4 * 60 * 60 * 1000);
  assert.equal(cfg.placementFloor, 0.5);
  assert.equal(cfg.seedInbox, "infradelivrixdemo@gmail.com");
  assert.ok(cfg.boxes.length >= 6);
  // Los defaults de la rampa son EXACTAMENTE los que estaban hardcodeados dentro de
  // `decidirCupoDeHoy` (`?? 40`, `?? 2`): con las env vars ausentes —el estado de producción hoy—
  // no cambia un solo correo.
  assert.equal(cfg.limiteDiario, 40);
  assert.equal(cfg.pasoPorDia, 2);
});

test("config FAIL-CLOSED: la basura cae al default, nunca a un número inventado", () => {
  // Un NaN acá no explota: se propaga a comparaciones `>=` que dan false para siempre, así que la
  // barrera se apaga en silencio. Cada entrada basura tiene que terminar en el default conservador.
  // "0" NO está en esta lista y esa es la corrección: en las palancas de RAMPA un cero es una orden
  // legítima ("congelá"), no basura. Tiene su propio test abajo.
  for (const basura of ["-5", "", "   ", "texto", "1e999", "NaN", "Infinity"]) {
    const cfg = resolveLiveDaemonConfig({
      WARMUP_LIVE_MAX_PER_DAY: basura,
      WARMUP_LIVE_INTERVAL_MS: basura,
      WARMUP_RAMPA_LIMITE_DIARIO: basura,
      WARMUP_RAMPA_PASO_POR_DIA: basura
    } as unknown as NodeJS.ProcessEnv);
    assert.equal(cfg.maxPerDay, 3, `maxPerDay con "${basura}"`);
    assert.equal(cfg.intervalMs, 4 * 60 * 60 * 1000, `intervalMs con "${basura}"`);
    assert.equal(cfg.limiteDiario, 40, `limiteDiario con "${basura}"`);
    assert.equal(cfg.pasoPorDia, 2, `pasoPorDia con "${basura}"`);
  }
});

test("rampa: un 0 escrito por el operador SE RESPETA — no cae al default y manda más de lo pedido", () => {
  // La trampa de `WARMUP_LIVE_MAX_PER_DAY=0` (documentada abajo) estaba REPRODUCIDA en las dos
  // palancas nuevas: con min=1, un 0 escrito a propósito para congelar la rampa caía al default y el
  // dominio mandaba 40/día. La diferencia con MAX_PER_DAY es el eje: estas dos gobiernan el volumen
  // POR DOMINIO, que es donde vive el umbral irreversible de Google. Un número escrito por el
  // operador no puede descartarse en silencio y salir MÁS alto.
  const cero = resolveLiveDaemonConfig({
    WARMUP_RAMPA_LIMITE_DIARIO: "0",
    WARMUP_RAMPA_PASO_POR_DIA: "0"
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(cero.limiteDiario, 0);
  assert.equal(cero.pasoPorDia, 0);

  // Y el vacío sigue siendo "no configurado", no "congelá": `Number("")` es 0, así que sin el guard
  // explícito de intEnv una variable declarada y sin valor habría frenado la rampa por accidente.
  const vacio = resolveLiveDaemonConfig({ WARMUP_RAMPA_LIMITE_DIARIO: "" } as unknown as NodeJS.ProcessEnv);
  assert.equal(vacio.limiteDiario, 40);
});

test("config: un decimal se trunca HACIA ABAJO, nunca hacia arriba", () => {
  // Redondear "2.9" a 3 sería dar más volumen del escrito. Se corta para abajo, siempre.
  const cfg = resolveLiveDaemonConfig({
    WARMUP_LIVE_MAX_PER_DAY: "2.9",
    WARMUP_RAMPA_LIMITE_DIARIO: "39.9"
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(cfg.maxPerDay, 2);
  assert.equal(cfg.limiteDiario, 39);
});

test("config: WARMUP_LIVE_MAX_PER_DAY=0 NO frena el daemon — cae al default 3", () => {
  // Esto NO es un descuido, es la trampa que hay que dejar escrita: alguien que quiera parar el
  // warmup escribiendo 0 obtiene 3, o sea MÁS de lo que pidió. Para frenar están el kill-file y
  // WARMUP_LIVE_ENABLE=false, que son las barreras hechas para eso.
  assert.equal(resolveLiveDaemonConfig({ WARMUP_LIVE_MAX_PER_DAY: "0" } as never).maxPerDay, 3);
});

// ── La línea ARRANCA: la aritmética del sobre de volumen ─────────────────────────────────────────

test("ARRANCA dice cuántos ciclos permite el intervalo, con los números REALES de producción", () => {
  const cfg = resolveLiveDaemonConfig({
    WARMUP_LIVE_MAX_PER_DAY: "14",
    WARMUP_LIVE_INTERVAL_MS: "5400000"
  } as unknown as NodeJS.ProcessEnv);
  const l = lineaDeArranque(cfg);
  assert.match(l, /tope 14 vueltas\/día/);
  assert.match(l, /intervalo 90min/);
  assert.match(l, /16 ciclos\/día posibles/, "24h / 90min = 16, y eso nunca estuvo escrito");
  assert.doesNotMatch(l, /OJO/, "14 ≤ 16: no hay nada que advertir");
  assert.match(l, new RegExp(`techo duro ${TECHO_DURO_POR_DOMINIO}/día`));
});

test("ARRANCA AVISA cuando el tope no se puede alcanzar con ese intervalo", () => {
  // La trampa aritmética: subir WARMUP_LIVE_MAX_PER_DAY a 50 sin bajar el intervalo no agrega un
  // solo correo, y el log de antes no decía nada — el que lo subió se quedaba creyendo que sí.
  const cfg = resolveLiveDaemonConfig({
    WARMUP_LIVE_MAX_PER_DAY: "50",
    WARMUP_LIVE_INTERVAL_MS: "5400000"
  } as unknown as NodeJS.ProcessEnv);
  const l = lineaDeArranque(cfg);
  assert.match(l, /OJO: el tope de 50 NO se puede alcanzar/);
  assert.match(l, /solo permite 16/);
});

// ── El sobre de volumen: dominios × cupo contra min(tope, ciclos) ────────────────────────────────

// ── UN ARCHIVO ILEGIBLE NO PUEDE ABRIR EL POOL ─────────────────────────────────────────────────

test("sin salud legible el pool cae al CONFIGURADO: un JSON cortado metía al pool a los que YA cruzaron", () => {
  // EL DEFECTO (encontrado por QA antes de desplegar, 2026-08-07). `leerSalud` devuelve `undefined`
  // ante cualquier fallo de lectura o parseo, y `elegirPool` se saltea entero el bloque `if (salud &&
  // salud.size > 0)` — o sea que se apagan TODAS las exclusiones, incluida la de `cruzados`, que es
  // la única irreversible. Medido con los archivos reales de producción y el `elegirPool` de verdad:
  // con salud ⇒ 6 boxes; con `salud: undefined` ⇒ 44, y entre esos 44 entra nationalfiling-infra.com,
  // que tiene `cruzados: ["google"]` en sender-measurement.json. No es hipotético: `medirFlota`
  // reescribe el archivo ENTERO, así que una escritura cortada deja JSON inválido.
  const crudo = {
    boxes: ["corpfiling-infra.com", "nationalfiling-infra.com", "controlstatecorp.com"],
    motivo: "44 de 57 nodos medidos aptos"
  };
  const conSalud = poolSinSalud(crudo, ["corpfiling-infra.com"], true, "/x/sender-measurement.json");
  assert.deepEqual(conSalud.boxes, crudo.boxes, "con salud legible no toca nada");

  const sinSalud = poolSinSalud(crudo, ["corpfiling-infra.com"], false, "/x/sender-measurement.json");
  assert.deepEqual(sinSalud.boxes, ["corpfiling-infra.com"], "cae a la lista explícita del operador");
  assert.ok(!sinSalud.boxes.includes("nationalfiling-infra.com"), "el que cruzó el umbral permanente NO puede entrar por un archivo roto");
  assert.match(sinSalud.motivo, /no sé quién cruzó el umbral permanente/, "y el log dice por qué se achicó");
});

test("CONTRATO: el loop RECUERDA la última lectura buena de salud, así un hipo de una vuelta no achica el pool", async () => {
  // La baranda barata que va antes del fail-closed: con `ultimaSalud` cacheada, un archivo ilegible
  // en UNA vuelta no cambia el pool. El fail-closed es para el caso en que nunca hubo lectura buena
  // en esta corrida (un reinicio con el archivo ya roto).
  //
  // Va como contrato sobre la fuente y no como corrida: el cuerpo del loop abre su propio Pool, sus
  // mailers y su IMAP, así que "simular el for" sería una COPIA del loop — y una copia comparte el
  // error con el original (la lección del fixture de Bedrock).
  const { readFile } = await import("node:fs/promises");
  const src = await readFile("apps/warmup-engine/src/service/live-warmup-daemon.ts", "utf8");
  assert.match(src, /const saludLeida = await leerSalud\(cfg\.saludFile\);/);
  assert.match(src, /if \(saludLeida\) ultimaSalud = saludLeida;/, "la lectura buena se guarda");
  assert.match(src, /const saludFlota = saludLeida \?\? ultimaSalud;/, "y se reusa cuando la nueva falla");
  assert.match(src, /poolSinSalud\(poolCrudo, poolConfigurado, saludFlota !== undefined/, "y el fail-closed es la función testeada, no una copia inline");
});

test("sobre: los 6 dominios de producción entran, y sobra lugar para UNO solo", () => {
  // La foto medida el 2026-08-07 contra la Postgres viva: 12 ciclos con `sent` en el día UTC contra
  // un tope de 14, y CERO líneas "tope diario" en todo el log del daemon. O sea que hoy el tope NO
  // es lo que ata: atan los cupos por dominio (6 × 2 = 12).
  const aviso = avisoDeSobre({ dominios: 6, maxPerDay: 14, intervalMs: 5_400_000, cupoArranque: 2 });
  assert.match(aviso!, /6×2=12 correos\/día ≤ 14 ciclos/);
  assert.match(aviso!, /entran 1 dominio\(s\) más/);
  assert.doesNotMatch(aviso!, /NO ALCANZA/);

  // LA UNIDAD SE DICE, y no es una nota al pie: el ticket que sale de este aviso pide "tope ≥ N", y
  // el tope se paga en CICLOS mientras la demanda está en CORREOS. `countCyclesToday` es
  // `COUNT(DISTINCT cycle_id)` y las continuaciones se graban con el cycleId de la vuelta actual, así
  // que N "Re:" dentro de una vuelta cuestan CERO del tope. Medido en la Postgres de producción:
  // 2026-08-05 fueron 18 envíos en 11 ciclos y 08-06, 15 en 12. Sin la aclaración, el operador
  // dimensiona un presupuesto de ciclos para una demanda de correos.
  assert.match(aviso!, /el sobre son CICLOS y la demanda CORREOS/);
  assert.match(aviso!, /no gastan ciclo/);
});

test("sobre: con 11 dominios NO alcanza, y el aviso pide LAS DOS palancas", () => {
  // El incidente que previene: "arrancar 5 dominios más" con el tope y el intervalo intactos NO
  // arranca 5 — reparte 14 envíos entre 11 dominios (1,27 cada uno), nadie junta las 4 mediciones
  // que la rampa pide, y los 6 que HOY calientan pasan de 2/día a 1,27. El daemon no se rompe ni
  // avisa: simplemente todos calientan menos. Antes de este aviso, el log no decía una palabra.
  const aviso = avisoDeSobre({ dominios: 11, maxPerDay: 14, intervalMs: 5_400_000, cupoArranque: 2 })!;
  assert.match(aviso, /EL SOBRE NO ALCANZA/);
  assert.match(aviso, /11 dominios × 2\/día = 22 correos/);
  assert.match(aviso, /el sobre es 14 ciclos/);
  assert.match(aviso, /el sobre son CICLOS y la demanda CORREOS/);
  assert.match(aviso, /~1\.27\/día/);
  // LAS DOS, y con números. Mover una sola no agrega un correo — que es exactamente la trampa que
  // este aviso existe para cerrar.
  assert.match(aviso, /intervalo ≤ 65min Y tope ≥ 22/);
});

test("sobre: subir el tope SIN bajar el intervalo no mueve el sobre — 14→50 sigue dando 16", () => {
  // La trampa aritmética, del lado del sobre: `min(tope, ciclos)` está gobernado por el intervalo.
  // Con 90 min entran 16 ciclos en el día, así que un tope de 50 sigue rindiendo 16, y 19 dominios
  // siguen sin entrar. El que suba solo el tope va a mirar el log y no va a ver nada distinto.
  const con50 = avisoDeSobre({ dominios: 19, maxPerDay: 50, intervalMs: 5_400_000, cupoArranque: 2 })!;
  assert.match(con50, /el sobre es 16/, "el tope 50 se clampea a los 16 ciclos que permite el intervalo");
  assert.match(con50, /intervalo ≤ 37min Y tope ≥ 38/);
  // Y con las DOS movidas, los 19 entran.
  const conLasDos = avisoDeSobre({ dominios: 19, maxPerDay: 38, intervalMs: 36 * 60_000, cupoArranque: 2 })!;
  assert.doesNotMatch(conLasDos, /NO ALCANZA/);
});

// ── La línea de semillas: en qué RECEPTORES se mide ──────────────────────────────────────────────

test("semillas: dos que miden y las dos Gmail ⇒ se dice que hay UN SOLO receptor", () => {
  // "2 pueden medir" suena a cobertura. El placement de toda la flota se lee en un solo receptor, y
  // el criterio "repartir entre proveedores" de elegirSemillaRotada no puede ejecutarse nunca.
  const l = lineaDeSemillas([
    { address: "a@gmail.com", provider: "gmail", enabled: true, auth: "gmail_oauth" },
    { address: "b@gmail.com", provider: "gmail", enabled: true, auth: "imap_password" },
    { address: "c@yahoo.com", provider: "yahoo", enabled: true, auth: "none" }
  ]);
  assert.match(l, /2 miden placement en gmail/);
  assert.match(l, /UN SOLO receptor \(gmail\)/);
  assert.match(l, /punto ciego/);
});

test("semillas: con dos proveedores midiendo, no hay alerta", () => {
  const l = lineaDeSemillas([
    { address: "a@gmail.com", provider: "gmail", enabled: true, auth: "gmail_oauth" },
    { address: "b@yahoo.com", provider: "yahoo", enabled: true, auth: "imap_password" }
  ]);
  assert.match(l, /2 miden placement en gmail\+yahoo/);
  assert.doesNotMatch(l, /UN SOLO receptor/);
});

test("semillas: ninguna mide ⇒ se dice 'ningún proveedor', NO se calla", () => {
  // Ausencia de dato no es evidencia de que está bien: sin nadie que mida, el freno por placement
  // no existe, y esa es la línea que lo tiene que decir.
  const l = lineaDeSemillas([{ address: "a@gmail.com", provider: "gmail", enabled: true, auth: "none" }]);
  assert.match(l, /0 miden placement en ningún proveedor/);
  assert.match(l, /UN SOLO receptor \(ninguno\)/);
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
  assert.deepEqual(recentInboxRate(de("a.com", "INBOX", "INBOX", "INBOX", "INBOX")), { tasa: 1, muestra: 4, dominios: 1 });
  assert.equal(recentInboxRate(de("a.com", "INBOX", "INBOX", "SPAM", "SPAM"))?.tasa, 0.5);
  // PROMOTIONS cuenta como bandeja. Este test afirmaba lo contrario (`["SPAM","PROMOTIONS"] → 0`)
  // y estaba fijando la regla equivocada: el diseño v1 §10 dice textual que las pestañas cuentan
  // como inbox, y `placement.ts:33` ya lo implementaba así. Con la regla vieja, un dominio sano
  // cuyos correos caen en la pestaña Promociones daba 0% y el gate lo pausaba.
  assert.equal(recentInboxRate(de("a.com", "SPAM", "SPAM", "PROMOTIONS", "PROMOTIONS"))?.tasa, 0.5);
  assert.equal(recentInboxRate(de("a.com", "PROMOTIONS", "PROMOTIONS", "PROMOTIONS", "PROMOTIONS"))?.tasa, 1);
  // OTHER no: archivado o etiquetado por el usuario no es aterrizar en bandeja.
  assert.equal(recentInboxRate(de("a.com", "OTHER", "OTHER", "INBOX", "INBOX"))?.tasa, 0.5);
});

test("recentInboxRate: lo que midió un dominio que hoy NO puede enviar no cuenta", () => {
  // Sin esto, frenar al dominio culpable no destrababa a los sanos: sus muestras seguían pesando
  // en el promedio de la flota y el freno global quedaba puesto igual.
  const mezcla = [
    ...de("sano.com", "INBOX", "INBOX", "INBOX", "INBOX"),
    ...de("frenado.com", "SPAM", "SPAM", "SPAM", "SPAM")
  ];
  assert.equal(recentInboxRate(mezcla)?.tasa, 0.5, "sin filtro, el frenado arrastra al sano");
  assert.deepEqual(recentInboxRate(mezcla, new Set(["sano.com"])), { tasa: 1, muestra: 4, dominios: 1 });
  assert.equal(recentInboxRate(mezcla, new Set(["nadie.com"])), null, "si ninguno cuenta, es null");
});

test("recentInboxRate: un dominio SIN historia no entra al promedio de la flota", () => {
  // Los números REALES de producción, medidos a las 02:00 del 2026-08-06, justo después de que el
  // warmup volviera a arrancar. El promedio crudo da 45% y habría vuelto a pausar todo en la
  // vuelta siguiente — el arreglo anterior compraba UNA vuelta y nada más.
  const real = [
    ...de("corpfiling-infra.com", "INBOX", "INBOX", "INBOX", "INBOX", "INBOX", "SPAM"),
    ...de("annualcorp-infra.com", "SPAM", "SPAM"),
    ...de("nationalfiling-infra.com", "MISSING"),
    ...de("annualfilings-ops.com", "SPAM"),
    ...de("annualfilings-control.com", "SPAM")
  ];
  assert.equal(real.length, 11);

  const r = recentInboxRate(real);
  assert.equal(r?.dominios, 1, "solo corpfiling-infra.com tiene 4+ mediciones propias");
  assert.equal(r?.muestra, 6);
  assert.ok((r?.tasa ?? 0) > 0.8, `el promedio pasa a ser el del dominio con historia (dio ${r?.tasa})`);

  // Cuatro dominios recién arrancados aportaban 5 muestras de día 0 y hundían a uno que va al 83%.
  const crudo = real.filter((p) => esInbox(p.placement)).length / real.length;
  assert.ok(crudo < 0.5, `el promedio crudo era ${Math.round(crudo * 100)}%: eso es lo que frenaba todo`);
});

test("recentInboxRate: cuando los nuevos JUNTAN historia, sí pesan", () => {
  // El umbral no es una excusa permanente: en cuanto un dominio llega a 4 mediciones propias entra
  // al promedio con todo su peso. Si de verdad viene mal, el freno de catástrofe dispara.
  const conHistoria = [
    ...de("bueno.com", "INBOX", "INBOX", "INBOX", "INBOX", "INBOX", "INBOX"),
    ...de("malo.com", "SPAM", "SPAM", "SPAM", "SPAM", "SPAM", "SPAM")
  ];
  const r = recentInboxRate(conHistoria);
  assert.equal(r?.dominios, 2);
  assert.equal(r?.muestra, 12);
  assert.equal(r?.tasa, 0.5);
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

test("gate: placement bajo el piso, CON muestra suficiente y de varios dueños ⇒ placement-pause", () => {
  // Este test decía "muestra suficiente" y la muestra era de UN dominio (`x.com`, 10 mediciones).
  // Fijaba la regla incompleta: bastaba con que un solo dominio se hundiera para apagar la flota.
  // Ahora "suficiente" también quiere decir de más de un dueño — la muestra se reparte en dos.
  const bad = [
    ...de("x.com", "SPAM", "SPAM", "SPAM", "SPAM", "INBOX"),
    ...de("y.com", "SPAM", "SPAM", "SPAM", "INBOX", "INBOX")
  ]; // 30%, 10 mediciones, 2 dominios
  assert.equal(decideDaemonAction({ ...base, recentPlacements: bad }).action, "placement-pause");
  const ok = [
    ...de("x.com", "INBOX", "INBOX", "INBOX", "SPAM", "SPAM"),
    ...de("y.com", "INBOX", "INBOX", "INBOX", "SPAM", "SPAM")
  ]; // 60%, 10 mediciones, 2 dominios
  assert.equal(decideDaemonAction({ ...base, recentPlacements: ok }).action, "send");
});

test("gate: sin mediciones aún ⇒ no bloquea por placement (envía)", () => {
  assert.equal(decideDaemonAction({ ...base, recentPlacements: [] }).action, "send");
});

test("gate: con muestra chica NO apaga la fábrica entera", () => {
  // El caso REAL del 2026-08-06: el warmup llevaba horas parado con "inbox 33% < piso 50%", y esas
  // seis mediciones eran el único dominio que venía calentando bien (2/2) contra cuatro muestras
  // sueltas de cuatro dominios que recién arrancaban. Que un dominio nuevo caiga en spam el primer
  // día es lo normal, no una degradación de la flota.
  const real = [
    ...de("nationalfiling-infra.com", "MISSING"),
    ...de("corpfiling-infra.com", "INBOX", "INBOX"),
    ...de("annualfilings-ops.com", "SPAM"),
    ...de("annualfilings-control.com", "SPAM"),
    ...de("annualcorp-infra.com", "SPAM")
  ];
  // Ni siquiera hay un dominio con historia suficiente: no hay sobre qué afirmar nada de la flota.
  assert.equal(recentInboxRate(real), null);
  assert.equal(decideDaemonAction({ ...base, recentPlacements: real }).action, "send", "6 mediciones sueltas no apagan 58 nodos");
});

test("gate: el freno global no puede ser un candado", () => {
  // Parado no se mide, sin medir la tasa no cambia, y sin que la tasa cambie no se destraba: la
  // única salida era un humano a mano. Con el filtro por elegibles, frenar al dominio culpable
  // destraba a los sanos en la vuelta siguiente — que es lo que el agente ya sabe hacer solo.
  const mezcla = [
    ...de("culpable.com", "SPAM", "SPAM", "SPAM", "SPAM", "SPAM", "SPAM", "SPAM", "SPAM", "SPAM", "SPAM"),
    ...de("sano.com", "INBOX", "INBOX", "INBOX", "INBOX")
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

test("gate: el freno de TODA la flota no lo puede disparar UN dominio solo", () => {
  // El caso de producción de hoy: el único dominio con historia suficiente es corpfiling-infra.com,
  // así que las 10 mediciones que cuentan son las 10 suyas. Con la condición vieja —muestra ≥ 10 y
  // nada más— seis SPAM seguidos de ESE dominio apagaban el warmup de los 58 nodos.
  // Para él ya está el freno fino (`decidirCupoDeHoy`), que lo baja o lo frena a él solo.
  const unoSolo = de(
    "corpfiling-infra.com",
    "INBOX", "INBOX", "INBOX", "INBOX", "SPAM", "SPAM", "SPAM", "SPAM", "SPAM", "SPAM"
  ); // 40% < piso 50%, 10 mediciones, 1 dominio
  const r = recentInboxRate(unoSolo);
  assert.equal(r?.muestra, 10);
  assert.equal(r?.dominios, 1);
  assert.ok((r?.tasa ?? 1) < 0.5, "la tasa SÍ está bajo el piso: lo que falta es de cuántos dueños");
  assert.equal(
    decideDaemonAction({ ...base, recentPlacements: unoSolo }).action,
    "send",
    "un dominio no es la flota: no apaga los 58 nodos"
  );
});

test("gate: cuando el freno global NO se puede evaluar, lo DICE — el silencio se leía como 'todo bien'", () => {
  // El costo de la condición de arriba: con MIN_DOMINIOS_FLOTA=2 y las 10 mediciones que cuentan
  // siendo todas de corpfiling-infra.com, hoy en producción el corte de catástrofe NO PUEDE
  // dispararse. La condición es correcta —un dominio no es la flota— pero un gate que no se puede
  // evaluar tiene que declararse: si no, "no se disparó" es indistinguible de "se evaluó y dio
  // bien", que es la confusión más cara de este sistema. Y el log del daemon no decía nada.
  const unSoloDueno = de("corpfiling-infra.com", ...Array.from({ length: 20 }, () => "SPAM" as const));
  const r = decideDaemonAction({ ...base, recentPlacements: unSoloDueno });
  assert.equal(r.action, "send");
  assert.match(r.reason, /freno global INACTIVO/);
  assert.match(r.reason, /solo 1 dominio\(s\) con historia/);

  // Sin ninguna medición que cuente, también se declara. Nunca "ok" pelado.
  const nadie = decideDaemonAction({ ...base, recentPlacements: [] });
  assert.equal(nadie.action, "send");
  assert.match(nadie.reason, /freno global INACTIVO: ningún dominio con 4\+ mediciones propias/);

  // Y cuando SÍ se evalúa y la flota está bien, se dice con el número: es la única forma de que el
  // operador distinga "el corte miró y no había nada" de "el corte no pudo mirar".
  const sana = [
    ...de("a.com", "INBOX", "INBOX", "INBOX", "INBOX", "INBOX"),
    ...de("b.com", "INBOX", "INBOX", "INBOX", "INBOX", "INBOX")
  ];
  const ok = decideDaemonAction({ ...base, recentPlacements: sana });
  assert.equal(ok.action, "send");
  assert.match(ok.reason, /freno global evaluado: inbox 100% sobre 10 mediciones de 2 dominios/);
});

test("gate: la MISMA evidencia repartida en varios dominios SÍ frena — es una degradación real", () => {
  // El umbral no es una excusa permanente. Cuando la mala señal viene de más de un dueño, ya no es
  // "un dominio nuevo cayó en spam": es la flota, y el corte de catástrofe tiene que disparar.
  const varios = [
    ...de("a.com", "SPAM", "SPAM", "SPAM", "INBOX"),
    ...de("b.com", "SPAM", "SPAM", "SPAM", "INBOX"),
    ...de("c.com", "SPAM", "SPAM", "SPAM", "INBOX")
  ]; // 25%, 12 mediciones, 3 dominios
  const r = recentInboxRate(varios);
  assert.equal(r?.dominios, 3);
  assert.equal(decideDaemonAction({ ...base, recentPlacements: varios }).action, "placement-pause");
});

test("pickBox rota estable por índice", () => {
  const boxes = ["a", "b", "c"];
  assert.equal(pickBox(boxes, 0), "a");
  assert.equal(pickBox(boxes, 3), "a");
  assert.equal(pickBox(boxes, 4), "b");
  assert.throws(() => pickBox([], 0));
});

// ── Los boxes AGOTADOS salen de la rotación ──────────────────────────────────────────────────────
//
// La pregunta vieja era `disponibles.some(b => b !== box && !frenados.has(b))`, y `disponibles` ya
// venía filtrado por `frenados`: o sea, literalmente `disponibles.length > 1`. Preguntaba si queda
// otro BOX, no si queda otro box CON CUPO.

const vacio: ReadonlySet<string> = new Set();

test("con TODOS los boxes agotados no queda candidato: el daemon duerme el intervalo, no 60 s", () => {
  // El caso normal desde media tarde: el cupo por dominio (2) es menor que el tope de vueltas, así
  // que los 6 del pool se agotan temprano. Con la expresión vieja la respuesta era siempre "sí,
  // quedan otros" ⇒ 60 s ⇒ ~1.400 vueltas/día × 7 consultas contra Postgres, y los WARN reales
  // enterrados bajo miles de líneas.
  const pool = ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com"];
  const agotados = new Set(pool);
  const r = elegirBoxDeLaVuelta({ pool, rebotadosHoy: vacio, agotados, seq: 7 });
  assert.equal(r.box, null, "sin candidato ⇒ el daemon duerme el intervalo entero");
  assert.deepEqual(r.disponibles, []);

  // Y la comparación con lo que hacía antes, sobre los MISMOS datos: `disponibles` viejo era el
  // pool menos los rebotados (nadie), así que `length > 1` daba true y se dormían 60 s.
  const viejo = pool.filter((b) => !vacio.has(b));
  assert.equal(viejo.length > 1, true, "así es como el bug decía 'queda alguno' con todo agotado");
});

test("las vueltas van al que TIENE cupo, en vez de gastarse salteando a los agotados", () => {
  // Efecto de sacar a los agotados de la rotación: `pickBox` deja de repartir plano por índice.
  // Con 12 de 13 dominios ya en su cupo, las vueltas que quedan son todas del que puede enviar —
  // antes cada una de esas vueltas elegía a un agotado, dormía 60 s y volvía a empezar.
  const pool = Array.from({ length: 13 }, (_, i) => `d${i}.com`);
  const agotados = new Set(pool.filter((d) => d !== "d0.com"));
  for (let seq = 0; seq < 14; seq += 1) {
    assert.equal(elegirBoxDeLaVuelta({ pool, rebotadosHoy: vacio, agotados, seq }).box, "d0.com");
  }
  // Sin la memoria de agotados, la rotación plana le daba 2 de 14 vueltas (14/13 ≈ 1,08 por cabeza).
  const plano = Array.from({ length: 14 }, (_, seq) => pickBox(pool, seq)).filter((b) => b === "d0.com");
  assert.equal(plano.length, 2);
});

test("agotados y rebotados se acumulan: los dos sacan de la rotación", () => {
  const pool = ["a.com", "b.com", "c.com"];
  const r = elegirBoxDeLaVuelta({
    pool,
    rebotadosHoy: new Set(["a.com"]),
    agotados: new Set(["b.com"]),
    seq: 0
  });
  assert.deepEqual(r.disponibles, ["c.com"]);
  assert.equal(r.box, "c.com");
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

test("una vuelta fallida NO clava la rotación de TODA la flota en el mismo dominio", async () => {
  // EL DEFECTO. `elegirBoxDeLaVuelta` elige por `seq % disponibles.length`, y dos de los `continue`
  // del cuerpo ocurren DESPUÉS de haber elegido box sin avanzar `seq`: el de `filasDePlacement` y el
  // catch de la vuelta. Sin el incremento, la vuelta siguiente elige EXACTAMENTE el mismo box, y así
  // cada 90 minutos, en silencio — un solo dominio envenenado (una fila con basura en `detail`, un
  // statement_timeout sobre su consulta) deja a los otros cinco sin calentar y nadie lo dice.
  //
  // Que es un olvido y no un diseño lo prueba el TERCER camino de fallo, el de la credencial SMTP,
  // que sí hace `seq += 1`.
  //
  // ES UNA CORRIDA REAL DEL LOOP, no una simulación: el incremento sólo se observa a través de
  // varias vueltas del mismo proceso, y una copia del `for` compartiría el error con el original —
  // que es textual la lección que este repo ya pagó con el fixture de Bedrock. El precio son ~6 s:
  // `intervaloConJitter` tiene un piso duro de 1 s por vuelta y hacen falta 6 para tocar 6 dominios.
  const pool = ["d1.com", "d2.com", "d3.com", "d4.com", "d5.com", "d6.com"];
  let locks = 0;
  const pg = {
    async query(sql: string) {
      // El lock se suelta después de 6 vueltas: es la forma de terminar el daemon sin `--once`
      // (con `--once` la primera vuelta rompe y la rotación no se puede observar).
      if (/pg_try_advisory_lock/.test(sql)) { locks += 1; return { rows: [{ ok: locks <= pool.length + 1 }] }; }
      // SÓLO `filasDePlacement` falla: lleva `node_domain = $1`, que `recentPlacements` no tiene.
      // Si fallara también la lectura global, la vuelta moriría ANTES de elegir box y el test
      // probaría otra cosa.
      if (/node_domain = \$1/.test(sql)) throw new Error("57014 statement timeout");
      if (/COUNT\(DISTINCT cycle_id\)/.test(sql)) return { rows: [{ n: 0 }] };
      return { rows: [] };
    },
    async end() {}
  };
  const c = capturarLog();
  try {
    await startLiveWarmupDaemon({
      // El intervalo va EXPLÍCITO en 1000: `intEnv` tiene mínimo 1000, así que el "50" de ENV_BASE
      // cae al default de 4 HORAS y el test se cuelga esperando la segunda vuelta. Es el mismo piso
      // que `intervaloConJitter`, o sea que 6 vueltas cuestan ~6 s y no hay forma de bajarlas.
      env: { ...ENV_BASE, WARMUP_LIVE_BOXES: pool.join(","), WARMUP_LIVE_INTERVAL_MS: "1000" } as NodeJS.ProcessEnv,
      argv: ["n", "d"],
      dobles: { pg: pg as never, saltearMigraciones: true }
    });
  } finally { c.restaurar(); }

  const tocados = new Set(
    c.lineas.flatMap((l) => {
      const m = /no pude leer el placement de (\S+)/.exec(l);
      return m ? [m[1]!] : [];
    })
  );
  assert.equal(tocados.size, pool.length, `la rotación tocó ${[...tocados].join(", ")} en vez de los ${pool.length} del pool`);
  assert.ok(c.lineas.some((l) => /perdí el lock/.test(l)), "el daemon terminó por donde el test lo cortó");
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

test("CONTRATO: el cuerpo del loop usa la función compartida, no una copia de la regla", async () => {
  // Las tres reglas de este lote viven en funciones puras y testeadas; lo que este test cuida es
  // que el daemon las USE y no vuelva a resolver lo mismo inline — que es exactamente cómo se
  // coló el bug original (`disponibles.some(...)` reimplementando la pregunta, y el guarda de la
  // continuación escrito a mano dentro del loop).
  const { readFile } = await import("node:fs/promises");
  const fuente = await readFile("apps/warmup-engine/src/service/live-warmup-daemon.ts", "utf8");
  // SIN COMENTARIOS: los comentarios de este archivo CITAN la expresión vieja para explicar el bug,
  // y un contrato que se rompe porque alguien documentó el incidente enseña a borrar la explicación.
  const src = fuente
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

  const veces = (re: RegExp): number => src.match(re)?.length ?? 0;
  assert.equal(veces(/elegirBoxDeLaVuelta\(\{/g), 2, "una para elegir, otra para preguntar si queda alguno");
  assert.equal(veces(/puedeMandarTurno\(\{/g), 1, "UN solo punto de llamada: la regla no se copia al daemon");
  assert.match(src, /medicionesPropias: propias\.length/, "la continuación pasa las mediciones propias");
  assert.match(src, /agotados\.add\(box\)/, "el box que cumplió su cupo se recuerda");
  assert.doesNotMatch(
    src,
    /disponibles\.some\(/,
    "la pregunta '¿queda otro box con cupo?' no puede volver a resolverse inline"
  );
  // El techo de la rampa deja de ser un literal escondido en decision-diaria y viaja desde la config.
  assert.equal(veces(/limiteDiario: cfg\.limiteDiario/g), 2, "rampa configurada en los DOS caminos de envío");

  // NUESTRO CORREO TIENE QUE QUEDAR EN NUESTRO LIBRO.
  //
  // `leerLibroPropio` (sender-measurement.ts) reconoce nuestros envíos por
  // `detail->>'smtp' ILIKE '%queued as %'`: sin la respuesta de Postfix no hay queue-id, y la
  // medición atribuye ese mensaje al OTRO inquilino que comparte el nodo. Medido el 2026-08-06
  // contra la Postgres de producción: de 36 filas `kind='sent'` en 7 días, 12 no tenían `smtp` —
  // eran las 12 continuaciones de hilo, el 33% de nuestro correo — y se concentraban justo en los
  // dominios que de verdad calientan (corpfiling-infra.com, 6 de 19 invisibles). Un dominio sin
  // muestra propia queda `no_own_traffic`, que no vende cupo y no entra al pool: el warmup se
  // apagaba solo por no grabar una respuesta que ya tenía en la mano.
  assert.equal(veces(/kind: "sent"/g), 1, "un solo emisor de 'sent' en el daemon");
  assert.match(
    src,
    /detail: \{ smtp: enviado\.response/,
    "el turno de continuación graba el queue-id de Postfix o queda fuera de nuestro propio libro"
  );
});

test("CONTRATO: cada camino de envío DESCUENTA del cupo, y el gate del log mira el umbral permanente", async () => {
  // POR QUÉ ES UN CONTRATO SOBRE LA FUENTE y no una corrida. Los dos defectos que fija están en el
  // CUERPO del loop del daemon, que abre su propio Pool, sus mailers y su IMAP: cualquier test que
  // "simule el for" sería una COPIA del loop, y una copia comparte el error con el original — es
  // textual la lección que este repo ya pagó (el fixture escrito desde la suposición del wire de
  // Bedrock escondió que `stop_reason` nunca se leía). Las reglas puras ya tienen sus tests
  // (`puedeMandarTurno`, `evaluarGate`); lo que acá se fija es que el loop les dé el dato correcto.
  const { readFile } = await import("node:fs/promises");
  const fuente = await readFile("apps/warmup-engine/src/service/live-warmup-daemon.ts", "utf8");
  const src = fuente
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
  const veces = (re: RegExp): number => src.match(re)?.length ?? 0;

  // 1. EL CONTADOR DEL DÍA SE ESCRIBE EN LOS DOS CAMINOS DE ENVÍO. El comentario del ciclo principal
  //    declaraba cerrado el sobrepaso "con cupo 2 salían 3, todos los días", pero sólo cerró la pata
  //    ciclo→continuación: adentro del `for (const hiloPrevio of abiertos)` el Map se LEÍA y nunca se
  //    escribía, así que N hilos del MISMO dominio decidían contra la misma foto y salían N correos
  //    reales por encima del cupo. Reproducido con la función real: cupo 6, `enviadosHoy` 5 y 4
  //    hilos ⇒ los 4 dan permiso ⇒ 9 envíos. Y alcanzable hoy: en la Postgres de producción hay una
  //    semilla con 8 hilos abiertos del mismo dominio. Era PRE-EXISTENTE, no de este lote.
  assert.equal(
    veces(/enviadosPorDominio\.set\(/g),
    2,
    "un camino de envío que no descuenta del cupo del día es un contador salteable: uno por el ciclo principal y otro por la continuación"
  );

  // 2. EL GATE DEL LOG MIRA LA CONDICIÓN IRREVERSIBLE. `evaluarGate` trata `cruzoUmbralPermanente`
  //    como su PRIMERA condición, y el daemon la omitía: imprimía "gate §3: pasa" sobre un dominio
  //    que ya cruzó el umbral permanente de bulk sender de Gmail, mientras `planDelDia` —que sí se lo
  //    pasa— decía lo contrario del mismo dominio el mismo día. El dato ya estaba en scope.
  assert.match(src, /cruzoUmbralPermanente: \(saludFlota/, "el gate del daemon lee la salud que ya tiene en la mano");
  assert.equal(veces(/evaluarGate\(\{/g), 1, "un solo punto de llamada en el daemon: el veredicto no se arma dos veces");
  // Y "pasa" se dice con lo que NO se pudo mirar: ausencia de dato no es evidencia de que algo está bien.
  assert.match(src, /veredicto\.sinInstrumento\.length/, "el log dice cuántas condiciones de §3 quedaron sin instrumento");
});

test("CONTRATO: todos los Pool de pg del warmup registran listener de 'error'", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const f of ["apps/warmup-engine/src/service/live-warmup-daemon.ts", "scripts/ops/warmup-monitor.ts"]) {
    const src = await readFile(f, "utf8");
    if (!/new Pool\(/.test(src)) continue;
    assert.match(src, /\.on\("error"/, `${f}: Pool sin listener 'error' — un socket ocioso mata el proceso`);
  }
});

// ── El turno de continuación por fin MIDE ────────────────────────────────────────────────────────
//
// Medido el 2026-08-06: de 18 envíos de la vuelta, 7 eran continuaciones y NINGUNA producía una
// fila `measured`. El 45% del correo de corpfiling-infra.com gastaba cupo del día y no aportaba una
// sola muestra de la evidencia que gobierna su propia rampa.

import { medirTurnoDeHilo } from "./live-warmup-daemon.ts";

function grabador() {
  const filas: Array<Record<string, unknown>> = [];
  return { filas, recorder: { async record(e: Record<string, unknown>) { filas.push(e); } } as never };
}

const BASE_HILO = { cycleId: "cyc-1", boxDomain: "corpfiling-infra.com", seedInbox: "s@gmail.com" };
const ENVIADO = { messageId: "<abc@corpfiling-infra.com>", response: "250 2.0.0 Ok: queued as 4XyZ" };
const SIN_ESPERA = { pollAttempts: 2, pollDelayMs: 0, sleep: async () => {} };

test("el turno de continuación graba su placement con el lector ya abierto", async () => {
  const { filas, recorder } = grabador();
  const vistos: unknown[] = [];
  await medirTurnoDeHilo({
    ...SIN_ESPERA,
    ops: {
      findMessage: async (q: unknown) => { vistos.push(q); return { gmailId: "g1", threadId: "t1", labelIds: ["INBOX"] }; },
      modifyLabels: async () => { throw new Error("medir no puede TOCAR el buzón"); },
      sendReply: async () => { throw new Error("medir no puede responder"); }
    } as never,
    enviado: ENVIADO, subject: "Re: algo [abc123]", recorder, base: BASE_HILO, testId: "t-abc123",
    log: () => {}
  });
  assert.equal(filas.length, 1);
  assert.equal(filas[0]!.kind, "measured");
  assert.equal(filas[0]!.placement, "INBOX");
  assert.deepEqual(vistos[0], { rfc822MessageId: "abc@corpfiling-infra.com", subject: "Re: algo [abc123]" }, "sin los <>");
});

test("el turno que nadie volvió a ver se graba MISSING, no 'error'", async () => {
  // Grabarlo como `error` lo dejaría FUERA de las ventanas de placement (que filtran
  // kind='measured') y ese silencio se lee como éxito: el único camino del sistema hacia más
  // volumen sobre evidencia falsa, ya cerrado una vez en el ciclo principal.
  const { filas, recorder } = grabador();
  await medirTurnoDeHilo({
    ...SIN_ESPERA,
    ops: { findMessage: async () => null, modifyLabels: async () => {}, sendReply: async () => ({ id: "x" }) } as never,
    enviado: ENVIADO, subject: "Re: algo", recorder, base: BASE_HILO, testId: "t-1", log: () => {}
  });
  assert.equal(filas[0]!.kind, "measured");
  assert.equal(filas[0]!.placement, "MISSING");
});

test("un IMAP que corta a mitad NO se convierte en MISSING: es 'no sé'", async () => {
  // MISSING es una afirmación fuerte sobre la reputación del dominio. Un lector que se cae es la
  // lección del probe con `head -c` del 2026-07-29: un chequeo colgado devuelve "no sé", jamás un
  // veredicto que castigue.
  const { filas, recorder } = grabador();
  await medirTurnoDeHilo({
    ...SIN_ESPERA,
    ops: { findMessage: async () => { throw new Error("ECONNRESET"); }, modifyLabels: async () => {}, sendReply: async () => ({ id: "x" }) } as never,
    enviado: ENVIADO, subject: "Re: algo", recorder, base: BASE_HILO, testId: "t-1", log: () => {}
  });
  assert.equal(filas[0]!.kind, "error");
  assert.equal((filas[0]!.detail as { stage: string }).stage, "measured");
  assert.notEqual(filas[0]!.placement, "MISSING");
});

test("sin lector no se inventa un veredicto: no se graba nada", async () => {
  const { filas, recorder } = grabador();
  await medirTurnoDeHilo({
    ...SIN_ESPERA, ops: null,
    enviado: ENVIADO, subject: "Re: algo", recorder, base: BASE_HILO, testId: "t-1", log: () => {}
  });
  assert.deepEqual(filas, [], "no medido y 'no llegó' no son lo mismo");
});

// ══ SE ROMPE EL METRÓNOMO (jitter) ═══════════════════════════════════════════════════════════════

test("jitter: dos vueltas seguidas NO salen separadas por el mismo intervalo", () => {
  // EL DEFECTO MEDIDO en el log de producción el 2026-08-07: los deltas entre vueltas son 91, 91,
  // 91, 95, 92, 91, 92, 91 minutos. Un metrónomo de 91 minutos exactos, 24 h/día, todos los días.
  // §3 del doc lista "cadencia de máquina" entre los errores que queman, y es la firma más barata
  // de borrar que tiene el sistema.
  const base = 90 * 60_000;
  const muestras = Array.from({ length: 200 }, () => intervaloConJitter(base, Math.random()));
  assert.ok(new Set(muestras).size > 100, "dos corridas no pueden dar el mismo delta");
  assert.ok(Math.min(...muestras) >= base * 0.65, "el piso es -35%");
  assert.ok(Math.max(...muestras) <= base * 1.35, "el techo es +35%");
});

test("jitter: NO cambia el volumen — la media es el intervalo configurado", () => {
  // Es la propiedad que hace que esto no necesite autorización del operador: con las mismas vueltas
  // sólo cambia CUÁNDO salen. `0,65 + azar·0,7` tiene media 1,0 exacta.
  const base = 90 * 60_000;
  const n = 20_000;
  const media = Array.from({ length: n }, (_, i) => intervaloConJitter(base, (i + 0.5) / n)).reduce((a, b) => a + b, 0) / n;
  assert.ok(Math.abs(media - base) / base < 0.01, `la media (${Math.round(media)}) tiene que dar el intervalo (${base})`);
});

test("jitter: un intervalo mínimo nunca cae por debajo de 1 s", () => {
  assert.equal(intervaloConJitter(1000, 0), 1000);
});

test("CONTRATO: NINGUNA espera del loop usa el intervalo pelado", async () => {
  // El intervalo estaba escrito SEIS veces en el cuerpo del loop: dejar una sola sin jitter alcanza
  // para que el patrón vuelva a aparecer en el log, y es exactamente el modo en que este defecto se
  // conservó tanto tiempo. Se lee el fuente sin comentarios, igual que el otro contrato de acá.
  const { readFile } = await import("node:fs/promises");
  const src = (await readFile("apps/warmup-engine/src/service/live-warmup-daemon.ts", "utf8"))
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
  //
  // SE CUENTAN LAS OCURRENCIAS, NO SE BUSCA UNA CADENA. El assert anterior era
  // `doesNotMatch(/await sleep\(cfg\.intervalMs\)/)` y estaba VERDE con dos esperas peladas, porque
  // ninguna de las dos escribía esa cadena literal: `await sleep(siguiente.box ?
  // Math.min(cfg.intervalMs, 60_000) : cfg.intervalMs)` y `await sleep(Math.min(cfg.intervalMs,
  // 60_000))`. Cualquier envoltorio evade una cadena literal; lo que no se evade es que TODA
  // aparición del intervalo dentro del loop esté adentro de `intervaloConJitter(`.
  const loop = src.slice(src.indexOf("const dormirIntervalo"));
  const total = [...loop.matchAll(/cfg\.intervalMs/g)].map((m) => m.index as number);
  const conJitter = new Set([...loop.matchAll(/intervaloConJitter\(cfg\.intervalMs/g)].map((m) => (m.index as number) + "intervaloConJitter(".length));
  const peladas = total.filter((i) => !conJitter.has(i));
  assert.ok(total.length >= 3, `el barrido tiene que ver las esperas del loop, vio ${total.length}`);
  assert.deepEqual(
    peladas.map((i) => loop.slice(Math.max(0, i - 60), i + 20).split("\n").pop()),
    [],
    "una espera del loop usa el intervalo PELADO: 90 min clavados, sin el ±35%"
  );
});

// ══ LA FRANJA HORARIA ════════════════════════════════════════════════════════════════════════════

test("la ventana horaria por defecto son las 24 h: hoy no aparta una sola vuelta", () => {
  assert.equal(resolveLiveDaemonConfig({} as NodeJS.ProcessEnv).ventanaUtc, null);
  for (let h = 0; h < 24; h++) assert.equal(dentroDeVentana(h, null), true);
});

test("con franja configurada, la madrugada UTC queda afuera", () => {
  // Medido: el 25% del volumen histórico caía entre las 00:00 y las 06:00 UTC, o sea de madrugada
  // en el huso del receptor. La franja SÓLO puede bajar el volumen del día, nunca subirlo.
  const v = resolveLiveDaemonConfig({ WARMUP_LIVE_VENTANA_UTC: "08-22" } as never).ventanaUtc;
  assert.deepEqual(v, { desde: 8, hasta: 22 });
  assert.equal(dentroDeVentana(3, v), false);
  assert.equal(dentroDeVentana(8, v), true);
  assert.equal(dentroDeVentana(21, v), true);
  assert.equal(dentroDeVentana(22, v), false, "el borde superior es exclusivo");
});

test("una franja ilegible cae a las 24 h — FAIL-OPEN, y a propósito", () => {
  // Al revés que el resto de la config. Una ventana rota interpretada como "no enviar nunca"
  // apagaría el warmup entero por un typo y SIN ruido: el daemon seguiría vivo, girando y sin
  // mandar. Caer a 24 h es exactamente el comportamiento de hoy.
  for (const basura of ["", "  ", "de 8 a 22", "22-8", "8-99", "8-8", "-3-5"]) {
    assert.equal(resolveLiveDaemonConfig({ WARMUP_LIVE_VENTANA_UTC: basura } as never).ventanaUtc, null, `con "${basura}"`);
  }
});

// ══ EL INSTRUMENTO DE MEDICIÓN ═══════════════════════════════════════════════════════════════════

const semilla = (address: string, auth: SeedDelDaemon["auth"]): SeedDelDaemon => ({
  address, provider: "gmail", enabled: true, auth
});

test("el instrumento es determinista: la misma semilla en cada vuelta, o no sirve de nada", () => {
  // Si rotara, todas las semillas terminarían entrenadas y no se ganaría nada. El orden del archivo
  // no puede decidirlo: se ordena por dirección.
  const a = [semilla("trazosvercel@gmail.com", "imap_password"), semilla("flomia33193@gmail.com", "imap_password")];
  const b = [...a].reverse();
  assert.equal(instrumentoDeMedicion(a), "flomia33193@gmail.com");
  assert.equal(instrumentoDeMedicion(a), instrumentoDeMedicion(b), "no puede depender del orden del registro");
});

test("las semillas SOLO-DESTINO no pueden ser el instrumento: no miden nada", () => {
  const seeds = [semilla("solodestino@gmail.com", "none"), semilla("mide@gmail.com", "imap_password")];
  assert.equal(instrumentoDeMedicion(seeds), "mide@gmail.com");
});

test("sin ninguna semilla que mida no hay instrumento", () => {
  assert.equal(instrumentoDeMedicion([semilla("solodestino@gmail.com", "none")]), null);
});

test("EL AVISO DEL SOBRE MIRA EL PISO DEL OPERADOR, no la constante: si no, se vuelve ciego justo al usarlo", async () => {
  // EL INCIDENTE QUE FIJA (encontrado por QA antes de desplegar, 2026-08-07). El daemon pasaba
  // `cupoArranque: CUPO_ARRANQUE` fijo, así que el aviso calculaba la demanda como dominios×2
  // SIEMPRE — incluso corriendo con `WARMUP_RAMPA_PISO_SOSTENER=6`, que es la ÚNICA palanca capaz de
  // destrabar la fábrica y el motivo entero de este trabajo.
  //
  // Con piso 6 la demanda real de los 6 dominios del pool es 36 correos/día (medido corriendo
  // `decidirCupoDeHoy` con las 6 ventanas reales de la Postgres viva) contra un sobre de 14 ciclos, y
  // el log seguía diciendo "entran 1 dominio(s) más". El operador que lea eso agrega un séptimo
  // dominio y produce exactamente la dilución que el aviso existe para evitar: nadie junta las 4
  // mediciones que la rampa pide, y sumar dominios le SACA volumen a los que ya calientan.
  const ciego = avisoDeSobre({ dominios: 6, maxPerDay: 14, intervalMs: 5_400_000, cupoArranque: 2 })!;
  assert.match(ciego, /entran 1 dominio\(s\) más/, "con el piso por defecto el sobre alcanza — ése es el estado de hoy");

  const conLaPalanca = avisoDeSobre({ dominios: 6, maxPerDay: 14, intervalMs: 5_400_000, cupoArranque: 6 })!;
  assert.match(conLaPalanca, /EL SOBRE NO ALCANZA/, `con el piso en 6 el MISMO sobre no alcanza: ${conLaPalanca}`);
  assert.match(conLaPalanca, /6 dominios × 6\/día = 36 correos/);
  assert.match(conLaPalanca, /Hacen falta LAS DOS/, "y sube el tope Y baja el intervalo, no una sola");

  // Y LAS DOS MITADES ATADAS: el aviso puede estar perfecto y no servir si el daemon le pasa la
  // constante. Va como contrato sobre la fuente porque el `sobreCfg` se arma dentro del loop, que
  // abre Pool, mailers e IMAP — simularlo sería una COPIA del loop, y una copia comparte el error con
  // el original (la lección del fixture de Bedrock).
  const { readFile } = await import("node:fs/promises");
  const src = await readFile("apps/warmup-engine/src/service/live-warmup-daemon.ts", "utf8");
  assert.match(
    src,
    /cupoArranque: cfg\.pisoSostener/,
    "el daemon tiene que pasarle el piso del entorno al aviso, no CUPO_ARRANQUE"
  );
});
