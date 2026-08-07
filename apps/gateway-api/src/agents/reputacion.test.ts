// Tests de los ojos de reputación. Lo que fijan NO es que los chequeos anden — es que NINGUNO
// pueda terminar en "ok" sin haber medido. Todos los incidentes caros de este proyecto tienen la
// misma forma: un chequeo que no se pudo hacer, leído como un chequeo que pasó.

import assert from "node:assert/strict";
import test from "node:test";

import {
  barridoDeReputacion,
  ordenDelBarrido,
  PRESUPUESTO_LISTAS_POR_BARRIDO,
  revisarReputacionDe,
  type ChequeoReputacion,
  type EntradaReputacion,
  type ReputacionLeida
} from "./reputacion.ts";
// Se importa del MOTOR a propósito: lo que hay que fijar es que la señal llegue hasta la válvula
// que excluye del pool, no que el campo se llene. El 5º incidente de esta clase fue exactamente un
// campo que se llenaba de un lado y no cruzaba al otro.
import { authRota, elegirPool } from "../../../warmup-engine/src/service/plan-diario.ts";

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

// ── TLS: la señal que no miraba nadie ────────────────────────────────────────────────────────────

test("sin sonda de TLS el certificado sale 'no sé', nunca vigente", async () => {
  // La regla 1 del módulo, en el chequeo más nuevo: el cuarto estado implícito ("no lo miré, debe
  // estar bien") es el que fabrica las mentiras caras.
  const r = await revisarReputacionDe(entrada());
  assert.equal(r.tls.estado, "no-se");
});

test("el certificado vencido y el que está por vencer son los dos 'mal'", async () => {
  // filing-ops.com se quedó sin cert TLS y ninguna de las otras cuatro señales se movió: SPF, DKIM,
  // DMARC y PTR seguían en verde mientras los receptores que exigen STARTTLS le cerraban la puerta.
  const vencido = await revisarReputacionDe(entrada({ tls: async () => ({ vence: "2026-08-01T00:00:00Z", nombre: "mail.x.com" }) }));
  assert.equal(vencido.tls.estado, "mal");
  assert.match(vencido.tls.detalle, /venció hace \d+ día/);

  const porVencer = await revisarReputacionDe(entrada({ tls: async () => ({ vence: "2026-08-13T12:00:00Z", nombre: null }) }));
  assert.equal(porVencer.tls.estado, "mal", "7 días de margen ya es un problema: hay que renovarlo antes");

  const sano = await revisarReputacionDe(entrada({ tls: async () => ({ vence: "2026-11-06T12:00:00Z", nombre: "mail.x.com" }) }));
  assert.equal(sano.tls.estado, "ok");
});

test("el 587 sin certificado es 'mal', y el handshake que se cuelga es 'no sé'", async () => {
  const sinCert = await revisarReputacionDe(entrada({ tls: async () => null }));
  assert.equal(sinCert.tls.estado, "mal", "responde pero no presenta certificado: STARTTLS no sirve");

  const colgado = await revisarReputacionDe(entrada({ timeoutMs: 20, tls: nunca }));
  assert.equal(colgado.tls.estado, "no-se", "un chequeo colgado es 'no sé', no 'bloqueado' (la lección del probe con head -c)");
});

// ── El barrido diario ────────────────────────────────────────────────────────────────────────────

const rep = (dominio: string, over: Partial<ReputacionLeida> = {}): ReputacionLeida => {
  const ok: ChequeoReputacion = { estado: "ok", detalle: "ok" };
  return { dominio, ip: "1.2.3.4", blacklist: { estado: "ok", detalle: "sin detecciones" }, spf: ok, dkim: ok, dmarc: ok, ptr: ok, tls: ok, ...over };
};

test("el orden del barrido: primero los que calientan, después los cerca, después el resto", async () => {
  // No es cosmético: con la cuota acotada, el orden decide QUIÉN queda medido. Los dos primeros
  // grupos son donde la respuesta cambia una decisión de hoy o algo irreversible.
  assert.deepEqual(
    ordenDelBarrido({
      todos: ["zzz.com", "quema.com", "aaa.com", "calienta.com"],
      calientanHoy: ["calienta.com"],
      cerca: ["quema.com"]
    }),
    ["calienta.com", "quema.com", "aaa.com", "zzz.com"]
  );
});

