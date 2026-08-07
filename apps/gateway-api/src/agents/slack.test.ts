import assert from "node:assert/strict";
import test from "node:test";
import {
  camposDeLaPregunta,
  camposObservables,
  decidirSiHablar,
  dejaSalir,
  enCastellano,
  esRegla,
  loQueSeCallo,
  mandarASlack,
  novedades,
  presupuestoDeAvances,
  promoverPorPreguntas,
  recordarAviso,
  registrarReaccion,
  registrarSalida,
  REGLAS,
  TOCAN,
  type Aviso,
  type EstadoParaSlack,
  type LlaveDecision,
  type MemoriaSlack,
  type Novedad,
  type Relevancia,
  type TablaRelevancia
} from "./slack.ts";
import type { HechosWarmup } from "./warmup-monitor.ts";

/** Horas desde la medianoche UTC del 2026-08-06. Acepta fracciones: el enfriamiento por clave se
 *  mide en minutos, y con una versión que redondeaba producía una fecha ilegible que `Date.parse`
 *  daba NaN — o sea un test verde porque el reloj no se podía leer. */
const T = (h: number): string => new Date(Date.parse("2026-08-06T00:00:00.000Z") + h * 3_600_000).toISOString();

const base = (over: Partial<EstadoParaSlack> = {}): EstadoParaSlack => ({
  emisor: "send",
  acciones: [],
  reparos: [],
  sinLectura: null,
  voz: "Juanes, todo tranquilo.",
  ahora: "el emisor está mandando",
  riesgo: "ninguno",
  ...over
});

const HOY = "2026-08-06";
const memBase = (over: Partial<MemoriaSlack> = {}): MemoriaSlack => ({
  ultimoEmisor: "send",
  ultimoAviso: T(9),
  ultimaFirma: null,
  ...over
});

const N = (clave: string, despues: string | number | null, antes: string | number | null = 0): Novedad => ({
  clave,
  objeto: clave.startsWith("placement:")
    ? clave.slice("placement:".length)
    : clave.includes(":")
      ? clave.slice(clave.indexOf(":") + 1).replace(/\.[a-zA-Z]+$/, "")
      : "",
  antes,
  despues
});

/** La tabla que deja salir un par de huella. Se arma a mano: lo que la llena es otro test. */
const abierta = (par: string): Relevancia => ({
  tabla: { [par]: { salieron: 5, respondio: 3, quejo: 0, peso: 1, muestra: 5, ultimaVez: null } }
});

// ══ A) LA LISTA CERRADA ═════════════════════════════════════════════════════════════════════════

test("REGLAS es una lista CERRADA y cada entrada está completa", () => {
  // Va como lista de reglas con id —y no como un párrafo en el prompt— porque un criterio en prosa
  // el modelo lo devuelve como hallazgo propio, y si es falso lo devuelve con seguridad. Este
  // proyecto ya lo pagó dos veces.
  assert.ok(REGLAS.length > 0);
  const ids = new Set<string>();
  for (const r of REGLAS) {
    assert.ok(r.id.length > 0, "toda regla tiene id");
    assert.ok(!ids.has(r.id), `id repetido: ${r.id}`);
    ids.add(r.id);
    assert.ok(["dano", "ceguera", "decision"].includes(r.clase), `${r.id}: clase fuera del enum`);
    assert.ok(r.decision.length > 0, `${r.id}: sin llave de decisión`);
    // UN PREDICADO QUE LLAME A UN MODELO NO COMPILA — la firma es sincrónica. Y por si alguien
    // devuelve una promesa igual, se verifica que no sea `async`.
    assert.equal(r.predicado.constructor.name, "Function", `${r.id}: el predicado no puede ser async`);
    assert.equal(r.predicado.length, 1, `${r.id}: el predicado recibe solo EstadoParaSlack`);
    assert.notEqual(r.texto.constructor.name, "AsyncFunction", `${r.id}: el texto no puede ser async`);
  }
  // UNA SOLA REGLA EXENTA DE TODO, y la puerta de atrás se cierra con la condición de abajo, no
  // contando entradas. `siempre` sin `firmaDelHecho` es la exención total: sin reloj y sin nada que
  // la limite, o sea el lugar donde alguien mete su caso favorito y el presupuesto deja de existir.
  // Esa sigue siendo una sola.
  //
  // `siempre` CON `firmaDelHecho` no es una exención: es un gate distinto y más estricto que el
  // reloj — habla cuando el hecho cambia y calla mientras sea el mismo, sin tope de 6 h que se trague
  // eventos DISTINTOS. Lo pide dec5: el agente frenaba un dominio a las 11:00 y otro a las 13:00 y no
  // avisaba ninguno de los dos, nunca, porque el enfriamiento es por id de regla. Un agente autónomo
  // cambiando la infraestructura en silencio es lo que esa regla existe para impedir.
  assert.deepEqual(REGLAS.filter((r) => r.siempre && !r.firmaDelHecho).map((r) => r.id), ["d1-cruce-umbral"]);
});

test("LA PRUEBA ANTI-CÍRCULO: cada regla nombra la decisión concreta que toma el jefe", () => {
  // "Una regla que no puede nombrar una llave no es una regla, es una huella con ínfulas." Es el
  // gate mecánico contra el círculo: si al leer el mensaje él no hace NADA distinto, no debía salir.
  //
  // Cada entrada de este mapa se lee como una frase: al leer <regla>, Juanes <hace esto>.
  const QUE_HACE_EL_JEFE: Record<string, { llave: LlaveDecision; hace: string }> = {
    "d1-cruce-umbral": { llave: "kill-switch", hace: "decide si mata el dominio que cruzó" },
    "d3-derrumbe-flota": { llave: "bajar-o-retirar-nodo", hace: "baja o retira el nodo que se cayó" },
    "d2-cerca-con-cap-alto": { llave: "bajar-cap-del-nodo", hace: "baja el cap del nodo" },
    "d4-reputacion": { llave: "bajar-o-retirar-nodo", hace: "retira el nodo con la IP quemada" },
    "c1-sin-lectura-2": { llave: "arreglar-el-nodo", hace: "levanta el modelo caído" },
    "c2-medicion-vencida": { llave: "arreglar-el-nodo", hace: "vuelve a correr la medición del cupo" },
    "c3-reputacion-no-se": { llave: "arreglar-el-nodo", hace: "arregla la llave de la API de listas negras" },
    "c4-veredicto-sin-atribuir": { llave: "arreglar-el-nodo", hace: "separa el correo nuestro del de terceros" },
    "dec1-emisor-pausado": { llave: "levantar-pausa-emisor", hace: "levanta la pausa del emisor" },
    "dec2-soltar-trabado": { llave: "autorizar-soltar", hace: "autoriza soltar el dominio" },
    "dec3-mano-fallo": { llave: "arreglar-el-nodo", hace: "destraba el nodo donde no pegó la mano" },
    "dec4-fabrica-sin-enviar": { llave: "arreglar-el-nodo", hace: "va a ver si el daemon del warmup sigue vivo" },
    "dec5-toque-de-infra": { llave: "revertir-la-mano", hace: "revierte lo que el agente tocó" }
  };
  for (const r of REGLAS) {
    const esperado = QUE_HACE_EL_JEFE[r.id];
    assert.ok(esperado, `la regla ${r.id} no nombra ninguna decisión del jefe: o le ponés una llave o es huella`);
    assert.equal(r.decision, esperado.llave, `${r.id}: ${esperado.hace}`);
  }
  assert.equal(Object.keys(QUE_HACE_EL_JEFE).length, REGLAS.length, "no sobra ni falta ninguna");
});

test("FAIL-CLOSED: ningún camino produce un Aviso sin clase o con una regla desconocida", () => {
  // Recorre las combinaciones de EstadoParaSlack que pueden disparar cualquier cosa. Un Aviso con
  // `regla` vacía sería un mensaje que no se puede auditar ni tapar, o sea el círculo otra vez.
  const piezas: Array<Partial<EstadoParaSlack>> = [
    {},
    { sinLectura: "el modelo devolvió texto vacío" },
    { reparos: ["dice que z.com cruzó y no figura"] },
    { emisor: "placement-pause" },
    { emisor: "cap-reached" },
    { emisor: "killed" },
    { emisor: null },
    { acciones: [{ accion: "frenar_dominio", objetivo: "a.com", ejecutada: true, detalle: "ok" }] },
    { acciones: [{ accion: "soltar_dominio", objetivo: "a.com", ejecutada: false, detalle: "no habilitado" }] },
    { acciones: [{ accion: "medir_dominio", objetivo: "a.com", ejecutada: true, detalle: "83%" }] },
    { acciones: [{ accion: "revisar_reputacion", objetivo: "a.com", ejecutada: true, detalle: "clean" }] },
    { novedades: [N("flota.cruzados", "x.com", "")] },
    { novedades: [N("flota.sanas", 8, 14)] },
    { novedades: [N("placement:x.com", "INBOX", "SPAM")] },
    { novedades: [N("plan:x.com.enPool", 1, 0)] },
    { hechos: HECHOS() },
    { hechos: HECHOS({ cap: { ...HECHOS().cap!, medidoEn: T(-30) } }) },
    { hechos: { ...HECHOS(), reputacion: [{ dominio: "x.com", listas: "no-se" }] } }
  ];
  const memorias: Array<MemoriaSlack | null> = [null, memBase(), memBase({ vueltasSinLecturaUtil: 4, vueltasEmisorFrenado: 4 })];
  let vistos = 0;
  for (const a of piezas)
    for (const b of piezas)
      for (const m of memorias) {
        for (const rel of [undefined, abierta("huella:placement"), { tabla: {} } as Relevancia]) {
          const av = decidirSiHablar(base({ ...a, ...b }), m, T(10), rel);
          if (!av) continue;
          vistos++;
          assert.ok(av.regla.length > 0, `Aviso sin regla: ${av.motivo}`);
          assert.ok(["dano", "ceguera", "decision", "huella"].includes(av.clase), `clase inválida: ${av.clase}`);
          assert.ok(esRegla(av.regla, av.clase), `regla desconocida: ${av.regla}`);
          if (av.clase === "huella") assert.equal(av.decision, null, "la huella no pide ninguna llave");
          else assert.ok(av.decision, `${av.regla}: una clase que interrumpe tiene que nombrar la llave`);
        }
      }
  assert.ok(vistos > 50, `el barrido tiene que producir avisos de verdad, produjo ${vistos}`);
});

// ══ LOS HECHOS DE PRUEBA ════════════════════════════════════════════════════════════════════════

const HECHOS = (over: Partial<HechosWarmup> = {}): HechosWarmup => ({
  generadoEn: T(10),
  semillas: { destinos: 5, midiendo: 1, puntoCiego: ["outlook"] },
  vueltas: [{ dominio: "annualfilings-control.com", semilla: "s@gmail.com", cuando: T(9), placement: "SPAM", completa: true, error: null }],
  cap: { nodosMedidos: 14, nodosSinMedir: 44, enElTope: [], frenados: ["a.com", "b.com"], sinLimite: 0, medidoEn: T(9) },
  flota: { sanas: 13, bloqueadas: 22, atascadas: 22, cruzados: [], cerca: [], medidoEn: T(9) },
  plan: [{ dominio: "corpfiling-infra.com", diaN: 3, placementTasa: 0.83, placementMuestra: 6, cupo: 4, accion: "sostener", motivo: "x", enviadosHoy: 2 }],
  ...over
});

// ══ EL INCIDENTE IRREVERSIBLE ═══════════════════════════════════════════════════════════════════

