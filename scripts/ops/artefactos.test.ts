// Tests de la barrera. Lo que fijan es que NO pueda decir OK sobre un campo que nadie escribe —
// que es exactamente la falla que viene a cazar, y que la primera versión de este archivo cometió
// contra la copia real (daba OK 66/66 sobre 66 dominios con el TLS en "no-se").

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { join, relative } from "node:path";
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
  // El total sale de FILAS y no de un 7 escrito a mano: cada lote que agrega una fila dejaba este
  // test en rojo por una razón que no tiene nada que ver con lo que prueba, y un test que se rompe
  // por crecer se termina borrando.
  assert.match(l, new RegExp(`de ${FILAS.length} en FALTA`));
});

test("cada fila declara quién la promete y desde cuándo", () => {
  // Una tabla sin autor es una lista de deseos: cuando aparece un FALTA hay que saber a qué lote
  // reclamarle, y desde qué fecha se supone que está.
  for (const f of FILAS) {
    assert.match(f.promete, /lote \d/, `${f.archivo} → ${f.donde} no dice quién lo promete`);
    assert.match(f.desde, /^\d{4}-\d{2}-\d{2}$/);
  }
});

// ── Y LA PROSA DE LA FILA TAMBIÉN SE VERIFICA ───────────────────────────────────────────────────
//
// Este archivo existe para que un aviso no mienta, y su propio texto mintió. Dos filas decían "FALTA
// cablearla en warmup-monitor.ts:341" y "…:1475" sobre `sondaTlsDelNodo` y `porQueNoSePodraCumplir`
// DESPUÉS de que el diff del 2026-08-08 las cableara (hoy se llaman desde warmup-monitor.ts:390 y
// :1551). El chequeo del campo seguía siendo correcto; lo que envejecía mal era la única parte que
// el operador LEE. Un aviso que grita en falso enseña a ignorar todos los demás — y el que se
// ignora después es el que importaba.
//
// Se verifica en LOS DOS SENTIDOS, igual que scripts/ops/manos-sin-llamador.test.ts: una lista de
// deuda que nadie contrasta contra el árbol envejece hacia la ficción en las dos direcciones.
//
// ponytail: se afirma el ARCHIVO del llamador, no la LÍNEA. Un test que fije `:390` se pone rojo
// cada vez que alguien agrega un import arriba, y un test que se rompe por algo que no es su tema se
// termina borrando. Si la línea se corre, el número del texto queda viejo pero no MIENTE sobre el
// hecho; el archivo sí es el hecho.

const RAIZ = fileURLToPath(new URL("../../", import.meta.url));
const esTest = (f: string): boolean => /\.(test|spec)\.[tj]sx?$/.test(f) || f.includes(".fixture.");
/** Sin comentarios: un llamador que sólo existe en prosa no es un llamador. Es EL punto del test. */
const sinComentarios = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function fuentes(): Array<{ ruta: string; codigo: string }> {
  const out: Array<{ ruta: string; codigo: string }> = [];
  for (const dir of ["apps", "scripts"]) {
    for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true, recursive: true }) as Array<{
      name: string;
      parentPath: string;
      isFile(): boolean;
    }>) {
      if (!e.isFile() || !/\.[tj]sx?$/.test(e.name) || e.name.endsWith(".d.ts")) continue;
      const abs = join(e.parentPath, e.name);
      if (abs.includes("node_modules") || abs.includes("/dist/")) continue;
      const ruta = relative(RAIZ, abs);
      if (esTest(ruta)) continue;
      out.push({ ruta, codigo: sinComentarios(readFileSync(abs, "utf8")) });
    }
  }
  return out;
}

/** Los archivos de producción que NOMBRAN el símbolo sin declararlo. Vacío = nadie lo llama. */
function llamadores(nombre: string): string[] {
  const declara = new RegExp(`export\\s+(?:async\\s+)?(?:function\\*?|const|class|let|var)\\s+${nombre}\\b`);
  return fuentes()
    .filter(({ ruta, codigo }) => !ruta.endsWith("artefactos.ts") && !declara.test(codigo) && new RegExp(`\\b${nombre}\\b`).test(codigo))
    .map(({ ruta }) => ruta);
}

test("una fila que habla del cableado no puede mentir sobre el cableado", () => {
  // El símbolo va entre paréntesis en el texto de la fila; el veredicto sale del árbol, no de la
  // prosa. Sin esta convención habría que adivinar de qué función habla la frase.
  const hablan = FILAS.filter((f) => /FALTA cablear|cableada en/.test(f.promete));
  assert.ok(hablan.length > 0, "si ninguna fila habla de cableado, este test se volvió decoración: borralo o arreglá el patrón");

  for (const f of hablan) {
    const nombre = /\(([A-Za-z_$][\w$]*)\)/.exec(f.promete)?.[1];
    assert.ok(nombre, `${f.donde}: la fila habla del cableado y no dice de QUÉ función. Poné el símbolo entre paréntesis.`);
    const quienes = llamadores(nombre);
    const archivo = /cableada en ([\w./-]+):/.exec(f.promete)?.[1];

    if (/FALTA cablear/.test(f.promete)) {
      // Si dice que falta, tiene que faltar DE VERDAD. Es la dirección que ya falló: las dos filas
      // del 2026-08-08 seguían gritando "FALTA cablear" sobre código que ya tenía llamador.
      assert.deepEqual(
        quienes,
        [],
        `${f.donde} dice "FALTA cablear ${nombre}" y ${nombre} YA tiene llamador en ${quienes.join(", ")}. ` +
          `Corregí el texto: un aviso que grita en falso enseña a ignorar todos los demás.`
      );
    } else {
      // Y si dice que está cableada, tiene que estarlo, en el archivo que nombra. Sin esto, borrar el
      // llamador dejaría la fila afirmando un cableado inexistente — la misma mentira al revés, que
      // es la forma exacta en que SIN_ANUNCIAR envejeció hasta que una auditoría la repitió como
      // hecho verificado.
      assert.ok(
        quienes.length > 0,
        `${f.donde} dice que ${nombre} está cableada y NINGÚN archivo de producción la nombra fuera de los comentarios.`
      );
      // Por SUFIJO, porque el texto de la fila nombra el archivo como lo nombra todo el repo
      // ("warmup-monitor.ts:390") y el barrido devuelve la ruta desde la raíz. Exigir la ruta
      // completa obligaría a escribir la prosa para el test en vez de para el operador, que la lee.
      assert.ok(
        archivo && quienes.some((q) => q === archivo || q.endsWith(`/${archivo}`)),
        `${f.donde} dice que ${nombre} se cablea en ${archivo ?? "(sin archivo)"} y sus llamadores reales son ${quienes.join(", ")}.`
      );
    }
  }
});

test("LA BARRERA TAMPOCO SE PUEDE APUNTAR A PRODUCCIÓN", () => {
  const script = fileURLToPath(new URL("./artefactos.ts", import.meta.url));
  const r = spawnSync(process.execPath, ["--experimental-strip-types", script, "/Users/Shared/delivrix/runtime/openclaw-workspace/inventory"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /vive en producción/);
});
