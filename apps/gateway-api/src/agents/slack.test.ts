import assert from "node:assert/strict";
import test from "node:test";
import {
  camposObservables,
  decidirSiHablar,
  mandarASlack,
  novedades,
  presupuestoDeAvances,
  recordarAviso,
  type EstadoParaSlack,
  type MemoriaSlack,
  type Novedad
} from "./slack.ts";
import type { HechosWarmup } from "./warmup-monitor.ts";

/** Horas desde la medianoche UTC del 2026-08-06. Acepta fracciones: el enfriamiento por clave se
 *  mide en minutos, y con la versión de plantilla `T(10.5)` producía una fecha ilegible que
 *  `Date.parse` daba NaN — o sea un test verde porque el reloj no se podía leer. */
const T = (h: number): string => new Date(Date.parse("2026-08-06T00:00:00.000Z") + h * 3_600_000).toISOString();

const base = (over: Partial<EstadoParaSlack> = {}): EstadoParaSlack => ({
  emisor: "placement-pause",
  acciones: [],
  reparos: [],
  sinLectura: null,
  voz: "Juanes, todo tranquilo.",
  ahora: "el emisor está pausado",
  riesgo: "ninguno",
  ...over
});

test("si nada cambió y no hay nada que hacer, SE CALLA", () => {
  // Es la respuesta correcta casi siempre. Corre cada 10 min: hablar en cada vuelta son 144
  // mensajes por día y en dos días el operador lo silencia.
  const mem: MemoriaSlack = { ultimoEmisor: "placement-pause", ultimoAviso: T(9), ultimaFirma: null };
  assert.equal(decidirSiHablar(base(), mem, T(10)), null);
});

test("habla cuando CAMBIA el estado del emisor, en las dos direcciones", () => {
  const mem: MemoriaSlack = { ultimoEmisor: "send", ultimoAviso: T(9), ultimaFirma: null };
  const frenó = decidirSiHablar(base({ emisor: "placement-pause" }), mem, T(10));
  assert.ok(frenó);
  assert.match(frenó.texto, /se frenó/);

  const arrancó = decidirSiHablar(
    base({ emisor: "send" }),
    { ultimoEmisor: "placement-pause", ultimoAviso: T(9), ultimaFirma: null },
    T(10)
  );
  assert.ok(arrancó);
  assert.match(arrancó.texto, /arrancó/);
});

test("si ACTUÓ sobre la infraestructura, lo dice siempre", () => {
  // Una mano que se mueve en silencio es exactamente lo que no queremos de un agente autónomo.
  const a = decidirSiHablar(
    base({ acciones: [{ accion: "frenar_dominio", objetivo: "x.com", ejecutada: true, detalle: "frenado" }] }),
    { ultimoEmisor: "placement-pause", ultimoAviso: T(9), ultimaFirma: null },
    T(10)
  );
  assert.ok(a);
  assert.match(a.texto, /frenar_dominio x\.com/);
  assert.equal(a.pideRespuesta, false);
});

test("si quiso actuar y NO pudo, pide decisión — pero UNA sola vez", () => {
  // El caso real: pidió lo mismo 10 veces en 2 horas. Serían 10 mensajes idénticos en Slack.
  const estado = base({
    acciones: [{ accion: "frenar_dominio", objetivo: "y.com", ejecutada: false, detalle: "no habilitado" }]
  });
  const mem: MemoriaSlack = { ultimoEmisor: "placement-pause", ultimoAviso: T(9), ultimaFirma: null };

  const primero = decidirSiHablar(estado, mem, T(10));
  assert.ok(primero);
  assert.equal(primero.pideRespuesta, true);
  assert.match(primero.texto, /¿Lo resolvés vos\?/);

  // Con la memoria actualizada, el MISMO pedido ya no vuelve a molestar.
  const mem2 = recordarAviso(estado, true, T(10), mem);
  assert.equal(decidirSiHablar(estado, mem2, T(11)), null, "no repite el mismo pedido");
});

test("si no pudo mirar, lo dice: un vigilante ciego tiene que avisar", () => {
  const a = decidirSiHablar(base({ sinLectura: "fetch failed" }), null, T(10));
  assert.ok(a);
  assert.match(a.texto, /No pude leer/);
});

test("si dijo algo que no se sostiene, avisa que quedó SIN MANOS", () => {
  // Con reparos el agente no ejecuta nada. El operador tiene que saber que quedó mudo de manos,
  // no solo de boca.
  const a = decidirSiHablar(base({ reparos: ["nombra z.com, que no está en los datos"] }), null, T(10));
  assert.ok(a);
  assert.equal(a.pideRespuesta, true);
  assert.match(a.texto, /no toqué nada/);
});

test("la memoria recuerda el emisor AUNQUE se haya callado", () => {
  // Si no, el primer cambio tras un silencio se reportaría contra un estado viejísimo.
  const mem = recordarAviso(base({ emisor: "send" }), false, T(10), { ultimoEmisor: "placement-pause", ultimoAviso: T(9), ultimaFirma: null });
  assert.equal(mem.ultimoEmisor, "send");
  assert.equal(mem.ultimoAviso, T(9), "pero no marca que habló");
});

test("la señal de vida SE BORRÓ: sin un dato que nombrar, el silencio es más honesto", () => {
  // Este test decía lo contrario ("con riesgo abierto sale 'Sigo acá'") y se dio vuelta a
  // propósito, con su incidente: en las últimas 8 h del régimen mudo la señal de vida fue 2 de los
  // 3 avisos que salieron —19:02 "Sigo acá…" y 01:01 "Sigo acá…"— y no decía absolutamente nada.
  // Parece un reporte y no lo es: el jefe la leyó como "todo en orden" mientras la base registraba
  // 14 eventos reales, y a las 01:10 escribió "No me has dicho nada en toda la tarde …".
  // Ahora ese lugar lo ocupa la razón 7, que solo habla con (campo, objeto, antes, después).
  const mem: MemoriaSlack = { ultimoEmisor: "placement-pause", ultimoAviso: T(0), ultimaFirma: null };
  assert.equal(decidirSiHablar(base({ riesgo: "ninguno" }), mem, T(10)), null, "sin riesgo, silencio");
  assert.equal(
    decidirSiHablar(base({ riesgo: "la rampa se estanca" }), mem, T(10)),
    null,
    "un riesgo declarado tampoco alcanza: si no hay un cambio que nombrar, no hay mensaje"
  );
});

