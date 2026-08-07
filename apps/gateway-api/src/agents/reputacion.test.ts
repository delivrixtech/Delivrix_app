// Tests de los ojos de reputación. Lo que fijan NO es que los chequeos anden — es que NINGUNO
// pueda terminar en "ok" sin haber medido. Todos los incidentes caros de este proyecto tienen la
// misma forma: un chequeo que no se pudo hacer, leído como un chequeo que pasó.

import assert from "node:assert/strict";
import test from "node:test";

import { revisarReputacionDe, type EntradaReputacion } from "./reputacion.ts";

const AHORA = new Date("2026-08-06T12:00:00.000Z");

/** Un error de DNS como los que tira node:dns: lo que importa es el `code`. */
function errDns(code: string): Error & { code: string } {
  return Object.assign(new Error(`query failed: ${code}`), { code });
}

const nunca = () => new Promise<never>(() => {});

function entrada(over: Partial<EntradaReputacion> = {}): EntradaReputacion {
  return {
    dominio: "corpfiling-infra.com",
    ip: "80.190.75.10",
    now: () => AHORA,
    resolveTxt: async (fqdn) => {
      if (fqdn === "corpfiling-infra.com") return [["v=spf1 ip4:80.190.75.10 -all"]];
      if (fqdn === "_dmarc.corpfiling-infra.com") return [["v=DMARC1; p=quarantine; rua=mailto:x@y.com"]];
      if (fqdn === "s2026a._domainkey.corpfiling-infra.com") return [["v=DKIM1; k=rsa; p=MIIBIjANBg"]];
      throw errDns("ENOTFOUND");
    },
    reverse: async () => ["mail.corpfiling-infra.com"],
    resolve4: async () => ["80.190.75.10"],
    blacklist: async () => ({ estado: "clean", listas: [] }),
    ...over
  };
}

test("todo en verde: las cinco señales dan ok, y la IP viaja tal cual", async () => {
  const r = await revisarReputacionDe(entrada());
  assert.equal(r.ip, "80.190.75.10");
  assert.deepEqual(
    [r.blacklist.estado, r.spf.estado, r.dkim.estado, r.dmarc.estado, r.ptr.estado],
    ["ok", "ok", "ok", "ok", "ok"]
  );
  assert.match(r.dkim.detalle, /s2026a/, "encuentra el selector real de Delivrix, no 'default'");
});

test("UNA sola consulta de API por invocación: la cuota se gasta solo en listas negras", async () => {
  // Son 58 nodos. A cinco comandos por nodo (blacklist + spf + dkim + dmarc + ptr) la cuota de
  // MXToolbox se agota justo el día que hace falta y el chequeo queda mudo. SPF/DMARC/PTR salen de
  // node:dns y DKIM del diagnóstico que ya existe en el repo: todo eso cuesta cero.
  let consultas = 0;
  await revisarReputacionDe(entrada({ blacklist: async () => { consultas += 1; return { estado: "clean", listas: [] }; } }));
  assert.equal(consultas, 1);
});

test("sin IP no se llama a la API, y NADA sale como limpio", async () => {
  // Un dominio con credencial y sin binding existe de verdad en el inventario. Preguntar por listas
  // negras de una IP que no se sabe cuál es no tiene sentido, y gastar cuota en eso menos.
  let consultas = 0;
  const r = await revisarReputacionDe(entrada({ ip: null, blacklist: async () => { consultas += 1; return { estado: "clean", listas: [] }; } }));
  assert.equal(consultas, 0, "no se gasta cuota en una pregunta que no se puede formular");
  assert.equal(r.blacklist.estado, "no-se");
  assert.equal(r.ptr.estado, "no-se");
  assert.match(r.blacklist.detalle, /no sé de qué IP hablamos/);
  // La auth del dominio SÍ se puede mirar sin IP: no se pierde por el camino.
  assert.equal(r.spf.estado, "ok");
});

test("TODO colgado: cinco 'no sé', ni un solo 'ok'", async () => {
  // La lección del 2026-07-29: un probe con `head -c` se colgó esperando un banner, devolvió rc=124
  // y reportó 10 de 10 nodos bloqueados estando los 8 bien. Un chequeo que se cuelga es "no sé".
  const r = await revisarReputacionDe(
    entrada({ timeoutMs: 20, resolveTxt: nunca, reverse: nunca, resolve4: nunca, blacklist: nunca })
  );
  const estados = [r.blacklist.estado, r.spf.estado, r.dkim.estado, r.dmarc.estado, r.ptr.estado];
  assert.deepEqual(estados, ["no-se", "no-se", "no-se", "no-se", "no-se"]);
  assert.equal(estados.filter((e) => e === "ok").length, 0);
  assert.match(r.blacklist.detalle, /no respondió en 20 ms/, "dice por qué no sabe, no lo esconde");
});

