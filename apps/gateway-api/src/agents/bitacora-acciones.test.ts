import assert from "node:assert/strict";
import test from "node:test";
import { bitacoraVacia, daLoMismo, idDe, juzgar, lineasParaPrompt, registrar, type Bitacora, type Veredicto } from "./bitacora-acciones.ts";

const T = (n: number): string => `2026-08-0${n}T10:00:00.000Z`;

test("pedir lo mismo dos veces SUMA, no duplica", () => {
  // Es la señal que corta el bucle: el agente pidió frenar el mismo dominio 10 veces seguidas
  // porque nadie le dijo que ya lo había pedido.
  let b = registrar(null, { accion: "frenar_dominio", objetivo: "x.com", motivo: "cruzó", estado: "rechazada", detalle: "no habilitado", cuando: T(1) });
  b = registrar(b, { accion: "frenar_dominio", objetivo: "x.com", motivo: "cruzó", estado: "rechazada", detalle: "no habilitado", cuando: T(2) });
  b = registrar(b, { accion: "frenar_dominio", objetivo: "x.com", motivo: "cruzó", estado: "rechazada", detalle: "no habilitado", cuando: T(3) });
  assert.equal(b.entradas.length, 1, "una sola entrada");
  assert.equal(b.entradas[0]?.veces, 3);
  assert.equal(b.entradas[0]?.primeraVez, T(1), "conserva cuándo empezó");
  assert.equal(b.entradas[0]?.ultimaVez, T(3));
});

test("acciones sobre objetivos distintos son entradas distintas", () => {
  let b = registrar(null, { accion: "frenar_dominio", objetivo: "a.com", motivo: "m", estado: "ejecutada", cuando: T(1) });
  b = registrar(b, { accion: "frenar_dominio", objetivo: "b.com", motivo: "m", estado: "ejecutada", cuando: T(1) });
  assert.equal(b.entradas.length, 2);
});

test("el ANTES que se conserva es el de la primera vez", () => {
  // Contra ese estado se juzga si sirvió. Pisarlo con el de la última vez borraría la referencia.
  let b = registrar(null, { accion: "frenar_dominio", objetivo: "x.com", motivo: "m", estado: "ejecutada", antes: { cap: 50 }, cuando: T(1) });
  b = registrar(b, { accion: "frenar_dominio", objetivo: "x.com", motivo: "m", estado: "ejecutada", antes: { cap: 0 }, cuando: T(2) });
  assert.deepEqual(b.entradas[0]?.antes, { cap: 50 });
});

test("juzgar solo cierra lo EJECUTADO, una sola vez, y nunca inventa", () => {
  const criterio = (antes: Record<string, unknown> | null, despues: Record<string, unknown>): Veredicto | null => {
    if (!antes) return null;
    return { cuando: "", resultado: despues.cap === 0 && antes.cap !== 0 ? "sirvio" : "no_sirvio", medido: `cap ${String(antes.cap)} → ${String(despues.cap)}` };
  };

  let b = registrar(null, { accion: "frenar_dominio", objetivo: "x.com", motivo: "m", estado: "ejecutada", antes: { cap: 50 }, cuando: T(1) });
  b = juzgar(b, idDe("frenar_dominio", "x.com"), { cuando: T(2), datos: { cap: 0 } }, criterio);
  assert.equal(b.entradas[0]?.veredicto?.resultado, "sirvio");
  assert.match(b.entradas[0]?.veredicto?.medido ?? "", /50 → 0/);

  // No se re-juzga: el primer veredicto es el que vale.
  b = juzgar(b, idDe("frenar_dominio", "x.com"), { cuando: T(3), datos: { cap: 99 } }, criterio);
  assert.equal(b.entradas[0]?.veredicto?.resultado, "sirvio");

  // Una RECHAZADA no se juzga nunca: no se ejecutó, no hay efecto que medir.
  let r = registrar(null, { accion: "frenar_dominio", objetivo: "y.com", motivo: "m", estado: "rechazada", antes: { cap: 50 }, cuando: T(1) });
  r = juzgar(r, idDe("frenar_dominio", "y.com"), { cuando: T(2), datos: { cap: 0 } }, criterio);
  assert.equal(r.entradas[0]?.veredicto, null);

  // Sin ANTES no hay con qué comparar: el criterio devuelve null y no se inventa un veredicto.
  let s = registrar(null, { accion: "frenar_dominio", objetivo: "z.com", motivo: "m", estado: "ejecutada", cuando: T(1) });
  s = juzgar(s, idDe("frenar_dominio", "z.com"), { cuando: T(2), datos: { cap: 0 } }, criterio);
  assert.equal(s.entradas[0]?.veredicto, null);
});

