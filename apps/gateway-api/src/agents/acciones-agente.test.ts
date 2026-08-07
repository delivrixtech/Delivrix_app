// Tests de las manos del agente. Lo que protegen NO es que las acciones funcionen — es que las
// que NO están permitidas no se ejecuten. Todo lo que entra acá lo escribió un modelo, así que se
// trata como entrada hostil.

import assert from "node:assert/strict";
import test from "node:test";

import {
  CAP_AL_SOLTAR,
  ejecutarAcciones,
  extraerAcciones,
  MAX_ACCIONES_POR_VUELTA,
  porQueNoVuelve,
  type ContextoAcciones,
  type Pendiente,
  type ReputacionLeida
} from "./acciones-agente.ts";
import { revisarReputacionDe } from "./reputacion.ts";

const AHORA = new Date("2026-08-04T17:00:00.000Z");

function ctx(over: Partial<ContextoAcciones> = {}): ContextoAcciones & { frenados: string[]; pausas: string[]; lista: Pendiente[] } {
  const frenados: string[] = [];
  const pausas: string[] = [];
  const lista: Pendiente[] = [];
  return {
    frenados, pausas, lista,
    dominiosConocidos: ["a.com", "b.com"],
    ahora: () => AHORA,
    frenarDominio: async (d) => { frenados.push(d); return { antes: 20, despues: 0 }; },
    pausarWarmup: async (m) => { pausas.push(m); },
    warmupPausado: async () => pausas.length > 0,
    pendientes: { listar: async () => lista, guardar: async (p) => { lista.length = 0; lista.push(...p); } },
    ...over
  } as never;
}

test("una acción que NO está en la lista blanca no se ejecuta, y se dice", () => {
  return ejecutarAcciones([{ accion: "borrar_todo", motivo: "porque sí" }], ctx()).then((r) => {
    assert.equal(r[0]!.ejecutada, false);
    assert.match(r[0]!.detalle, /no es una acción permitida/);
  });
});

test("NO se puede frenar un dominio que no existe: un nombre alucinado no llega al SSH", async () => {
  const c = ctx();
  const r = await ejecutarAcciones([{ accion: "frenar_dominio", dominio: "inventado.com", motivo: "x" }], c);
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /no está en el inventario/);
  assert.deepEqual(c.frenados, [], "no se tocó nada");
});

test("frenar un dominio real sí se ejecuta y deja antes/después", async () => {
  const c = ctx();
  const r = await ejecutarAcciones([{ accion: "frenar_dominio", dominio: "A.com", motivo: "cruzó el umbral" }], c);
  assert.equal(r[0]!.ejecutada, true);
  assert.deepEqual(c.frenados, ["a.com"]);
  assert.equal(r[0]!.antes, 20);
  assert.equal(r[0]!.despues, 0);
});

test("toda acción exige MOTIVO: sin él no se ejecuta", async () => {
  // Una acción automática sin motivo registrado es indefendible después.
  const c = ctx();
  const r = await ejecutarAcciones([{ accion: "frenar_dominio", dominio: "a.com" }], c);
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /motivo/);
  assert.deepEqual(c.frenados, []);
});

test("pausar es IDEMPOTENTE: si ya estaba pausado no se reporta como acción nueva", async () => {
  const c = ctx();
  await ejecutarAcciones([{ accion: "pausar_warmup", motivo: "placement en caída" }], c);
  const r2 = await ejecutarAcciones([{ accion: "pausar_warmup", motivo: "placement en caída" }], c);
  assert.equal(r2[0]!.ejecutada, false);
  assert.match(r2[0]!.detalle, /ya estaba pausado/);
  assert.equal(c.pausas.length, 1);
});

test("una capacidad no habilitada se rechaza en vez de romper", async () => {
  const r = await ejecutarAcciones([{ accion: "pausar_warmup", motivo: "x" }], ctx({ pausarWarmup: undefined }));
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /no está habilitado/);
});

test("el mismo pendiente NO se duplica: suma al contador", async () => {
  // Sin esto, "falta una semilla de Yahoo" crearía un pendiente cada 10 minutos y la lista sería
  // inservible en un día.
  const c = ctx();
  await ejecutarAcciones([{ accion: "anotar_pendiente", dominio: "semilla de yahoo", motivo: "punto ciego" }], c);
  await ejecutarAcciones([{ accion: "anotar_pendiente", dominio: "semilla de yahoo", motivo: "punto ciego" }], c);
  assert.equal(c.lista.length, 1);
  assert.equal(c.lista[0]!.visto, 2);
});

test("resolver un pendiente inexistente se rechaza", async () => {
  const r = await ejecutarAcciones([{ accion: "resolver_pendiente", id: "no-existe", motivo: "x" }], ctx());
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /no hay pendiente abierto/);
});

test("hay un TOPE de acciones por lectura, y lo que se descarta se declara", async () => {
  // Un agente que hace veinte cosas de golpe no se puede auditar.
  const c = ctx();
  const muchas = Array.from({ length: 6 }, () => ({ accion: "frenar_dominio", dominio: "a.com", motivo: "x" }));
  const r = await ejecutarAcciones(muchas, c);
  assert.equal(c.frenados.length, MAX_ACCIONES_POR_VUELTA);
  assert.match(r.at(-1)!.detalle, /se ignoraron 3/);
});

// ── Extracción del texto del modelo ─────────────────────────────────────────────────────────────

test("extrae acciones de las líneas ACCION y nada más", () => {
  const a = extraerAcciones(
    "AHORA: todo bien.\nACCION: frenar_dominio | dominio=a.com | motivo=cruzó el umbral\nRIESGO: ninguno"
  );
  assert.equal(a.length, 1);
  assert.equal(a[0]!.accion, "frenar_dominio");
  assert.equal(a[0]!.dominio, "a.com");
  assert.equal(a[0]!.motivo, "cruzó el umbral");
});

test("una lectura sin acciones no produce ninguna", () => {
  assert.deepEqual(extraerAcciones("AHORA: todo bien.\nFALTA: nada"), []);
});

test("una línea mal formada se IGNORA, no se adivina", () => {
  // Adivinar sobre una acción que toca producción es exactamente lo que no queremos.
  assert.deepEqual(extraerAcciones("ACCION:"), []);
});

// ── Dedup de pendientes reformulados ─────────────────────────────────────────────────────────────
// Visto en producción a los diez minutos de habilitar las acciones: el agente anotó la MISMA cosa
// tres veces con tres redacciones. Los modelos reformulan; con dedup exacto la promesa de "anotalo
// una sola vez" se rompe el primer día.

import { mismoPendiente } from "./acciones-agente.ts";