test("EL CRUCE DEL UMBRAL SALE: con el presupuesto agotado, enfriado, y con el modelo caído", () => {
  // Cruzar 5.000/día a personales de Gmail clasifica el dominio como "bulk sender" PARA SIEMPRE
  // (cita verificada en la doc oficial). Es lo único irreversible del negocio, y hasta hoy era
  // estructuralmente IMPOSIBLE que el canal avisara: `flota.cruzados` ni siquiera estaba en el
  // retrato observable. Las tres condiciones van en el MISMO caso a propósito: cada una por
  // separado ya dejó mudo al canal alguna vez.
  const mem = memBase({
    avancesHoy: 10, // presupuesto agotado
    diaAvances: HOY,
    novedadesRecientes: { "regla:d1-cruce-umbral": T(9.9) } // enfriado hace seis minutos
  });
  const modeloCaido = base({
    sinLectura: "el modelo devolvió texto vacío", // y encima ciego
    voz: null,
    novedades: [N("flota.cruzados", "bizreport-control.com,statefilings-control.com", "bizreport-control.com")]
  });
  const a = decidirSiHablar(modeloCaido, mem, T(10));
  assert.ok(a, "el cruce sale igual: es la única regla exenta de todo");
  assert.equal(a.clase, "dano");
  assert.equal(a.regla, "d1-cruce-umbral");
  assert.equal(a.decision, "kill-switch");
  assert.equal(a.porElModelo, false, "un aviso de daño nunca depende de que el modelo conteste");
  assert.match(a.texto, /statefilings-control\.com/);
  assert.ok(!a.texto.includes("bizreport-control.com"), "el que ya había cruzado no se vuelve a anunciar");
  assert.match(a.texto, /no se revierte/);
});

test("el cruce NO se pierde por una lectura fallida de la flota", () => {
  // Si `readInventoryJson` se cae una vuelta, `hechos.flota` viene null y la lista de cruzados
  // desaparece del retrato. Sin arrastre, un cruce que ocurre justo en esa vuelta se pierde PARA
  // SIEMPRE. Un aviso tarde le gana a ninguno cuando la cosa es irreversible.
  const limpio = HECHOS();
  const cruzo = HECHOS({ flota: { sanas: 13, bloqueadas: 22, atascadas: 22, cruzados: ["nuevo.com"], cerca: [], medidoEn: T(9) } });

  const s1 = camposObservables(limpio, {});
  assert.equal(s1["flota.cruzados"], "", "arranca vacío y NO ausente: el conjunto vacío es un dato");
  const s2 = camposObservables(HECHOS({ flota: null }), s1); // la vuelta que no se pudo leer
  assert.equal(s2["flota.cruzados"], "", "arrastrado, no borrado");
  const s3 = camposObservables(cruzo, s2);

  const a = decidirSiHablar(base({ novedades: novedades(s2, s3) }), memBase(), T(10));
  assert.match(a?.texto ?? "", /nuevo\.com/, "el cruce sale, tarde pero sale");
  assert.equal(a?.regla, "d1-cruce-umbral");
});

test("el retrato de producción NO tiene la clave: cómo nace d1 y desde cuándo avisa", () => {
  // EL RETRATO VIVO de la Studio (runtime/openclaw-workspace/inventory/warmup-monitor.json) tiene 27
  // claves y NINGUNA es `flota.cruzados`: la clave es nueva en este lote. Y `novedades()` saltea por
  // diseño toda clave que APARECE. O sea que la vuelta 1 después del despliegue es MUDA, y hay que
  // saber exactamente qué se pierde ahí y qué no.
  //
  // LO QUE SE PIERDE: los 10 dominios que YA cruzaron (medido en sender-measurement.json:
  // annualfiling-infra.com, bizreport-control.com, corpannualinfra.com, corpannualops.com,
  // corpdocfiling-ledger.com, corpledger-control.com, nationalfiling-control.com,
  // nationalfiling-infra.com, nationalfilinginfra.com, nationalfilingops.com). NO se anuncian, y es
  // deliberado: cruzaron semanas antes de que el canal mirara, el pool ya los excluye, y sacar un
  // "cruzaron el umbral, decime si los mato" sobre 10 hechos históricos es una falsedad sobre el
  // CUÁNDO — la misma clase de error que le hizo atribuir a Gmail nuestro propio cap de Postfix.
  //
  // LO QUE NO SE PIERDE, y es lo que este test fija: la clave queda PERSISTIDA en la vuelta 1, así
  // que desde la vuelta 2 cualquier cruce nuevo sale entero.
  const retratoDeProduccion: Record<string, string | number | null> = {
    "cap.frenados": 44,
    "flota.sanas": 13,
    "flota.bloqueadas": 22,
    "plan:corpfiling-infra.com.accion": "sostener",
    "placement:corpfiling-infra.com": "INBOX"
  };
  assert.equal("flota.cruzados" in retratoDeProduccion, false, "así está hoy el archivo de la Studio");

  const yaCruzados = HECHOS({
    flota: { sanas: 13, bloqueadas: 22, atascadas: 22, cruzados: ["bizreport-control.com"], cerca: [], medidoEn: T(9) }
  });
  const vuelta1 = camposObservables(yaCruzados, retratoDeProduccion);
  assert.equal(vuelta1["flota.cruzados"], "bizreport-control.com", "la clave NACE con la verdad de hoy");
  assert.deepEqual(
    novedades(retratoDeProduccion, vuelta1).filter((n) => n.clave === "flota.cruzados"),
    [],
    "y no se anuncia un cruce viejo como si fuera de ahora"
  );

  // VUELTA 2: cruza uno NUEVO. Acá sí, y sin arrastrar a los históricos.
  const cruzaOtro = HECHOS({
    flota: {
      sanas: 13, bloqueadas: 22, atascadas: 22,
      cruzados: ["bizreport-control.com", "infranationalreport.com"], cerca: [], medidoEn: T(9)
    }
  });
  const vuelta2 = camposObservables(cruzaOtro, vuelta1);
  const a = decidirSiHablar(base({ novedades: novedades(vuelta1, vuelta2) }), memBase(), T(10));
  assert.equal(a?.regla, "d1-cruce-umbral");
  assert.match(a?.texto ?? "", /infranationalreport\.com/);
  assert.doesNotMatch(a?.texto ?? "", /bizreport-control\.com/, "sólo el que cruzó AHORA, no el histórico");
});

test("los cruzados entran como LISTA, no como contador", () => {
  // Con un contador, un dominio que cruza y otro que se saca del inventario se cancelan y el aviso
  // no sale nunca. Cruzar es POR DOMINIO y es irreversible.
  const antes = camposObservables(HECHOS({ flota: { sanas: 1, bloqueadas: 0, atascadas: 0, cruzados: ["b.com"], cerca: [] } }), {});
  const ahora = camposObservables(HECHOS({ flota: { sanas: 1, bloqueadas: 0, atascadas: 0, cruzados: ["a.com"], cerca: [] } }), antes);
  const a = decidirSiHablar(base({ novedades: novedades(antes, ahora) }), memBase(), T(10));
  assert.match(a?.texto ?? "", /a\.com/, "un cambio de composición con el mismo total igual habla");
});

test("el orden de la query no dispara un cruce falso", () => {
  const uno = camposObservables(HECHOS({ flota: { sanas: 1, bloqueadas: 0, atascadas: 0, cruzados: ["b.com", "a.com"], cerca: [] } }), {});
  const otro = camposObservables(HECHOS({ flota: { sanas: 1, bloqueadas: 0, atascadas: 0, cruzados: ["a.com", "b.com"], cerca: [] } }), uno);
  assert.deepEqual(novedades(uno, otro), []);
});

// ══ NO MEDIDO ≠ LIMPIO ══════════════════════════════════════════════════════════════════════════

test("con los campos del lote 3 AUSENTES, d2/d4/c3/c4 no afirman NADA", () => {
  // "Una mano prometida y no cableada es peor que no darla": pasó tres veces en este repo. Estas
  // cuatro reglas nacen con su input ausente, y mientras lo esté el resultado tiene que ser SILENCIO
  // y jamás un "está limpio". Es la lección del 2026-07-25: 38 nodos cerrados en Gmail con CERO
  // detecciones de blacklist, y alguien leyó ese cero como "está limpio".
  for (const hechos of [undefined, null, HECHOS()]) {
    const a = decidirSiHablar(base({ hechos }), memBase(), T(10));
    if (a) {
      assert.ok(!["d2-cerca-con-cap-alto", "d4-reputacion", "c3-reputacion-no-se", "c4-veredicto-sin-atribuir"].includes(a.regla));
      assert.ok(!/limpio|sin listas|todo bien/i.test(a.texto));
    }
  }
});

test("`listas: no-se` produce CEGUERA, nunca 'limpio'", () => {
  // El 2026-08-07T09:23Z `revisar_reputacion` corrió sobre annualfiling-infra.com (89.117.75.226) y
  // devolvió textual "no pude consultar las listas negras… No sé si está listado". Ese resultado no
  // llegó a Slack ni quedó en ningún archivo del inventario. Un instrumento cuyo resultado no se
  // guarda no vigila nada, y un "no sé" que se calla se lee como "está bien".
  const a = decidirSiHablar(
    base({ hechos: { ...HECHOS(), reputacion: [{ dominio: "annualfiling-infra.com", ip: "89.117.75.226", listas: "no-se" }] } }),
    memBase(),
    T(10)
  );
  assert.ok(a);
  assert.equal(a.clase, "ceguera");
  assert.equal(a.regla, "c3-reputacion-no-se");
  assert.match(a.texto, /No sé si/);
  assert.match(a.texto, /no medido no es lo mismo que limpio/);
});

test("el 'no sé' POR PRESUPUESTO no interrumpe: esa ceguera la elegimos nosotros", () => {
  // MEDIDO: `PRESUPUESTO_LISTAS_POR_BARRIDO = 25` sobre 58 dominios ⇒ 33 filas nacen en "no-se"
  // TODOS LOS DÍAS, por diseño y no por falla. Con el predicado viejo (`listas === "no-se"`) c3 era
  // permanentemente verdadera: ~4 mensajes diarios, para siempre, "No pude consultar las listas
  // negras de X y de 32 más", que no cambia ninguna decisión del jefe. El archivo sigue sin mentir
  // —ninguno de los dos estados es "limpio"—, pero sólo la ceguera de verdad interrumpe.
  const soloPresupuesto = decidirSiHablar(
    base({
      hechos: {
        ...HECHOS(),
        reputacion: [
          { dominio: "a.com", ip: "1.1.1.1", listas: "no-se", porPresupuesto: true },
          { dominio: "b.com", ip: "1.1.1.2", listas: "no-se", porPresupuesto: true }
        ]
      }
    }),
    memBase(),
    T(10)
  );
  assert.notEqual(soloPresupuesto?.regla, "c3-reputacion-no-se");

  // Y la mezcla: 32 por presupuesto y UNA que de verdad falló ⇒ habla, y habla de esa.
  const mezcla = decidirSiHablar(
    base({
      hechos: {
        ...HECHOS(),
        reputacion: [
          { dominio: "a.com", ip: "1.1.1.1", listas: "no-se", porPresupuesto: true },
          { dominio: "annualfiling-infra.com", ip: "89.117.75.226", listas: "no-se" }
        ]
      }
    }),
    memBase(),
    T(10)
  );
  assert.equal(mezcla?.regla, "c3-reputacion-no-se");
  assert.match(mezcla?.texto ?? "", /annualfiling-infra\.com/);
  assert.doesNotMatch(mezcla?.texto ?? "", /y de 1 más/, "las que no consultamos no engordan el número de la ceguera");
});

