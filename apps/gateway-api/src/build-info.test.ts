import assert from "node:assert/strict";
import test from "node:test";
import { buildInfo, leerVersion, recortar } from "./build-info.ts";

test("la versión sale del PRIMER encabezado del changelog", () => {
  assert.equal(leerVersion("# v1.0 — 2026-08-05\ntexto"), "1.0");
  assert.equal(leerVersion("# 1.5 - hoy"), "1.5", "la 'v' es opcional");
  assert.equal(leerVersion("# v2.10.3 — x"), "2.10.3");
  assert.equal(leerVersion("# v3.0 — nueva\n\n# v2.0 — vieja"), "3.0", "la de arriba es la vigente");
  assert.equal(leerVersion("no hay encabezado"), null);
});

test("el changelog se recorta en un límite de versión, nunca a mitad de frase", () => {
  // Un changelog cortado a mitad de una viñeta le miente al agente sobre qué se hizo.
  const texto = `# v2.0 — nuevo\n${"x".repeat(60)}\n\n# v1.0 — viejo\n${"y".repeat(60)}`;
  const r = recortar(texto, 90);
  assert.ok(r.includes("# v2.0"), "conserva la versión más nueva");
  assert.ok(!r.includes("# v1.0"), "descarta las viejas enteras");
  assert.equal(recortar("# v1.0 — corto", 500), "# v1.0 — corto", "no toca lo que ya entra");
});

test("buildInfo lee el CHANGELOG real del repo y el commit vivo", async () => {
  // Contra el archivo de verdad, no un fixture: si alguien mueve el CHANGELOG o le cambia el
  // formato del encabezado, esto se entera. Un fixture escrito desde mi suposición no.
  const info = await buildInfo();
  assert.match(info.version ?? "", /^[0-9]+\.[0-9]+/, "el CHANGELOG del repo declara una versión");
  assert.match(info.commit ?? "", /^[0-9a-f]{40}$/, "el commit es el HEAD real");
  assert.ok((info.changelog ?? "").length <= 1200, "no se le manda el histórico entero al agente");
});
