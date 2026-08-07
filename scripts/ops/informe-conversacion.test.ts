// Tests del medidor de la conversación. Lo que fijan no es que los números salgan — es que NO
// salga un número cuando no hay con qué, y que el instrumento no se pueda apuntar a producción.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MEMORIA_REAL } from "../../apps/gateway-api/src/agents/memoria-conversacion.fixture.ts";
import { resumen, type MemoriaConversacion } from "../../apps/gateway-api/src/agents/memoria-conversacion.ts";
import { indice, lineas, MINIMO_PARA_INDICE } from "./informe-conversacion.ts";

const REAL = MEMORIA_REAL as unknown as MemoriaConversacion;
const AHORA = "2026-08-07T19:00:00.000Z";

test("CON EL ARCHIVO REAL DE HOY el índice dice 'no sé', no un porcentaje", () => {
  // 18 intercambios. Una tasa sobre 18 registros no es una tasa: UN intercambio mueve cada
  // componente 5,6 puntos, así que el informe "mejoraría" un 5% por el ruido de una conversación.
  // Es la lección del `placement-pause`, donde 4 muestras sueltas frenaron al único dominio que
  // estaba calentando bien.
  assert.equal(resumen(REAL, AHORA).intercambios, 18);
  assert.equal(indice(resumen(REAL, AHORA)), null);
  const l = lineas(REAL, AHORA).join("\n");
  assert.match(l, /no sé — 18 intercambios y hacen falta 30/);
  assert.doesNotMatch(l.split("\n")[1] as string, /^\s*\d+(\.\d+)?%/, "ni un número de reemplazo, ni un 0, ni un provisorio");
});

test("LA LÍNEA BASE del encabezado es reproducible con los mismos registros", () => {
  // Si alguno de estos ocho cambia, el baseline escrito en el encabezado del script quedó viejo — y
  // un baseline que envejece sin avisar es el modo de falla que este archivo existe para no repetir
  // (el log que anunciaba "leo cada 20s" meses después de haber bajado a 6).
  const r = resumen(REAL, AHORA);
  assert.equal(r.intercambios, 18);
  assert.equal(r.insiste, 0);
  assert.equal(r.conforme, 8);
  assert.equal(r.corrige, 1);
  assert.equal(r.sinReaccion, 9);
  assert.equal(r.repetidas, 4);
  assert.equal(r.inventadas, 0);
  assert.equal(r.fallos, 0);
});

test("el índice suma los TRES que bajan cuando mejora, y conforme NO entra", () => {
  // Anti-gaming: `conforme` es evidencia débil ("Ok!" tanto puede ser "entendí" como "ya fue,
  // dejalo"), así que un índice que la premia se gana escribiendo mensajes que cierren la charla.
  const base = { ...resumen(null, AHORA), intercambios: 40, insiste: 4, tasaInsiste: 0.1, repetidas: 4, sinRespuesta: 4, conforme: 0 };
  const sinConformes = indice(base);
  assert.equal(sinConformes?.valor, 10, "10% = (10 + 10 + 10) / 3");

  // Veinte conformes más no mueven el índice ni un punto: no hay forma de ganarlo por ahí.
  assert.equal(indice({ ...base, conforme: 20 })?.valor, sinConformes?.valor);

  // Y baja de verdad cuando bajan los tres.
  assert.equal(indice({ ...base, insiste: 0, tasaInsiste: 0, repetidas: 0, sinRespuesta: 0 })?.valor, 0);
});

test("EL ÍNDICE NO SE GANA CON 'Ok!' — pasar todos los nulos a conforme no lo mueve", () => {
  // EL DEFECTO QUE ESTE TEST HABRÍA CAZADO: `conforme` no entraba al índice como término propio,
  // pero el tercer componente era `sinReacción` = `reaccion === null`, así que cada "Ok!" SACABA un
  // intercambio de ese balde y bajaba el número. Medido sobre este mismo archivo real duplicado
  // para pasar el piso de 30 (n=36): 24,1 ⇒ 7,4 (−16,7 puntos, −69%) sin que la conversación
  // mejorara en nada. El anti-gaming estaba escrito y entraba por la puerta de al lado.
  const dup: MemoriaConversacion = {
    ...REAL,
    intercambios: [
      ...REAL.intercambios,
      // Otro día, para que sigan siendo posteriores entre sí y no empaten en `cuando`.
      ...REAL.intercambios.map((x) => ({ ...x, ts: `${x.ts}-b`, cuando: new Date(Date.parse(x.cuando) + 86_400_000).toISOString() }))
    ]
  };
  const ganado: MemoriaConversacion = {
    ...dup,
    intercambios: dup.intercambios.map((x) => (x.reaccion === null ? { ...x, reaccion: "conforme" as const } : x))
  };

  const antes = resumen(dup, AHORA);
  const despues = resumen(ganado, AHORA);
  assert.equal(antes.sinReaccion, 18);
  assert.equal(despues.sinReaccion, 0, "el balde de los nulos se vacía entero: eso es lo que movía el índice");
  assert.equal(indice(antes)?.valor, indice(despues)?.valor, "y el índice NO se mueve");

  // El silencio duro NO mira etiquetas: mira si el jefe volvió a escribir. Con 36 intercambios del
  // mismo autor solo el último puede quedar sin respuesta, y eso no cambia por etiquetarlo.
  assert.equal(antes.sinRespuesta, 1);
  assert.equal(despues.sinRespuesta, 1);
});

test("`sinReacción` NO era silencio: 8 de los 9 nulos del archivo real tienen mensaje posterior", () => {
  // Por qué el baseline de "50% sin respuesta" era falso y hay que dejar de leerlo así:
  // `anotarReaccion` etiqueta UN intercambio por mensaje del jefe, así que un nulo en el medio del
  // hilo es una etiqueta que no llegó, no una persona callada. El número que sí mide silencio es
  // `sinRespuesta`, y sobre este archivo vale 1: el último.
  const r = resumen(REAL, AHORA);
  assert.equal(r.sinReaccion, 9);
  assert.equal(r.sinRespuesta, 1);
  const l = lineas(REAL, AHORA).join("\n");
  assert.match(l, /sin respuesta \(no volvió a escribir después\): 1\/18/);
  assert.match(l, /sin etiqueta de reacción: 9\/18/);
});

test("el piso es de muestra, no de calidad: con 29 no hay número y con 30 sí", () => {
  const casi = { ...resumen(null, AHORA), intercambios: MINIMO_PARA_INDICE - 1, tasaInsiste: 0, repetidas: 0, sinReaccion: 0 };
  assert.equal(indice(casi), null);
  assert.equal(indice({ ...casi, intercambios: MINIMO_PARA_INDICE })?.valor, 0);
});

test("EL INSTRUMENTO NO SE PUEDE APUNTAR A PRODUCCIÓN", () => {
  // Corre el comando de verdad contra el árbol vivo. Hasta este lote no tenía guard —y sin
  // argumento abría directamente el workspace de producción—, que es la forma más fácil de que el
  // próximo agregado "que solo escribe un cachito" toque el archivo que el daemon reescribe bajo
  // lock cada 6 segundos.
  const script = fileURLToPath(new URL("./informe-conversacion.ts", import.meta.url));
  const r = spawnSync(process.execPath, ["--experimental-strip-types", script, "/Users/Shared/delivrix/runtime/openclaw-workspace/inventory/warmup-conversacion.json"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /vive en producción/);
  assert.match(r.stderr, /Copialo con scp/);
});