test("LA FÁBRICA PARADA MIENTRAS EL EMISOR DICE QUE MANDA", () => {
  // MEDIDO EN LA BASE DE PRODUCCIÓN: entre 2026-08-06T17:53Z y 2026-08-07T00:01Z hubo CERO envíos y
  // CERO mediciones en `warmup_activity` — 6 h 08 m — y en ese hueco el monitor corrió 34 vueltas
  // diciendo textual "La flota calienta activamente con 13 dominios entregando". Es literalmente la
  // queja del jefe ("no estoy viendo avances") y ninguna regla la veía: c2 mira la edad de la
  // medición del CAP y de la FLOTA, que son procesos externos y siguen frescos con la fábrica muerta.
  const parada = base({
    hechos: HECHOS({ vueltas: [{ dominio: "a.com", semilla: "s@gmail.com", cuando: T(3), placement: "INBOX", completa: true, error: null }] })
  });
  const a = decidirSiHablar(parada, memBase(), T(10));
  assert.equal(a?.regla, "dec4-fabrica-sin-enviar");
  assert.equal(a?.pideRespuesta, true);
  assert.match(a?.texto ?? "", /7 horas/, "el número sale del dato, no de una frase");

  // NO DISPARA con el emisor pausado: ahí que no salga correo es la consecuencia esperada y de eso
  // habla dec1. El hallazgo es la CONTRADICCIÓN entre lo que dice y lo que hace.
  assert.notEqual(decidirSiHablar({ ...parada, emisor: "placement-pause" }, memBase(), T(10))?.regla, "dec4-fabrica-sin-enviar");

  // NI CON `vueltas` VACÍO: eso es "no pude leer la base", que es c1 y no una fábrica parada.
  // Ausencia de dato NO es evidencia.
  assert.notEqual(decidirSiHablar(base({ hechos: HECHOS({ vueltas: [] }) }), memBase(), T(10))?.regla, "dec4-fabrica-sin-enviar");

  // Y con una vuelta reciente, silencio.
  const viva = base({
    hechos: HECHOS({ vueltas: [{ dominio: "a.com", semilla: "s@gmail.com", cuando: T(9), placement: "INBOX", completa: true, error: null }] })
  });
  assert.notEqual(decidirSiHablar(viva, memBase(), T(10))?.regla, "dec4-fabrica-sin-enviar");
});

test("LAS DOS SEÑALES DEL 2026-07-25: el mensaje las dice las dos, o no sale", () => {
  // Ese día 38 nodos estaban cerrados en Gmail con TODAS las IPs limpias en listas negras: la
  // reputación interna de Google es invisible al chequeo de blacklists. Decir solo "está limpio"
  // sobre un nodo que el receptor rechaza es peor que no decir nada.
  const a = decidirSiHablar(
    base({ hechos: { ...HECHOS(), reputacion: [{ dominio: "x.com", listas: [], receptor: "cerrado" }] } }),
    memBase(),
    T(10)
  );
  assert.ok(a);
  assert.equal(a.clase, "dano");
  assert.match(a.texto, /0 listas negras/, "señal 1");
  assert.match(a.texto, /receptor cerrado/, "señal 2");
  assert.match(a.texto, /limpio no quiere decir sano/);

  // Blacklist limpia y receptor ABIERTO: no hay nada que decir.
  assert.equal(
    decidirSiHablar(base({ hechos: { ...HECHOS(), reputacion: [{ dominio: "x.com", listas: [], receptor: "abierto" }] } }), memBase(), T(10)),
    null
  );
});

test("una IP listada en una lista negra es DAÑO, con la lista nombrada", () => {
  const a = decidirSiHablar(
    base({ hechos: { ...HECHOS(), reputacion: [{ dominio: "x.com", ip: "1.2.3.4", listas: ["spamhaus-sbl"] }] } }),
    memBase(),
    T(10)
  );
  assert.equal(a?.clase, "dano");
  assert.match(a?.texto ?? "", /1\.2\.3\.4/);
  assert.match(a?.texto ?? "", /spamhaus-sbl/);
  assert.equal(a?.decision, "bajar-o-retirar-nodo");
});

test("el cap por encima del techo es DAÑO, nombra la llave y TRAE LOS DOS NÚMEROS", () => {
  const estado = base({
    hechos: { ...HECHOS(), cap: { ...HECHOS().cap!, porEncimaDelTecho: [{ dominio: "infranationalreport.com", cap: 15_000 }] } }
  });
  const a = decidirSiHablar(estado, memBase(), T(10));
  assert.equal(a?.regla, "d2-cerca-con-cap-alto");
  assert.equal(a?.decision, "bajar-cap-del-nodo");
  assert.match(a?.texto ?? "", /infranationalreport\.com/);
  // LOS DOS NÚMEROS ADENTRO DE LA FRASE. Sin ellos el mensaje decía "por encima del techo que
  // aguanta el dominio" y la respuesta textual del jefe, el 2026-08-06T21:15, fue "No entiendo, es
  // decir ?". Un aviso de daño que no se puede accionar es ruido con corbata.
  assert.match(a?.texto ?? "", /15\.000/, "el cap cableado en el nodo");
  assert.match(a?.texto ?? "", /2\.000/, "y el techo que aguanta el dominio");
});

test("d2 es un ESTADO: se dice una vez y vuelve sólo si cambia el conjunto", () => {
  // MEDIDO CON UN REPLAY DE 24 h sobre los hechos de producción: el predicado daba verdadero en 135
  // de 135 vueltas y salían 4 mensajes por día sobre el MISMO dominio, todos los días, hasta que
  // alguien corriera `limite-fisico`. El enfriamiento por reloj es un temporizador de repetición,
  // no un freno: para un estado permanente hay que mirar el HECHO.
  const conUno = base({
    hechos: { ...HECHOS(), cap: { ...HECHOS().cap!, porEncimaDelTecho: [{ dominio: "infranationalreport.com", cap: 15_000 }] } }
  });
  const primero = decidirSiHablar(conUno, memBase(), T(10));
  assert.equal(primero?.regla, "d2-cerca-con-cap-alto");
  const mem = recordarAviso(conUno, true, T(10), memBase(), primero);

  // Seis horas después (el enfriamiento por reloj ya venció) y el hecho es el mismo: silencio.
  assert.notEqual(
    decidirSiHablar(conUno, mem, T(17))?.regla,
    "d2-cerca-con-cap-alto",
    "el mismo cap, siete horas después, NO se repite (aunque otra regla sí pueda hablar)"
  );
  assert.deepEqual(
    loQueSeCallo(conUno, mem, T(17)).filter((t) => t.motivo === "sin-cambio").map((t) => t.clave),
    ["d2-cerca-con-cap-alto"],
    "y se declara por qué se calló: un tapado que no se cuenta es un mensaje perdido"
  );

  // Entra OTRO dominio a la lista: eso sí es nuevo y vuelve a hablar, entero.
  const conDos = base({
    hechos: {
      ...HECHOS(),
      cap: {
        ...HECHOS().cap!,
        porEncimaDelTecho: [
          { dominio: "infranationalreport.com", cap: 15_000 },
          { dominio: "otro.com", cap: 9_000 }
        ]
      }
    }
  });
  const segundo = decidirSiHablar(conDos, mem, T(17));
  assert.equal(segundo?.regla, "d2-cerca-con-cap-alto");
  assert.match(segundo?.texto ?? "", /otro\.com/);
});

test("la atribución entra como DATO, jamás como gate", () => {
  // La auditoría proponía marcar como no-accionables los dominios con `atribucion.modo === "todo"`
  // en las manos que REDUCEN. Verificado: las 58 bandejas están en modo "todo", así que ese guard
  // deja al agente SIN MANOS hoy mismo. Acá es una regla de ceguera y nada más: el agente sigue
  // pudiendo frenar.
  const conPuntoCiego = base({
    hechos: { ...HECHOS(), flota: { ...HECHOS().flota!, atribuido: false } },
    acciones: [{ accion: "frenar_dominio", objetivo: "x.com", ejecutada: true, detalle: "cap 255 a 0" }]
  });
  const a = decidirSiHablar(conPuntoCiego, memBase(), T(10));
  assert.equal(a?.regla, "c4-veredicto-sin-atribuir", "la ceguera gana a la decisión: primero se dice que no ve");
  assert.match(a?.texto ?? "", /correo que pasa por el nodo/);
  // CON EL NÚMERO ADENTRO. El texto anterior no nombraba una bandeja ni una cifra y salía idéntico
  // 4 veces por día, para siempre: era el mensaje más fácil de aprender a ignorar del canal.
  assert.match(a?.texto ?? "", /\d+ bandejas/);

  // Y UNA SOLA VEZ. Es un estado, no un evento: las 58 bandejas siguen en `atribucion.modo: "todo"`
  // hasta que exista un proyecto que separe nuestro correo del de terceros.
  const mem = recordarAviso(conPuntoCiego, true, T(10), memBase(), a);
  assert.notEqual(
    decidirSiHablar(conPuntoCiego, mem, T(17))?.regla,
    "c4-veredicto-sin-atribuir",
    "siete horas después no lo vuelve a decir: es un estado, no un evento"
  );
  // Y la mano se ejecutó igual: esto no frenó nada.
  assert.equal(conPuntoCiego.acciones[0]?.ejecutada, true);
});

// ══ EL CANDADO ANTI-FALSEDAD ════════════════════════════════════════════════════════════════════

test("una mano fallida con la medición VENCIDA dice 'no sé', jamás 'no pegó'", () => {
  // Es lo que produjo los 4 pedidos FALSOS de arreglar un freno que ya estaba puesto: el agente
  // afirmaba "bizreport-control.com sigue con cupo 255: el freno no quedó puesto" apoyado en un
  // `cap` de la medición anterior. "No medido" y "no pegó" no son lo mismo, exactamente igual que
  // "no medido" y "cero".
  const acciones = [{ accion: "frenar_dominio", objetivo: "bizreport-control.com", ejecutada: false, detalle: "sigue con cupo 255: el freno no quedó puesto" }];

  // La ceguera gana a la decisión, así que la vuelta en que la medición vence lo primero que sale es
  // "la medición ya no vale". El caso peligroso es el DE DESPUÉS: c2 ya habló y está enfriada seis
  // horas, y en esa ventana dec3 no puede aprovechar el silencio para afirmar el fallo.
  const c2YaHablo = memBase({ novedadesRecientes: { "regla:c2-medicion-vencida": T(9.5) } });
  const vencida = decidirSiHablar(base({ acciones, hechos: HECHOS({ cap: { ...HECHOS().cap!, medidoEn: T(-30) } }) }), c2YaHablo, T(10));
  assert.ok(vencida);
  assert.equal(vencida.regla, "dec3-mano-fallo");
  assert.match(vencida.texto, /no sé si quedó puesto/);
  assert.ok(!/no pegó|no quedó puesto|no se aplicó/.test(vencida.texto), "no puede AFIRMAR el fallo sobre un snapshot vencido");

  // Con la medición fresca sí puede decirlo: el dato es de hoy.
  const fresca = decidirSiHablar(base({ acciones, hechos: HECHOS() }), memBase(), T(10));
  assert.match(fresca?.texto ?? "", /no quedó puesto/);
});

test("la medición vencida se avisa por sí sola, como ceguera", () => {
  // La medición del cupo vence a las 12 h y la Mac se duerme: es el modo de falla normal, no el
  // raro. Un dato de ayer leído como de hoy es cómo se fabrica un pedido falso.
  const a = decidirSiHablar(base({ hechos: HECHOS({ cap: { ...HECHOS().cap!, medidoEn: T(-20) } }) }), memBase(), T(10));
  assert.equal(a?.regla, "c2-medicion-vencida");
  assert.equal(a?.clase, "ceguera");
  assert.match(a?.texto ?? "", /30 horas/);
  assert.match(a?.texto ?? "", /de memoria, no de hoy/);
});

// ══ B) LA HUELLA SE CALLA ═══════════════════════════════════════════════════════════════════════

test("MIRAR NO ES ACTUAR: las manos pasivas no producen un solo mensaje", () => {
  // Textual del jefe: "esta bien que me notifique cada huella que va haciendo, pero tambien lo
  // siento innecesario porque es lo que el agente en delivrix app esta haciendo en su columna
  // propia". Tres de los 11 mensajes del log real eran "Hice esto: revisar_reputacion X".
  for (const accion of ["medir_dominio", "diagnosticar_dominio", "leer_cupo_nodo", "revisar_reputacion", "anotar_pendiente", "resolver_pendiente"]) {
    const soloMiro = base({ acciones: [{ accion, objetivo: "a.com", ejecutada: true, detalle: "83% sobre 6" }] });
    assert.equal(decidirSiHablar(soloMiro, memBase(), T(10)), null, `${accion} no puede hablar`);
  }
});