test("EL CAMPO PISADO: una ejecución seguida de un rechazo SIGUE siendo juzgable", () => {
  // EL INVARIANTE, no el caso. `registrar` PISA `estado` en cada re-registro, y `juzgar` exigía
  // `estado === "ejecutada"`. O sea que un `frenar_dominio` que SÍ se aplicó y a la vuelta siguiente
  // se rechaza por idempotencia ("ya está en cap 0" — que es el camino NORMAL, no un borde) quedaba
  // inelegible para juicio PARA SIEMPRE.
  //
  // El resultado medido en la Mac Studio (runtime/openclaw-workspace/inventory/warmup-acciones.json,
  // 2026-08-07): 40 entradas, 0 veredictos, 0 con `antes`. La maquinaria de juicio está COMPLETA
  // desde hace semanas y emite textual "<dominio> sigue con cupo N: el freno no quedó puesto"
  // (scripts/ops/warmup-monitor.ts:924). Nunca corrió una sola vez. Por eso el censo del agente
  // devolvió 43 episodios de "no se midió el efecto de mis propias acciones": el canal por el que su
  // freno deshecho tenía que llegarle al modelo estaba cerrado por UNA línea.
  const criterio = (_antes: Record<string, unknown> | null, despues: Record<string, unknown>) =>
    despues.cap === 0
      ? ({ cuando: "", resultado: "sirvio", medido: "quedó en cap 0" } as const)
      : ({ cuando: "", resultado: "no_sirvio", medido: `sigue con cupo ${String(despues.cap)}: el freno no quedó puesto` } as const);

  let b = registrar(null, { accion: "frenar_dominio", objetivo: "bizreport-control.com", motivo: "cruzó el umbral", estado: "ejecutada", antes: { cap: 20 }, cuando: T(1) });
  // La vuelta siguiente pide lo mismo y el ejecutor lo rechaza: ya está frenado.
  b = registrar(b, { accion: "frenar_dominio", objetivo: "bizreport-control.com", motivo: "cruzó el umbral", estado: "rechazada", detalle: "ya está en cap 0", cuando: T(2) });
  assert.equal(b.entradas[0]?.estado, "rechazada", "el último desenlace es el rechazo, y así tiene que verlo el modelo");

  b = juzgar(b, idDe("frenar_dominio", "bizreport-control.com"), { cuando: T(3), datos: { cap: 255 } }, criterio);
  assert.equal(b.entradas[0]?.veredicto?.resultado, "no_sirvio", "se ejecutó alguna vez: hay efecto que medir");
  assert.match(b.entradas[0]?.veredicto?.medido ?? "", /el freno no quedó puesto/, "el hecho que nunca le llegó al modelo");

  // Y lo que NUNCA se ejecutó sigue sin juzgarse: no hay efecto que medir.
  let r = registrar(null, { accion: "frenar_dominio", objetivo: "nunca.com", motivo: "m", estado: "rechazada", detalle: "no habilitado", antes: { cap: 20 }, cuando: T(1) });
  r = juzgar(r, idDe("frenar_dominio", "nunca.com"), { cuando: T(2), datos: { cap: 0 } }, criterio);
  assert.equal(r.entradas[0]?.veredicto, null);
});

