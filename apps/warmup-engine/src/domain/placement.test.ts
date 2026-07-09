import assert from "node:assert/strict";
import test from "node:test";
import {
  computeRollup,
  ewma,
  wilsonLowerBound,
  worstMajorProviderLb,
  DEFAULT_EWMA_ALPHA,
  Z_95
} from "./placement.ts";
import type { LandedIn, PlacementResultRow, SeedProvider } from "./types.ts";

function row(landedIn: LandedIn | null, seedProvider: SeedProvider = "gmail"): PlacementResultRow {
  return { testId: "t", nodeId: "n1", seedProvider, landedIn };
}

// ── §9 regla 1: tabs cuenta como inbox ───────────────────────────────────────
test("tabs cuenta como inbox: inboxCount = primary + tabs", () => {
  const r = computeRollup([row("primary"), row("tabs"), row("spam")]);
  assert.equal(r.inboxCount, 2, "primary + tabs");
  assert.equal(r.spamCount, 1);
  assert.equal(r.samples, 3);
});

// ── §9 regla 2: MISSING ≠ SPAM ───────────────────────────────────────────────
test("missing es su propio bucket, no cuenta como spam ni como inbox", () => {
  const r = computeRollup([row("primary"), row("missing"), row("missing"), row("spam")]);
  assert.equal(r.inboxCount, 1);
  assert.equal(r.spamCount, 1, "los missing NO inflan el spam");
  assert.equal(r.missingCount, 2);
  assert.equal(r.samples, 4);
});

// ── §9 regla 3: solo cuentan los leídos (grace window no diluye) ─────────────
test("los pendientes (landedIn null) del grace window no cuentan", () => {
  const r = computeRollup([row("primary"), row("primary"), row(null), row(null)]);
  assert.equal(r.samples, 2, "solo los 2 leídos");
  assert.equal(r.inboxCount, 2);
  // 2/2 leídos ⇒ el LB no se diluye por los pendientes
  assert.equal(r.inboxWilsonLb, wilsonLowerBound(2, 2));
});

// ── §9 regla 4: Wilson lower-bound < proporción cruda; n chico penaliza ───────
test("wilsonLowerBound es menor que la proporción cruda (n chico penaliza)", () => {
  // 3/3 = 100% crudo, pero el LB es bastante < 1 por incertidumbre
  const lbSmall = wilsonLowerBound(3, 3)!;
  assert.ok(lbSmall < 1, "el LB no cae en la trampa del 100% crudo");
  assert.ok(lbSmall < 0.5, `n=3 penaliza fuerte: ${lbSmall}`);
  // con más n y misma proporción (100%), el LB sube: n grande = más confianza
  const lbBig = wilsonLowerBound(100, 100)!;
  assert.ok(lbBig > lbSmall, "más muestras ⇒ LB más alto para la misma proporción");
});

test("computeRollup gatea sobre el LB, no sobre inboxCount/samples", () => {
  const r = computeRollup([row("primary"), row("primary"), row("primary")]);
  const crude = r.inboxCount / r.samples; // 1.0
  assert.equal(crude, 1);
  assert.ok(r.inboxWilsonLb! < crude, "el LB castiga el n chico frente al crudo");
});

// ── §9 regla 4: n=0 ⇒ LB undefined ───────────────────────────────────────────
test("n=0 ⇒ wilsonLowerBound undefined (no hay señal)", () => {
  assert.equal(wilsonLowerBound(0, 0), undefined);
  assert.equal(wilsonLowerBound(5, 0), undefined);
});

test("rollup sin muestras leídas ⇒ inboxWilsonLb undefined", () => {
  const r = computeRollup([row(null), row(null)]);
  assert.equal(r.samples, 0);
  assert.equal(r.inboxWilsonLb, undefined);
  assert.equal(r.inboxEwma, undefined, "sin previo ni LB, no inventa EWMA");
});

// ── §9 regla 5: EWMA suaviza ──────────────────────────────────────────────────
test("ewma suaviza: mezcla previo y actual según alpha", () => {
  // alpha por defecto 0.3
  assert.equal(ewma(undefined, 0.9), 0.9, "primera ventana arranca en current");
  assert.equal(ewma(0.9, 0.5, 0.3), 0.3 * 0.5 + 0.7 * 0.9);
  const smoothed = ewma(0.9, 0.5);
  assert.ok(smoothed > 0.5 && smoothed < 0.9, "el EWMA no salta al valor nuevo");
  assert.equal(DEFAULT_EWMA_ALPHA, 0.3);
});

test("computeRollup combina el LB de la ventana con el EWMA previo", () => {
  const results = [row("primary"), row("primary"), row("primary"), row("primary")];
  const lb = wilsonLowerBound(4, 4)!;
  const r = computeRollup(results, { prevEwma: 0.9 });
  assert.equal(r.inboxEwma, ewma(0.9, lb, DEFAULT_EWMA_ALPHA));
  // el EWMA queda entre el previo alto y el LB (más bajo por n chico)
  assert.ok(r.inboxEwma! > lb && r.inboxEwma! < 0.9);
});

test("sin muestras pero con EWMA previo, el rollup arrastra el previo (no lo borra)", () => {
  const r = computeRollup([row(null)], { prevEwma: 0.82 });
  assert.equal(r.inboxWilsonLb, undefined);
  assert.equal(r.inboxEwma, 0.82, "arrastra el previo, no cae a 0");
});

// ── §9 gate por proveedor mayor ───────────────────────────────────────────────
test("worstMajorProviderLb toma el peor LB entre proveedores mayores", () => {
  const results: PlacementResultRow[] = [
    // gmail: 10/10 inbox ⇒ LB alto
    ...Array.from({ length: 10 }, () => row("primary", "gmail")),
    // outlook: 1/5 inbox ⇒ LB bajo (este debe ganar como "peor")
    row("primary", "outlook"),
    row("spam", "outlook"),
    row("spam", "outlook"),
    row("spam", "outlook"),
    row("spam", "outlook")
  ];
  const worst = worstMajorProviderLb(results)!;
  const gmailLb = wilsonLowerBound(10, 10)!;
  const outlookLb = wilsonLowerBound(1, 5)!;
  assert.equal(worst, outlookLb);
  assert.ok(worst < gmailLb);
  assert.equal(computeRollup(results).worstMajorProviderLb, outlookLb);
});

test("gmx/webde no son proveedores mayores: no arrastran el gate", () => {
  const results = [row("spam", "gmx"), row("spam", "webde"), row("primary", "gmail")];
  assert.equal(worstMajorProviderLb(results), wilsonLowerBound(1, 1), "solo gmail cuenta");
});

test("worstMajorProviderLb undefined si ningún proveedor mayor tiene muestras", () => {
  assert.equal(worstMajorProviderLb([row(null, "gmail"), row("spam", "gmx")]), undefined);
});

// ── complaintRate entra como dato externo (no derivable de seeds) ─────────────
test("complaintRate se propaga al rollup cuando se pasa como opción", () => {
  const r = computeRollup([row("primary")], { complaintRate: 0.004 });
  assert.equal(r.complaintRate, 0.004);
  assert.equal(computeRollup([row("primary")]).complaintRate, undefined);
});

// ── Wilson: sanidad numérica ──────────────────────────────────────────────────
test("wilsonLowerBound usa z=1.96 por defecto y clampa a [0,1]", () => {
  assert.equal(wilsonLowerBound(1, 1), wilsonLowerBound(1, 1, Z_95));
  const lb = wilsonLowerBound(0, 5)!;
  assert.ok(lb >= 0, "0 éxitos ⇒ LB >= 0, nunca negativo");
});