test("sin credenciales no revienta: informa y sigue", async () => {
  // Que Slack esté caído o sin configurar no puede tumbar al agente que vigila la fábrica.
  const r = await mandarASlack({ texto: "x", motivo: "m", pideRespuesta: false }, {});
  assert.equal(r.ok, false);
  assert.match(r.motivo ?? "", /SLACK_BOT_TOKEN/);

  const rota = await mandarASlack(
    { texto: "x", motivo: "m", pideRespuesta: false },
    { token: "t", canal: "c", fetchImpl: (async () => { throw new Error("red caída"); }) as never }
  );
  assert.equal(rota.ok, false);
  assert.match(rota.motivo ?? "", /red caída/);

  const okey = await mandarASlack(
    { texto: "x", motivo: "m", pideRespuesta: false },
    { token: "t", canal: "c", fetchImpl: (async () => ({ json: async () => ({ ok: true }) })) as never }
  );
  assert.equal(okey.ok, true);
});

test("un problema que dura toda la noche NO son 48 mensajes idénticos", () => {
  // Corriendo cada 10 min, las razones que avisan sobre una CONDICIÓN QUE PERSISTE (el modelo
  // caído, una lectura con reparos) no miraban la memoria: un problema que dura la noche llenaba
  // Slack antes del desayuno. El daño real no es la molestia — es que entrena al operador a
  // ignorar el canal por el que tiene que llegar lo urgente.
  const ciego = base({ sinLectura: "fetch failed" });
  const primero = decidirSiHablar(ciego, null, T(1));
  assert.ok(primero, "la primera vez sí avisa");

  const mem = recordarAviso(ciego, true, T(1), null, primero);
  assert.equal(decidirSiHablar(ciego, mem, T(2)), null, "una hora después, callado");
  assert.equal(decidirSiHablar(ciego, mem, T(6)), null, "cinco horas después, todavía callado");

  // Pero callarse para siempre tampoco sirve: si a las 4am quedó ciego, a las 8 hay que saberlo.
  const alRato = decidirSiHablar(ciego, mem, T(8));
  assert.ok(alRato, "a las 7 horas lo repite: sigue roto y hay que enterarse");
});

test("dos condiciones distintas no se tapan entre sí", () => {
  // Guardando solo la firma del ESTADO, un aviso por reparos silenciaba al de sin-lectura y al
  // revés, porque el estado subyacente puede ser el mismo. Cada razón lleva su etiqueta.
  const conReparos = base({ reparos: ["dice que x.com cruzó y no figura"] });
  const a1 = decidirSiHablar(conReparos, null, T(1));
  assert.ok(a1);
  const mem = recordarAviso(conReparos, true, T(1), null, a1);

  const ciego = base({ sinLectura: "modelo caído" });
  assert.ok(decidirSiHablar(ciego, mem, T(2)), "otra condición SÍ se avisa aunque sea a los minutos");
});

test("MIRAR no dispara un mensaje: solo lo que cambia la infraestructura", () => {
  // La noche del 2026-08-06 el agente mandó ~25 mensajes mientras el operador dormía, y casi todos
  // terminaban en "Hice esto: medir_dominio X, diagnosticar_dominio Y" — avisando que había ido a
  // mirar. El efecto perverso: cada ojo nuevo que le dábamos lo hacía hablar MÁS, así que mejorar
  // su autonomía empeoraba el canal.
  const mem: MemoriaSlack = { ultimoEmisor: "send", ultimoAviso: T(9), ultimaFirma: null };
  const soloMiro = base({
    emisor: "send",
    acciones: [
      { accion: "medir_dominio", objetivo: "a.com", ejecutada: true, detalle: "83% sobre 6" },
      { accion: "diagnosticar_dominio", objetivo: "b.com", ejecutada: true, detalle: "healthy" },
      { accion: "leer_cupo_nodo", objetivo: "c.com", ejecutada: true, detalle: "cupo 20" }
    ]
  });
  assert.equal(decidirSiHablar(soloMiro, mem, T(10)), null, "ir a mirar no es noticia");

  // Pero lo que TOCA la flota se sigue diciendo siempre, en la misma vuelta.
  const ademasToco = base({
    emisor: "send",
    acciones: [
      { accion: "medir_dominio", objetivo: "a.com", ejecutada: true, detalle: "83%" },
      { accion: "frenar_dominio", objetivo: "z.com", ejecutada: true, detalle: "cap 255 → 0" }
    ]
  });
  const a = decidirSiHablar(ademasToco, mem, T(10));
  assert.ok(a);
  assert.match(a.texto, /frenar_dominio z\.com/);
  assert.ok(!a.texto.includes("medir_dominio"), "no mezcla lo que miró con lo que hizo");
});

test("un parpadeo de infraestructura NO se convierte en '¿lo resolvés vos?'", () => {
  // Ocurrió tal cual el 2026-08-06: mientras el operador corría el instalador, Postgres se recargó
  // doce segundos y el agente le mandó dos "@Juanes Quise medir_dominio X y no pude: ECONNREFUSED
  // 127.0.0.1:5432. ¿Lo resolvés vos?" — con mención, sonándole el móvil, sobre algo que ya estaba
  // arreglado antes de que lo leyera.
  const parpadeo = base({
    emisor: "send",
    acciones: [
      { accion: "medir_dominio", objetivo: "a.com", ejecutada: false, reintentable: true, detalle: "no pude medirlo: connect ECONNREFUSED 127.0.0.1:5432" }
    ]
  });
  const mem: MemoriaSlack = { ultimoEmisor: "send", ultimoAviso: T(9), ultimaFirma: null };
  assert.equal(decidirSiHablar(parpadeo, mem, T(10)), null);

  // Un SSH caído al frenar tampoco: se reintenta en la vuelta siguiente.
  const ssh = base({
    emisor: "send",
    acciones: [{ accion: "frenar_dominio", objetivo: "z.com", ejecutada: false, reintentable: true, detalle: "no pude frenar z.com: timeout" }]
  });
  assert.equal(decidirSiHablar(ssh, mem, T(10)), null);
});