test("TOCAN es lista BLANCA: una mano nueva calla por defecto", () => {
  // Era una lista NEGRA (`CONTABLES`) y por eso `revisar_reputacion` —la última mano que se agregó—
  // reabrió la fuga que ya habíamos tapado para las otras pasivas. Con lista blanca, el que agrega
  // una mano tiene que decidir explícitamente que se anuncia.
  assert.deepEqual([...TOCAN].sort(), ["frenar_dominio", "pausar_warmup", "soltar_dominio"]);
  const manoNueva = base({ acciones: [{ accion: "auditar_dns", objetivo: "a.com", ejecutada: true, detalle: "ok" }] });
  assert.equal(decidirSiHablar(manoNueva, memBase(), T(10)), null);
});

test("toda novedad nace con clase HUELLA y no sale sola", () => {
  // Recorre las siete claves del retrato. Ninguna puede producir un Aviso por sí sola: el panel ya
  // pinta esas 62 filas de `warmup_activity` en 24 h.
  const claves = [
    "placement:x.com",
    "plan:x.com.accion",
    "plan:x.com.diaN",
    "plan:x.com.enPool",
    "cap.frenados",
    "flota.sanas",
    "flota.bloqueadas"
  ];
  for (const clave of claves) {
    const a = decidirSiHablar(base({ novedades: [N(clave, clave === "placement:x.com" ? "INBOX" : 4, clave === "placement:x.com" ? "SPAM" : 3)] }), memBase(), T(10));
    assert.equal(a, null, `${clave} no puede hablar sin pasar por la tabla de relevancia`);
  }
});

test("y cuando el aprendizaje la promueve, sale — pero por el modelo", () => {
  const a = decidirSiHablar(base({ novedades: [N("placement:x.com", "INBOX", "SPAM")] }), memBase(), T(10), abierta("huella:placement"));
  assert.ok(a);
  assert.equal(a.clase, "huella");
  assert.equal(a.regla, "huella:placement");
  assert.equal(a.decision, null);
  assert.equal(a.porElModelo, true, "un avance lo redacta el modelo, y si está caído no sale");
  assert.equal(a.pideRespuesta, false, "un avance no interrumpe a nadie");
});

test("ninguna huella se pierde en silencio: queda contada con su motivo", () => {
  // Un canal donde no se puede saber cuánto se calló no se puede calibrar.
  const estado = base({ novedades: [N("placement:x.com", "INBOX", "SPAM"), N("plan:x.com.diaN", 4, 3)] });
  const t = loQueSeCallo(estado, memBase(), T(10));
  assert.ok(t.some((x) => x.motivo === "clase-huella" && x.clave === "huella:placement"));
  assert.ok(t.some((x) => x.texto?.includes("entró en bandeja")), "y con lo que habría dicho");
});

test("una regla que gana deja la huella contada, no perdida", () => {
  const estado = base({
    novedades: [N("placement:x.com", "INBOX", "SPAM")],
    acciones: [{ accion: "frenar_dominio", objetivo: "z.com", ejecutada: true, detalle: "ok" }]
  });
  assert.equal(decidirSiHablar(estado, memBase(), T(10), abierta("huella:placement"))?.regla, "dec5-toque-de-infra");
  assert.ok(loQueSeCallo(estado, memBase(), T(10), abierta("huella:placement")).some((x) => x.motivo === "regla-gana"));
});

// ══ C) LOS BUGS DE VERDAD ═══════════════════════════════════════════════════════════════════════

test("EL BUG DEL ACENTO: un dominio que RECUPERA cupo dice que volvió a calentar", () => {
  // El retrato escribía "si" y la plantilla comparaba contra "sí" —con acento—, así que nunca
  // coincidían: un dominio que recupera cupo (rango 0 en PRIORIDAD, o sea el mensaje que GANA la
  // vuelta) se anunciaba textualmente como "X dejó de calentar". Justo al revés, y en la noticia más
  // visible del canal.
  const frenado = HECHOS({ plan: [{ dominio: "corpfiling-infra.com", diaN: 3, placementTasa: null, placementMuestra: 0, cupo: 0, accion: "frenar", motivo: "x", enviadosHoy: 0 }] });
  const suelto = HECHOS({ plan: [{ dominio: "corpfiling-infra.com", diaN: 3, placementTasa: null, placementMuestra: 0, cupo: 20, accion: "sostener", motivo: "x", enviadosHoy: 0 }] });
  const antes = camposObservables(frenado, {});
  const novs = novedades(antes, camposObservables(suelto, antes)).filter((n) => n.clave.endsWith(".enPool"));
  assert.equal(novs.length, 1);

  const a = decidirSiHablar(base({ novedades: novs }), memBase(), T(10), abierta("huella:plan.enPool"));
  assert.match(a?.texto ?? "", /volvió a calentar/);
  assert.ok(!/dejó de calentar/.test(a?.texto ?? ""), "el bug era exactamente este texto");
});

test("contrato: toda clave que escribe camposObservables cae en la rama correcta de la plantilla", () => {
  // El bug del acento no fue un typo suelto: fue que el productor y el consumidor del valor no
  // estaban atados por nada. Este test recorre lo que el retrato escribe DE VERDAD y verifica el
  // texto, así que la próxima vez que alguien cambie un valor se entera acá y no en Slack.
  const conCupo = HECHOS({ plan: [{ dominio: "d.com", diaN: 5, placementTasa: null, placementMuestra: 0, cupo: 7, accion: "subir", motivo: "x", enviadosHoy: 0 }] });
  const sinCupo = HECHOS({ plan: [{ dominio: "d.com", diaN: 4, placementTasa: null, placementMuestra: 0, cupo: 0, accion: "frenar", motivo: "x", enviadosHoy: 0 }] });
  const antes = camposObservables(sinCupo, {});
  const ahora = camposObservables(conCupo, antes);
  const esperado: Record<string, RegExp> = {
    "plan:d.com.enPool": /volvió a calentar/,
    "plan:d.com.accion": /le subo el volumen/,
    "plan:d.com.diaN": /cumplió el día 5/
  };
  for (const n of novedades(antes, ahora)) {
    const re = esperado[n.clave];
    assert.ok(re, `clave sin contrato: ${n.clave}`);
    const a = decidirSiHablar(base({ novedades: [n] }), memBase(), T(10), abierta(`huella:${n.clave.includes(".") ? n.clave.split(":")[1]?.split(".").slice(-1)[0] : ""}`) as Relevancia);
    // El par se arma con el campo, no con el dominio: se resuelve con la tabla completa.
    const par = n.clave.endsWith(".enPool") ? "huella:plan.enPool" : n.clave.endsWith(".accion") ? "huella:plan.accion" : "huella:plan.diaN";
    const b = decidirSiHablar(base({ novedades: [n] }), memBase(), T(10), abierta(par));
    assert.match(b?.texto ?? a?.texto ?? "", re, `${n.clave} cayó en la rama equivocada`);
  }
});

test("un plan.diaN no finito NO se anuncia", () => {
  // `diaN` es `number | null`. Sin el guard salía "X cumplió el día sin medir de calentamiento",
  // que no significa nada — y encima se comía el cupo de la vuelta.
  const a = decidirSiHablar(base({ novedades: [N("plan:x.com.diaN", null, 3)] }), memBase(), T(10), abierta("huella:plan.diaN"));
  assert.equal(a, null);
  assert.ok(loQueSeCallo(base({ novedades: [N("plan:x.com.diaN", null, 3)] }), memBase(), T(10)).some((t) => t.motivo === "sin-plantilla"));
});

test("un campo huérfano NO se cae al fallback con flecha: se loguea y calla", () => {
  // El fallback era `${etiqueta} de ${objeto}: ${antes} → ${despues}.` — o sea, el texto de máquina
  // que hay que matar, y encima sobre un campo que nadie pensó todavía. Era la puerta por la que
  // volvía el "bot del 2000" cada vez que alguien agregaba una clave al retrato.
  const huerfano = base({ novedades: [N("semillas.midiendo", 4, 1)] });
  assert.equal(decidirSiHablar(huerfano, memBase(), T(10), abierta("huella:semillas.midiendo")), null);
  assert.deepEqual(
    loQueSeCallo(huerfano, memBase(), T(10)).filter((t) => t.motivo === "sin-plantilla").map((t) => t.clave),
    ["semillas.midiendo"]
  );
});

test("el enum del emisor sale TRADUCIDO, no crudo entre paréntesis", () => {
  // Salía "El emisor se frenó (cap-reached)." — un identificador de código dentro de un mensaje
  // para una persona.
  const a = decidirSiHablar(base({ emisor: "cap-reached" }), memBase({ vueltasEmisorFrenado: 3 }), T(10));
  assert.ok(a);
  assert.match(a.texto, /llegó al tope de vueltas del día/);
  assert.ok(!a.texto.includes("cap-reached"));
  assert.ok(!a.texto.includes("placement-pause"));
});

// ══ LA VOZ ══════════════════════════════════════════════════════════════════════════════════════