test("reconoce como el mismo pendiente las tres redacciones que salieron en vivo", () => {
  assert.equal(mismoPendiente("outlook y yahoo", "semillas para outlook y yahoo"), true);
  assert.equal(mismoPendiente("outlook y yahoo", "outlook,yahoo"), true);
  assert.equal(mismoPendiente("semillas para outlook y yahoo", "outlook,yahoo"), true);
});

test("NO confunde pendientes de temas distintos", () => {
  assert.equal(mismoPendiente("semilla de yahoo", "soltar cupo en corpfiling-infra.com"), false);
  assert.equal(mismoPendiente("semilla de outlook", "semilla de gmail"), false);
});

test("los acentos y la puntuación no crean duplicados", () => {
  assert.equal(mismoPendiente("revisión del cupo", "revision del cupo!"), true);
});

test("dos pendientes con redacciones distintas se juntan en uno", async () => {
  const c = ctx();
  await ejecutarAcciones([{ accion: "anotar_pendiente", dominio: "outlook y yahoo", motivo: "punto ciego" }], c);
  await ejecutarAcciones([{ accion: "anotar_pendiente", dominio: "semillas para outlook y yahoo", motivo: "punto ciego" }], c);
  await ejecutarAcciones([{ accion: "anotar_pendiente", dominio: "outlook,yahoo", motivo: "punto ciego" }], c);
  assert.equal(c.lista.length, 1, "una sola entrada, no tres");
  assert.equal(c.lista[0]!.visto, 3);
});

test("el freno tiene ALCANCE: solo donde el daño ya está hecho", async () => {
  // Un dominio sano frenado por decisión del modelo cuesta calentamiento real. Uno que ya cruzó
  // el umbral permanente no tiene nada que perder. La diferencia no puede quedar librada al juicio
  // del modelo: es una barrera.
  const frenados: string[] = [];
  const ctx = {
    dominiosConocidos: ["sano.com", "cruzado.com"],
    frenablesConDanio: ["cruzado.com"],
    frenarDominio: async (d: string) => {
      frenados.push(d);
      return { antes: 50, despues: 0 };
    }
  };

  const sobreSano = await ejecutarAcciones(
    [{ accion: "frenar_dominio", dominio: "sano.com", motivo: "me parece" }],
    ctx as never
  );
  assert.equal(sobreSano[0]?.ejecutada, false, "un dominio sano NO se frena solo");
  assert.match(sobreSano[0]?.detalle ?? "", /no cruzó el umbral/);
  assert.match(sobreSano[0]?.detalle ?? "", /pendiente/, "le dice cuál es la salida correcta");
  assert.deepEqual(frenados, [], "no llegó a tocar la flota");

  const sobreCruzado = await ejecutarAcciones(
    [{ accion: "frenar_dominio", dominio: "cruzado.com", motivo: "cruzó el umbral permanente" }],
    ctx as never
  );
  assert.equal(sobreCruzado[0]?.ejecutada, true, "donde el daño ya está hecho, sí actúa");
  assert.deepEqual(frenados, ["cruzado.com"]);

  // Sin alcance declarado se mantiene el comportamiento previo (tests y dry-run).
  const sinAlcance = await ejecutarAcciones(
    [{ accion: "frenar_dominio", dominio: "sano.com", motivo: "m" }],
    { dominiosConocidos: ["sano.com"], frenarDominio: async () => ({ antes: 10, despues: 0 }) } as never
  );
  assert.equal(sinAlcance[0]?.ejecutada, true);
});

test("cada acción deja su SUJETO, o la bitácora no sirve", async () => {
  // Sin `objetivo`, "frenar A" y "frenar B" colapsan en la misma entrada de la bitácora: `veces`
  // sube por acciones distintas y el veredicto se le aplica al dominio equivocado.
  const r = await ejecutarAcciones(
    [
      { accion: "frenar_dominio", dominio: "a.com", motivo: "m" },
      { accion: "frenar_dominio", dominio: "fantasma.com", motivo: "m" }
    ],
    { dominiosConocidos: ["a.com"], frenarDominio: async () => ({ antes: 5, despues: 0 }) } as never
  );
  assert.equal(r[0]?.objetivo, "a.com", "la ejecutada dice sobre qué");
  assert.equal(r[1]?.objetivo, "fantasma.com", "la RECHAZADA también: es la que más se repite");
});

test("si el JEFE lo ordena, el alcance del freno se relaja — pero solo ese", async () => {
  // El alcance existe para acotar al MODELO: que no decida frenar un dominio sano por su cuenta.
  // Si Juanes lo ordena por su canal privado, es su fábrica y su decisión; negarse sería tratarlo
  // como si fuera el modelo.
  const frenados: string[] = [];
  const base = {
    dominiosConocidos: ["sano.com"],
    frenablesConDanio: ["otro.com"],
    frenarDominio: async (d: string) => {
      frenados.push(d);
      return { antes: 40, despues: 0 };
    }
  };

  const porElModelo = await ejecutarAcciones([{ accion: "frenar_dominio", dominio: "sano.com", motivo: "m" }], base as never);
  assert.equal(porElModelo[0]?.ejecutada, false, "el modelo solo, no");

  const porElJefe = await ejecutarAcciones(
    [{ accion: "frenar_dominio", dominio: "sano.com", motivo: "me lo pidió Juanes" }],
    { ...base, ordenadoPorElJefe: true } as never
  );
  assert.equal(porElJefe[0]?.ejecutada, true, "ordenado por el jefe, sí");
  assert.deepEqual(frenados, ["sano.com"]);
});

test("lo que NO se destraba ni con orden del jefe: un dominio que no existe", async () => {
  // El alcance es criterio; que el dominio EXISTA es un hecho. Una orden no puede crear un nodo.
  const r = await ejecutarAcciones(
    [{ accion: "frenar_dominio", dominio: "fantasma.com", motivo: "dale" }],
    { dominiosConocidos: ["real.com"], ordenadoPorElJefe: true, frenarDominio: async () => ({ antes: 1, despues: 0 }) } as never
  );
  assert.equal(r[0]?.ejecutada, false);
  assert.match(r[0]?.detalle ?? "", /no está en el inventario/);
});

test("leer_cupo_nodo: la mano que le permite IR A VER en vez de opinar sobre una foto", async () => {
  // Sin ella el agente afirmó "bizreport-control.com sigue con cupo 255" leyendo un archivo de
  // horas, cuando el nodo real ya estaba en 0 porque él mismo lo había frenado.
  const r = await ejecutarAcciones(
    [{ accion: "leer_cupo_nodo", dominio: "x.com", motivo: "quiero confirmar antes de afirmar" }],
    {
      dominiosConocidos: ["x.com"],
      leerCupoNodo: async () => ({ cap: 0, consumidoHoy: null })
    } as never
  );
  assert.equal(r[0]?.ejecutada, true);
  assert.match(r[0]?.detalle ?? "", /FRENADO \(cupo 0\)/);
  assert.equal(r[0]?.objetivo, "x.com");
});