test("cuota agotada ⇒ los que sobran quedan en 'no-se', NUNCA en limpio", async () => {
  // Es LA confusión que costó julio: el 2026-07-25 había 38 nodos cerrados en Gmail y el chequeo de
  // blacklists decía 0 detecciones, y alguien leyó ese cero como "está limpio".
  const pedidos: Array<{ d: string; conListas: boolean }> = [];
  const a = await barridoDeReputacion({
    orden: ["a.com", "b.com", "c.com"],
    presupuesto: 1,
    now: () => AHORA,
    revisar: async (d, conListas) => {
      pedidos.push({ d, conListas });
      return rep(d, conListas ? {} : { blacklist: { estado: "no-se", detalle: "no consultado" } });
    }
  });
  assert.deepEqual(a.dominios.map((f) => f.listas), [[], "no-se", "no-se"]);
  assert.deepEqual(a.cuota, { gastadas: 1, presupuesto: 1, sinConsultar: 2 });
  assert.deepEqual(pedidos.map((p) => p.conListas), [true, false, false], "no se llama a la API paga después del tope");
  // Y lo gratis se mide igual: quedarse sin cuota no puede dejar ciega a la autenticación.
  assert.equal(a.dominios[2]!.spf.estado, "ok");

  // LOS DOS "NO SÉ" SON DISTINTOS, y el archivo tiene que poder distinguirlos: "no pregunté porque
  // me quedé sin cuota" (decisión nuestra) contra "pregunté y falló" (ceguera de verdad). Sin la
  // marca, la regla del canal que avisa "no pude consultar las listas negras" era permanentemente
  // verdadera —33 de 58 filas todos los días— y sacaba ~4 mensajes diarios que no cambian ninguna
  // decisión del jefe.
  assert.deepEqual(a.dominios.map((f) => f.porPresupuesto), [undefined, true, true]);
});

test("un dominio que revienta no vacía el barrido ni se reporta limpio", async () => {
  const r = await barridoDeReputacion({
    orden: ["roto.com", "sano.com"],
    now: () => AHORA,
    revisar: async (d) => {
      if (d === "roto.com") throw new Error("ECONNREFUSED");
      return rep(d);
    }
  });
  assert.equal(r.dominios.length, 2, "el barrido sigue: un nodo no puede colgar la vuelta entera");
  assert.equal(r.dominios[0]!.listas, "no-se");
  assert.equal(r.dominios[0]!.spf.estado, "no-se", "las cinco señales quedan en 'no sé', no en verde");
  assert.equal(r.dominios[1]!.dominio, "sano.com");
});

test("el barrido es READ-ONLY: lo único que hace es preguntar", async () => {
  // El test que fija la promesa. `barridoDeReputacion` no recibe UN solo puerto de escritura —ni
  // mailer, ni cap, ni SSH— así que "no manda correo y no toca caps" no es una convención que
  // alguien pueda romper sin cambiar la firma. Lo único inyectado es `revisar`.
  const llamadas: string[] = [];
  const r = await barridoDeReputacion({
    orden: ["a.com"],
    now: () => AHORA,
    revisar: async (d) => { llamadas.push(d); return rep(d); }
  });
  assert.deepEqual(llamadas, ["a.com"], "una consulta por dominio, y nada más");
  assert.equal(r.medidoEn, AHORA.toISOString());
});

test("el presupuesto de cuota vive en CÓDIGO, no en una variable de entorno", () => {
  // Un tope que se sube con una env var a las 3 de la mañana dejó de ser un tope. La cuota de
  // MXToolbox se comparte con la pestaña Reputación del panel.
  assert.equal(typeof PRESUPUESTO_LISTAS_POR_BARRIDO, "number");
  assert.ok(PRESUPUESTO_LISTAS_POR_BARRIDO > 0 && PRESUPUESTO_LISTAS_POR_BARRIDO < 58, "menos que la flota entera");
});

// ── EL CERTIFICADO, DE PUNTA A PUNTA ─────────────────────────────────────────────────────────────

test("TLS: un cert VENCIDO llega hasta la exclusión del pool, no se queda en el campo", async () => {
  // No alcanza con probar que el campo se llena: el incidente de esta clase fue exactamente un campo
  // que se llenaba de un lado y no llegaba al otro. `chequearTls` estaba escrito y testeado desde el
  // primer día, y el llamador nunca le pasaba la sonda — o sea que `authRota`, que YA excluye por
  // `tls === "mal"`, estaba conectada a un dato que no podía valer "mal" ni con el cert caído.
  // filing-ops.com, uno de los 7 candidatos a soltar, es el dominio cuyo cert vencido lo motivó.
  const vencido = await revisarReputacionDe(entrada({
    dominio: "filing-ops.com",
    tls: async () => ({ vence: "2026-07-01T00:00:00.000Z", nombre: "mail.filing-ops.com" })
  }));
  assert.equal(vencido.tls.estado, "mal");
  assert.match(vencido.tls.detalle, /venció hace 37 día\(s\)/);

  // Y la cadena entera: la fila del archivo entra a `authRota` con la misma forma con la que la lee
  // `elegirPool`, y el dominio queda fuera del pool.
  assert.match(authRota({ tls: { estado: vencido.tls.estado } }) ?? "", /certificado TLS/);
  const cupos = { porDominio: new Map([["filing-ops.com", 20]]), vencida: false, medidoEn: AHORA.toISOString(), edadHoras: 1 };
  const { boxes } = elegirPool(cupos, ["filing-ops.com"], undefined, new Map([["filing-ops.com", { tls: { estado: vencido.tls.estado } }]]));
  assert.deepEqual(boxes, [], "con el certificado caído no se calienta: mandar así quema el dominio");

  // El "no sé" NO excluye a nadie, y esa asimetría es la que deja encender esto sin apagar la
  // fábrica: sin sonda inyectada la señal es "no sé" y el pool queda igual que hoy.
  const sinSonda = await revisarReputacionDe(entrada({ dominio: "filing-ops.com" }));
  assert.equal(sinSonda.tls.estado, "no-se");
  assert.equal(authRota({ tls: { estado: sinSonda.tls.estado } }), null);
});