/** Todos los textos que puede producir `decidirSiHablar`, con los escenarios que los disparan. */
function todosLosTextos(): string[] {
  const out: string[] = [];
  const push = (a: Aviso | null) => {
    if (a) out.push(a.texto);
  };
  push(decidirSiHablar(base({ novedades: [N("flota.cruzados", "x.com", "")] }), memBase(), T(10)));
  push(decidirSiHablar(base({ novedades: [N("flota.sanas", 8, 14)] }), memBase(), T(10)));
  push(decidirSiHablar(base({ novedades: [N("flota.bloqueadas", 30, 22)] }), memBase(), T(10)));
  push(
    decidirSiHablar(
      base({ hechos: { ...HECHOS(), cap: { ...HECHOS().cap!, porEncimaDelTecho: [{ dominio: "a.com", cap: 15_000 }, { dominio: "b.com", cap: 9_000 }] } } }),
      memBase(),
      T(10)
    )
  );
  push(decidirSiHablar(base({ hechos: { ...HECHOS(), reputacion: [{ dominio: "a.com", ip: "1.2.3.4", listas: ["sbl"] }] } }), memBase(), T(10)));
  push(decidirSiHablar(base({ hechos: { ...HECHOS(), reputacion: [{ dominio: "a.com", listas: [], receptor: "cerrado" }] } }), memBase(), T(10)));
  push(decidirSiHablar(base({ hechos: { ...HECHOS(), reputacion: [{ dominio: "a.com", listas: "no-se" }] } }), memBase(), T(10)));
  push(decidirSiHablar(base({ hechos: { ...HECHOS(), flota: { ...HECHOS().flota!, atribuido: false } } }), memBase(), T(10)));
  push(decidirSiHablar(base({ sinLectura: "el modelo devolvió texto vacío" }), memBase({ vueltasSinLecturaUtil: 3 }), T(10)));
  push(decidirSiHablar(base({ reparos: ["el 33% no sale de ningún dato"] }), memBase({ vueltasSinLecturaUtil: 3 }), T(10)));
  push(decidirSiHablar(base({ hechos: HECHOS({ cap: { ...HECHOS().cap!, medidoEn: T(-20) } }) }), memBase(), T(10)));
  push(decidirSiHablar(base({ hechos: HECHOS({ flota: { ...HECHOS().flota!, medidoEn: T(-20) }, cap: null }) }), memBase(), T(10)));
  for (const emisor of ["placement-pause", "cap-reached", "killed", "inert", "raro-nuevo"])
    push(decidirSiHablar(base({ emisor }), memBase({ vueltasEmisorFrenado: 3 }), T(10)));
  push(decidirSiHablar(base({ acciones: [{ accion: "soltar_dominio", objetivo: "z.com", ejecutada: false, detalle: "rechazada: soltar no está habilitado en este entorno" }] }), memBase(), T(10)));
  push(decidirSiHablar(base({ acciones: [{ accion: "frenar_dominio", objetivo: "z.com", ejecutada: false, detalle: "rechazada: sigue con cupo 255: el freno no quedó puesto" }], hechos: HECHOS() }), memBase(), T(10)));
  push(decidirSiHablar(base({ acciones: [{ accion: "frenar_dominio", objetivo: "z.com", ejecutada: false, detalle: 'rechazada: "revisar_reputacion" no está habilitado' }] }), memBase(), T(10)));
  push(decidirSiHablar(base({ acciones: [{ accion: "pausar_warmup", ejecutada: false, detalle: "rechazada: pausar_warmup no está habilitado" }] }), memBase(), T(10)));
  for (const accion of ["frenar_dominio", "soltar_dominio", "pausar_warmup"])
    push(decidirSiHablar(base({ acciones: [{ accion, objetivo: "z.com", ejecutada: true, detalle: "ok" }] }), memBase(), T(10)));
  push(decidirSiHablar(base({ acciones: [{ accion: "frenar_dominio", objetivo: "a.com", ejecutada: true, detalle: "ok" }, { accion: "soltar_dominio", objetivo: "b.com", ejecutada: true, detalle: "ok" }] }), memBase(), T(10)));
  for (const [clave, antes, despues] of [
    ["placement:x.com", "SPAM", "INBOX"],
    ["placement:x.com", "INBOX", "SPAM"],
    ["placement:x.com", null, "INBOX"],
    ["placement:x.com", "INBOX", "MISSING"],
    ["placement:x.com", "INBOX", "OTHER"],
    ["plan:x.com.accion", "sostener", "subir"],
    ["plan:x.com.accion", "sostener", "bajar"],
    ["plan:x.com.accion", "sostener", "frenar"],
    ["plan:x.com.accion", "frenar", "arrancar"],
    ["plan:x.com.diaN", 3, 4],
    ["plan:x.com.enPool", 0, 1],
    ["plan:x.com.enPool", 1, 0],
    ["cap.frenados", 44, 45],
    ["cap.frenados", 45, 44],
    ["flota.sanas", 13, 14],
    ["flota.bloqueadas", 22, 23]
  ] as Array<[string, string | number | null, string | number]>) {
    const campo = clave.startsWith("placement:") ? "placement" : `${clave.split(":")[0]}.${clave.split(".").slice(-1)[0]}`;
    push(decidirSiHablar(base({ novedades: [N(clave, despues, antes)] }), memBase(), T(10), abierta(`huella:${campo}`)));
  }
  return out;
}

test("HIGIENE DE LA VOZ: ni un guión bajo, ni una flecha, ni un asterisco, ni un identificador", () => {
  // Textual: "esa manera o lexico de escribir esta muy bot del 2000… recuerdo que openclaw me
  // respondia con asteriscos, muy horrible genericamente, y luego arreglamos eso". El vicio concreto
  // salía así en producción: "Voy a medir y diagnosticar los cercanos y los frenados para ver qué
  // puedo soltar. Hice esto: revisar_reputacion controlnationalcorp.com." — una frase de persona con
  // un identificador de código pegado atrás.
  const textos = todosLosTextos();
  assert.ok(textos.length >= 30, `el barrido tiene que cubrir todas las plantillas, cubrió ${textos.length}`);
  for (const t of textos) {
    assert.ok(!t.includes("_"), `guión bajo: ${t}`);
    assert.ok(!t.includes("→"), `flecha de diff: ${t}`);
    assert.ok(!t.includes("*"), `asterisco de énfasis: ${t}`);
    assert.ok(!/:\s*[a-z][a-z0-9]*_[a-z0-9_]+/.test(t), `dos puntos y un identificador: ${t}`);
    assert.ok(!/\bHice esto:/.test(t), `el texto de máquina grapado al final: ${t}`);
    assert.ok(!/\brechazada:/i.test(t), `el prefijo de log del ejecutor: ${t}`);
  }
});

test("CONTRA-CONDICIÓN: ningún mensaje sale sin nombrar un hecho con su número o su nombre propio", () => {
  // La otra mitad de la higiene, y la que evita el péndulo: una plantilla más "humana" que pierde el
  // dato exacto obliga al jefe a preguntar de nuevo. Le pasó el 2026-08-06T21:15 — "No entiendo, es
  // decir ?" — después de la regresión de "Sigo acá. Ya los estoy evaluando…".
  for (const t of todosLosTextos()) {
    assert.ok(/\d/.test(t) || /[a-z0-9-]+\.(com|net|org)/i.test(t), `sin un dato que agarrar: ${t}`);
  }
});

test("la acción va DENTRO de la oración, con su verbo", () => {
  const a = decidirSiHablar(base({ acciones: [{ accion: "frenar_dominio", objetivo: "z.com", ejecutada: true, detalle: "ok" }] }), memBase(), T(10));
  assert.match(a?.texto ?? "", /le puse el cupo en 0 a z\.com/);
  assert.equal(a?.decision, "revertir-la-mano");
  const s = decidirSiHablar(base({ acciones: [{ accion: "soltar_dominio", objetivo: "z.com", ejecutada: true, detalle: "ok" }] }), memBase(), T(10));
  assert.match(s?.texto ?? "", /solté z\.com/);
});

test("`enCastellano` limpia el detalle crudo del ejecutor sin comerse el dato", () => {
  assert.equal(enCastellano('rechazada: "medir_dominio" no está habilitado'), "medir dominio no está habilitado");
  assert.equal(enCastellano("el placement de x.com: SPAM → INBOX"), "el placement de x.com: SPAM a INBOX");
  assert.equal(enCastellano("**ojo** con x.com"), "ojo con x.com");
  assert.equal(enCastellano("cupo 255 en 89.117.75.226"), "cupo 255 en 89.117.75.226", "los números y las IP se respetan");
});

test("NINGUNA regla usa la voz del modelo", () => {
  // La voz es por donde entraron los 4 pedidos FALSOS de arreglar un freno que ya estaba puesto, y
  // por donde se fugan las promesas. Un mensaje de daño, ceguera o decisión no puede depender de
  // que el modelo conteste ni de lo que el modelo diga.
  const conVoz = base({
    voz: "Sigo acá. Ya los estoy evaluando y te aviso apenas sepa algo.",
    acciones: [{ accion: "frenar_dominio", objetivo: "z.com", ejecutada: true, detalle: "ok" }]
  });
  const a = decidirSiHablar(conVoz, memBase(), T(10));
  assert.ok(a);
  assert.ok(!a.texto.includes("Sigo acá"), "la voz no entra en una clase que interrumpe");
  assert.equal(a.porElModelo, false);
});

test("MODELO CAÍDO, LOS DOS LADOS: el problema sale, el avance no", () => {
  // Es la tarde del 2026-08-06 verificada en test y no en prosa: "No pude leer el estado" a las
  // 21:00 y a la 01:10 el jefe escribiendo "No me has dicho nada en toda la tarde". Con la clase
  // decidiendo el carril, un aviso de problema NUNCA depende del modelo — y un avance que no sale
  // no le cuesta nada, porque el panel lo tiene.
  const sinModelo = { voz: null, ahora: null, sinLectura: "el modelo devolvió texto vacío" };

  const dano = decidirSiHablar(base({ ...sinModelo, novedades: [N("flota.cruzados", "x.com", "")] }), memBase(), T(10));
  assert.equal(dano?.clase, "dano");
  assert.ok((dano?.texto.length ?? 0) > 40, "y con su texto COMPLETO, no un muñón");
  assert.equal(dano?.porElModelo, false);

  const ceguera = decidirSiHablar(base(sinModelo), memBase({ vueltasSinLecturaUtil: 1 }), T(10));
  assert.equal(ceguera?.clase, "ceguera");
  assert.equal(ceguera?.regla, "c1-sin-lectura-2");
  assert.equal(ceguera?.porElModelo, false);
  assert.match(ceguera?.texto ?? "", /Van 2 vueltas/);

  // Y el avance promovido queda marcado como "lo redacta el modelo": el orquestador lo descarta y
  // lo cuenta como tapado=modelo-caido. No hay rama de fallback a propósito.
  const avance = decidirSiHablar(base({ novedades: [N("placement:x.com", "INBOX", "SPAM")] }), memBase(), T(10), abierta("huella:placement"));
  assert.equal(avance?.porElModelo, true);
});

// ══ CEGUERA: DOS VUELTAS, NO LA PRIMERA ═════════════════════════════════════════════════════════

test("la PRIMERA vuelta ciega no interrumpe; la segunda sí", () => {
  // La primera es un tropiezo: el modelo tarda, Postgres se recarga doce segundos. La segunda ya es
  // un vigilante ciego, y eso hay que decirlo.
  const ciego = base({ sinLectura: "fetch failed" });
  assert.equal(decidirSiHablar(ciego, null, T(1)), null, "una sola vuelta no es noticia");
  const mem1 = recordarAviso(ciego, false, T(1), null);
  assert.equal(mem1.vueltasSinLecturaUtil, 1);
  const a = decidirSiHablar(ciego, mem1, T(1.2));
  assert.ok(a, "la segunda seguida sí");
  assert.equal(a.regla, "c1-sin-lectura-2");
});

test("una vuelta buena en el medio RESETEA el contador", () => {
  let mem = recordarAviso(base({ sinLectura: "x" }), false, T(1), null);
  mem = recordarAviso(base(), false, T(2), mem);
  assert.equal(mem.vueltasSinLecturaUtil, 0);
  assert.equal(decidirSiHablar(base({ sinLectura: "x" }), mem, T(3)), null, "vuelve a contar desde cero");
});

test("los REPAROS cuentan como vuelta ciega: quedó mudo de manos, no solo de boca", () => {
  // Con reparos el agente NO ejecuta nada, así que la vuelta es igual de ciega que sin lectura.
  // Antes eran dos razones distintas y ninguna contaba vueltas: un problema que duraba la noche
  // llenaba Slack, y el arreglo que lo tapó lo dejó mudo.
  const conReparos = base({ reparos: ["dice que z.com cruzó y no figura"] });
  const mem = recordarAviso(conReparos, false, T(1), null);
  const a = decidirSiHablar(conReparos, mem, T(1.2));
  assert.equal(a?.regla, "c1-sin-lectura-2");
  assert.match(a?.texto ?? "", /no cuadra con los datos/);
  assert.match(a?.texto ?? "", /no toqué nada/);
});

test("un problema que dura toda la noche NO son 48 mensajes idénticos", () => {
  // Corriendo cada 10 min, una condición que persiste sin enfriamiento son 48 mensajes idénticos
  // antes del desayuno. El daño no es la molestia: entrena al operador a ignorar el canal por el que
  // tiene que llegar lo urgente. Pero callarse para siempre tampoco sirve — si a las 4am quedó
  // ciego, a las 8 hay que seguir sabiéndolo.
  let mem: MemoriaSlack | null = null;
  const ciego = base({ sinLectura: "fetch failed" });
  let mensajes = 0;
  for (let i = 0; i < 72; i++) {
    // 12 horas, una vuelta cada 10 minutos.
    const ahora = new Date(Date.parse(T(0)) + i * 600_000).toISOString();
    const a = decidirSiHablar(ciego, mem, ahora);
    if (a) mensajes++;
    mem = recordarAviso(ciego, !!a, ahora, mem, a);
  }
  assert.equal(mensajes, 2, "una vez por turno de sueño, no una por vuelta");
});