test("pero lo que SÍ necesita un humano sigue interrumpiendo", () => {
  // La contracara: bajar el ruido solo sirve si lo que de verdad requiere una decisión llega.
  const mem: MemoriaSlack = { ultimoEmisor: "send", ultimoAviso: T(9), ultimaFirma: null };
  const bloqueado = base({
    emisor: "send",
    acciones: [{ accion: "soltar_dominio", objetivo: "z.com", ejecutada: false, detalle: "rechazada: soltar no está habilitado en este entorno" }]
  });
  const a = decidirSiHablar(bloqueado, mem, T(10));
  assert.ok(a, "una falta de permiso no se arregla sola: hay que avisarle");
  assert.equal(a.pideRespuesta, true);
});

test("si falla una mano que solo MIRA, no se pide nada", () => {
  // Sin datos esta vuelta el agente tiene menos información, no un problema que delegar. Vale
  // incluso si el fallo no vino marcado como reintentable.
  const mem: MemoriaSlack = { ultimoEmisor: "send", ultimoAviso: T(9), ultimaFirma: null };
  const miroYFallo = base({
    emisor: "send",
    acciones: [{ accion: "diagnosticar_dominio", objetivo: "a.com", ejecutada: false, detalle: "rechazada: diagnosticar no está habilitado" }]
  });
  assert.equal(decidirSiHablar(miroYFallo, mem, T(10)), null);
});

// ── RAZÓN 7: LA FÁBRICA AVANZÓ ───────────────────────────────────────────────────────────────────
//
// El agujero que tapan estos tests, medido en las últimas ~8 h de producción del 2026-08-06 (45
// vueltas de guardia): el agente habló 3 veces —"Sigo acá…", "No pude leer el estado", "Sigo
// acá…"— mientras la base registraba 14 eventos reales, incluidos dos INBOX de
// annualfilings-control.com. Ninguna de las seis razones viejas mira la FÁBRICA: todas miran al
// AGENTE. A las 01:10 el jefe escribió "No me has dicho nada en toda la tarde …".

const HECHOS = (over: Partial<HechosWarmup> = {}): HechosWarmup => ({
  generadoEn: "2026-08-06T20:00:00.000Z",
  semillas: { destinos: 5, midiendo: 1, puntoCiego: ["outlook"] },
  vueltas: [
    { dominio: "annualfilings-control.com", semilla: "s@gmail.com", cuando: "2026-08-06T19:00:00Z", placement: "SPAM", completa: true, error: null }
  ],
  cap: { nodosMedidos: 14, nodosSinMedir: 44, enElTope: [], frenados: ["a.com", "b.com"], sinLimite: 0, medidoEn: null },
  flota: { sanas: 13, bloqueadas: 22, atascadas: 22, cruzados: [], cerca: [] },
  plan: [
    { dominio: "corpfiling-infra.com", diaN: 3, placementTasa: 0.83, placementMuestra: 6, cupo: 4, accion: "sostener", motivo: "x", enviadosHoy: 2 }
  ],
  ...over
});

/**
 * EL CABLEADO REAL: el retrato de `antes` es el que se PERSISTIÓ, no uno recalculado desde los
 * hechos viejos. Es la diferencia entre decir "SPAM → INBOX" y decir "sin medir → INBOX" sobre un
 * dominio medido 18 h antes; ver los dos tests de la evicción. Este helper encadena a mano —los
 * tests son el único lugar donde el "disco" es una variable— y por eso el segundo argumento es el
 * mapa anterior y nunca `{}`.
 */
const diff = (a: HechosWarmup, b: HechosWarmup, guardado: Record<string, string | number | null> = {}): Novedad[] => {
  const antes = camposObservables(a, guardado);
  return novedades(antes, camposObservables(b, antes));
};

test("dos lecturas idénticas no producen NINGUNA novedad", () => {
  // El agente corre cada 10 minutos sobre una fábrica que casi siempre está igual. Si el diff
  // devolviera algo con el mismo retrato, serían 144 avisos por día y volveríamos a la noche de
  // los ~25 mensajes, esta vez con mejor excusa.
  assert.deepEqual(diff(HECHOS(), HECHOS()), []);
});

test("un campo que cambió y NO está en la lista cerrada no produce nada", () => {
  // La lista es cerrada POR CONSTRUCCIÓN, no por un filtro: son 58 dominios y sin esto cualquier
  // campo que se menee produce mensaje. `flota.atascadas` y `semillas.midiendo` se mueven solos
  // todo el tiempo y no son un avance de nadie.
  const otro = HECHOS({
    flota: { sanas: 13, bloqueadas: 22, atascadas: 40, cruzados: [], cerca: [] },
    semillas: { destinos: 9, midiendo: 4, puntoCiego: [] },
    rechazos: [{ origen: "freno_propio", cuantos: 99, explicacion: "es NUESTRO cap", ejemplo: "450 …" }]
  });
  assert.deepEqual(diff(HECHOS(), otro), []);
});