test("`ultimaEjecucion` no se limpia NUNCA, y `antes` sigue siendo el de la primera vez", () => {
  // Tres rechazos seguidos después de la ejecución: la fecha de la ejecución original tiene que
  // sobrevivir a los tres. Si se limpiara, el arreglo de arriba duraría exactamente una vuelta —
  // que es peor que no arreglarlo, porque parecería arreglado.
  let b = registrar(null, { accion: "frenar_dominio", objetivo: "x.com", motivo: "m", estado: "ejecutada", antes: { cap: 50 }, cuando: T(1) });
  for (const t of [T(2), T(3), T(4)]) {
    b = registrar(b, { accion: "frenar_dominio", objetivo: "x.com", motivo: "m", estado: "rechazada", detalle: "ya está en cap 0", cuando: t });
  }
  assert.equal(b.entradas[0]?.ultimaEjecucion, T(1), "el instante de la ejecución original");
  assert.equal(b.entradas[0]?.ultimaVez, T(4), "y `ultimaVez` sigue siendo el último intento: son dos preguntas distintas");
  assert.deepEqual(b.entradas[0]?.antes, { cap: 50 }, "contra este estado se juzga (comportamiento existente, no romperlo)");

  // Una ejecución posterior sí lo mueve: es la ÚLTIMA ejecución, no la primera.
  b = registrar(b, { accion: "frenar_dominio", objetivo: "x.com", motivo: "m", estado: "ejecutada", cuando: T(5) });
  assert.equal(b.entradas[0]?.ultimaEjecucion, T(5));
});

test("las 40 entradas VIEJAS, sin el campo, siguen siendo juzgables", () => {
  // El archivo de producción se escribió antes de que `ultimaEjecucion` existiera. Si el arreglo las
  // dejara afuera, dejaría afuera justo a las que motivaron el arreglo.
  const viejo: Bitacora = {
    version: 1,
    entradas: [
      {
        id: idDe("frenar_dominio", "x.com"),
        accion: "frenar_dominio",
        objetivo: "x.com",
        motivo: "m",
        estado: "ejecutada",
        detalle: null,
        primeraVez: T(1),
        ultimaVez: T(1),
        veces: 1,
        antes: { cap: 20 },
        veredicto: null
      } as never
    ]
  };
  const j = juzgar(viejo, idDe("frenar_dominio", "x.com"), { cuando: T(2), datos: { cap: 0 } }, () => ({ cuando: "", resultado: "sirvio", medido: "cap 0" }));
  assert.equal(j.entradas[0]?.veredicto?.resultado, "sirvio");
});

test("EL CONTADOR DE REPETICIÓN SALE EN LO EJECUTADO, no solo en lo rechazado", () => {
  // Se calculaba desde hace semanas y se interpolaba SOLO en la rama `rechazada`, o sea en 6 de las
  // 40 entradas de producción. Las otras 34 son ejecutadas y ahí está el bucle que duele: 306
  // ejecuciones para 63 resultados distintos (79% repetido). El caso real medido:
  // `diagnosticar_dominio bizregistry-ops.com`, pedido 46 veces. El modelo leía la línea como si
  // fuera la primera vez — porque para él LO ERA: cada vuelta arranca de cero y esta línea es todo
  // lo que sabe de su propio pasado.
  const conVeces = (veces: number, iguales: number): Bitacora => ({
    version: 1,
    entradas: [
      {
        id: idDe("diagnosticar_dominio", "bizregistry-ops.com"),
        accion: "diagnosticar_dominio",
        objetivo: "bizregistry-ops.com",
        motivo: "m",
        estado: "ejecutada",
        detalle: null,
        primeraVez: T(1),
        ultimaVez: T(2),
        ultimaEjecucion: T(2),
        veces,
        detalleIgualSeguidas: iguales,
        antes: null,
        veredicto: null
      }
    ]
  });

  assert.match(lineasParaPrompt(conVeces(41, 1), 6)[0]!, /41/, "el número tiene que estar en la línea, no en la cabeza de nadie");

  // Con el detalle cargado, el contador viaja igual.
  let conDetalle = registrar(null, { accion: "medir_dominio", objetivo: "x.com", motivo: "m", estado: "ejecutada", detalle: "sin tráfico", cuando: T(1) });
  conDetalle = registrar(conDetalle, { accion: "medir_dominio", objetivo: "x.com", motivo: "m", estado: "ejecutada", detalle: "sin tráfico", cuando: T(2) });
  assert.match(lineasParaPrompt(conDetalle, 6)[0]!, /lo pediste 2 veces/);

  // Y una acción pedida UNA sola vez no lleva contador: el caso normal no se ensucia.
  const unaSola = registrar(null, { accion: "medir_dominio", objetivo: "y.com", motivo: "m", estado: "ejecutada", detalle: "sin tráfico", cuando: T(1) });
  assert.doesNotMatch(lineasParaPrompt(unaSola, 6)[0]!, /lo pediste/);
});