test("dos condiciones distintas no se tapan entre sí", () => {
  // El enfriamiento es POR REGLA. Guardando un solo slot, un aviso de ceguera silenciaba al de daño.
  const ciego = base({ sinLectura: "modelo caído" });
  const mem1 = recordarAviso(ciego, false, T(1), null);
  const a1 = decidirSiHablar(ciego, mem1, T(1.2));
  const mem2 = recordarAviso(ciego, true, T(1.2), mem1, a1);
  const cruce = base({ sinLectura: "modelo caído", novedades: [N("flota.cruzados", "x.com", "")] });
  assert.equal(decidirSiHablar(cruce, mem2, T(1.4))?.regla, "d1-cruce-umbral", "otra regla habla igual");
});

// ══ DECISIONES ══════════════════════════════════════════════════════════════════════════════════

test("el emisor frenado pide la llave, pero recién a la SEGUNDA vuelta", () => {
  // Un `cap-reached` de una vuelta se levanta solo al día siguiente y no necesita a nadie.
  const pausado = base({ emisor: "placement-pause" });
  assert.equal(decidirSiHablar(pausado, memBase({ ultimoEmisor: "send" }), T(10)), null);
  const mem = recordarAviso(pausado, false, T(10), memBase({ ultimoEmisor: "send" }));
  const a = decidirSiHablar(pausado, mem, T(10.2));
  assert.equal(a?.regla, "dec1-emisor-pausado");
  assert.equal(a?.decision, "levantar-pausa-emisor");
  assert.equal(a?.pideRespuesta, true, "esto sí le suena el móvil: sin él no avanza");
  // Y cuando arranca, se calla: una buena noticia del emisor no es una llave de nadie.
  assert.equal(decidirSiHablar(base({ emisor: "send" }), mem, T(10.2)), null);
});

test("un parpadeo de infraestructura NO se convierte en '¿lo resolvés vos?'", () => {
  // Ocurrió tal cual el 2026-08-06: mientras el operador corría el instalador, Postgres se recargó
  // doce segundos y el agente le mandó dos "@Juanes Quise medir_dominio X y no pude: ECONNREFUSED
  // 127.0.0.1:5432. ¿Lo resolvés vos?" — con mención, sobre algo ya arreglado antes de que lo leyera.
  const ssh = base({ acciones: [{ accion: "frenar_dominio", objetivo: "z.com", ejecutada: false, reintentable: true, detalle: "timeout de SSH" }] });
  assert.equal(decidirSiHablar(ssh, memBase(), T(10)), null);
});

test("un error de sintaxis SUYO no se le pregunta al jefe", () => {
  // Salió a Slack tal cual, y está en el log real: "Quise diagnosticar_dominio_bizregistry-ops.com y
  // no pude: rechazada, no es una acción permitida. ¿Lo resolvés vos?". El modelo pegó el dominio al
  // nombre de la acción. No hay nada que resolver del otro lado, y preguntarlo gasta la única señal
  // que sirve para lo que sí lo necesita.
  const suyo = base({ acciones: [{ accion: "frenar_dominio", objetivo: "nope.com", ejecutada: false, detalle: 'rechazada: "nope.com" no está en el inventario' }] });
  assert.equal(decidirSiHablar(suyo, memBase(), T(10)), null);
});

test("pero una falta de PERMISO sí interrumpe, con la llave correcta", () => {
  const a = decidirSiHablar(
    base({ acciones: [{ accion: "soltar_dominio", objetivo: "x.com", ejecutada: false, detalle: "rechazada: soltar no está habilitado en este entorno" }] }),
    memBase(),
    T(10)
  );
  assert.equal(a?.regla, "dec2-soltar-trabado");
  assert.equal(a?.decision, "autorizar-soltar");
  assert.equal(a?.pideRespuesta, true);
});

test("una falta de permiso se dice UNA vez, no cuatro por día para siempre", () => {
  // El flag lo puso él. No se mueve hasta que alguien lo cambie, así que con el enfriamiento por
  // reloj eran cuatro mensajes idénticos por día sobre una decisión que ya tomó. Mismo mecanismo
  // que d2 y c4: se dice cuando el hecho cambia, no cuando pasan seis horas.
  const trabada = base({
    acciones: [{ accion: "soltar_dominio", objetivo: "x.com", ejecutada: false, detalle: "rechazada: soltar no está habilitado en este entorno" }]
  });
  const a1 = decidirSiHablar(trabada, memBase(), T(10));
  assert.equal(a1?.regla, "dec2-soltar-trabado");
  const mem = recordarAviso(trabada, true, T(10), memBase(), a1);
  assert.equal(decidirSiHablar(trabada, mem, T(20)), null, "el mismo flag, diez horas después, ya está dicho");
  // Otra mano trabada SÍ habla: es un hecho nuevo, no la repetición del anterior.
  const otra = base({
    acciones: [{ accion: "soltar_dominio", objetivo: "y.com", ejecutada: false, detalle: "rechazada: soltar no está habilitado en este entorno" }]
  });
  assert.equal(decidirSiHablar(otra, mem, T(20))?.regla, "dec2-soltar-trabado");
});

test("UNA MANO QUE NO HIZO NADA PORQUE NO HABÍA NADA QUE HACER NO ESTÁ TRABADA", () => {
  // Los tres detalles son TEXTUALES de acciones-agente.ts (líneas 474, 573 y 647), que es idempotente
  // en las tres manos que tocan infra. Sin el filtro salían como clase `decision` con la mención que
  // le hace sonar el móvil, pidiéndole destrabar algo que no está trabado — y la tercera AFIRMABA lo
  // contrario del hecho ("Quedaron 0 frenos aplicados y sigue mandando" sobre un warmup ya pausado).
  // Es textual el "No entiendo, es decir ?" del 2026-08-06T21:15, subido de categoría a DECISION.
  // Y no es un caso raro: hay 46 nodos en cap 0, así que `frenar_dominio` cae acá seguido.
  const noOps: Array<[string, string | null, string]> = [
    ["frenar_dominio", "z.com", "z.com ya estaba en cap 0: no hacía falta"],
    ["soltar_dominio", "z.com", "z.com ya está suelto (cap 20): no hacía falta"],
    ["pausar_warmup", null, "el warmup ya estaba pausado: no hacía falta"]
  ];
  for (const [accion, objetivo, detalle] of noOps) {
    assert.equal(
      decidirSiHablar(base({ acciones: [{ accion, objetivo, ejecutada: false, detalle }] }), memBase(), T(10)),
      null,
      `${accion}: "${detalle}" no es una llave que él gire`
    );
  }
  // Y la mano que SÍ falló de verdad sigue saliendo: el filtro no puede comerse el caso real.
  const rota = base({
    acciones: [{ accion: "frenar_dominio", objetivo: "z.com", ejecutada: false, detalle: "no pude frenar z.com: el nodo devolvió 550" }]
  });
  const a = decidirSiHablar(rota, memBase(), T(10));
  assert.equal(a?.regla, "dec3-mano-fallo");
  assert.equal(a?.pideRespuesta, true);
});

test("UN TOQUE DE INFRA POR VUELTA SE DICE, aunque sean tres seguidos en menos de 6 h", () => {
  // El enfriamiento genérico por id de regla se tragaba eventos DISTINTOS: frenó a.com a las 10:00 y
  // avisó; frenó b.com a las 11:00 y c.com a las 13:00 y no avisó ninguno de los dos, nunca. Los dos
  // quedaron con el cupo en 0 y él no se enteró. Un agente autónomo cambiando la infraestructura en
  // silencio es exactamente lo que esta regla existe para impedir.
  const freno = (d: string): EstadoParaSlack =>
    base({ acciones: [{ accion: "frenar_dominio", objetivo: d, ejecutada: true, detalle: "ok" }] });
  let mem: MemoriaSlack = memBase();
  for (const [h, d] of [[10, "a.com"], [11, "b.com"], [13, "c.com"]] as const) {
    const a = decidirSiHablar(freno(d), mem, T(h));
    assert.equal(a?.regla, "dec5-toque-de-infra", `frenó ${d} a las ${h}:00 y no lo dijo`);
    assert.match(a?.texto ?? "", new RegExp(d.replace(".", "\\.")), "el mensaje nombra el dominio que tocó");
    mem = recordarAviso(freno(d), true, T(h), mem, a);
  }
  // Pero la MISMA mano repetida no se dice dos veces: eso es el estado, no un evento nuevo.
  assert.equal(decidirSiHablar(freno("c.com"), mem, T(13.2)), null);
});

test("si falla una mano que solo MIRA, no se pide nada", () => {
  const miroYFallo = base({ acciones: [{ accion: "revisar_reputacion", objetivo: "a.com", ejecutada: false, detalle: "rechazada: no está habilitado" }] });
  assert.equal(decidirSiHablar(miroYFallo, memBase(), T(10)), null, "es un turno con menos información, no un problema que delegar");
});

test("UN DAÑO NO SE COME A OTRO DAÑO: la vuelta del 2026-08-06T20:52:39Z dice las DOS cosas", () => {
  // LOS DATOS SON REALES, de las dos copias consecutivas de sender-measurement.json:
  //   14:51:46Z → {sanas: 13, bloqueadas: 16, cruzados: 9}
  //   20:52:39Z → {sanas:  6, bloqueadas: 36, cruzados: 10 (+corpdocfiling-ledger.com)}
  // Los predicados de d1 y d3 daban los DOS true, salía el primero y `return`. El mensaje "Se
  // cayeron 7 bandejas de golpe" no salía nunca — ni ahí ni después, porque `novedades` es un diff y
  // en la vuelta siguiente ya no hay delta. Se perdía la mitad B del encargo por un `return`.
  const vuelta = base({
    novedades: [
      N("flota.cruzados", "a.com,corpdocfiling-ledger.com", "a.com"),
      N("flota.sanas", 6, 13),
      N("flota.bloqueadas", 36, 16)
    ]
  });
  const a = decidirSiHablar(vuelta, memBase(), T(20.87));
  assert.equal(a?.clase, "dano");
  assert.match(a?.texto ?? "", /corpdocfiling-ledger\.com/, "el cruce del umbral permanente");
  assert.match(a?.texto ?? "", /7 bandejas/, "y el derrumbe de la flota, en el MISMO mensaje");
  assert.equal(a?.pideRespuesta, true);
  assert.deepEqual(a?.reglas?.map((r) => r.id), ["d1-cruce-umbral", "d3-derrumbe-flota"]);

  // Y el acompañante queda enfriado: en la vuelta siguiente no vuelve a salir solo repitiéndose.
  const mem = recordarAviso(vuelta, true, T(20.87), memBase(), a);
  assert.equal(decidirSiHablar(base({ novedades: [N("flota.sanas", 6, 13)] }), mem, T(21)), null);
});

test("y lo que se tapa por otra regla NO es invisible para el instrumento", () => {
  // `loQueSeCallo` cortaba en la primera regla que matcheaba, así que un DAÑO tapado por otro DAÑO no
  // aparecía en ningún lado y `sentinel-audit` lo contaba de menos. Un canal donde no se puede saber
  // cuánto se calló no se calibra.
  const dosClases = base({
    novedades: [N("flota.cruzados", "nuevo.com", "")],
    sinLectura: "el modelo no contesta"
  });
  const tapados = loQueSeCallo(dosClases, memBase({ vueltasSinLecturaUtil: 5 }), T(10));
  const ceguera = tapados.find((t) => t.clave === "c1-sin-lectura-2");
  assert.equal(ceguera?.motivo, "otra-regla-gano", "la ceguera pasó todas las puertas y no salió: hay que decirlo");
  assert.match(ceguera?.texto ?? "", /a ciegas/, "con lo que habría dicho, o no se puede auditar");
});