test("el plazo envuelve TODO junto: cinco chequeos colgados no tardan cinco plazos", async () => {
  const t0 = Date.now();
  await revisarReputacionDe(entrada({ timeoutMs: 60, resolveTxt: nunca, reverse: nunca, resolve4: nunca, blacklist: nunca }));
  assert.ok(Date.now() - t0 < 250, `tardó ${Date.now() - t0} ms: el plazo tiene que ser compartido, no por chequeo`);
});

// ── SPF ────────────────────────────────────────────────────────────────────────────────────────

test("SPF: sin registro es 'mal'; el DNS caído es 'no sé'", async () => {
  const sin = await revisarReputacionDe(entrada({ resolveTxt: async () => { throw errDns("ENOTFOUND"); } }));
  assert.equal(sin.spf.estado, "mal", "NXDOMAIN es un dato: no publica SPF");

  // SERVFAIL NO es un dato. Colapsarlo con el anterior fabrica las dos mentiras: "no publica SPF"
  // cuando el DNS estaba caído, y confianza sobre una medición que no existió.
  const roto = await revisarReputacionDe(entrada({ resolveTxt: async () => { throw errDns("ESERVFAIL"); } }));
  assert.equal(roto.spf.estado, "no-se");
  assert.match(roto.spf.detalle, /ESERVFAIL/);
});

test("SPF: dos registros es permerror, aunque los dos se vean bien de a uno", async () => {
  const r = await revisarReputacionDe(
    entrada({ resolveTxt: async () => [["v=spf1 ip4:1.2.3.4 -all"], ["v=spf1 include:otro.com ~all"]] })
  );
  assert.equal(r.spf.estado, "mal");
  assert.match(r.spf.detalle, /permerror/);
});

test("SPF: +all autoriza a cualquiera, y eso no es 'ok'", async () => {
  const abierto = await revisarReputacionDe(entrada({ resolveTxt: async () => [["v=spf1 +all"]] }));
  assert.equal(abierto.spf.estado, "mal");

  const sinAll = await revisarReputacionDe(entrada({ resolveTxt: async () => [["v=spf1 ip4:1.2.3.4"]] }));
  assert.equal(sinAll.spf.estado, "mal");
  assert.match(sinAll.spf.detalle, /sin mecanismo all/);

  // El `all` que manda es el último: antes hay includes con palabras que terminan parecido.
  const conInclude = await revisarReputacionDe(entrada({ resolveTxt: async () => [["v=spf1 include:_spf.allmail.com -all"]] }));
  assert.equal(conInclude.spf.estado, "ok");
});

test("SPF: los TXT partidos en trozos de 255 bytes se pegan antes de mirarlos", async () => {
  const r = await revisarReputacionDe(entrada({ resolveTxt: async () => [["v=spf1 ip4:80.190.75.10 ", "-all"]] }));
  assert.equal(r.spf.estado, "ok");
});

// ── DMARC ──────────────────────────────────────────────────────────────────────────────────────

test("DMARC: p=none es 'ok' porque cumple el mínimo, pero el texto dice que no protege", async () => {
  // Gmail y Yahoo exigen un registro DMARC desde 2024; p=none lo cumple. Marcarlo "mal" haría que
  // el agente pida arreglar algo que ya cumple, y ese ruido es cómo se entrena a ignorarlo.
  const r = await revisarReputacionDe(
    entrada({ resolveTxt: async (f) => (f.startsWith("_dmarc.") ? [["v=DMARC1; p=none"]] : [["v=spf1 -all"]]) })
  );
  assert.equal(r.dmarc.estado, "ok");
  assert.match(r.dmarc.detalle, /no protege/);
});

test("DMARC: sin registro es 'mal'", async () => {
  const r = await revisarReputacionDe(
    entrada({ resolveTxt: async (f) => (f.startsWith("_dmarc.") ? [] : [["v=spf1 -all"]]) })
  );
  assert.equal(r.dmarc.estado, "mal");
  assert.match(r.dmarc.detalle, /no publica DMARC/);
});

// ── DKIM ───────────────────────────────────────────────────────────────────────────────────────