test("el placement habla cuando CAMBIA, y una clave que APARECE no cuenta", () => {
  // Contar cada correo daba 14 avisos/día (el tope físico del daemon); contar el cambio da 8, y las
  // 8 incluyen el SPAM→INBOX de annualfilings-control.com de las 00:01Z, que es el evento exacto que
  // originó la queja.
  const otraVueltaIgual = HECHOS({
    vueltas: [
      { dominio: "annualfilings-control.com", semilla: "s@gmail.com", cuando: "2026-08-06T19:30:00Z", placement: "SPAM", completa: true, error: null },
      { dominio: "annualfilings-control.com", semilla: "s@gmail.com", cuando: "2026-08-06T19:00:00Z", placement: "SPAM", completa: true, error: null }
    ]
  });
  assert.deepEqual(diff(HECHOS(), otraVueltaIgual), [], "dos mediciones seguidas con el mismo valor no son noticia");

  const mejoro = HECHOS({
    vueltas: [
      { dominio: "annualfilings-control.com", semilla: "s@gmail.com", cuando: "2026-08-06T20:00:00Z", placement: "INBOX", completa: true, error: null },
      { dominio: "annualfilings-control.com", semilla: "s@gmail.com", cuando: "2026-08-06T19:00:00Z", placement: "SPAM", completa: true, error: null }
    ]
  });
  assert.deepEqual(diff(HECHOS(), mejoro), [
    { clave: "placement:annualfilings-control.com", objeto: "annualfilings-control.com", antes: "SPAM", despues: "INBOX" }
  ]);

  // UNA CLAVE QUE APARECE NO ES NOVEDAD, tampoco la de placement. Estaba exceptuada —"la primera
  // medición de un dominio es un evento de verdad"— y esa excepción fabricaba mensajes: `vueltas` es
  // una ventana `LIMIT 8` sobre los ciclos GLOBALES, así que la clave de un dominio DESAPARECE del
  // retrato cuando mide menos seguido que 1 de cada 8 ciclos, y al volver se anunciaba "sin medir →
  // INBOX" sobre un dominio medido 18 h antes. Reproducido sobre los 19 ciclos reales del
  // 2026-08-06: 2 de 12 avisos del día eran eso, los dos falsos contra la base.
  //
  // El precio de esta línea es que la PRIMERA medición de verdad no se anuncia. Se paga a propósito:
  // el arrastre de `camposObservables` recupera la buena noticia (ver los dos tests de la evicción),
  // y así el peor caso de un retrato mal cableado es silencio en vez de una mentira con nombre y
  // apellido. Ausencia de dato no es evidencia de nada.
  const primeraVez = HECHOS({
    vueltas: [
      ...HECHOS().vueltas,
      { dominio: "corp-delivery.com", semilla: "s@gmail.com", cuando: "2026-08-06T20:10:00Z", placement: "INBOX", completa: true, error: null }
    ]
  });
  assert.deepEqual(diff(HECHOS(), primeraVez), []);
});

test("LA EVICCIÓN NO PUEDE FABRICAR UN 'sin medir → INBOX', ni con el retrato mal cableado", () => {
  // El defecto que se coló dos rondas seguidas: el arrastre de `camposObservables` solo tapa el
  // agujero si quien cablea PERSISTE el retrato; recalculándolo desde los hechos anteriores
  // (`camposObservables(previa.hechos, {})`) el mapa viejo va sin arrastre y el nuevo sí, así que
  // toda clave arrastrada aparece como nueva. Este test fija que el peor caso sea SILENCIO.
  const midioSpam = HECHOS({ vueltas: [CICLO("x.com", "2026-08-06T10:00:00Z", "SPAM")] });
  const evictado = HECHOS({ vueltas: [CICLO("otro.com", "2026-08-06T11:00:00Z", "INBOX")] });
  const vuelve = HECHOS({ vueltas: [CICLO("x.com", "2026-08-06T12:00:00Z", "INBOX")] });

  // Mal cableado: el mapa "antes" se recalcula desde los hechos evictados.
  assert.deepEqual(
    diff(evictado, vuelve),
    [],
    "sin el retrato guardado se PIERDE la noticia, que es el costo honesto; lo que no puede es inventarse"
  );

  // Bien cableado: el retrato se persiste vuelta a vuelta y la noticia sale entera.
  const s1 = camposObservables(midioSpam, {});
  const s2 = camposObservables(evictado, s1);
  assert.deepEqual(novedades(s2, camposObservables(vuelve, s2)), [
    { clave: "placement:x.com", objeto: "x.com", antes: "SPAM", despues: "INBOX" }
  ]);
});

test("una vuelta SIN placement no inventa un valor", () => {
  // `placement: null` es "todavía no se midió". Escribirlo como valor haría que la medición real
  // siguiente se leyera como un cambio desde un dato que nunca existió — la confusión más cara del
  // sistema, la misma que hizo leer "0 detecciones de blacklist" como "está limpio".
  const sinMedir = HECHOS({
    vueltas: [{ dominio: "nuevo.com", semilla: "s@gmail.com", cuando: "2026-08-06T20:00:00Z", placement: null, completa: false, error: null }]
  });
  assert.equal(camposObservables(sinMedir, {})["placement:nuevo.com"], undefined);
});

test("sin snapshot previo NO habla: en una instalación fresca todo sería 'nuevo'", () => {
  // Fail-closed. Con el mapa previo vacío, las ~30 claves del retrato serían 30 avances de golpe:
  // el agente abriría su vida en Slack con una tormenta.
  assert.deepEqual(novedades({}, camposObservables(HECHOS(), {})), []);
  assert.deepEqual(diff(HECHOS({ plan: undefined, cap: null, flota: null, vueltas: [] }), HECHOS()), []);
});

test("una lectura que se recupera NO es un avance de la fábrica", () => {
  // En el orquestador `plan` sale de `planDelDia(...).catch(() => undefined)` y `cap`/`flota` de
  // `readInventoryJson(...).catch(() => null)`: un tropiezo borra la sección entera. Al volver,
  // contar sus claves como "nuevas" declararía 24 avances que nadie logró.
  const sinPlan = HECHOS({ plan: undefined, cap: null });
  assert.deepEqual(diff(sinPlan, HECHOS()), [], "aparecer no es avanzar");
  assert.deepEqual(diff(HECHOS(), sinPlan), [], "y desaparecer tampoco: eso ya lo dice la razón 1");
});