test("cuando además VOLVIÓ LO MISMO, se dice cuántas seguidas — y el número no puede mentir", () => {
  // `veces` y `detalleIgualSeguidas` NO son el mismo número: la entrada real de producción tiene
  // veces=46 e iguales=8. Decir "las 46 devolvieron lo mismo" sería una falsedad medible, que es la
  // clase de frase que este proyecto ya pagó dos veces. Se afirma lo que el contador sabe.
  const entrada = (veces: number, iguales: number): Bitacora => ({
    version: 1,
    entradas: [
      {
        id: idDe("diagnosticar_dominio", "bizregistry-ops.com"),
        accion: "diagnosticar_dominio",
        objetivo: "bizregistry-ops.com",
        motivo: "m",
        estado: "ejecutada",
        detalle: "healthy, 0 entregados / 0 rechazados",
        primeraVez: T(1),
        ultimaVez: T(2),
        ultimaEjecucion: T(2),
        veces,
        detalleIgualSeguidas: iguales,
        antes: null,
        veredicto: null
      }
    ]
  });

  const cuatro = lineasParaPrompt(entrada(4, 4), 6)[0]!;
  assert.match(cuatro, /lo pediste 4 veces y las últimas 4 devolvieron lo mismo/);

  const real = lineasParaPrompt(entrada(46, 8), 6)[0]!;
  assert.match(real, /lo pediste 46 veces y las últimas 8 devolvieron lo mismo/);
  assert.doesNotMatch(real, /las 46 devolvieron/, "no se afirma sobre 46 lo que solo se sabe de 8");

  // Con menos de 3 iguales no se afirma repetición de resultado: dos seguidas puede ser casualidad y
  // el corte de `daLoMismo` ya se ocupa de ese caso por su lado.
  assert.doesNotMatch(lineasParaPrompt(entrada(5, 2), 6)[0]!, /devolvieron lo mismo/);
});

test("las líneas del prompt priorizan el bucle repetido y son acotadas", () => {
  let b = bitacoraVacia();
  for (let i = 0; i < 6; i++) {
    b = registrar(b, { accion: "anotar_pendiente", objetivo: `p${i}`, motivo: "m", estado: "ejecutada", cuando: T(1) });
  }
  b = registrar(b, { accion: "frenar_dominio", objetivo: "repetido.com", motivo: "m", estado: "rechazada", detalle: "no habilitado", cuando: T(1) });
  b = registrar(b, { accion: "frenar_dominio", objetivo: "repetido.com", motivo: "m", estado: "rechazada", detalle: "no habilitado", cuando: T(2) });

  const l = lineasParaPrompt(b, 3);
  assert.equal(l.length, 3, "respeta el tope: el prompt ya pesa y el relleno lo ahogó antes");
  assert.match(l[0] ?? "", /repetido\.com/, "lo repetido y rechazado va primero");
  assert.match(l[0] ?? "", /2 veces/);
  assert.match(l[0] ?? "", /no lo va a cambiar/, "le dice explícitamente que insistir no sirve");
});

test("sin bitácora no rompe ni inventa", () => {
  assert.deepEqual(lineasParaPrompt(null), []);
  assert.deepEqual(lineasParaPrompt(bitacoraVacia()), []);
  assert.deepEqual(lineasParaPrompt({ version: 1, entradas: [] as never }), []);
});