test("DKIM: si NINGÚN selector resolvió es 'no sé', jamás 'sin DKIM'", async () => {
  // Es la razón de ser de diagnoseDkim y por eso se reusa en vez de escribir otro: un DNS caído
  // reportado como "DKIM missing" bloquea envíos cuya firma está perfecta.
  const r = await revisarReputacionDe(
    entrada({
      resolveTxt: async (f) => {
        if (f.includes("_domainkey")) throw errDns("ESERVFAIL");
        return f.startsWith("_dmarc.") ? [["v=DMARC1; p=quarantine"]] : [["v=spf1 -all"]];
      }
    })
  );
  assert.equal(r.dkim.estado, "no-se");
  assert.match(r.dkim.detalle, /puede ser el DNS/);
});

test("DKIM: una clave REVOCADA (p= vacío) no es 'ok' ni es ausencia", async () => {
  const r = await revisarReputacionDe(
    entrada({
      resolveTxt: async (f) => {
        if (f === "s2026a._domainkey.corpfiling-infra.com") return [["v=DKIM1; k=rsa; p="]];
        if (f.includes("_domainkey")) throw errDns("ENOTFOUND");
        return f.startsWith("_dmarc.") ? [["v=DMARC1; p=quarantine"]] : [["v=spf1 -all"]];
      }
    })
  );
  assert.equal(r.dkim.estado, "mal");
  assert.match(r.dkim.detalle, /REVOCADO/);
});

// ── PTR ────────────────────────────────────────────────────────────────────────────────────────

test("PTR: sin confirmación hacia adelante NO es 'ok'", async () => {
  // El receptor hace FCrDNS: un PTR que apunta a un nombre que no vuelve a la misma IP vale cero.
  // Sin este segundo paso, un PTR a un nombre muerto se reportaría en verde y el problema quedaría
  // invisible justo en el dominio que no entrega.
  const r = await revisarReputacionDe(entrada({ resolve4: async () => ["1.2.3.4"] }));
  assert.equal(r.ptr.estado, "mal");
  assert.match(r.ptr.detalle, /no vuelve a 80\.190\.75\.10/);
});

test("PTR: sin PTR es 'mal'; el reverse que falla por otra cosa es 'no sé'", async () => {
  const sin = await revisarReputacionDe(entrada({ reverse: async () => { throw errDns("ENOTFOUND"); } }));
  assert.equal(sin.ptr.estado, "mal");

  const roto = await revisarReputacionDe(entrada({ reverse: async () => { throw errDns("ETIMEOUT"); } }));
  assert.equal(roto.ptr.estado, "no-se");

  const vacio = await revisarReputacionDe(entrada({ reverse: async () => [] }));
  assert.equal(vacio.ptr.estado, "mal", "lista vacía es 'no tiene PTR', no un error");
});

// ── LISTAS NEGRAS ──────────────────────────────────────────────────────────────────────────────

test("listas negras: listado nombra las listas; error de la API es 'no sé'", async () => {
  const listado = await revisarReputacionDe(entrada({ blacklist: async () => ({ estado: "listed", listas: ["SPAMCOP", "SORBS"] }) }));
  assert.equal(listado.blacklist.estado, "mal");
  assert.match(listado.blacklist.detalle, /SPAMCOP, SORBS/);

  // Un fallo de la API NO puede salir como "sin detecciones": ese es el modo exacto en que un
  // instrumento roto se disfraza de buena noticia.
  const error = await revisarReputacionDe(entrada({ blacklist: async () => ({ estado: "error", listas: [] }) }));
  assert.equal(error.blacklist.estado, "no-se");
  assert.doesNotMatch(error.blacklist.detalle, /sin detecciones/);

  // Hacia el verde no se falla nunca: un aviso no es una detección, pero tampoco es limpio.
  const aviso = await revisarReputacionDe(entrada({ blacklist: async () => ({ estado: "warning", listas: ["UCEPROTECT"] }) }));
  assert.equal(aviso.blacklist.estado, "mal");
});

test("la API que revienta no rompe la lectura: las otras cuatro señales siguen saliendo", async () => {
  const r = await revisarReputacionDe(entrada({ blacklist: async () => { throw new Error("ECONNRESET"); } }));
  assert.equal(r.blacklist.estado, "no-se");
  assert.match(r.blacklist.detalle, /ECONNRESET/);
  assert.equal(r.spf.estado, "ok");
  assert.equal(r.dmarc.estado, "ok");
});