test("el orden es DANO, después CEGUERA, después DECISION", () => {
  const todoJunto = base({
    novedades: [N("flota.cruzados", "x.com", "")],
    sinLectura: "modelo caído",
    acciones: [{ accion: "frenar_dominio", objetivo: "z.com", ejecutada: true, detalle: "ok" }]
  });
  assert.equal(decidirSiHablar(todoJunto, memBase({ vueltasSinLecturaUtil: 5 }), T(10))?.clase, "dano");
  const sinDano = base({ sinLectura: "modelo caído", acciones: todoJunto.acciones });
  assert.equal(decidirSiHablar(sinDano, memBase({ vueltasSinLecturaUtil: 5 }), T(10))?.clase, "ceguera");
});

// ══ D) EL UMBRAL QUE APRENDE ════════════════════════════════════════════════════════════════════

test("LA BARRERA: ninguna secuencia de reacciones puede callar un incendio", () => {
  // El riesgo más alto del paquete: un sistema que aprende a callarse puede aprender a callar un
  // incendio. La barrera es que `dejaSalir` SOLO se consulta para la clase huella — y esto lo
  // verifica a la fuerza bruta, sobre secuencias de reacciones que degradan todo lo degradable.
  const escenarios: Array<{ nombre: string; estado: EstadoParaSlack; mem: MemoriaSlack }> = [
    { nombre: "dano/cruce", estado: base({ novedades: [N("flota.cruzados", "x.com", "")] }), mem: memBase() },
    { nombre: "dano/derrumbe", estado: base({ novedades: [N("flota.sanas", 8, 14)] }), mem: memBase() },
    { nombre: "dano/reputacion", estado: base({ hechos: { ...HECHOS(), reputacion: [{ dominio: "a.com", listas: ["sbl"] }] } }), mem: memBase() },
    { nombre: "ceguera/sin-lectura", estado: base({ sinLectura: "x" }), mem: memBase({ vueltasSinLecturaUtil: 4 }) },
    { nombre: "ceguera/medicion", estado: base({ hechos: HECHOS({ cap: { ...HECHOS().cap!, medidoEn: T(-40) } }) }), mem: memBase() },
    { nombre: "decision/emisor", estado: base({ emisor: "killed" }), mem: memBase({ vueltasEmisorFrenado: 4 }) },
    { nombre: "decision/soltar", estado: base({ acciones: [{ accion: "soltar_dominio", objetivo: "z.com", ejecutada: false, detalle: "no habilitado" }] }), mem: memBase() }
  ];
  const secuencias: Array<Array<"conforme" | "insiste" | "corrige">> = [
    ["corrige"],
    ["insiste"],
    ["corrige", "corrige", "corrige"],
    ["insiste", "corrige", "insiste", "corrige"],
    ["conforme", "corrige"],
    Array.from({ length: 20 }, () => "corrige" as const)
  ];
  for (const { nombre, estado, mem } of escenarios) {
    const antes = decidirSiHablar(estado, mem, T(10));
    assert.ok(antes, `${nombre}: tiene que hablar antes`);
    for (const seq of secuencias) {
      // Se degrada TODO par imaginable, incluido el id de la regla usado como par por si alguien lo
      // cablea mal el día de mañana.
      let tabla: TablaRelevancia = {};
      for (const par of ["huella:placement", "huella:plan.diaN", `huella:${antes.regla}`, antes.regla, antes.clase])
        for (const r of seq) tabla = registrarReaccion(tabla, par, r);
      // Y también 40 salidas sin respuesta con el jefe despierto.
      for (const par of [antes.regla, `huella:${antes.regla}`])
        for (let i = 0; i < 40; i++) tabla = registrarSalida(tabla, par, `ts-${i}`, true, T(10));
      const despues = decidirSiHablar(estado, mem, T(10), { tabla });
      assert.ok(despues, `${nombre}: una reacción del jefe NO puede callar una clase que interrumpe`);
      assert.equal(despues.regla, antes.regla);
    }
  }
});

test("y ninguna reacción puede SUBIR algo hasta las clases que interrumpen", () => {
  // La barrera del otro lado: aprender no puede fabricar un daño. Una huella muy respondida sigue
  // siendo huella — sale, pero por el modelo y sin pedir ninguna llave. Y de paso fija la promoción
  // por RESPUESTAS en el hilo: tres contestaciones abren el par igual que tres preguntas.
  let tabla: TablaRelevancia = {};
  for (let i = 0; i < 50; i++) tabla = registrarReaccion(tabla, "huella:plan.diaN", "conforme");
  assert.equal(dejaSalir(tabla, "huella:plan.diaN"), true);
  const a = decidirSiHablar(base({ novedades: [N("plan:x.com.diaN", 4, 3)] }), memBase(), T(10), { tabla });
  assert.equal(a?.clase, "huella");
  assert.equal(a?.decision, null);
  assert.equal(a?.porElModelo, true);
});

test("PROMOCIÓN: tres preguntas del jefe sobre placement abren ese par", () => {
  // La señal más honesta que hay y es gratis: lo que él pregunta. Reusa los `temas` de
  // memoria-conversacion.ts, que hoy se calculan y no los lee nadie.
  const temas = [
    { cita: "como viene el placement de los dominios?", vistas: [T(-48), T(-24), T(-2)] },
    { cita: "y la rampa?", vistas: [T(-2)] }
  ];
  const tabla = promoverPorPreguntas({}, temas, T(10));
  assert.equal(dejaSalir(tabla, "huella:placement"), true);
  assert.equal(dejaSalir(tabla, "huella:plan.diaN"), false, "una sola pregunta no es una costumbre");
  assert.equal(tabla["huella:placement"]?.muestra, 3, "y la muestra va al lado del peso");

  const a = decidirSiHablar(base({ novedades: [N("placement:x.com", "INBOX", "SPAM")] }), memBase(), T(10), { tabla });
  assert.match(a?.texto ?? "", /entró en bandeja/);
});

test("las preguntas fuera de la ventana de 14 días NO promueven", () => {
  const viejas = [{ cita: "como viene el placement?", vistas: [T(-24 * 30), T(-24 * 25), T(-24 * 20)] }];
  assert.equal(dejaSalir(promoverPorPreguntas({}, viejas, T(10)), "huella:placement"), false);
});

test("el mapa de palabras ata pregunta a campo sin modelo", () => {
  assert.deepEqual(camposDeLaPregunta("y el placement de las bandejas?"), ["placement"]);
  assert.deepEqual(camposDeLaPregunta("cuantos dominios frenados quedan"), ["cap.frenados"]);
  assert.deepEqual(camposDeLaPregunta("hola que tal"), [], "una pregunta que no es de ningún campo no promueve nada");
});

test("DEGRADACIÓN: un solo 'corrige' cierra el par de una", () => {
  // `corrige` e `insiste` son evidencia DURA: él volvió a escribir. No hace falta esperar a la
  // décima.
  const tabla = promoverPorPreguntas({}, [{ cita: "el placement?", vistas: [T(-3), T(-2), T(-1)] }], T(10));
  assert.equal(dejaSalir(tabla, "huella:placement"), true);
  assert.equal(dejaSalir(registrarReaccion(tabla, "huella:placement", "corrige"), "huella:placement"), false);
  assert.equal(dejaSalir(registrarReaccion(tabla, "huella:placement", "insiste"), "huella:placement"), false);
  assert.equal(dejaSalir(registrarReaccion(tabla, "huella:placement", "conforme"), "huella:placement"), true, "un conforme sostiene");
});

test("DEGRADACIÓN: diez salidas sin respuesta ESTANDO DESPIERTO cierran el par", () => {
  let tabla = promoverPorPreguntas({}, [{ cita: "la rampa de los dias?", vistas: [T(-3), T(-2), T(-1)] }], T(10));
  assert.equal(dejaSalir(tabla, "huella:plan.diaN"), true);
  for (let i = 0; i < 9; i++) tabla = registrarSalida(tabla, "huella:plan.diaN", `ts${i}`, true, T(10));
  assert.equal(dejaSalir(tabla, "huella:plan.diaN"), true, "nueve todavía no");
  tabla = registrarSalida(tabla, "huella:plan.diaN", "ts9", true, T(10));
  assert.equal(dejaSalir(tabla, "huella:plan.diaN"), false);
});

test("COMPOSICIÓN: una queja le gana a una pregunta vieja, vuelta tras vuelta", () => {
  // EL DEFECTO QUE ESTE TEST IMPIDE, y es el círculo en una línea: el orquestador corre
  // `promoverPorPreguntas` UNA VEZ POR VUELTA (paso 9) y `temas` vive 14 días en memoria. La
  // promoción seteaba `peso: 1` incondicionalmente, así que el jefe corregía un mensaje, el par se
  // cerraba, y diez minutos después la MISMA pregunta vieja lo volvía a abrir. Las dos degradaciones
  // que este archivo promete eran inertes en composición.
  //
  // El test que las cubría hacía promover→corrige, o sea el orden que NO ocurre en producción. Éste
  // hace promover→corrige→PROMOVER, que es el orden real.
  const temas = [{ cita: "el placement?", vistas: [T(-3), T(-2), T(-1)] }];
  let tabla = promoverPorPreguntas({}, temas, T(10));
  assert.equal(dejaSalir(tabla, "huella:placement"), true);

  tabla = registrarReaccion(tabla, "huella:placement", "corrige");
  assert.equal(dejaSalir(tabla, "huella:placement"), false);

  // La vuelta siguiente, con los mismos temas de siempre: TIENE que seguir cerrado.
  for (let i = 0; i < 20; i++) {
    tabla = promoverPorPreguntas(tabla, temas, T(10 + i / 6));
    assert.equal(dejaSalir(tabla, "huella:placement"), false, `reabierto en la vuelta ${i + 1}`);
  }

  // Y lo mismo con la otra degradación: diez salidas sin respuesta cierran el par, y la promoción
  // de la vuelta siguiente no lo reabre.
  let otra = promoverPorPreguntas({}, [{ cita: "la rampa de los dias?", vistas: [T(-3), T(-2), T(-1)] }], T(10));
  for (let i = 0; i < 10; i++) otra = registrarSalida(otra, "huella:plan.diaN", `ts${i}`, true, T(10));
  assert.equal(dejaSalir(otra, "huella:plan.diaN"), false);
  otra = promoverPorPreguntas(otra, [{ cita: "la rampa de los dias?", vistas: [T(-3), T(-2), T(-1)] }], T(11));
  assert.equal(dejaSalir(otra, "huella:plan.diaN"), false, "diez salidas ignoradas pesan más que tres preguntas viejas");
});

test("EL SILENCIO NO ES EVIDENCIA: con el jefe dormido, diez salidas no degradan nada", () => {
  // La ausencia de respuesta NO es evidencia de irrelevancia — el jefe puede estar durmiendo. Un
  // sistema que degrada por silencio se puede apagar solo, y el canal ya se quedó mudo dos veces por
  // arreglos que parecían correctos.
  let tabla = promoverPorPreguntas({}, [{ cita: "la rampa de los dias?", vistas: [T(-3), T(-2), T(-1)] }], T(10));
  for (let i = 0; i < 30; i++) tabla = registrarSalida(tabla, "huella:plan.diaN", `ts${i}`, false, T(10));
  assert.equal(dejaSalir(tabla, "huella:plan.diaN"), true);
  assert.equal(tabla["huella:plan.diaN"]?.salieron, 0, "una salida con él dormido no cuenta contra el par");
  assert.ok((tabla["huella:plan.diaN"]?.hilos?.length ?? 0) > 0, "pero el hilo se guarda: si contesta a la mañana, se cosecha");
});

test("con muestra menor a 3 el par NO sale, tenga el peso que tenga", () => {
  // Un peso sobre 3 muestras no es un peso. Es la misma regla que el informe imprime al lado del
  // número, y acá impide que decida.
  assert.equal(dejaSalir({ "huella:placement": { salieron: 1, respondio: 1, quejo: 0, peso: 1, muestra: 2, ultimaVez: null } }, "huella:placement"), false);
  assert.equal(dejaSalir({ "huella:placement": { salieron: 3, respondio: 3, quejo: 0, peso: 1, muestra: 3, ultimaVez: null } }, "huella:placement"), true);
});