// ── EL RECEPTOR, QUE SE LEÍA Y NO LO ESCRIBÍA NADIE ──────────────────────────────────────────────

test("la fila lleva el estado del RECEPTOR: la mitad de la regla d4 era código muerto", async () => {
  // La regla que no negocia este módulo —"listas limpias PERO el receptor cerrado"— es el modo de
  // falla exacto del 2026-07-25: 38 de 64 nodos rechazados por Gmail con 550-5.7.1 y TODAS sus IPs
  // limpias. El canal la tenía implementada y leía `receptor`, que nadie escribía. Hay 36 bandejas
  // cerradas hoy para reproducirla.
  const r = await barridoDeReputacion({
    orden: ["cerrado.com", "sano.com"],
    now: () => AHORA,
    receptorDe: (d) => (d === "cerrado.com" ? "cerrado" : "sano"),
    revisar: async (d) => rep(d)
  });
  assert.equal(r.dominios[0]!.receptor, "cerrado");
  assert.deepEqual(r.dominios[0]!.listas, [], "y con las listas limpias: las dos señales cruzadas");
  assert.equal(r.dominios[1]!.receptor, "sano");

  // Sin el dato, `null`: "no se sabe", jamás "sano". Ausencia de dato no es evidencia de nada.
  const sin = await barridoDeReputacion({ orden: ["x.com"], now: () => AHORA, revisar: async (d) => rep(d) });
  assert.equal(sin.dominios[0]!.receptor, null);
});

// ── LA CUOTA: NO SE GASTA EN PREGUNTAS QUE NO SE FORMULAN ────────────────────────────────────────

test("un dominio SIN IP no gasta presupuesto: la unidad queda para el que sí se puede consultar", async () => {
  // Medido: hasta 7 de las 25 consultas (28%) se iban en dominios sin binding, donde
  // `chequearBlacklist` ni llama a la API. Los dominios del final de la lista quedaban sin medir por
  // una cuota que nadie gastó.
  const r = await barridoDeReputacion({
    orden: ["sinip1.com", "sinip2.com", "sinip3.com", "conip1.com", "conip2.com"],
    presupuesto: 2,
    now: () => AHORA,
    revisar: async (d, conListas) =>
      d.startsWith("sinip")
        ? rep(d, { ip: null, blacklist: { estado: "no-se", detalle: "no sé de qué IP hablamos: el dominio no tiene nodo asignado en el inventario" } })
        : rep(d, conListas ? {} : { blacklist: { estado: "no-se", detalle: "no consultado" } })
  });
  assert.equal(r.cuota.gastadas, 2, "las dos unidades se gastaron en los dos que sí tienen IP");
  assert.deepEqual(r.dominios.map((f) => f.listas), ["no-se", "no-se", "no-se", [], []]);
  // Y el "no sé" de los sin IP NO se marca como decisión de presupuesto: no fue el tope, fue que no
  // hay a quién preguntarle.
  assert.equal(r.dominios[0]!.porPresupuesto, undefined);
});

test("cuando se pregunta y no hay veredicto, se guarda POR QUÉ", async () => {
  // De 25 consultas del barrido real, 13 volvieron sin veredicto y el motivo se descartaba: la
  // cobertura real era 12 de 66 (18%) y el archivo la mostraba como 25 de 66. Entre las 13 perdidas
  // había 4 de los 6 dominios que HOY calientan, que son prioridad 0 del orden.
  const r = await barridoDeReputacion({
    orden: ["a.com"],
    now: () => AHORA,
    revisar: async (d) => rep(d, { blacklist: { estado: "no-se", detalle: "la API de listas negras respondió con error" } })
  });
  assert.equal(r.dominios[0]!.listas, "no-se");
  assert.equal(r.dominios[0]!.listasMotivo, "la API de listas negras respondió con error");
  assert.equal(r.cuota.gastadas, 1, "la consulta se gastó igual: preguntamos");

  // Y una fila con veredicto no arrastra motivo: el campo existe solo cuando hay algo que explicar.
  const ok = await barridoDeReputacion({ orden: ["b.com"], now: () => AHORA, revisar: async (d) => rep(d) });
  assert.equal(ok.dominios[0]!.listasMotivo, undefined);
});