test("un nodo ilegible NO se reporta como frenado", async () => {
  // Si "no pude leer" se mostrara como 0, el agente concluiría que su freno funcionó cuando en
  // realidad no sabe nada. Ausencia de dato no es evidencia.
  const r = await ejecutarAcciones(
    [{ accion: "leer_cupo_nodo", dominio: "x.com", motivo: "m" }],
    { dominiosConocidos: ["x.com"], leerCupoNodo: async () => ({ cap: null, consumidoHoy: null }) } as never
  );
  assert.match(r[0]?.detalle ?? "", /no se pudo leer el cupo/);
  assert.ok(!/FRENADO/.test(r[0]?.detalle ?? ""));

  // Y si el nodo está incomunicado, la acción falla honestamente en vez de inventar.
  const roto = await ejecutarAcciones(
    [{ accion: "leer_cupo_nodo", dominio: "x.com", motivo: "m" }],
    { dominiosConocidos: ["x.com"], leerCupoNodo: async () => { throw new Error("ssh timeout"); } } as never
  );
  assert.equal(roto[0]?.ejecutada, false);
  assert.match(roto[0]?.detalle ?? "", /no pude leer el nodo/);
});

test("diagnosticar_dominio: dice QUIÉN lo rechaza, que es lo que nadie leía", async () => {
  // La lección más cara del proyecto: 38 de 64 nodos estaban cerrados en Gmail mientras el chequeo
  // de listas negras decía "0 blacklist". La evidencia llevaba semanas en el mail.log de cada
  // máquina. Esta mano la lee.
  const r = await ejecutarAcciones(
    [{ accion: "diagnosticar_dominio", dominio: "x.com", motivo: "quiero saber por qué no entrega" }],
    {
      dominiosConocidos: ["x.com"],
      diagnosticarDominio: async () => ({
        estado: "blocked_by_provider",
        bloqueanPor: ["gmail.com"],
        degradadoEn: ["yahoo.com"],
        entregados: 12,
        rechazados: 430,
        detalle: "550-5.7.1 unsolicited mail"
      })
    } as never
  );
  assert.equal(r[0]?.ejecutada, true);
  assert.match(r[0]?.detalle ?? "", /CERRADO en: gmail\.com/, "dice quién, no solo que está mal");
  assert.match(r[0]?.detalle ?? "", /Rechazo parcial en: yahoo\.com/);
  assert.match(r[0]?.detalle ?? "", /12 entregados \/ 430 rechazados/);
  assert.match(r[0]?.detalle ?? "", /5\.7\.1/, "trae el motivo real del receptor");
});

test("un dominio inventado no llega a abrir SSH, ni para diagnosticar", async () => {
  let llamado = false;
  const r = await ejecutarAcciones(
    [{ accion: "diagnosticar_dominio", dominio: "fantasma.com", motivo: "m" }],
    {
      dominiosConocidos: ["real.com"],
      diagnosticarDominio: async () => {
        llamado = true;
        return { estado: "ok", bloqueanPor: [], degradadoEn: [], entregados: 0, rechazados: 0, detalle: "" };
      }
    } as never
  );
  assert.equal(r[0]?.ejecutada, false);
  assert.equal(llamado, false, "ni siquiera se intentó la conexión");
});

// ── SOLTAR: la única acción que aumenta volumen ─────────────────────────────────────────────────
//
// Hasta hoy el agente solo sabía reducir, y esa asimetría tenía un costo real: cada dominio listo
// para arrancar esperaba a que un humano lo soltara a mano. Lo que hace que soltar sea seguro no es
// que el modelo elija bien —es que el modelo casi no elige: propone el candidato, el código
// verifica contra la infraestructura viva, y el cupo es una constante que él no puede tocar.

/** Contexto de soltar con todo en verde; cada test rompe UNA condición. */
function ctxSoltar(over: Partial<ContextoAcciones> = {}): ContextoAcciones & { soltados: Array<[string, number]> } {
  const soltados: Array<[string, number]> = [];
  return {
    soltados,
    dominiosConocidos: ["listo.com"],
    // "TODO EN VERDE" INCLUYE HABER LEÍDO LA MEDICIÓN DE FLOTA. Antes este helper no traía el campo
    // y los tests pasaban igual, porque `undefined` se colapsaba a "no cruzó" — o sea que la suite
    // entera de soltar corría por el camino que fallaba abierto sin que nadie lo viera.
    //
    // Y DESPUÉS traía `[]`, que fue peor: el helper declaraba "la lista vacía dice se leyó y nadie
    // cruzó", pero `[]` es TRUTHY, así que la suite volvió a correr por el mismo camino y el
    // arreglo se declaró hecho estando abierto. La lista de acá es NO VACÍA a propósito y trae un
    // dominio ajeno, que es la forma exacta que tiene producción (9 dominios cruzados, ninguno de
    // ellos el candidato).
    frenablesConDanio: ["quemado-ajeno.com"],
    ahora: () => AHORA,
    leerCupoNodo: async () => ({ cap: 0, consumidoHoy: null }),
    diagnosticarDominio: async () => ({ estado: "ok", bloqueanPor: [], degradadoEn: [], entregados: 10, rechazados: 0, detalle: "" }),
    medirDominio: async () => ({ tasaInbox: null, muestra: 0, diaN: null, ultimaMedicion: null }),
    soltarDominio: async (d, cap) => { soltados.push([d, cap]); return { antes: 0, despues: cap }; },
    pendientes: { listar: async () => [], guardar: async () => {} },
    ...over
  } as never;
}

test("soltar: con todo en verde suelta — y el cupo NO lo elige el modelo", async () => {
  const c = ctxSoltar();
  // El modelo pide un cupo enorme en el motivo: no tiene por dónde entrar. `cap` es constante.
  const r = await ejecutarAcciones([{ accion: "soltar_dominio", dominio: "listo.com", motivo: "soltalo con cupo 5000" }], c);
  assert.equal(r[0]!.ejecutada, true);
  assert.deepEqual(c.soltados, [["listo.com", CAP_AL_SOLTAR]]);
  assert.match(r[0]!.detalle, /cupo 20\/día/);
  assert.match(r[0]!.detalle, /sin mediciones previas/, "dice que arranca de cero, no inventa un 0%");
});

