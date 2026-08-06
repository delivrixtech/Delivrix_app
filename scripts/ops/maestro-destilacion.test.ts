import assert from "node:assert/strict";
import test from "node:test";

import { aJsonl, partir, type Corpus, type Ejemplo } from "./maestro-destilacion.ts";

/**
 * Estas dos funciones son las únicas puras del maestro y las únicas que deciden QUÉ se entrena.
 * Estuvieron sin un solo test desde que se escribieron, y el precio de que estén mal no se paga
 * al correrlas: se paga semanas después, cuando alguien entrena con un archivo que mlx no lee o
 * mide la mejora contra ejemplos que el modelo ya vio. Para entonces el costo de API ya se gastó.
 */

const ejemplo = (n: number, cuando: string): Ejemplo => ({
  id: `kimi-k3-${cuando}`,
  cuando,
  maestro: "kimi-k3",
  entrada: `Momento: ${cuando}\nEMISOR: ACTIVO, mandando. Vueltas hoy ${n}/14.`,
  salida: `AHORA: vuelta ${n}.\nPORQUE: dato.\nRIESGO: ninguno.\nFALTA: nada.`,
  reparos: 0
});

const corpusDe = (ejemplos: Ejemplo[]): Corpus => ({ version: 1, ejemplos, descartados: 1 });

test("aJsonl escribe UNA línea JSON por ejemplo, con system/user/assistant", () => {
  // El formato es el contrato con la herramienta de entrenamiento: una línea rota o un rol de
  // más y el archivo entero se cae al cargar. Se verifica acá porque el error no aparece al
  // exportar —el JSONL se escribe igual de bien— sino recién al entrenar.
  const jsonl = aJsonl(corpusDe([ejemplo(1, "2026-08-06T03:05:06.431Z"), ejemplo(2, "2026-08-06T05:00:00.000Z")]), "SISTEMA");
  const lineas = jsonl.split("\n");
  assert.equal(lineas.length, 2, "una línea por ejemplo, sin línea vacía intercalada");
  for (const [i, linea] of lineas.entries()) {
    const fila = JSON.parse(linea) as { messages: Array<{ role: string; content: string }> };
    assert.deepEqual(
      fila.messages.map((m) => m.role),
      ["system", "user", "assistant"],
      `fila ${i}: el orden de los roles es parte del formato`
    );
    assert.equal(fila.messages[0]?.content, "SISTEMA", "el system prompt va en cada fila, no una sola vez");
    assert.ok(!/\n/.test(linea), "JSONL: los saltos de línea del texto van escapados, nunca crudos");
  }
});

test("aJsonl mete el prompt del agente como `user` y la respuesta verificada como `assistant`", () => {
  // Invertirlos entrena al modelo a producir hechos y consumir lecturas: exactamente al revés.
  const e = ejemplo(3, "2026-08-06T07:00:00.000Z");
  const fila = JSON.parse(aJsonl(corpusDe([e]), "S")) as { messages: Array<{ role: string; content: string }> };
  assert.equal(fila.messages[1]?.content, e.entrada);
  assert.equal(fila.messages[2]?.content, e.salida);
});

test("partir sobre 16 ejemplos de UN SOLO DÍA deja 13 de entrenamiento y 3 de validación", () => {
  // El corte es por fecha y no al azar, y el propio comentario de `partir` dice por qué: los
  // ejemplos del mismo día se parecen entre sí. Este es el caso real medido el 2026-08-06 —los
  // 16 ejemplos del corpus nacieron entre las 03:05Z y las 16:26Z del MISMO día—, así que la
  // validación no mide generalización: mide el mismo día contra sí mismo. El test fija el
  // reparto para que quede a la vista que 3 de 3 ejemplos de validación son del día entrenado.
  const ejemplos = Array.from({ length: 16 }, (_, i) => ejemplo(i, `2026-08-06T${String(3 + i).padStart(2, "0")}:00:00.000Z`));
  const { train, valid } = partir(corpusDe(ejemplos));
  assert.equal(train.ejemplos.length, 13);
  assert.equal(valid.ejemplos.length, 3);
  assert.equal(new Set([...train.ejemplos, ...valid.ejemplos].map((e) => e.cuando.slice(0, 10))).size, 1, "todos del mismo día: la validación NO mide generalización");
});

test("partir no deja el mismo ejemplo de los dos lados", () => {
  // Un ejemplo que está en train y en valid infla la métrica de validación hasta volverla
  // inútil: el modelo lo memorizó, no lo generalizó, y el número dice que mejoró.
  const ejemplos = Array.from({ length: 10 }, (_, i) => ejemplo(i, `2026-08-0${i}T10:00:00.000Z`.replace("2026-08-010", "2026-08-10")));
  const { train, valid } = partir(corpusDe(ejemplos));
  const enTrain = new Set(train.ejemplos.map((e) => e.id));
  assert.ok(valid.ejemplos.every((e) => !enTrain.has(e.id)), "ningún id repetido entre train y valid");
  assert.equal(train.ejemplos.length + valid.ejemplos.length, ejemplos.length, "no se pierde ni se duplica ningún ejemplo");
});

test("partir ordena por fecha antes de cortar: la validación es siempre lo MÁS NUEVO", () => {
  // Si el corpus llega desordenado y se corta tal cual, la validación queda con ejemplos viejos
  // y el modelo se mide contra el pasado que ya entrenó. El orden es lo que hace que el corte
  // temporal signifique algo.
  const desordenado = [
    ejemplo(3, "2026-08-06T12:00:00.000Z"),
    ejemplo(1, "2026-08-04T12:00:00.000Z"),
    ejemplo(2, "2026-08-05T12:00:00.000Z")
  ];
  const { train, valid } = partir(corpusDe(desordenado), 0.3);
  assert.deepEqual(train.ejemplos.map((e) => e.cuando.slice(0, 10)), ["2026-08-04", "2026-08-05"]);
  assert.deepEqual(valid.ejemplos.map((e) => e.cuando.slice(0, 10)), ["2026-08-06"]);
});

test("partir con un solo ejemplo NO deja el entrenamiento vacío", () => {
  // Con 1 ejemplo, floor(1 * 0.85) da 0: sin el Math.max, el export escribía un train.jsonl
  // vacío y el entrenamiento arrancaba sin material. Falla silenciosa, la peor clase.
  const { train, valid } = partir(corpusDe([ejemplo(1, "2026-08-06T03:00:00.000Z")]));
  assert.equal(train.ejemplos.length, 1);
  assert.equal(valid.ejemplos.length, 0);
});
