import test from "node:test";
import assert from "node:assert/strict";
import {
  DELIVERY_STATS_WINDOW,
  assessDeliveryHealth,
  buildDeliveryStatsCommand,
  parseDeliveryStats,
  readNodeDeliveryHealth,
  type DeliveryHealthSshRunner
} from "./smtp-delivery-health.ts";

function stdout(input: {
  delivered?: Array<[number, string]>;
  blocked?: Array<[number, string]>;
  deferred?: Array<[number, string]>;
  truncated?: boolean;
}): string {
  const block = (rows?: Array<[number, string]>): string =>
    (rows ?? []).map(([n, d]) => `   ${n} ${d}`).join("\n");
  const lines = [
    "## DELIVERED", block(input.delivered),
    "## BLOCKED", block(input.blocked),
    "## DEFERRED", block(input.deferred)
  ];
  if (!input.truncated) lines.push("## END");
  return `${lines.join("\n")}\n`;
}

test("buildDeliveryStatsCommand: solo lee, no envia, y marca el fin", () => {
  const command = buildDeliveryStatsCommand();
  assert.match(command, /mail\.log/);
  assert.match(command, /## END/);
  assert.equal(/set -e/.test(command), false);
  // Es una señal pasiva: no debe existir ninguna ruta de envío acá.
  assert.equal(/sendmail|smtp-source|swaks/.test(command), false);
});

test("parseDeliveryStats: agrega por proveedor y totaliza", () => {
  const stats = parseDeliveryStats(stdout({
    delivered: [[706, "gmail.com"], [140, "yahoo.com"]],
    blocked: [[3, "gmail.com"]]
  }))!;
  assert.equal(stats.totals.delivered, 846);
  assert.equal(stats.totals.blocked, 3);
  assert.equal(stats.byProvider[0]!.provider, "gmail.com");
  assert.equal(stats.byProvider[0]!.delivered, 706);
});

test("parseDeliveryStats: salida truncada ⇒ null (no se inventa salud)", () => {
  assert.equal(parseDeliveryStats(stdout({ delivered: [[10, "gmail.com"]], truncated: true })), null);
});

// El caso real de corp-delivery.com: entrega perfecto en yahoo/aol mientras Gmail lo
// rechaza en el 100% de los intentos. Un promedio global lo habria dado sano.
test("assessDeliveryHealth: cerrado en un proveedor aunque el resto entregue bien", () => {
  const verdict = assessDeliveryHealth(parseDeliveryStats(stdout({
    delivered: [[1483, "yahoo.com"], [416, "aol.com"], [4, "gmail.com"]],
    blocked: [[3883, "gmail.com"]]
  }))!);
  assert.equal(verdict.status, "blocked_by_provider");
  assert.deepEqual(verdict.blockedProviders, ["gmail.com"]);
  assert.match(verdict.detail, /gmail\.com/);
});

test("assessDeliveryHealth: nodo sano con volumen real a gmail", () => {
  const verdict = assessDeliveryHealth(parseDeliveryStats(stdout({
    delivered: [[706, "gmail.com"], [140, "yahoo.com"], [35, "aol.com"]]
  }))!);
  assert.equal(verdict.status, "healthy");
  assert.deepEqual(verdict.blockedProviders, []);
});

test("assessDeliveryHealth: rechazo parcial ⇒ degraded", () => {
  const verdict = assessDeliveryHealth(parseDeliveryStats(stdout({
    delivered: [[60, "gmail.com"]],
    blocked: [[40, "gmail.com"]]
  }))!);
  assert.equal(verdict.status, "degraded");
  assert.deepEqual(verdict.degradedProviders, ["gmail.com"]);
});

test("assessDeliveryHealth: pocos intentos no alcanzan para acusar bloqueo", () => {
  const verdict = assessDeliveryHealth(parseDeliveryStats(stdout({
    blocked: [[3, "gmail.com"]]
  }))!);
  assert.equal(verdict.status, "healthy");
  assert.deepEqual(verdict.blockedProviders, []);
});

// Los nodos MAS sanos aparecian "cerrados en su propio dominio": son los rebotes que
// Postfix se manda a si mismo (postmaster, notificaciones de no-entrega), no un proveedor.
test("assessDeliveryHealth: los rebotes al propio dominio no cuentan como bloqueo", () => {
  const stats = parseDeliveryStats(stdout({
    delivered: [[4944, "gmail.com"]],
    blocked: [[120, "infranationalreport.com"]]
  }))!;
  assert.equal(assessDeliveryHealth(stats).status, "blocked_by_provider");
  assert.equal(assessDeliveryHealth(stats, "infranationalreport.com").status, "healthy");
});

test("assessDeliveryHealth: excluir el propio dominio no tapa un bloqueo real de proveedor", () => {
  const stats = parseDeliveryStats(stdout({
    delivered: [[500, "yahoo.com"]],
    blocked: [[300, "gmail.com"], [40, "propio.com"]]
  }))!;
  const verdict = assessDeliveryHealth(stats, "propio.com");
  assert.equal(verdict.status, "blocked_by_provider");
  assert.deepEqual(verdict.blockedProviders, ["gmail.com"]);
});

test("assessDeliveryHealth: sin trafico ⇒ no_traffic, no 'sano'", () => {
  const verdict = assessDeliveryHealth(parseDeliveryStats(stdout({}))!);
  assert.equal(verdict.status, "no_traffic");
});

// El falso negativo peligroso: si no se pudo leer, NO puede decir "sano".
test("readNodeDeliveryHealth: SSH que falla ⇒ unreadable, nunca healthy", async () => {
  const sshRunner: DeliveryHealthSshRunner = {
    run: async () => { throw new Error("SSH command failed with exit 255.\nPermission denied (publickey)."); }
  };
  const verdict = await readNodeDeliveryHealth({ sshRunner, serverSlug: "server60", serverIp: "10.0.0.1" });
  assert.equal(verdict.status, "unreadable");
  assert.match(verdict.detail, /lectura fallida/);
});

test("readNodeDeliveryHealth: propaga serverSlug (el runner elige usuario y sudo)", async () => {
  const seen: Array<string | null | undefined> = [];
  const sshRunner: DeliveryHealthSshRunner = {
    run: async (input) => {
      seen.push(input.serverSlug);
      return { stdout: stdout({ delivered: [[100, "gmail.com"]] }), exitCode: 0 };
    }
  };
  const verdict = await readNodeDeliveryHealth({ sshRunner, serverSlug: "server60", serverIp: "10.0.0.1" });
  assert.equal(verdict.status, "healthy");
  assert.deepEqual(seen, ["server60"]);
});

// --- el diferido cuenta: era el agujero mas grande del modulo ---------------

test("un nodo que difiere casi todo NO es 'sin trafico' ni 'sano'", () => {
  // Medido en la flota el 2026-07-30: 2.193 diferidos contra 1.504 entregados hacia Gmail en un
  // solo dia, y ~14.000 mensajes atascados. `attempts` era delivered+blocked, asi que deferred
  // no existia para el veredicto: un nodo con la cola llena y cero entregas caia en `no_traffic`
  // — "el nodo no registra trafico saliente" — que es lo contrario exacto de lo que pasa.
  const verdict = assessDeliveryHealth({
    totals: { delivered: 0, blocked: 0, deferred: 920 },
    byProvider: [{ provider: "comcast.net", delivered: 0, blocked: 0, deferred: 920 }]
  });

  assert.equal(verdict.status, "stalled");
  assert.match(verdict.detail, /920 diferidos/);
  assert.match(verdict.detail, /la cola se acumula/);
});

test("no_traffic queda SOLO para el log realmente vacio", () => {
  const verdict = assessDeliveryHealth({
    totals: { delivered: 0, blocked: 0, deferred: 0 },
    byProvider: []
  });
  assert.equal(verdict.status, "no_traffic");
  assert.match(verdict.detail, /ni diferidos/);
});

test("algo de diferido con entregas sanas NO dispara stalled", () => {
  // 30% diferido es normal en correo: reintentos transitorios. El freno es para el 50%+.
  const verdict = assessDeliveryHealth({
    totals: { delivered: 700, blocked: 0, deferred: 300 },
    byProvider: [{ provider: "gmail.com", delivered: 700, blocked: 0, deferred: 300 }]
  });
  assert.equal(verdict.status, "healthy");
});

test("el veredicto declara SIEMPRE que ventana cubre: nunca es 'hoy'", () => {
  // El comando lee /var/log/mail.log* — todo el log rotado. Rotularlo "hoy" en la pantalla
  // seria fabricar un mock nuevo.
  const verdict = assessDeliveryHealth({ totals: { delivered: 10, blocked: 0, deferred: 0 }, byProvider: [] });
  assert.equal(verdict.window, DELIVERY_STATS_WINDOW);
  assert.match(verdict.window, /no es de hoy/);
});