test("soltar: si el receptor le tiene la puerta cerrada, NO suelta", async () => {
  // Soltar contra una puerta cerrada no calienta: produce rebotes, y los rebotes son lo que empuja
  // al umbral permanente de Google. Es estrictamente peor que no hacer nada.
  const c = ctxSoltar({
    diagnosticarDominio: async () => ({ estado: "blocked_by_provider", bloqueanPor: ["Yahoo", "Gmail"], degradadoEn: [], entregados: 0, rechazados: 40, detalle: "" })
  });
  const r = await ejecutarAcciones([{ accion: "soltar_dominio", dominio: "listo.com", motivo: "ya descansó" }], c);
  assert.equal(r[0]!.ejecutada, false);
  assert.deepEqual(c.soltados, []);
  assert.match(r[0]!.detalle, /Yahoo, Gmail/);
});

test("soltar: si ya estaba suelto, no lo reporta como acción", async () => {
  const c = ctxSoltar({ leerCupoNodo: async () => ({ cap: 20, consumidoHoy: 3 }) });
  const r = await ejecutarAcciones([{ accion: "soltar_dominio", dominio: "listo.com", motivo: "x" }], c);
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /ya está suelto/);
  assert.deepEqual(c.soltados, []);
});

test("soltar: un nodo ILEGIBLE no se trata como frenado", async () => {
  // La trampa: `cap: null` es "no sé", y confundirlo con 0 haría soltar un nodo que quizá ya estaba
  // enviando. Un dato ausente nunca puede valer como permiso.
  const c = ctxSoltar({ leerCupoNodo: async () => ({ cap: null, consumidoHoy: null }) });
  const r = await ejecutarAcciones([{ accion: "soltar_dominio", dominio: "listo.com", motivo: "x" }], c);
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /no suelto a ciegas/i);
});

test("soltar: con historia propia mala, no vuelve", async () => {
  const c = ctxSoltar({ medirDominio: async () => ({ tasaInbox: 0.2, muestra: 5, diaN: 3, ultimaMedicion: "2026-08-05" }) });
  const r = await ejecutarAcciones([{ accion: "soltar_dominio", dominio: "listo.com", motivo: "démosle otra" }], c);
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /20% de bandeja sobre 5/);
});

test("soltar: poca muestra NO bloquea — si no, es el mismo candado de la flota", async () => {
  // Un dominio con 1 sola medición mala no tiene historia: es un dominio nuevo. Exigirle evidencia
  // que solo puede conseguir enviando es exactamente el candado que paralizó la flota entera.
  const c = ctxSoltar({ medirDominio: async () => ({ tasaInbox: 0, muestra: 1, diaN: 0, ultimaMedicion: "2026-08-05" }) });
  const r = await ejecutarAcciones([{ accion: "soltar_dominio", dominio: "listo.com", motivo: "recién arranca" }], c);
  assert.equal(r[0]!.ejecutada, true);
  assert.deepEqual(c.soltados, [["listo.com", CAP_AL_SOLTAR]]);
});

test("soltar: sin con qué verificar, NO suelta", async () => {
  // Un chequeo que no se puede hacer no es un chequeo que pasa. Si falta el instrumento de una sola
  // condición, la acción no ocurre.
  for (const falta of ["leerCupoNodo", "diagnosticarDominio", "medirDominio"] as const) {
    const c = ctxSoltar({ [falta]: undefined });
    const r = await ejecutarAcciones([{ accion: "soltar_dominio", dominio: "listo.com", motivo: "x" }], c);
    assert.equal(r[0]!.ejecutada, false, `sin ${falta} no puede soltar`);
    assert.match(r[0]!.detalle, /no se suelta nada/);
  }
});

test("soltar: si el chequeo REVIENTA, tampoco suelta", async () => {
  const c = ctxSoltar({ diagnosticarDominio: async () => { throw new Error("ssh timeout"); } });
  const r = await ejecutarAcciones([{ accion: "soltar_dominio", dominio: "listo.com", motivo: "x" }], c);
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /ssh timeout/);
  assert.deepEqual(c.soltados, []);
});

test("soltar: un dominio inventado no llega ni al primer chequeo", async () => {
  const c = ctxSoltar();
  const r = await ejecutarAcciones([{ accion: "soltar_dominio", dominio: "inventado.com", motivo: "x" }], c);
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /no está en el inventario/);
  assert.deepEqual(c.soltados, []);
});

test("medir: distingue 'nunca se midió' de '0% de bandeja'", async () => {
  // Colapsar ausencia de dato con dato malo es la confusión más cara del sistema: el agente ya
  // trató un "no medido" como evidencia de que no había riesgo.
  const nunca = await ejecutarAcciones(
    [{ accion: "medir_dominio", dominio: "listo.com", motivo: "ver si está para volver" }],
    ctxSoltar()
  );
  assert.match(nunca[0]!.detalle, /todavía no se midió nunca/);

  const cero = await ejecutarAcciones(
    [{ accion: "medir_dominio", dominio: "listo.com", motivo: "ver" }],
    ctxSoltar({ medirDominio: async () => ({ tasaInbox: 0, muestra: 4, diaN: 2, ultimaMedicion: "2026-08-05" }) })
  );
  assert.match(cero[0]!.detalle, /0% de bandeja sobre 4 mediciones/);
  assert.match(cero[0]!.detalle, /día 2 de rampa/);
});

test("soltar: un dominio QUEMADO no vuelve nunca, ni por orden del jefe", async () => {
  // El hueco que casi se escapa: cruzar el umbral permanente de Google NO aparece como "el
  // receptor te bloquea" —el correo sigue entrando, solo que a spam para siempre— así que los
  // chequeos por SSH lo dejaban pasar. Es el peor caso posible de soltar: gastar envíos en un daño
  // que ya es irreversible, empujándolo más adentro.
  const c = ctxSoltar({ frenablesConDanio: ["listo.com"] });
  const r = await ejecutarAcciones([{ accion: "soltar_dominio", dominio: "listo.com", motivo: "ya descansó bastante" }], c);
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /umbral permanente/);
  assert.deepEqual(c.soltados, []);

  // Ni siquiera si lo ordena Juanes: su autoridad puede levantar los límites que existen para
  // acotar al MODELO, no un hecho físico del mundo.
  const conOrden = ctxSoltar({ frenablesConDanio: ["listo.com"], ordenadoPorElJefe: true });
  const r2 = await ejecutarAcciones([{ accion: "soltar_dominio", dominio: "listo.com", motivo: "soltalo igual" }], conOrden);
  assert.equal(r2[0]!.ejecutada, false);
  assert.deepEqual(conOrden.soltados, []);
});