test("la rotación nunca tira una acción sin veredicto", () => {
  // Esa es justo la que falta juzgar: perderla es perder el aprendizaje.
  let b = bitacoraVacia();
  for (let i = 0; i < 50; i++) {
    b = registrar(b, { accion: "anotar_pendiente", objetivo: `viejo${i}`, motivo: "m", estado: "ejecutada", antes: { v: 1 }, cuando: T(1) });
    b = juzgar(b, idDe("anotar_pendiente", `viejo${i}`), { cuando: T(2), datos: { v: 2 } }, () => ({ cuando: "", resultado: "sirvio", medido: "x" }));
  }
  b = registrar(b, { accion: "frenar_dominio", objetivo: "sin-juzgar.com", motivo: "m", estado: "ejecutada", cuando: T(3) });
  assert.ok(b.entradas.length <= 41, "acota el archivo");
  assert.ok(b.entradas.some((e) => e.objetivo === "sin-juzgar.com"), "conserva la que falta juzgar");
});

test("LA PODA CUMPLE EL TOPE AUNQUE NADIE HAYA JUZGADO NADA", () => {
  // Medido en warmup-acciones.json de la Mac Studio: 54 entradas contra un tope de 40 (135%), con 0
  // veredictos. El recorte solo descartaba entradas CON veredicto, y `juzgar` corre únicamente
  // sobre `frenar_dominio` — de la que no hay UNA sola entrada en el archivo. O sea que MAX_ENTRADAS
  // estaba muerta por construcción y el JSON crecía sin techo, en un archivo que se lee, parsea,
  // re-serializa y reescribe ENTERO bajo lock en cada vuelta.
  let b = bitacoraVacia();
  for (let i = 0; i < 45; i++) {
    b = registrar(b, { accion: "diagnosticar_dominio", objetivo: `d${i}.com`, motivo: "m", estado: "ejecutada", cuando: `2026-08-07T10:${String(i).padStart(2, "0")}:00.000Z` });
  }
  assert.ok(b.entradas.length <= 40, `el tope se cumple sin un solo veredicto (fueron ${b.entradas.length})`);
  // Y lo que sobrevive es lo más RECIENTE: una entrada que nadie tocó en horas ya no corta ningún bucle.
  assert.ok(b.entradas.some((e) => e.objetivo === "d44.com"));
  assert.ok(!b.entradas.some((e) => e.objetivo === "d0.com"));
});

test("las juzgadas se tiran PRIMERO: de esas ya se aprendió lo que había", () => {
  let b = bitacoraVacia();
  for (let i = 0; i < 40; i++) {
    b = registrar(b, { accion: "medir_dominio", objetivo: `d${i}.com`, motivo: "m", estado: "ejecutada", antes: { muestra: 0 }, cuando: `2026-08-07T${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z` });
  }
  // La más VIEJA con veredicto es la primera candidata, aunque haya otras más viejas sin él.
  b = juzgar(b, idDe("medir_dominio", "d5.com"), { cuando: "2026-08-07T12:00:00.000Z", datos: { muestra: 3 } }, () => ({ cuando: "", resultado: "sirvio", medido: "3 mediciones nuevas" }));
  b = registrar(b, { accion: "medir_dominio", objetivo: "nuevo.com", motivo: "m", estado: "ejecutada", cuando: "2026-08-07T13:00:00.000Z" });
  assert.ok(!b.entradas.some((e) => e.objetivo === "d5.com"), "la juzgada se va antes que las viejas sin juzgar");
  assert.ok(b.entradas.some((e) => e.objetivo === "d0.com"), "y la vieja SIN juzgar se queda: falta juzgarla");
});

test("daLoMismo: dos resultados IDÉNTICOS seguidos son un bucle; uno distinto lo resetea", () => {
  // `diagnosticar_dominio bizregistry-ops.com` se pidió 34 veces y devolvió 34 veces lo mismo.
  const igual = { accion: "diagnosticar_dominio", objetivo: "bizregistry-ops.com", motivo: "m", estado: "ejecutada" as const, detalle: "sin datos en el log" };
  let b = registrar(null, { ...igual, cuando: T(1) });
  assert.equal(daLoMismo(b, "diagnosticar_dominio", "bizregistry-ops.com"), null, "la primera vez no es un bucle");
  b = registrar(b, { ...igual, cuando: T(2) });
  assert.equal(daLoMismo(b, "diagnosticar_dominio", "bizregistry-ops.com"), 2, "las últimas dos dieron lo mismo");

  // Un resultado distinto es información nueva: el bucle se corta solo y volver a preguntar deja de
  // ser repetir.
  b = registrar(b, { ...igual, detalle: "ahora sí: CERRADO en Gmail", cuando: T(3) });
  assert.equal(daLoMismo(b, "diagnosticar_dominio", "bizregistry-ops.com"), null);

  // Y una acción que nunca se pidió no tiene bucle que cortar.
  assert.equal(daLoMismo(b, "medir_dominio", "otro.com"), null);
  assert.equal(daLoMismo(null, "medir_dominio", "otro.com"), null);
});

