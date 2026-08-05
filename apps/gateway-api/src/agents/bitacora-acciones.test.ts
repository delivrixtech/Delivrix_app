import assert from "node:assert/strict";
import test from "node:test";
import { bitacoraVacia, idDe, juzgar, lineasParaPrompt, registrar, type Veredicto } from "./bitacora-acciones.ts";

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
