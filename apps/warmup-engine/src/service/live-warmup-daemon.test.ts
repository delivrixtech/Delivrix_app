import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveLiveDaemonConfig,
  decideDaemonAction,
  recentInboxRate,
  pickBox,
  elegirBoxDeLaVuelta,
  lineaDeArranque,
  lineaDeSemillas,
  elegirSemillaDelRegistro,
  puedeMedir,
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

test("CONTRATO: todos los Pool de pg del warmup registran listener de 'error'", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const f of ["apps/warmup-engine/src/service/live-warmup-daemon.ts", "scripts/ops/warmup-monitor.ts"]) {
    const src = await readFile(f, "utf8");
    if (!/new Pool\(/.test(src)) continue;
    assert.match(src, /\.on\("error"/, `${f}: Pool sin listener 'error' — un socket ocioso mata el proceso`);
  }
});