test("los registros VIEJOS sin detalleIgualSeguidas no cortan nada", () => {
  // El archivo de producción tiene 54 entradas escritas antes de que el campo existiera. Ausente
  // cuenta como "primera vez", que es la dirección segura: no frena una consulta legítima.
  const viejo: Bitacora = { version: 1, entradas: [{ id: idDe("medir_dominio", "x.com"), accion: "medir_dominio", objetivo: "x.com", motivo: "m", estado: "ejecutada", detalle: "igual", primeraVez: T(1), ultimaVez: T(2), veces: 34, antes: null, veredicto: null }] };
  assert.equal(daLoMismo(viejo, "medir_dominio", "x.com"), null);
});

test("EL CAMINO DE PRODUCCIÓN: una acción EJECUTADA guarda su resultado en `motivo`, y el corte igual funciona", () => {
  // Esta es la forma EXACTA con la que escribe el único llamador real (scripts/ops/warmup-monitor.ts):
  //   motivo: a.detalle, detalle: a.ejecutada ? null : a.detalle
  // O sea que en una acción ejecutada —el caso medido, `diagnosticar_dominio bizregistry-ops.com`
  // 34 veces con la misma respuesta— el texto del resultado viaja en `motivo` y `detalle` llega en
  // `null`. Comparando solo `detalle`, el contador nunca se movía para las manos que SÍ se ejecutan:
  // el corte habría quedado escrito y apagado. Es la lección de "verificar por el camino de
  // producción": un fixture escrito desde mi suposición del wire ya escondió un bug entero acá.
  const comoEnProduccion = (texto: string, cuando: string) => ({
    accion: "diagnosticar_dominio",
    objetivo: "bizregistry-ops.com",
    motivo: texto,
    estado: "ejecutada" as const,
    detalle: null,
    cuando
  });
  let b = registrar(null, comoEnProduccion("bizregistry-ops.com: healthy, 0 entregados / 0 rechazados.", T(1)));
  assert.equal(daLoMismo(b, "diagnosticar_dominio", "bizregistry-ops.com"), null);
  b = registrar(b, comoEnProduccion("bizregistry-ops.com: healthy, 0 entregados / 0 rechazados.", T(2)));
  assert.equal(daLoMismo(b, "diagnosticar_dominio", "bizregistry-ops.com"), 2, "el bucle se ve aunque el texto viaje en motivo");

  // Y si el nodo empieza a contestar distinto, deja de ser un bucle.
  b = registrar(b, comoEnProduccion("bizregistry-ops.com: blocked_by_provider, CERRADO en: Gmail.", T(3)));
  assert.equal(daLoMismo(b, "diagnosticar_dominio", "bizregistry-ops.com"), null);
});

test("el corte NO puede volverse permanente: después de la negativa, la mano puede volver a mirar", () => {
  // Sin esto, la propia negativa queda escrita en la entrada, en la vuelta siguiente se lee igual a
  // sí misma y la mano queda cerrada PARA SIEMPRE sobre ese objetivo — incluso cuando el mundo
  // cambie. Un agente ciego es peor que uno repetitivo: estas cuatro manos no mutan nada.
  const ejecutada = (cuando: string) => ({ accion: "medir_dominio", objetivo: "x.com", motivo: "x.com: todavía no se midió nunca", estado: "ejecutada" as const, detalle: null, cuando });
  let b = registrar(null, ejecutada(T(1)));
  b = registrar(b, ejecutada(T(2)));
  assert.equal(daLoMismo(b, "medir_dominio", "x.com"), 2, "acá corta");

  // Y así es como el orquestador registra la negativa del propio corte: rechazada, con su texto.
  b = registrar(b, { accion: "medir_dominio", objetivo: "x.com", motivo: "rechazada: ya lo pediste 2 veces…", estado: "rechazada", detalle: "rechazada: ya lo pediste 2 veces…", cuando: T(3) });
  assert.equal(daLoMismo(b, "medir_dominio", "x.com"), null, "la vuelta siguiente puede volver a mirar");
});