test("soltar: SIN la medición de flota no se suelta NADA — el gate del umbral no falla abierto", async () => {
  // EL AGUJERO: `frenablesConDanio` sale de `hechos.flota?.cruzados ?? []`, y `hechos.flota` se lee
  // con un `.catch(() => null)`. Un sender-measurement.json ilegible —o a medio escribir durante un
  // deploy, que es exactamente lo que está pasando hoy en el carril de al lado— dejaba la lista sin
  // el campo, `Boolean(undefined)` daba false, y un dominio que cruzó el umbral PERMANENTE de Google
  // volvía al pool con cupo 20. Con WARMUP_AGENT_PUEDE_SOLTAR=true prendido en producción.
  //
  // El comentario del switch decía que este rechazo "no depende de leer nada por SSH, así que un
  // dominio quemado se rechaza aunque toda la infraestructura de chequeo esté caída". Era cierto a
  // medias: no depende del SSH, pero sí de un archivo JSON. Ahora el "no sé" no habilita.
  const c = ctxSoltar({ frenablesConDanio: undefined });
  const r = await ejecutarAcciones([{ accion: "soltar_dominio", dominio: "listo.com", motivo: "está listo" }], c);
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /no sé si cruzó el umbral permanente/);
  assert.deepEqual(c.soltados, [], "ni un solo dominio sale al pool sin esa medición");

  // Y tampoco lo levanta una orden del jefe: no se sabe si cruzó, y eso no lo decide la autoridad.
  const conOrden = ctxSoltar({ frenablesConDanio: undefined, ordenadoPorElJefe: true });
  const r2 = await ejecutarAcciones([{ accion: "soltar_dominio", dominio: "listo.com", motivo: "soltalo igual" }], conOrden);
  assert.equal(r2[0]!.ejecutada, false);
  assert.deepEqual(conOrden.soltados, []);
});

test("soltar: la LISTA VACÍA tampoco habilita — es la forma que produce el orquestador cuando no pudo leer la flota", async () => {
  // EL MISMO AGUJERO, SEGUNDA VUELTA, y la razón por la que el arreglo anterior no cerró nada:
  // `[]` es TRUTHY en JavaScript. El único productor real es
  // scripts/ops/warmup-monitor.ts:596 (guardia) y :1015 (chat):
  //     frenablesConDanio: [...new Set([...(hechos.flota?.cruzados ?? []), ...(hechos.cap?.enElTope ?? [])])]
  // Un spread SIEMPRE devuelve array. Con `sender-measurement.json` ilegible —se lee con
  // `.catch(() => null)`, y `hechos.flota` queda en null— eso da `[]`, no `undefined`. O sea que el
  // test de arriba cubría el ÚNICO valor que producción NO puede emitir, y el valor que sí emite
  // pasaba derecho: reproducido con `ejecutarAcciones` real ⇒ `ejecutada: true`, cupo 20 sobre
  // bizreport-control.com, con WARMUP_AGENT_PUEDE_SOLTAR=true prendido en producción.
  //
  // Y el prompt no mentía: `lineasDeFrenados` con flota null ya decía "umbral permanente: sin dato"
  // mientras el gate, en silencio, decía "no cruzó". El agente leía la verdad y el código no.
  const c = ctxSoltar({ frenablesConDanio: [] });
  const r = await ejecutarAcciones([{ accion: "soltar_dominio", dominio: "listo.com", motivo: "está listo" }], c);
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /no sé si cruzó el umbral permanente/);
  assert.deepEqual(c.soltados, [], "una lista vacía es 'no se pudo leer', no 'nadie cruzó'");

  const conOrden = ctxSoltar({ frenablesConDanio: [], ordenadoPorElJefe: true });
  const r2 = await ejecutarAcciones([{ accion: "soltar_dominio", dominio: "listo.com", motivo: "soltalo igual" }], conOrden);
  assert.equal(r2[0]!.ejecutada, false);
  assert.deepEqual(conOrden.soltados, []);

  // Y `null` explícito, que es la forma que el orquestador TIENE que empezar a emitir.
  const nulo = ctxSoltar({ frenablesConDanio: null as never });
  const r3 = await ejecutarAcciones([{ accion: "soltar_dominio", dominio: "listo.com", motivo: "está listo" }], nulo);
  assert.equal(r3[0]!.ejecutada, false);
  assert.deepEqual(nulo.soltados, []);
});

test("frenar: ese mismo `null` no puede ABRIR el alcance del freno", async () => {
  // La trampa de admitir tres estados en un campo que usan DOS acciones en direcciones opuestas.
  // El alcance del freno se rechaza con `[]` (lista leída, este dominio no tiene daño). Si `null`
  // cayera en el mismo `if (ctx.frenablesConDanio && …)`, sería falsy ⇒ "sin restricción" ⇒ el
  // modelo podría frenar CUALQUIERA de los 58 justo cuando no se pudo leer la flota. O sea: el
  // arreglo del gate de soltar abriría el del freno.
  const c = ctx({ dominiosConocidos: ["sano.com"], frenablesConDanio: null as never, frenarDominio: async () => ({ antes: 20, despues: 0 }) });
  const r = await ejecutarAcciones([{ accion: "frenar_dominio", dominio: "sano.com", motivo: "me parece" }], c);
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /no se pudo leer la medición de la flota/);

  // `undefined` sigue significando "este entorno no restringe" (dry-run y tests): no cambia.
  const libre = ctx({ dominiosConocidos: ["sano.com"], frenarDominio: async () => ({ antes: 20, despues: 0 }) });
  const r2 = await ejecutarAcciones([{ accion: "frenar_dominio", dominio: "sano.com", motivo: "x" }], libre);
  assert.equal(r2[0]!.ejecutada, true);
});

test("soltar: el rechazo por daño consumado NO necesita SSH", async () => {
  // Va primero justamente para esto: si la infraestructura de chequeo está caída, un dominio
  // quemado tiene que rechazarse igual. Fallar hacia "no sé, mejor lo suelto" sería el peor
  // fail-open del sistema.
  const c = ctxSoltar({
    frenablesConDanio: ["listo.com"],
    leerCupoNodo: async () => { throw new Error("ssh caído"); },
    diagnosticarDominio: async () => { throw new Error("ssh caído"); }
  });
  const r = await ejecutarAcciones([{ accion: "soltar_dominio", dominio: "listo.com", motivo: "x" }], c);
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /umbral permanente/, "rechaza por el motivo real, no por el error de SSH");
});

