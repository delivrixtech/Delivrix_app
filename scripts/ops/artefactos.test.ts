// Tests de la barrera. Lo que fijan es que NO pueda decir OK sobre un campo que nadie escribe —
// que es exactamente la falla que viene a cazar, y que la primera versión de este archivo cometió
// contra la copia real (daba OK 66/66 sobre 66 dominios con el TLS en "no-se").

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FILAS, informe, mirar } from "./artefactos.ts";

test("un campo que NADIE escribe sale FALTA con su total, no 'sin filas'", () => {
  // Medido contra la copia de producción: `dominios[].receptor` sobre 66 dominios, 0 con el campo.
  // La primera versión contaba sobre los valores encontrados y devolvía "SIN FILAS", que se lee
  // como "no había nada que mirar" cuando lo que pasa es que nadie lo escribe. Son dos cegueras
  // distintas y mandan a buscar el bug a lugares distintos.
  const json = { dominios: [{ dominio: "a.com" }, { dominio: "b.com" }] };
  assert.deepEqual(mirar(json, "dominios[].receptor"), { estado: "FALTA", vistos: 0, total: 2 });
  assert.deepEqual(mirar({ ...json, dominios: [{ receptor: "cerrado" }, { receptor: null }] }, "dominios[].receptor"), {
    estado: "OK",
    vistos: 1,
    total: 2
  });
});

test("PRESENTE NO ES MEDIDO: el TLS en 'no-se' no es un TLS escrito", () => {
  // Es el 6º incidente de la clase: el chequeo existía, `authRota` ya excluía por `tls === "mal"` y
  // el llamador nunca pasaba la sonda, así que los 66 dominios tenían el campo con el valor que
  // significa "no lo miré". Sin `noVale`, la barrera lo declaraba OK — mintiendo con la misma forma
  // que el sistema que vigila.
  const json = { dominios: [{ tls: { estado: "no-se" } }, { tls: { estado: "no-se" } }] };
  assert.equal(mirar(json, "dominios[].tls.estado").estado, "OK", "sin la lista, el campo presente alcanza");
  assert.equal(mirar(json, "dominios[].tls.estado", ["no-se"]).estado, "FALTA");
  assert.equal(mirar({ dominios: [{ tls: { estado: "no-se" } }, { tls: { estado: "ok" } }] }, "dominios[].tls.estado", ["no-se"]).estado, "OK");
});

test("un array vacío es SIN FILAS: no hay con qué contestar, y no es lo mismo que faltar", () => {
  assert.deepEqual(mirar({ hechos: { plan: [] } }, "hechos.plan[].gate"), { estado: "SIN FILAS", vistos: 0, total: 0 });
});

test("el informe distingue el archivo que no está del campo que no está", async () => {
  const l = (
    await informe("/no/existe", async (ruta) => {
      if (ruta.endsWith("warmup-acciones.json")) return JSON.stringify({ entradas: [{ id: "x", veredicto: null, antes: { cap: 20 } }] });
      throw new Error("ENOENT");
    })
  ).join("\n");
  assert.match(l, /OK\s+warmup-acciones\.json → entradas\[\]\.antes/);
  assert.match(l, /FALTA\s+warmup-acciones\.json → entradas\[\]\.veredicto/);
  assert.match(l, /SIN ARCHIVO\s+warmup-conversacion\.json/);
  // El cierre dice cuántas faltan, porque ese número es la regla: a las 24 h de un despliegue, una
  // fila en FALTA significa que el lote no está terminado aunque el gate esté verde.
  assert.match(l, /de 7 en FALTA/);
});

test("cada fila declara quién la promete y desde cuándo", () => {
  // Una tabla sin autor es una lista de deseos: cuando aparece un FALTA hay que saber a qué lote
  // reclamarle, y desde qué fecha se supone que está.
  for (const f of FILAS) {
    assert.match(f.promete, /lote \d/, `${f.archivo} → ${f.donde} no dice quién lo promete`);
    assert.match(f.desde, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("LA BARRERA TAMPOCO SE PUEDE APUNTAR A PRODUCCIÓN", () => {
  const script = fileURLToPath(new URL("./artefactos.ts", import.meta.url));
  const r = spawnSync(process.execPath, ["--experimental-strip-types", script, "/Users/Shared/delivrix/runtime/openclaw-workspace/inventory"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /vive en producción/);
});