test("EL PROMPT NO PUEDE AFIRMAR UN RESULTADO QUE NADIE DEVOLVIÓ: el motivo NO es el detalle", () => {
  // LA FALSEDAD MEDIDA CONTRA LA BITÁCORA REAL DE PRODUCCIÓN
  // (runtime/openclaw-workspace/inventory/warmup-acciones.json, 2026-08-07). El carril del chat
  // escribe `detalle: a.ejecutada ? null : a.detalle` y `motivo: "pedido por el jefe: <la pregunta
  // del jefe>"`. Con el fallback a `motivo`, esta función devolvía —textual, corriéndola sobre ese
  // archivo—:
  //
  //   "- revisar_reputacion bizreport-control.com se ejecutó y devolvió: pedido por el jefe:
  //    Entonces que hacemos, ese IP, ese smtp y ese dominio se pierde?"
  //
  // …bajo el título "LO QUE PEDISTE Y QUÉ PASÓ". O sea que el sistema le devolvía al modelo LA
  // PREGUNTA DEL JEFE presentada como la SALIDA DEL SENSOR. 3 de 33 entradas ejecutadas ese día eran
  // de esta clase, y las 3 del carril chat: el 100% del carril que falló.
  const soloMotivo = registrar(null, {
    accion: "revisar_reputacion",
    objetivo: "bizreport-control.com",
    motivo: "pedido por el jefe: Entonces que hacemos, ese IP, ese smtp y ese dominio se pierde?",
    estado: "ejecutada",
    detalle: null,
    cuando: "2026-08-07T22:05:00.000Z"
  });
  const linea = lineasParaPrompt(soloMotivo, 6)[0]!;
  assert.doesNotMatch(linea, /devolvió/, `sin detalle no se afirma nada: ${linea}`);
  assert.doesNotMatch(linea, /Entonces que hacemos/, "la pregunta del jefe NO es una medición");
  assert.match(linea, /todavía sin medir el efecto/, "la forma vieja, que es honesta");

  // Y con el detalle CARGADO —el carril de la guardia— sí se imprime, que es para lo que se hizo:
  // sin esto, de lo RECHAZADO volvía el detalle entero y de lo EJECUTADO solo la fecha.
  const conDetalle = registrar(null, {
    accion: "revisar_reputacion",
    objetivo: "bizreport-control.com",
    motivo: "barrido de la guardia",
    estado: "ejecutada",
    detalle: "bizreport-control.com: gmail.com le rechaza el correo hoy",
    cuando: "2026-08-07T22:05:00.000Z"
  });
  assert.match(lineasParaPrompt(conDetalle, 6)[0]!, /se ejecutó y devolvió: bizreport-control\.com: gmail\.com le rechaza/);
});

test("UN RENGLÓN DE BITÁCORA NO PUEDE SER MULTILÍNEA NI TRAER 10 KB AL PROMPT", () => {
  // El carril del chat guarda `detalle: a.detalle` CRUDO (scripts/ops/warmup-monitor.ts:1506), y la
  // salida de una herramienta puede ser larga y multilínea — la consulta de historia devuelve hasta
  // 13 renglones. Esto se interpola en UNA viñeta de una lista del prompt: sin recorte, un solo
  // renglón de bitácora parte la lista en pedazos y se come un presupuesto que ya está en ~6300
  // tokens. Los dos defectos van juntos porque el `slice` solo no alcanza: cortar sin aplanar deja
  // igual una viñeta partida.
  const largo = Array.from({ length: 13 }, (_, i) => `- 2026-08-0${(i % 9) + 1} (medición) corp-delivery.com: cayó en SPAM en la semilla de gmail`).join("\n");
  const b = registrar(null, {
    accion: "que_paso",
    objetivo: "corp-delivery.com",
    motivo: "pedido por el jefe",
    estado: "ejecutada",
    detalle: largo,
    cuando: "2026-08-07T22:05:00.000Z"
  });
  const linea = lineasParaPrompt(b, 6)[0]!;
  assert.equal(linea.split("\n").length, 1, "una viñeta es una línea: si trae saltos, rompe la lista del prompt");
  assert.ok(linea.length < 400, `el renglón mide ${linea.length}: sin tope se come el contexto`);
  assert.match(linea, /se ejecutó y devolvió: - 2026-08-01 \(medición\)/, "y sigue diciendo lo que devolvió, recortado pero no mudo");
});