test("si el SSH revienta, la excepción NO se escapa: el agente sigue vivo", async () => {
  // Era el hallazgo más grave de la auditoría de la noche del 2026-08-06. `limite-fisico.ts` sale
  // con código 1 cuando un nodo falla —o simplemente tarda más de 120s— y promisify(execFile) lo
  // convierte en rechazo. Frenar y soltar eran los ÚNICOS awaits desnudos del switch, así que el
  // throw subía hasta main().catch(→ process.exit(1)): launchd relanza a los 10s, el prompt de
  // entrada es idéntico porque no se persistió nada, el modelo vuelve a pedir lo mismo y vuelve a
  // morir. Bucle de crash con el vigilante mudo toda la noche, y el watchdog ni lo mira.
  const revienta = async () => { throw new Error("Command failed: limite-fisico.ts --frenar --apply"); };

  const f = await ejecutarAcciones(
    [{ accion: "frenar_dominio", dominio: "a.com", motivo: "cruzó el umbral" }],
    ctx({ dominiosConocidos: ["a.com"], frenarDominio: revienta as never })
  );
  assert.equal(f[0]!.ejecutada, false);
  assert.match(f[0]!.detalle, /no pude frenar a\.com/);
  assert.match(f[0]!.detalle, /Command failed/, "el motivo real llega al informe, no se traga");

  const s = await ejecutarAcciones(
    [{ accion: "soltar_dominio", dominio: "listo.com", motivo: "ya está" }],
    ctxSoltar({ soltarDominio: revienta as never })
  );
  assert.equal(s[0]!.ejecutada, false);
  assert.match(s[0]!.detalle, /no pude soltar listo\.com/);
});

// ── porQueNoVuelve ─────────────────────────────────────────────────────────────────────────────
//
// La regla vive en UNA función y se exporta para que el prompt le muestre al agente la condición YA
// EVALUADA al lado de cada dominio frenado. Estos tests fijan que la función y el switch no puedan
// divergir: si dijeran cosas distintas, el agente vería un candidato que el código después rechaza.

test("porQueNoVuelve: los 7 vírgenes califican — cero mediciones NO es historia mala", async () => {
  // Los 7 nodos vírgenes (bizregistry-ops.com y compañía) están en cap 0 con tráfico cero. Sin
  // enviar nunca, su salud queda en `no_traffic` para siempre: si la falta de historia bloqueara,
  // el candado no se abre jamás.
  assert.equal(porQueNoVuelve({ cruzado: false, bloqueanPor: [], muestra: 0, tasaInbox: null }), null);
  // Poca muestra tampoco juzga: una sola medición mala es ruido, no evidencia.
  assert.equal(porQueNoVuelve({ cruzado: false, bloqueanPor: [], muestra: 2, tasaInbox: 0 }), null);
  // Muestra suficiente y tasa desconocida: "no medido" y "cero" no son lo mismo.
  assert.equal(porQueNoVuelve({ cruzado: false, bloqueanPor: [], muestra: 9, tasaInbox: null }), null);
});

test("porQueNoVuelve: 'no sé si cruzó' NO es 'no cruzó', y gana sobre todo lo demás", async () => {
  // Los TRES estados. El prompt ya decía honestamente "umbral permanente: sin dato" mientras el gate
  // decía en silencio "no cruzó": la misma lección de "no medido ≠ cero" aplicada a la mitad.
  const m = porQueNoVuelve({ cruzado: null, bloqueanPor: [], muestra: 0, tasaInbox: null });
  assert.match(m ?? "", /no sé si cruzó el umbral permanente/);
  // Ni con un expediente impecable: sin ese dato no hay veredicto posible.
  assert.notEqual(porQueNoVuelve({ cruzado: null, bloqueanPor: [], muestra: 20, tasaInbox: 1 }), null);
});

test("porQueNoVuelve: el umbral permanente gana sobre todo lo demás", async () => {
  // bizreport-control.com cruzó el umbral el 2026-07-31. Ese hecho no lo deshace enviando, y por
  // eso se evalúa PRIMERO: se rechaza aunque no se pueda leer ni un solo nodo por SSH.
  const m = porQueNoVuelve({ cruzado: true, bloqueanPor: ["Gmail"], muestra: 20, tasaInbox: 0.9 });
  assert.match(m ?? "", /umbral permanente/);
});

test("porQueNoVuelve: receptor cerrado y historia mala, cada uno con su motivo", async () => {
  assert.match(porQueNoVuelve({ cruzado: false, bloqueanPor: ["Yahoo", "Gmail"], muestra: 0, tasaInbox: null }) ?? "", /cerrado Yahoo, Gmail/);
  assert.match(porQueNoVuelve({ cruzado: false, bloqueanPor: [], muestra: 5, tasaInbox: 0.2 }) ?? "", /20% de bandeja sobre 5 mediciones/);
  // El piso es 0.5 y no se copia en ningún otro lado: justo encima, califica.
  assert.equal(porQueNoVuelve({ cruzado: false, bloqueanPor: [], muestra: 5, tasaInbox: 0.6 }), null);
});

test("porQueNoVuelve dice EXACTAMENTE lo que rechaza el switch", async () => {
  // Si divergen, el agente ve un candidato que el código después niega — o peor, no ve uno que sí
  // podía soltar. Se compara el texto real de la acción contra el de la función.
  const cerrado = await ejecutarAcciones(
    [{ accion: "soltar_dominio", dominio: "listo.com", motivo: "x" }],
    ctxSoltar({ diagnosticarDominio: async () => ({ estado: "blocked_by_provider", bloqueanPor: ["Yahoo"], degradadoEn: [], entregados: 0, rechazados: 9, detalle: "" }) })
  );
  assert.equal(cerrado[0]!.detalle, `rechazada: listo.com ${porQueNoVuelve({ cruzado: false, bloqueanPor: ["Yahoo"], muestra: 0, tasaInbox: null })}`);

  const historia = await ejecutarAcciones(
    [{ accion: "soltar_dominio", dominio: "listo.com", motivo: "x" }],
    ctxSoltar({ medirDominio: async () => ({ tasaInbox: 0.2, muestra: 5, diaN: 3, ultimaMedicion: "2026-08-05" }) })
  );
  assert.equal(historia[0]!.detalle, `rechazada: listo.com ${porQueNoVuelve({ cruzado: false, bloqueanPor: [], muestra: 5, tasaInbox: 0.2 })}`);
});

// ── revisar_reputacion ─────────────────────────────────────────────────────────────────────────

const REPUTACION_LIMPIA: ReputacionLeida = {
  dominio: "listo.com",
  ip: "80.190.75.10",
  blacklist: { estado: "ok", detalle: "sin detecciones" },
  spf: { estado: "ok", detalle: "SPF con -all" },
  dkim: { estado: "ok", detalle: "DKIM válido en s2026a" },
  dmarc: { estado: "ok", detalle: "DMARC p=quarantine" },
  ptr: { estado: "ok", detalle: "PTR mail.listo.com confirmado" },
  // El certificado del 587: la quinta señal, que hasta hoy no miraba nadie. filing-ops.com se
  // quedó sin cert y las otras cuatro siguieron en verde.
  tls: { estado: "ok", detalle: "certificado vigente 60 día(s) (mail.listo.com)" }
};

