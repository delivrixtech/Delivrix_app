import assert from "node:assert/strict";
import test from "node:test";
import { esLaMisma, lineasParaPrompt, olvidar, recordar, vacias } from "./decisiones-del-jefe.ts";

const T = "2026-08-06T00:00:00.000Z";

test("la misma decisión dicha distinto NO se duplica", () => {
  // El jefe no repite la frase textual: la dice distinta cada vez. Sin esto la lista crece con la
  // misma decisión escrita de cinco formas y el prompt se llena del ruido que vino a evitar.
  assert.ok(
    esLaMisma(
      "trabajá con las 2 semillas que ya tenemos, no va a haber outlook ni yahoo por ahora",
      "por ahora no hay semillas de outlook ni yahoo, trabajá con las 2 que tenemos"
    )
  );
  assert.ok(!esLaMisma("no vas a tener semillas de outlook", "frená bizreport-control.com ya mismo"));

  let d = recordar(null, { que: "trabajá con las 2 semillas que hay, no va a haber outlook ni yahoo", origen: "slack", cuando: T });
  d = recordar(d, { que: "por ahora no hay outlook ni yahoo, usá las 2 semillas que tenemos", origen: "slack", cuando: "2026-08-06T01:00:00.000Z" });
  assert.equal(d.items.length, 1, "es la misma decisión");
  assert.equal(d.items[0]?.cuando, "2026-08-06T01:00:00.000Z", "refresca la fecha");
});

test("decisiones distintas conviven", () => {
  let d = recordar(null, { que: "no va a haber semillas de outlook ni yahoo por ahora", origen: "s", cuando: T });
  d = recordar(d, { que: "no frenes ningún dominio sin avisarme primero", origen: "s", cuando: T });
  assert.equal(d.items.length, 2);
});

test("van al prompt como DECISIONES, no como sugerencias", () => {
  // La diferencia entre "el jefe sugirió" y "el jefe decidió" es exactamente lo que hace que el
  // agente deje de pedir lo mismo cada 10 minutos.
  const d = recordar(null, { que: "trabajá con las 2 semillas que hay", origen: "s", cuando: T });
  const l = lineasParaPrompt(d);
  assert.match(l.join("\n"), /DECISIONES YA TOMADAS/);
  assert.match(l.join("\n"), /No las cuestiones/);
  assert.match(l.join("\n"), /ganan estas/, "si un hecho las contradice, mandan las decisiones");
  assert.match(l.join("\n"), /trabajá con las 2 semillas/);
});

test("sin decisiones no ensucia el prompt", () => {
  assert.deepEqual(lineasParaPrompt(null), []);
  assert.deepEqual(lineasParaPrompt(vacias()), []);
});

test("el jefe puede cambiar de opinión", () => {
  let d = recordar(null, { que: "no frenes nada sin avisarme", origen: "s", cuando: T });
  const id = d.items[0]?.id as string;
  d = olvidar(d, id);
  assert.equal(d.items.length, 0);
});

test("no guarda ruido", () => {
  const d = recordar(null, { que: "ok", origen: "s", cuando: T });
  assert.equal(d.items.length, 0, "un 'ok' no es una decisión");
});

test("acota la lista: un prompt inflado es el problema que vino a evitar", () => {
  // Decisiones GENUINAMENTE distintas: si se parecen, el deduplicador las colapsa —y hace bien,
  // pero entonces no se estaría probando el recorte.
  const temas = [
    "no compres dominios nuevos este mes",
    "priorizá siempre placement sobre volumen",
    "avisame antes de tocar cualquier nodo de webdock",
    "el kill switch lo manejo yo, nunca vos",
    "reportá en español salvo que escriba en inglés",
    "no uses la cuenta contabo tres para pruebas",
    "los fines de semana bajá la cadencia a la mitad",
    "cualquier gasto arriba de cien dolares lo apruebo yo",
    "nunca toques la configuracion de dns sin firma",
    "si esau pregunta, respondele como a mi",
    "el respaldo nocturno no se saltea jamas",
    "manteneme fuera de los detalles de postfix",
    "escalá a estefania si yo no contesto en dos horas",
    "no reinicies la mac studio sin permiso"
  ];
  let d = vacias();
  for (const t of temas) d = recordar(d, { que: t, origen: "s", cuando: T });
  assert.ok(d.items.length <= 12, `no infla el prompt (quedaron ${d.items.length})`);
  assert.match(d.items[d.items.length - 1]?.que ?? "", /no reinicies/, "conserva las más recientes");
});