// ── LA PREGUNTA DEL JEFE NO ES EL RESULTADO DE LA HERRAMIENTA ─────────────────────────────────────

/** Cómo registra el carril de CHAT: el motivo es la pregunta y el detalle se nulea en las ejecutadas. */
const comoElChat = (pregunta: string, cuando: string) => ({
  accion: "revisar_reputacion",
  objetivo: "corp-delivery.com",
  motivo: `pedido por el jefe: ${pregunta.slice(0, 80)}`,
  estado: "ejecutada" as const,
  detalle: null,
  cuando
});

test("REPREGUNTAR NO ES UN BUCLE: el jefe insiste y la mano no se corta ni se le miente al modelo", () => {
  // EL INCIDENTE DEL ENCARGO, por la puerta de atrás. `detalleIgualSeguidas` comparaba `detalle ??
  // motivo`, y el chat pasa la pregunta del jefe en `motivo` con `detalle` en null: se comparaba la
  // pregunta contra sí misma. Tres lecturas que devolvieron cosas DISTINTAS quedaban como "las
  // últimas 3 devolvieron lo mismo" en el prompt, y `daLoMismo` daba 3 y el ejecutor cortaba la
  // mano. O sea: el jefe repregunta y el agente se niega a mirar diciendo que ya contestó eso.
  //
  // Los tests de este archivo no lo cazaban porque arman las entradas con `detalle` cargado, forma
  // que el carril de chat nunca produce.
  let b: Bitacora | null = null;
  for (let i = 0; i < 3; i++) b = registrar(b, comoElChat("¿cuáles son los otros 4?", T(i + 1)));

  const e = b!.entradas[0]!;
  assert.equal(e.veces, 3, "sí lo pidió tres veces, y eso se sigue contando");
  assert.equal(e.detalleIgualSeguidas, 1, "pero no hay UN solo resultado registrado que comparar");
  assert.equal(daLoMismo(b, "revisar_reputacion", "corp-delivery.com"), null, "no se corta la mano que el jefe acaba de pedir");
  assert.doesNotMatch(lineasParaPrompt(b).join("\n"), /devolvieron lo mismo/, "afirmarlo sería una falsedad medible");
});

test("y el ANTIBUCLE de la guardia sigue contando: ahí el motivo SÍ es el resultado", () => {
  // La otra mitad, y por eso el fallback a `motivo` no se puede borrar de un saque: el carril de
  // guardia pasa `motivo: a.detalle`. Es el bucle medido en producción — diagnosticar_dominio
  // bizregistry-ops.com pedido 46 veces con 8 respuestas idénticas seguidas.
  let igual: Bitacora | null = null;
  for (let i = 0; i < 3; i++) igual = registrar(igual, { accion: "diagnosticar_dominio", objetivo: "z.com", motivo: "healthy, 0 entregados / 0 rechazados.", estado: "ejecutada", detalle: null, cuando: T(i + 1) });
  assert.equal(igual!.entradas[0]!.detalleIgualSeguidas, 3);
  assert.equal(daLoMismo(igual, "diagnosticar_dominio", "z.com"), 3, "esto sí es un bucle y se corta");

  let distinto: Bitacora | null = null;
  ["healthy", "blocked_by_provider, CERRADO en Gmail", "healthy otra vez"].forEach((s, i) => {
    distinto = registrar(distinto, { accion: "diagnosticar_dominio", objetivo: "y.com", motivo: s, estado: "ejecutada", detalle: null, cuando: T(i + 1) });
  });
  assert.equal(distinto!.entradas[0]!.detalleIgualSeguidas, 1, "un resultado distinto es información nueva");
});