// ── El presupuesto ───────────────────────────────────────────────────────────────────────────────

const N = (clave: string, despues: string | number, antes: string | number | null = 0): Novedad => ({
  clave,
  objeto: clave.includes(":") ? clave.slice(clave.indexOf(":") + 1).replace(/\.[a-zA-Z]+$/, "") : "",
  antes,
  despues
});

const HOY = "2026-08-06";
const memBase = (over: Partial<MemoriaSlack> = {}): MemoriaSlack => ({
  ultimoEmisor: "send",
  ultimoAviso: T(9),
  ultimaFirma: null,
  ...over
});

test("diez novedades en una vuelta son UN mensaje, y el sobrante se cuenta", () => {
  // El tope va en código y no en config: un tope de ruido que se puede subir por variable de
  // entorno a las 3am deja de ser un tope. Y el sobrante nunca se pierde en silencio — un canal
  // donde no se puede saber cuánto se calló no se puede calibrar.
  const muchas = Array.from({ length: 10 }, (_, i) => N(`plan:d${i}.com.diaN`, i + 1));
  const a = decidirSiHablar(base({ emisor: "send", novedades: muchas }), memBase(), T(10));
  assert.ok(a);
  assert.match(a.texto, /Además: 9 cambios menores\./);
  assert.equal(a.pideRespuesta, false, "un avance no interrumpe a nadie");
});

test("pasado el tope diario NO sale, pero se CUENTA", () => {
  // "No sale" tiene que poder distinguirse de "se perdió". Por eso `presupuestoDeAvances` se
  // exporta: el orquestador loguea los tapados aunque no mande nada.
  const mem = memBase({ avancesHoy: 10, diaAvances: HOY });
  const r = presupuestoDeAvances([N("cap.frenados", 45, 44)], mem, T(10));
  assert.equal(r.elegida, null);
  assert.equal(r.tapados, 1);
  assert.equal(decidirSiHablar(base({ emisor: "send", novedades: [N("cap.frenados", 45, 44)] }), mem, T(10)), null);
});

test("el tope de avances NUNCA calla un PROBLEMA", () => {
  // Es exactamente el error del arreglo anterior: bajar el ruido apagó lo que sí funcionaba. Con
  // el presupuesto agotado, las razones 1, 2, 4 y 5 siguen saliendo.
  const lleno = memBase({ avancesHoy: 10, diaAvances: HOY });
  const conNovedad = { novedades: [N("cap.frenados", 45, 44)] };

  assert.ok(decidirSiHablar(base({ ...conNovedad, sinLectura: "fetch failed" }), lleno, T(10)), "R1 sin lectura");
  assert.ok(decidirSiHablar(base({ ...conNovedad, reparos: ["dice que z.com cruzó y no figura"] }), lleno, T(10)), "R2 reparos");
  assert.ok(
    decidirSiHablar(
      base({ ...conNovedad, emisor: "send", acciones: [{ accion: "soltar_dominio", objetivo: "z.com", ejecutada: false, detalle: "no habilitado" }] }),
      lleno,
      T(10)
    ),
    "R4 acción trabada"
  );
  assert.ok(decidirSiHablar(base({ ...conNovedad, emisor: "placement-pause" }), lleno, T(10)), "R5 cambió el emisor");
});

test("la misma novedad no se dice dos veces, aunque cambie cualquier otra cosa", () => {
  // Dedupe por CLAVE con enfriamiento, no por texto. La firma vieja (acciones + emisor + sinLectura)
  // no alcanzaba: dos vueltas seguidas con la misma novedad dan firmas distintas si cambió cualquier
  // acción, y hablaría dos veces.
  const nov = N("placement:x.com", "INBOX", "SPAM");
  const estado = base({ emisor: "send", novedades: [nov] });
  const primero = decidirSiHablar(estado, memBase(), T(10));
  assert.ok(primero);
  const mem2 = recordarAviso(estado, true, T(10), memBase(), primero);
  assert.equal(mem2.novedadesRecientes?.["placement:x.com"], T(10));

  const otraAccion = base({
    emisor: "send",
    novedades: [nov],
    acciones: [{ accion: "medir_dominio", objetivo: "q.com", ejecutada: true, detalle: "83%" }]
  });
  assert.equal(decidirSiHablar(otraAccion, mem2, T(10.5)), null, "la misma novedad, callado");
});

test("UN VALOR QUE OSCILA NO PRODUCE UN MENSAJE POR VUELTA", () => {
  // El dedupe era por `clave=valorNuevo`, así que contra A→B→A→B nunca coincidía con el anterior y
  // no deduplicaba nada: el único freno que quedaba era el tope diario, y es el freno equivocado —
  // un flap se come los 10 avances del día y tapa el evento real. Los candidatos no son teóricos:
  // `flota.sanas`/`flota.bloqueadas` van y vienen con el modo de falla "nodo vivo pero incomunicado",
  // y `plan:<d>.accion` cruza PISO_CRITICO=0,35 con solo pasar de 2/6 a 3/6 de muestra.
  // Simulado con `cap.frenados` oscilando 8↔7 cada 10 minutos: 20 mensajes en 24 h.
  let mem = memBase();
  let mensajes = 0;
  for (let i = 0; i < 36; i++) {
    // 6 horas de vueltas cada 10 minutos.
    const ahora = new Date(Date.parse(T(0)) + i * 600_000).toISOString();
    const estado = base({ emisor: "send", novedades: [N("cap.frenados", i % 2 === 0 ? 8 : 7, i % 2 === 0 ? 7 : 8)] });
    const a = decidirSiHablar(estado, mem, ahora);
    if (a) mensajes++;
    mem = recordarAviso(estado, !!a, ahora, mem, a);
  }
  assert.equal(mensajes, 6, "una vez por hora, no una por vuelta");
});