test("sin la tabla (flag apagado) la huella NUNCA sale", () => {
  // `SENTINEL_APRENDE_RELEVANCIA` arranca apagado y el orquestador no pasa `relevancia`. El
  // fail-closed correcto: cero huella, y las tres clases que interrumpen intactas.
  const conNovedad = base({ novedades: [N("placement:x.com", "INBOX", "SPAM")] });
  assert.equal(decidirSiHablar(conNovedad, memBase(), T(10)), null);
  assert.equal(decidirSiHablar(conNovedad, memBase(), T(10), { tabla: {} }), null);
});

test("EL DÍA EN SOMBRA: no sale, pero se puede ver qué habría dicho", () => {
  const rel: Relevancia = { ...abierta("huella:placement"), sombra: true };
  const estado = base({ novedades: [N("placement:x.com", "INBOX", "SPAM")] });
  assert.equal(decidirSiHablar(estado, memBase(), T(10), rel), null);
  const t = loQueSeCallo(estado, memBase(), T(10), rel);
  const sombra = t.find((x) => x.motivo === "sombra");
  assert.ok(sombra, "tiene que quedar registrado como sombra");
  assert.match(sombra.texto ?? "", /entró en bandeja/);
});

// ══ EL PRESUPUESTO Y EL ENFRIAMIENTO DE LA HUELLA ═══════════════════════════════════════════════

test("el tope diario de huella NUNCA calla un problema", () => {
  // Es exactamente el error del arreglo anterior: bajar el ruido apagó lo que sí funcionaba.
  const lleno = memBase({ avancesHoy: 10, diaAvances: HOY });
  assert.ok(decidirSiHablar(base({ novedades: [N("flota.cruzados", "x.com", "")] }), lleno, T(10)), "el daño sale");
  assert.ok(decidirSiHablar(base({ sinLectura: "x" }), memBase({ ...lleno, vueltasSinLecturaUtil: 3 }), T(10)), "la ceguera sale");
  assert.ok(
    decidirSiHablar(base({ acciones: [{ accion: "soltar_dominio", objetivo: "z.com", ejecutada: false, detalle: "no habilitado" }] }), lleno, T(10)),
    "la decisión sale"
  );
});

test("pasado el tope diario la huella no sale, pero se CUENTA", () => {
  const mem = memBase({ avancesHoy: 10, diaAvances: HOY });
  const r = presupuestoDeAvances([N("cap.frenados", 45, 44)], mem, T(10));
  assert.equal(r.elegida, null);
  assert.equal(r.tapados, 1);
  assert.ok(loQueSeCallo(base({ novedades: [N("cap.frenados", 45, 44)] }), mem, T(10)).some((t) => t.motivo === "presupuesto"));
});

test("un valor que OSCILA no produce un mensaje por vuelta", () => {
  // El dedupe era por `clave=valorNuevo` y contra A→B→A→B nunca coincide. Simulado con `cap.frenados`
  // oscilando 8↔7 cada 10 minutos: 20 mensajes en 24 h, diez de ellos textualmente idénticos.
  let mem = memBase();
  let mensajes = 0;
  const rel = abierta("huella:cap.frenados");
  for (let i = 0; i < 36; i++) {
    const ahora = new Date(Date.parse(T(0)) + i * 600_000).toISOString();
    const estado = base({ novedades: [N("cap.frenados", i % 2 === 0 ? 8 : 7, i % 2 === 0 ? 7 : 8)] });
    const a = decidirSiHablar(estado, mem, ahora, rel);
    if (a) mensajes++;
    mem = recordarAviso(estado, !!a, ahora, mem, a);
  }
  assert.equal(mensajes, 6, "una vez por hora, no una por vuelta");
});

test("una caída a SPAM le gana a todo, y lo tapado no se llama 'avance'", () => {
  // Sobre los hechos reales del 2026-08-06 con seis cambios en una vuelta salía "los dominios
  // frenados: 8 → 7. Además: 5 avances menores." — y adentro de esos 5 iba el INBOX→SPAM de
  // corpfiling-infra.com. Una regresión rotulada como avance y encima tapada.
  const a = decidirSiHablar(
    base({ novedades: [N("cap.frenados", 7, 8), N("placement:corpfiling-infra.com", "SPAM", "INBOX"), N("flota.sanas", 14, 13)] }),
    memBase(),
    T(10),
    abierta("huella:placement")
  );
  assert.match(a?.texto ?? "", /ojo con corpfiling-infra\.com: se fue a spam/);
  assert.match(a?.texto ?? "", /y 2 cambio/, "no son 'avances': ahí adentro puede ir otra caída");
});

test("una huella NO corre para adelante el reloj de los problemas", () => {
  // El goteo y el olvido son dos problemas distintos y tienen relojes distintos. Si la huella pisara
  // el enfriamiento de la regla, un problema que persiste se dejaría de repetir cada vez que la
  // fábrica avanza.
  const ciego = base({ sinLectura: "fetch failed" });
  const mem1 = recordarAviso(ciego, false, T(1), null);
  const a1 = decidirSiHablar(ciego, mem1, T(1.2));
  const mem2 = recordarAviso(ciego, true, T(1.2), mem1, a1);

  const huella = base({ novedades: [N("placement:x.com", "INBOX", "SPAM")] });
  const av = decidirSiHablar(huella, mem2, T(2), abierta("huella:placement"));
  assert.ok(av);
  const mem3 = recordarAviso(huella, true, T(2), mem2, av);
  assert.equal(mem3.ultimoAviso, mem2.ultimoAviso, "la huella no toca el reloj de los problemas");
  assert.equal(mem3.avancesHoy, 1);
});

test("una memoria vieja sin los campos nuevos sigue funcionando", () => {
  // El warmup-slack.json que hay en producción no tiene ni `avancesHoy` ni los contadores nuevos. Si
  // fueran obligatorios, el primer despliegue leería una memoria "inválida".
  const vieja: MemoriaSlack = { ultimoEmisor: "send", ultimoAviso: T(9), ultimaFirma: null };
  const a = decidirSiHablar(base({ novedades: [N("flota.cruzados", "x.com", "")] }), vieja, T(10));
  assert.ok(a);
  const mem = recordarAviso(base(), true, T(10), vieja, a);
  assert.equal(mem.ultimoEmisor, "send", "y no se pierde nada de lo viejo");
  assert.equal(mem.vueltasSinLecturaUtil, 0);
});

test("el contador de huella se resetea al cambiar el día UTC", () => {
  const ayer = memBase({ avancesHoy: 10, diaAvances: "2026-08-05" });
  assert.ok(presupuestoDeAvances([N("cap.frenados", 45, 44)], ayer, T(10)).elegida, "diez de ayer no gastan el cupo de hoy");
});

// ══ EL RETRATO ══════════════════════════════════════════════════════════════════════════════════

test("dos lecturas idénticas no producen NINGUNA novedad", () => {
  const antes = camposObservables(HECHOS(), {});
  assert.deepEqual(novedades(antes, camposObservables(HECHOS(), antes)), []);
});

test("sin snapshot previo NO habla: en una instalación fresca todo sería 'nuevo'", () => {
  assert.deepEqual(novedades({}, camposObservables(HECHOS(), {})), []);
});

test("una lectura que se recupera NO es una novedad", () => {
  // En el orquestador `plan` sale de `planDelDia(...).catch(() => undefined)`: un tropiezo borra la
  // sección entera y al volver contaría 24 "avances" que nadie logró.
  const sinPlan = HECHOS({ plan: undefined, cap: null });
  const a1 = camposObservables(sinPlan, {});
  assert.deepEqual(novedades(a1, camposObservables(HECHOS(), a1)), [], "aparecer no es avanzar");
  const a2 = camposObservables(HECHOS(), {});
  assert.deepEqual(novedades(a2, camposObservables(sinPlan, a2)), [], "y desaparecer tampoco");
});

test("un dominio que se cae de la ventana y vuelve a medir LO MISMO no es novedad", () => {
  // `hechos.vueltas` es una query LIMIT 8 sobre los ciclos GLOBALES: la fila de un dominio se cae en
  // horas y su clave `placement:` desaparece. Sin arrastre, al volver se anunciaba "sin medir →
  // INBOX" sobre un dominio medido 18 h antes.
  const CICLO = (dominio: string, cuando: string, placement: string | null) => ({ dominio, semilla: "s@gmail.com", cuando, placement, completa: true, error: null });
  const s1 = camposObservables(HECHOS({ vueltas: [CICLO("x.com", T(1), "INBOX")] }), {});
  const s2 = camposObservables(HECHOS({ vueltas: Array.from({ length: 8 }, (_, i) => CICLO(`o${i}.com`, T(2 + i / 60), "SPAM")) }), s1);
  assert.equal(s2["placement:x.com"], "INBOX", "el valor conocido se arrastra");
  assert.deepEqual(novedades(s2, camposObservables(HECHOS({ vueltas: [CICLO("x.com", T(3), "INBOX")] }), s2)), []);
  // Y cuando de verdad cambia, sale con los DOS valores.
  assert.deepEqual(novedades(s2, camposObservables(HECHOS({ vueltas: [CICLO("x.com", T(3), "SPAM")] }), s2)), [
    { clave: "placement:x.com", objeto: "x.com", antes: "INBOX", despues: "SPAM" }
  ]);
});

test("una vuelta SIN placement no inventa un valor", () => {
  const sinMedir = HECHOS({ vueltas: [{ dominio: "nuevo.com", semilla: "s@gmail.com", cuando: T(10), placement: null, completa: false, error: null }] });
  assert.equal(camposObservables(sinMedir, {})["placement:nuevo.com"], undefined);
});

test("las MUESTRAS de placement no se observan", () => {
  const conMuestras = HECHOS({ plan: [{ dominio: "corpfiling-infra.com", diaN: 3, placementTasa: 0.83, placementMuestra: 7, cupo: 4, accion: "sostener", motivo: "x", enviadosHoy: 2 }] });
  const antes = camposObservables(HECHOS(), {});
  assert.equal(antes["plan:corpfiling-infra.com.muestra"], undefined);
  assert.deepEqual(novedades(antes, camposObservables(conMuestras, antes)), []);
});

// ══ E) EL CABLE QUE FALTABA ═════════════════════════════════════════════════════════════════════

test("mandarASlack DEVUELVE el ts, que es lo que ata una respuesta a su mensaje", () => {
  // Se venía descartando la respuesta de `chat.postMessage`. Sin ese identificador es literalmente
  // imposible saber a qué mensaje PROACTIVO contestó el jefe —`leerHilo` necesita el ts del hilo— y
  // sin eso todo el aprendizaje de relevancia es ciego del lado de la respuesta, que es justo el
  // numerador que él no puede falsear desde el código.
  const aviso: Aviso = { texto: "x", motivo: "m", pideRespuesta: false, clase: "dano", regla: "d1-cruce-umbral", decision: "kill-switch", porElModelo: false };
  return Promise.all([
    mandarASlack(aviso, { token: "t", canal: "c", fetchImpl: (async () => ({ json: async () => ({ ok: true, ts: "1754500000.001" }) })) as never }).then((r) => {
      assert.equal(r.ok, true);
      assert.equal(r.ts, "1754500000.001");
    }),
    mandarASlack(aviso, {}).then((r) => {
      assert.equal(r.ok, false);
      assert.equal(r.ts, null, "sin credenciales no hay ts, y no se inventa uno");
      assert.match(r.motivo ?? "", /SLACK_BOT_TOKEN/);
    }),
    mandarASlack(aviso, { token: "t", canal: "c", fetchImpl: (async () => { throw new Error("red caída"); }) as never }).then((r) => {
      assert.equal(r.ok, false);
      assert.equal(r.ts, null);
      assert.match(r.motivo ?? "", /red caída/);
    })
  ]);
});