function ctxReputacion(over: Partial<ContextoAcciones> = {}): ContextoAcciones {
  return {
    dominiosConocidos: ["listo.com"],
    ahora: () => AHORA,
    revisarReputacion: async () => REPUTACION_LIMPIA,
    // GMAIL CERRADO con las IPs limpias: es la medición real del 2026-07-25.
    diagnosticarDominio: async () => ({
      estado: "blocked_by_provider",
      bloqueanPor: ["Gmail"],
      degradadoEn: [],
      entregados: 0,
      rechazados: 41,
      detalle: "550-5.7.1 unsolicited mail"
    }),
    pendientes: { listar: async () => [], guardar: async () => {} },
    ...over
  } as never;
}

test("reputación: la lista negra limpia NUNCA sale sin el estado del receptor", async () => {
  // LA MEDICIÓN QUE JUSTIFICA ESTA REGLA: el 2026-07-25, 38 de 64 nodos estaban rechazados por
  // Gmail con 550-5.7.1 "unsolicited" y TODAS sus IPs limpias en listas negras. Son dos señales
  // distintas y la primera sola produce confianza falsa — ese error costó un mes.
  const r = await ejecutarAcciones([{ accion: "revisar_reputacion", dominio: "listo.com", motivo: "no entrega y quiero saber por qué" }], ctxReputacion());
  assert.equal(r[0]!.ejecutada, true);
  assert.match(r[0]!.detalle, /sin detecciones/, "la primera señal está");
  assert.match(r[0]!.detalle, /receptor: CERRADO en Gmail/, "y la segunda al lado, en la misma frase");
  // La forma estructural: si el texto dice que no hay detecciones, el receptor aparece SIEMPRE.
  if (/sin detecciones|limpi/i.test(r[0]!.detalle)) assert.match(r[0]!.detalle, /receptor:/);
});

test("reputación: los 7 vírgenes NO reciben un 'nadie se lo bloquea' sobre cero evidencia", async () => {
  // LA SEGUNDA SEÑAL TAMBIÉN PUEDE SER FALSA. `diagnosticarUnDominio` devuelve `no_traffic` con los
  // contadores en 0 para los 7 nodos vírgenes (filing-ops.com y compañía) — que son justamente el
  // caso de uso de soltar_dominio — y el ternario publicaba "nadie se lo bloquea (0 entregados / 0
  // rechazados)". O sea: la mitad que existe para que "listas negras limpias" no se lea como verde
  // afirmaba lo verde sobre un nodo que nunca mandó un correo. "No medido" y "cero" otra vez.
  const r = await ejecutarAcciones(
    [{ accion: "revisar_reputacion", dominio: "listo.com", motivo: "¿está listo para arrancar?" }],
    ctxReputacion({
      diagnosticarDominio: async () => ({ estado: "no_traffic", bloqueanPor: [], degradadoEn: [], entregados: 0, rechazados: 0, detalle: "" })
    })
  );
  assert.equal(r[0]!.ejecutada, true, "es un dato útil: se publica, pero diciendo lo que es");
  assert.match(r[0]!.detalle, /sin evidencia propia/);
  assert.match(r[0]!.detalle, /nunca mandó, así que no sabemos si lo aceptan/);
  assert.doesNotMatch(r[0]!.detalle, /nadie se lo bloquea/, "eso sería afirmar algo sobre cero mediciones");
});

test("reputación: un mail.log ILEGIBLE no es un mail.log limpio", async () => {
  // `readNodeDeliveryHealth` devuelve `unreadable` con los contadores en 0 cuando el SSH falló o las
  // fechas no se entienden. Con el ternario viejo salía "unreadable, nadie se lo bloquea (0/0)" y
  // con `ejecutada: true`: un chequeo que falló disfrazado de medición limpia. Es el probe colgado
  // del 2026-07-29 otra vez, en otro archivo.
  let consultas = 0;
  const r = await ejecutarAcciones(
    [{ accion: "revisar_reputacion", dominio: "listo.com", motivo: "x" }],
    ctxReputacion({
      diagnosticarDominio: async () => ({ estado: "unreadable", bloqueanPor: [], degradadoEn: [], entregados: 0, rechazados: 0, detalle: "" }),
      revisarReputacion: async () => { consultas += 1; return REPUTACION_LIMPIA; }
    })
  );
  assert.equal(r[0]!.ejecutada, false);
  assert.equal(r[0]!.reintentable, true, "un SSH caído se arregla solo: no vale despertar a nadie");
  assert.doesNotMatch(r[0]!.detalle, /sin detecciones|nadie se lo bloquea/);
  assert.equal(consultas, 0, "y no se gasta cuota de MXToolbox en algo que no se va a poder publicar");
});

test("reputación: sin el instrumento del receptor, la acción se RECHAZA", async () => {
  // Mismo criterio que soltar_dominio: un chequeo que no se puede hacer no es un chequeo que pasa.
  // Acá además evita gastar cuota de API en una lectura que no se va a poder publicar entera.
  let consultas = 0;
  const r = await ejecutarAcciones(
    [{ accion: "revisar_reputacion", dominio: "listo.com", motivo: "x" }],
    ctxReputacion({ diagnosticarDominio: undefined, revisarReputacion: async () => { consultas += 1; return REPUTACION_LIMPIA; } })
  );
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /una lista negra limpia no dice nada/);
  assert.equal(consultas, 0, "no se gasta cuota en algo que no se va a poder reportar");
});

test("reputación: un chequeo colgado dice 'no sé', y NO lo da por bueno", async () => {
  // La lección del probe con `head -c`: rc=124 se reportó como "bloqueado" en 10 de 10 nodos que
  // estaban bien. Un instrumento que no contesta no puede producir un veredicto en ninguna dirección.
  const r = await ejecutarAcciones(
    [{ accion: "revisar_reputacion", dominio: "listo.com", motivo: "x" }],
    ctxReputacion({
      revisarReputacion: async () => ({ ...REPUTACION_LIMPIA, blacklist: { estado: "no-se", detalle: "no respondió en 15000 ms" } })
    })
  );
  assert.equal(r[0]!.ejecutada, false);
  assert.equal(r[0]!.reintentable, true, "un timeout se arregla solo: no vale interrumpir a un humano");
  assert.match(r[0]!.detalle, /no sé si está listado/i);
  assert.doesNotMatch(r[0]!.detalle, /sin detecciones|limpi/i);
});

test("reputación: la API que falla es TRANSITORIA, no una decisión pendiente", async () => {
  // El incidente del 2026-08-06: Postgres se recargó doce segundos y el agente le mencionó al jefe
  // dos veces algo que ya estaba resuelto cuando lo leyó. Un parpadeo de infraestructura no es una
  // pregunta para un humano.
  const r = await ejecutarAcciones(
    [{ accion: "revisar_reputacion", dominio: "listo.com", motivo: "x" }],
    ctxReputacion({ revisarReputacion: async () => { throw new Error("ECONNRESET api.mxtoolbox.com"); } })
  );
  assert.equal(r[0]!.ejecutada, false);
  assert.equal(r[0]!.reintentable, true);
  assert.match(r[0]!.detalle, /ECONNRESET/);

  // Y lo mismo si el que se cae es el lado del receptor.
  const sinReceptor = await ejecutarAcciones(
    [{ accion: "revisar_reputacion", dominio: "listo.com", motivo: "x" }],
    ctxReputacion({ diagnosticarDominio: async () => { throw new Error("ssh timeout"); } })
  );
  assert.equal(sinReceptor[0]!.reintentable, true);
});