test("el enfriamiento es POR CLAVE: un flap no tapa el evento de otro dominio", () => {
  // El daño real del flap no era el ruido: era que se comía el presupuesto y dejaba afuera el
  // SPAM→INBOX. El enfriamiento tiene que ser de la clave que habló, nunca del canal.
  const flap = base({ emisor: "send", novedades: [N("cap.frenados", 8, 7)] });
  const a = decidirSiHablar(flap, memBase(), T(10));
  const mem = recordarAviso(flap, true, T(10), memBase(), a);
  const otro = base({ emisor: "send", novedades: [N("placement:annualfilings-control.com", "INBOX", "SPAM")] });
  assert.match(decidirSiHablar(otro, mem, T(10.1))?.texto ?? "", /SPAM → INBOX/);
});

test("sale la novedad IMPORTANTE, no la primera de la lista", () => {
  // El riesgo que nombró el operador: que el avance importante quede atrás de uno trivial. Un
  // dominio que se soltó pesa más que un día de rampa.
  const a = decidirSiHablar(
    base({ emisor: "send", novedades: [N("plan:corpfiling-infra.com.diaN", 4, 3), N("cap.frenados", 45, 44)] }),
    memBase(),
    T(10)
  );
  assert.ok(a);
  assert.match(a.motivo, /^novedad cap\.frenados 44→45/);
  assert.match(a.texto, /los dominios frenados: 44 → 45\./);
});

test("el motivo es RECALCULABLE: campo, objeto y los dos valores", () => {
  // Sin esto no se puede separar ruido de señal con un comando, que es la única auditoría posible
  // del canal: todo aviso proactivo tiene que poder reproducirse desde el diff de dos snapshots.
  const a = decidirSiHablar(
    base({ emisor: "send", novedades: [N("plan:corpfiling-infra.com.diaN", 4, 3)] }),
    memBase(),
    T(10)
  );
  assert.ok(a);
  assert.equal(a.motivo, "novedad plan.diaN corpfiling-infra.com 3→4");
  assert.equal(a.texto, "el día de rampa de corpfiling-infra.com: 3 → 4.");
  assert.ok(!/Sigo acá|todo tranquilo/.test(a.texto), "el avance NO lleva la voz del modelo: lleva el número");
});

test("un valor que no se midió se dice 'sin medir', jamás 0", () => {
  // No medido y cero no son lo mismo, y confundirlos es cómo se fabrica un dato. La primera
  // medición de un dominio tiene que leerse como lo que es.
  const a = decidirSiHablar(
    base({ emisor: "send", novedades: [{ clave: "placement:corp-delivery.com", objeto: "corp-delivery.com", antes: null, despues: "INBOX" }] }),
    memBase(),
    T(10)
  );
  assert.ok(a);
  assert.match(a.texto, /el placement de corp-delivery\.com: sin medir → INBOX\./);
});

test("un avance NO resucita el pedido de decisión que ya se hizo", () => {
  // La trampa del contador: si el aviso de avance pisara `ultimaFirma`, la razón 4 volvería a
  // mandar "Quise X y no pude, ¿lo resolvés vos?" en la vuelta siguiente. Es el bug de los 10
  // mensajes idénticos en 2 horas, reabierto por la puerta de atrás.
  const trabado = base({
    emisor: "send",
    acciones: [{ accion: "soltar_dominio", objetivo: "z.com", ejecutada: false, detalle: "no habilitado" }]
  });
  const pedido = decidirSiHablar(trabado, memBase(), T(10));
  assert.ok(pedido);
  const mem1 = recordarAviso(trabado, true, T(10), memBase(), pedido);

  const conAvance = { ...trabado, novedades: [N("cap.frenados", 45, 44)] };
  const avance = decidirSiHablar(conAvance, mem1, T(11));
  assert.ok(avance, "el avance sí sale: el pedido ya está hecho y no se repite");
  assert.match(avance.motivo, /^novedad /);
  const mem2 = recordarAviso(conAvance, true, T(11), mem1, avance);

  assert.equal(decidirSiHablar(trabado, mem2, T(12)), null, "y el pedido sigue callado");
});

test("un avance NO corre para adelante el reloj de las 6 horas", () => {
  // El goteo y el olvido son dos problemas distintos y tienen dos relojes distintos. Si el avance
  // moviera `ultimoAviso`, un problema que persiste (el modelo caído) se dejaría de repetir cada
  // vez que la fábrica avanza — y si a las 4am quedó ciego, a las 8 hay que seguir sabiéndolo.
  const ciego = base({ sinLectura: "fetch failed" });
  const primero = decidirSiHablar(ciego, null, T(1));
  assert.ok(primero);
  const mem1 = recordarAviso(ciego, true, T(1), null, primero);

  const sano = base({ emisor: "placement-pause", novedades: [N("flota.sanas", 14, 13)] });
  const avance = decidirSiHablar(sano, mem1, T(2));
  assert.ok(avance);
  const mem2 = recordarAviso(sano, true, T(2), mem1, avance);

  assert.equal(decidirSiHablar(ciego, mem2, T(3)), null, "sigue tapado: el avance no borró la firma del problema");
  assert.ok(decidirSiHablar(ciego, mem2, T(7)), "a las 6 h del primer aviso lo repite, no a las 6 h del avance");
});

test("una memoria vieja sin los campos del presupuesto sigue funcionando", () => {
  // El warmup-slack.json que hay en producción no tiene `avancesHoy` ni `diaAvances`. Si fueran
  // obligatorios, el primer despliegue leería una memoria "inválida" y el agente se olvidaría del
  // último emisor: su primer mensaje sería un cambio de emisor que no ocurrió.
  const vieja: MemoriaSlack = { ultimoEmisor: "send", ultimoAviso: T(9), ultimaFirma: null };
  const a = decidirSiHablar(base({ emisor: "send", novedades: [N("cap.frenados", 45, 44)] }), vieja, T(10));
  assert.ok(a, "el contador arranca en 0");
  const mem = recordarAviso(base({ emisor: "send" }), true, T(10), vieja, a);
  assert.equal(mem.avancesHoy, 1);
  assert.equal(mem.diaAvances, HOY);
  assert.equal(mem.ultimoEmisor, "send", "y no se pierde nada de lo viejo");
});

