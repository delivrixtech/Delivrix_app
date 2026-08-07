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