test("reputación: sin IP no se inventa un veredicto, y NO es reintentable", async () => {
  // Falta el binding en el inventario: eso lo arregla una persona, no el tiempo. Distinguirlo del
  // parpadeo es lo que hace que la mención al jefe signifique algo.
  const r = await ejecutarAcciones(
    [{ accion: "revisar_reputacion", dominio: "listo.com", motivo: "x" }],
    ctxReputacion({ revisarReputacion: async () => ({ ...REPUTACION_LIMPIA, ip: null, blacklist: { estado: "no-se", detalle: "no sé de qué IP hablamos" }, ptr: { estado: "no-se", detalle: "no sé de qué IP hablamos" } }) })
  );
  assert.equal(r[0]!.ejecutada, false);
  assert.equal(r[0]!.reintentable, undefined, "no se arregla solo: hay que tocar el inventario");
  assert.match(r[0]!.detalle, /no sé de qué IP hablamos/);
});

test("reputación: la auth rota se nombra con su detalle, no con un color", async () => {
  const r = await ejecutarAcciones(
    [{ accion: "revisar_reputacion", dominio: "listo.com", motivo: "x" }],
    ctxReputacion({
      revisarReputacion: async () => ({
        ...REPUTACION_LIMPIA,
        dkim: { estado: "mal", detalle: "DKIM presente pero REVOCADO (p= vacío)" },
        ptr: { estado: "no-se", detalle: "no pude consultar el PTR: ESERVFAIL" }
      }),
      diagnosticarDominio: async () => ({ estado: "healthy", bloqueanPor: [], degradadoEn: [], entregados: 27, rechazados: 0, detalle: "" })
    })
  );
  assert.match(r[0]!.detalle, /DKIM MAL \(DKIM presente pero REVOCADO/);
  assert.match(r[0]!.detalle, /PTR no sé \(no pude consultar el PTR: ESERVFAIL\)/);
  assert.match(r[0]!.detalle, /TLS ok/, "la quinta señal viaja en la misma frase, no en un renglón aparte");
  assert.match(r[0]!.detalle, /receptor: healthy, nadie se lo bloquea \(27 entregados \/ 0 rechazados\)/);
});

test("reputación: un dominio inventado no llega a consultar nada", async () => {
  let consultas = 0;
  const r = await ejecutarAcciones(
    [{ accion: "revisar_reputacion", dominio: "inventado.com", motivo: "x" }],
    ctxReputacion({ revisarReputacion: async () => { consultas += 1; return REPUTACION_LIMPIA; } })
  );
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /no está en el inventario/);
  assert.equal(consultas, 0);
});

test("reputación: sin la mano cableada, se dice — no se ejecuta en silencio", async () => {
  const r = await ejecutarAcciones([{ accion: "revisar_reputacion", dominio: "listo.com", motivo: "x" }], ctxReputacion({ revisarReputacion: undefined }));
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /no está habilitado en este entorno/);
});

test("reputación: la mano REAL encaja en la acción, no una forma que inventé en un fixture", async () => {
  // Verificar por el camino de producción. El proyecto ya pagó esta lección: un fixture escrito
  // desde mi suposición del wire de Bedrock ocultó que `stop_reason` nunca se leía — el test y el
  // código compartían el error. Acá la acción se ejecuta contra `revisarReputacionDe` de verdad.
  const r = await ejecutarAcciones(
    [{ accion: "revisar_reputacion", dominio: "listo.com", motivo: "quiero ver por qué no entrega" }],
    ctxReputacion({
      revisarReputacion: (dominio) =>
        revisarReputacionDe({
          dominio,
          ip: "80.190.75.10",
          resolveTxt: async (f) => {
            if (f === "listo.com") return [["v=spf1 ip4:80.190.75.10 -all"]];
            if (f === "_dmarc.listo.com") return [["v=DMARC1; p=quarantine"]];
            if (f === "s2026a._domainkey.listo.com") return [["v=DKIM1; k=rsa; p=MIIBIjANBg"]];
            throw Object.assign(new Error("nope"), { code: "ENOTFOUND" });
          },
          reverse: async () => ["mail.listo.com"],
          resolve4: async () => ["80.190.75.10"],
          blacklist: async () => ({ estado: "clean", listas: [] })
        })
    })
  );
  assert.equal(r[0]!.ejecutada, true);
  assert.match(r[0]!.detalle, /listo\.com \(80\.190\.75\.10\): listas negras sin detecciones · auth SPF ok, DKIM ok, DMARC ok, PTR ok, TLS no sé \(no tengo con qué mirar el certificado en este entorno\) · receptor: CERRADO en Gmail/);
});

test("el dominio pegado al nombre de la acción se tolera, no se le pasa el problema al jefe", () => {
  // Ocurrió tal cual en producción: el modelo escribió
  //   ACCION: diagnosticar_dominio bizregistry-ops.com | motivo=...
  // y como el parser convierte espacios en guiones bajos, la acción quedó
  // "diagnosticar_dominio_bizregistry-ops.com". Rechazada por inexistente, y de ahí salió a Slack
  // "Quise diagnosticar_dominio_bizregistry-ops.com y no pude. ¿Lo resolvés vos?" — el agente le
  // pidió ayuda al jefe por SU PROPIO error de sintaxis.
  const [a] = extraerAcciones("ACCION: diagnosticar_dominio bizregistry-ops.com | motivo=ver quién lo cierra");
  assert.equal(a!.accion, "diagnosticar_dominio");
  assert.equal(a!.dominio, "bizregistry-ops.com");
  assert.equal(a!.motivo, "ver quién lo cierra");

  // El campo explícito gana sobre el pegado: si escribió las dos formas, manda la que eligió.
  const [b] = extraerAcciones("ACCION: frenar_dominio pegado.com | dominio=elegido.com | motivo=x");
  assert.equal(b!.dominio, "elegido.com");

  // Y lo que NO es un desliz sigue rechazándose: un nombre inventado no se parece a ninguna acción.
  const [c] = extraerAcciones("ACCION: borrar_todo_ya | motivo=porque sí");
  assert.equal(c!.accion, "borrar_todo_ya", "no se fuerza a la acción más parecida: eso sería adivinar");
});