test("el contador de avances se resetea al cambiar el día UTC", () => {
  // Si no, el primer día con tormenta dejaría al agente mudo para siempre.
  const ayer = memBase({ avancesHoy: 10, diaAvances: "2026-08-05" });
  const r = presupuestoDeAvances([N("cap.frenados", 45, 44)], ayer, T(10));
  assert.ok(r.elegida, "diez de ayer no gastan el cupo de hoy");
  const mem = recordarAviso(base({ emisor: "send" }), true, T(10), ayer, {
    texto: "x",
    motivo: "novedad cap.frenados 44→45",
    pideRespuesta: false,
    firma: "novedad|",
    avance: "cap.frenados"
  });
  assert.equal(mem.avancesHoy, 1, "arranca de nuevo, no de 11");
  assert.equal(mem.diaAvances, HOY);
});

// ── LA VENTANA DE 8 FILAS, Y LOS AVANCES QUE FABRICABA ───────────────────────────────────────────

/** Un ciclo cualquiera, para llenar la ventana de `vueltas` con dominios ajenos. */
const CICLO = (dominio: string, cuando: string, placement: string | null) => ({
  dominio,
  semilla: "s@gmail.com",
  cuando,
  placement,
  completa: true,
  error: null
});

test("un dominio que se cae de la ventana y vuelve a medir LO MISMO no es novedad", () => {
  // `hechos.vueltas` es una query LIMIT 8 sobre los ciclos GLOBALES. Con 6 dominios y ~14 ciclos por
  // día, la fila de un dominio se cae de la ventana en horas y su clave `placement:` desaparece;
  // cuando vuelve a medir, REAPARECE y —por la excepción que hace que aparecer sea el evento para
  // placement— se anunciaba "sin medir → INBOX" sobre un dominio medido 18 h antes. Medido sobre el
  // stream real del 2026-08-06: 4 de 12 mensajes simulados tenían esa forma y 2 eran falsos contra
  // la base. Y no es un borde: le pasa a CADA dominio que mide menos seguido que 1 de cada 8 ciclos.
  const midio = HECHOS({ vueltas: [CICLO("x.com", "2026-08-06T01:00:00Z", "INBOX")] });
  const otros = HECHOS({
    vueltas: Array.from({ length: 8 }, (_, i) => CICLO(`otro${i}.com`, `2026-08-06T02:0${i}:00Z`, "SPAM"))
  });
  const vuelveIgual = HECHOS({ vueltas: [CICLO("x.com", "2026-08-06T03:00:00Z", "INBOX")] });

  const s1 = camposObservables(midio, {});
  const s2 = camposObservables(otros, s1);
  assert.equal(s2["placement:x.com"], "INBOX", "el valor conocido se arrastra: la evicción no borra lo medido");
  const s3 = camposObservables(vuelveIgual, s2);
  assert.deepEqual(novedades(s2, s3), [], "volver a medir lo mismo NO es un avance");
});

test("y cuando de verdad cambia después de una evicción, lo dice con los DOS valores", () => {
  // El otro lado de la misma moneda, y es la mejor noticia que puede dar la fábrica: SPAM → INBOX.
  // Con la ventana suelta se anunciaba como "sin medir → INBOX", o sea la transición perdida.
  const enSpam = HECHOS({ vueltas: [CICLO("x.com", "2026-08-06T01:00:00Z", "SPAM")] });
  const otros = HECHOS({ vueltas: Array.from({ length: 8 }, (_, i) => CICLO(`otro${i}.com`, `2026-08-06T02:0${i}:00Z`, "SPAM")) });
  const mejoro = HECHOS({ vueltas: [CICLO("x.com", "2026-08-06T03:00:00Z", "INBOX")] });

  const s1 = camposObservables(enSpam, {});
  const s2 = camposObservables(otros, s1);
  assert.deepEqual(novedades(s2, camposObservables(mejoro, s2)), [
    { clave: "placement:x.com", objeto: "x.com", antes: "SPAM", despues: "INBOX" }
  ]);
});

test("las MUESTRAS de placement no son un avance: no se observan", () => {
  // `placementMuestra` es `placements.length`, un contador monótono que sube con cada medición
  // (~14/día, el techo del daemon) y que además es el DENOMINADOR de un avance, no un avance. Estaba
  // último en la prioridad, así que ganaba la vuelta cada vez que no cambiaba nada más —o sea casi
  // siempre— y se comía el cupo diario con "las muestras de placement de X: 3 → 4", dejando tapado
  // el evento real de las 20:00. Contra el retrato real de producción eran 6 de 32 claves.
  const conMuestras = HECHOS({
    plan: [{ dominio: "corpfiling-infra.com", diaN: 3, placementTasa: 0.83, placementMuestra: 7, cupo: 4, accion: "sostener", motivo: "x", enviadosHoy: 2 }]
  });
  assert.equal(camposObservables(conMuestras, {})["plan:corpfiling-infra.com.muestra"], undefined);
  assert.deepEqual(diff(HECHOS(), conMuestras), [], "subir de 6 a 7 mediciones no es noticia");
});

test("una CAÍDA a SPAM le gana a todo, y lo tapado no se llama 'avance'", () => {
  // Sobre los hechos reales del 2026-08-06 con seis cambios en una vuelta, salía "los dominios
  // frenados: 8 → 7. Además: 5 avances menores." — y adentro de esos 5 iba el INBOX→SPAM de
  // corpfiling-infra.com. Una regresión rotulada como avance y encima tapada.
  const a = decidirSiHablar(
    base({
      emisor: "send",
      novedades: [N("cap.frenados", 7, 8), N("placement:corpfiling-infra.com", "SPAM", "INBOX"), N("flota.sanas", 14, 13)]
    }),
    memBase(),
    T(10)
  );
  assert.ok(a);
  assert.match(a.texto, /el placement de corpfiling-infra\.com: INBOX → SPAM\./);
  assert.match(a.texto, /Además: 2 cambios menores\./, "no son 'avances': ahí adentro puede ir otra caída");
});

test("con el modelo caído YA AVISADO, la fábrica se sigue contando", () => {
  // Las razones 1 y 2 hacían `return null` adentro de su dedupe de 6 h, así que un modelo caído
  // dejaba al agente mudo sobre la FÁBRICA seis horas seguidas — la tarde del 2026-08-06: "No pude
  // leer el estado" a las 21:00 y a la 01:10 el jefe escribiendo "No me has dicho nada en toda la
  // tarde", con dos INBOX en la base en el medio. El aviso de avance es una plantilla pura sobre los
  // hechos, y los hechos están frescos aunque el modelo no conteste: `reunirHechos` corre antes de
  // `pedirLectura`, que devuelve los mismos hechos en todos sus caminos de fallo.
  const ciego = base({ sinLectura: "el modelo tardó demasiado" });
  const primero = decidirSiHablar(ciego, null, T(1));
  assert.ok(primero);
  const mem = recordarAviso(ciego, true, T(1), null, primero);
  assert.equal(decidirSiHablar(ciego, mem, T(2)), null, "el problema no se repite cada 10 minutos");

  const conNovedad = { ...ciego, novedades: [N("placement:annualfilings-control.com", "INBOX", "SPAM")] };
  const a = decidirSiHablar(conNovedad, mem, T(2));
  assert.ok(a, "pero el SPAM→INBOX sale igual: no depende del modelo");
  assert.match(a.texto, /el placement de annualfilings-control\.com: SPAM → INBOX\./);

  // Lo mismo con una lectura con reparos: el error es del MODELO, la aritmética de los hechos no.
  const conReparos = base({ reparos: ["el 33% no sale de ningún dato"], novedades: [N("cap.frenados", 7, 8)] });
  const r1 = decidirSiHablar(conReparos, null, T(1));
  assert.ok(r1);
  const mem2 = recordarAviso(conReparos, true, T(1), null, r1);
  assert.match(decidirSiHablar(conReparos, mem2, T(2))?.texto ?? "", /los dominios frenados: 8 → 7\./);
});


// ── EL AVANCE VIAJA PEGADO: las razones 3, 4 y 5 no se lo tragan ─────────────────────────────────

const SUBIO = N("placement:annualfilings-control.com", "INBOX", "SPAM");

test("una acción ejecutada NO se traga el SPAM→INBOX de la misma vuelta", () => {
  // Las razones 1 y 2 ya devolvían el avance cuando se callaban por repetidas; las 3, 4 y 5 hacían
  // `return` a secas. Si esa vuelta hubo una acción ejecutada, una acción trabada o un cambio de
  // emisor, el avance no salía — y el snapshot se pisa en la misma vuelta, así que el diff se
  // consumía y la vuelta siguiente ya no lo veía. Silencio permanente sobre la mejor noticia que da
  // la fábrica, sin quedar contado ni en `tapados`: literalmente "0 mensajes en un día donde pasaron
  // cosas buenas", que es la mitad de la queja 2.
  const a = decidirSiHablar(
    base({
      emisor: "placement-pause",
      novedades: [SUBIO],
      acciones: [{ accion: "soltar_dominio", objetivo: "corp-delivery.com", ejecutada: true, detalle: "ok" }]
    }),
    memBase(),
    T(10)
  );
  assert.ok(a);
  assert.match(a.texto, /soltar_dominio corp-delivery\.com/, "la acción sigue saliendo");
  assert.match(a.texto, /SPAM → INBOX/, "y el avance viaja con ella, en el MISMO mensaje");
  // El motivo tiene que llevar los dos: el log es la única auditoría del canal, y un avance sin
  // motivo propio no se puede reproducir desde el diff.
  assert.match(a.motivo, /ejecutó una acción \+novedad placement annualfilings-control\.com SPAM→INBOX/);
});

test("una acción trabada y un cambio de emisor tampoco se lo tragan", () => {
  const trabada = decidirSiHablar(
    base({
      emisor: "placement-pause",
      novedades: [SUBIO],
      acciones: [{ accion: "soltar_dominio", objetivo: "z.com", ejecutada: false, detalle: "no habilitado" }]
    }),
    memBase(),
    T(10)
  );
  assert.match(trabada?.texto ?? "", /SPAM → INBOX/);
  assert.equal(trabada?.pideRespuesta, true, "sigue siendo un pedido de decisión");

  const emisor = decidirSiHablar(base({ emisor: "send", novedades: [SUBIO] }), memBase({ ultimoEmisor: "placement-pause" }), T(10));
  assert.match(emisor?.texto ?? "", /El emisor arrancó/);
  assert.match(emisor?.texto ?? "", /SPAM → INBOX/);
});

test("el avance pegado COBRA el presupuesto y entra al enfriamiento", () => {
  // Si el pegado no dejara rastro, la misma novedad podría volver a salir sola en la vuelta
  // siguiente: el jefe leería dos veces el mismo SPAM→INBOX, una pegada y otra suelta.
  const estado = base({
    emisor: "placement-pause",
    novedades: [SUBIO],
    acciones: [{ accion: "soltar_dominio", objetivo: "corp-delivery.com", ejecutada: true, detalle: "ok" }]
  });
  const a = decidirSiHablar(estado, memBase(), T(10));
  const mem = recordarAviso(estado, true, T(10), memBase(), a);
  assert.equal(mem.avancesHoy, 1, "cuenta en el presupuesto aunque haya viajado pegado");
  assert.equal(mem.novedadesRecientes?.["placement:annualfilings-control.com"], T(10));
  assert.equal(decidirSiHablar(base({ emisor: "placement-pause", novedades: [SUBIO] }), mem, T(10.5)), null, "y no vuelve suelto");
  // Un aviso PEGADO sí corre el reloj de los problemas: el mensaje que salió es el de la otra razón.
  assert.equal(mem.ultimoAviso, T(10));
});
