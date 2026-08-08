// Tests del límite físico. El grueso NO testea mi idea del policy service: ejecuta el script
// Python REAL que se instala en el nodo, hablándole el protocolo real de Postfix por stdin. Un
// fixture escrito desde mi suposición del wire no cazaría que el contrato está mal (la lección de
// Bedrock: test y código compartirían el mismo error).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCapSelfCheckCommand,
  buildDailyCapInstallPlan,
  buildDailyCapRollbackPlan,
  buildDailyCapStatusCommand,
  buildFrenoPlan,
  CAP_POLICY_PARAM,
  lineaDeUso,
  parseDailyCapStatus,
  porEncimaDelTecho,
  renderDailyCapPolicyScript,
  SUBMISSION_RESTRICTIONS
} from "./node-daily-cap.ts";
import { TECHO_DURO_POR_DOMINIO } from "../../warmup-engine/src/domain/decision-diaria.ts";

/** Un request real del protocolo de policy delegation (atributos + línea vacía). */
function request(attrs: Record<string, string>): string {
  return `${Object.entries(attrs)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n\n`;
}

async function prepararScript(): Promise<{ dir: string; script: string; capFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cap-policy-"));
  const script = join(dir, "policy.py");
  await writeFile(script, renderDailyCapPolicyScript(), { mode: 0o755 });
  return { dir, script, capFile: join(dir, "cap") };
}

/** Corre el script real como lo corre Postfix: requests por stdin, acciones por stdout. */
function correr(script: string, entrada: string, env: Record<string, string>): string[] {
  const r = spawnSync("python3", [script], {
    input: entrada,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  assert.equal(r.status, 0, `el script salió ${r.status}: ${r.stderr}`);
  return r.stdout.split("\n").filter((l) => l.startsWith("action="));
}

test("el script real respeta el cap: bajo el tope pasa, al cruzarlo DIFIERE", async () => {
  const { dir, script, capFile } = await prepararScript();
  await writeFile(capFile, "3\n");
  const entrada = Array.from({ length: 5 }, () =>
    request({ request: "smtpd_access_policy", sasl_username: "mailer@a.com", recipient: "x@gmail.com" })
  ).join("");

  const acciones = correr(script, entrada, { QUOTA_CAP_FILE: capFile, QUOTA_COUNT_DIR: dir });

  assert.equal(acciones.length, 5, "una respuesta por request");
  assert.deepEqual(acciones.slice(0, 3), ["action=DUNNO", "action=DUNNO", "action=DUNNO"]);
  assert.match(acciones[3] ?? "", /^action=DEFER_IF_PERMIT 4\.7\.1/);
  assert.match(acciones[4] ?? "", /^action=DEFER_IF_PERMIT/);
});

test("fail-closed: sin archivo de cap legible NO se envía nada", async () => {
  const { dir, script, capFile } = await prepararScript();
  // capFile nunca se escribe: es el escenario "alguien borró/corrompió el cap".
  const acciones = correr(script, request({ request: "smtpd_access_policy", sasl_username: "mailer@a.com" }), {
    QUOTA_CAP_FILE: capFile,
    QUOTA_COUNT_DIR: dir
  });
  assert.match(acciones[0] ?? "", /^action=DEFER_IF_PERMIT/, "un cap ilegible NUNCA abre la puerta");
});

test("sin sasl_username no se cuenta: un tercero no puede agotarnos el cupo del día", async () => {
  const { dir, script, capFile } = await prepararScript();
  await writeFile(capFile, "2\n");
  // 5 requests sin autenticar (las echa el `reject` posterior) + 2 autenticadas que SÍ deben pasar.
  const entrada =
    Array.from({ length: 5 }, () => request({ request: "smtpd_access_policy", recipient: "x@gmail.com" })).join("") +
    request({ request: "smtpd_access_policy", sasl_username: "mailer@a.com" }) +
    request({ request: "smtpd_access_policy", sasl_username: "mailer@a.com" });

  const acciones = correr(script, entrada, { QUOTA_CAP_FILE: capFile, QUOTA_COUNT_DIR: dir });

  assert.deepEqual(acciones.slice(0, 5), Array(5).fill("action=DUNNO"), "las no autenticadas pasan sin contar");
  assert.deepEqual(acciones.slice(5), ["action=DUNNO", "action=DUNNO"], "el cupo real seguía intacto");
});

test("el contador sobrevive al reinicio del proceso (donde anvil falla)", async () => {
  const { dir, script, capFile } = await prepararScript();
  await writeFile(capFile, "2\n");
  const uno = request({ request: "smtpd_access_policy", sasl_username: "mailer@a.com" });

  // Tres PROCESOS distintos, como tres reload de Postfix: el contador es de disco, no de memoria.
  const a = correr(script, uno, { QUOTA_CAP_FILE: capFile, QUOTA_COUNT_DIR: dir });
  const b = correr(script, uno, { QUOTA_CAP_FILE: capFile, QUOTA_COUNT_DIR: dir });
  const c = correr(script, uno, { QUOTA_CAP_FILE: capFile, QUOTA_COUNT_DIR: dir });

  assert.equal(a[0], "action=DUNNO");
  assert.equal(b[0], "action=DUNNO");
  assert.match(c[0] ?? "", /^action=DEFER_IF_PERMIT/, "el 3º cruza el cap de 2 aunque el proceso sea nuevo");
});

test("el cap se cambia en caliente: se relee en cada request, sin reload", async () => {
  const { dir, script, capFile } = await prepararScript();
  await writeFile(capFile, "1\n");
  const uno = request({ request: "smtpd_access_policy", sasl_username: "mailer@a.com" });

  assert.equal(correr(script, uno, { QUOTA_CAP_FILE: capFile, QUOTA_COUNT_DIR: dir })[0], "action=DUNNO");
  assert.match(correr(script, uno, { QUOTA_CAP_FILE: capFile, QUOTA_COUNT_DIR: dir })[0] ?? "", /DEFER/);

  await writeFile(capFile, "5\n"); // el operador sube el tope
  assert.equal(
    correr(script, uno, { QUOTA_CAP_FILE: capFile, QUOTA_COUNT_DIR: dir })[0],
    "action=DUNNO",
    "sin reiniciar nada"
  );
});

test("el contador del día queda legible para el panel (lo lee el status por SSH)", async () => {
  const { dir, script, capFile } = await prepararScript();
  await writeFile(capFile, "10\n");
  correr(
    script,
    request({ request: "smtpd_access_policy", sasl_username: "mailer@a.com" }).repeat(4),
    { QUOTA_CAP_FILE: capFile, QUOTA_COUNT_DIR: dir }
  );
  // UTC: el mismo día que usa `date -u` en buildDailyCapStatusCommand. Si el script volviera a
  // hora local, este assert falla en cualquier huso corrido — que es justo lo que pasó.
  const dia = new Date().toISOString().slice(0, 10);
  const contenido = await readFile(join(dir, `count-${dia}`), "utf8");
  assert.equal(contenido.trim(), "4");
});

test("la AUTOPRUEBA corre entera por un shell real (no solo por stdin de node)", async () => {
  // Regresión del bug que cazó el canary: la autoprueba usaba `REQ=$(printf ...)` y la sustitución
  // de comandos come los newlines finales, así que el último request se quedaba sin su línea en
  // blanco y sin respuesta → exit 1 en un nodo donde el script estaba PERFECTO. Los tests de arriba
  // no podían verlo: alimentan stdin desde node, sin shell en el medio. Este pasa por bash.
  const { script } = await prepararScript();
  const r = spawnSync("bash", ["-c", buildCapSelfCheckCommand(script)], { encoding: "utf8" });
  assert.equal(r.status, 0, `la autoprueba falló: ${r.stderr}`);
  assert.match(r.stdout, /## SELFCHECK OK/);
});

test("contador con basura: difiere con motivo propio, sin morirse", async () => {
  const { dir, script, capFile } = await prepararScript();
  await writeFile(capFile, "2000\n");
  const dia = new Date().toISOString().slice(0, 10);
  await writeFile(join(dir, `count-${dia}`), "no-soy-un-numero\n");

  const acciones = correr(script, request({ request: "smtpd_access_policy", sasl_username: "mailer@a.com" }), {
    QUOTA_CAP_FILE: capFile,
    QUOTA_COUNT_DIR: dir
  });
  // correr() ya exige exit 0: el proceso NO murió (antes reventaba y Postfix caía a su 451 por
  // crash-loop; ahora el fail-closed es propio y dice por qué).
  assert.match(acciones[0] ?? "", /^action=DEFER_IF_PERMIT 4\.3\.5 quota state unreadable/);
});

test("directorio del contador no escribible: difiere, no deja pasar", async () => {
  const { script, capFile } = await prepararScript();
  await writeFile(capFile, "2000\n");
  const acciones = correr(script, request({ request: "smtpd_access_policy", sasl_username: "mailer@a.com" }), {
    QUOTA_CAP_FILE: capFile,
    QUOTA_COUNT_DIR: "/no/existe/este/dir"
  });
  assert.match(acciones[0] ?? "", /^action=DEFER_IF_PERMIT 4\.3\.5/);
});

test("cap file con texto no numérico = cap 0 = fail-closed", async () => {
  const { dir, script, capFile } = await prepararScript();
  await writeFile(capFile, "dos mil\n");
  const acciones = correr(script, request({ request: "smtpd_access_policy", sasl_username: "mailer@a.com" }), {
    QUOTA_CAP_FILE: capFile,
    QUOTA_COUNT_DIR: dir
  });
  assert.match(acciones[0] ?? "", /^action=DEFER_IF_PERMIT/);
});

test("un request sin su línea en blanco final no recibe respuesta (Postfix difiere por timeout)", async () => {
  const { dir, script, capFile } = await prepararScript();
  await writeFile(capFile, "10\n");
  const acciones = correr(
    script,
    request({ request: "smtpd_access_policy", sasl_username: "mailer@a.com" }) +
      "request=smtpd_access_policy\nsasl_username=mailer@a.com\n", // ← sin la línea vacía
    { QUOTA_CAP_FILE: capFile, QUOTA_COUNT_DIR: dir }
  );
  assert.equal(acciones.length, 1, "el request incompleto NO se contesta: nunca se aprueba a medias");
});

// ── El plan remoto ───────────────────────────────────────────────────────────────────────────────

test("check_policy_service va PRIMERO o el cap es decorativo", () => {
  // Postfix evalúa de izquierda a derecha y se detiene en el primer PERMIT: si
  // permit_sasl_authenticated fuera antes, el policy service no se consultaría jamás.
  const partes = SUBMISSION_RESTRICTIONS.split(",").map((p) => p.trim());
  assert.match(partes[0] ?? "", /^check_policy_service /);
  assert.ok(partes.indexOf("permit_sasl_authenticated") > 0);
  assert.equal(partes.at(-1), "reject");
});

test("la restriction se cablea por referencia a un parámetro, no inline", () => {
  // `postconf -P` muere con "does not accept whitespace in parameter value", y
  // `check_policy_service unix:private/quota` tiene un espacio irreductible. Cazado en el canary.
  const wire = buildDailyCapInstallPlan({ cap: 2000 }).find((p) => p.label === "wire-submission-restrictions");
  const cmd = wire?.command ?? "";
  assert.ok(cmd.includes(`postconf -e '${CAP_POLICY_PARAM} = `), "la lista con espacios va a main.cf");
  for (const linea of cmd.split(" && ").filter((l) => l.includes("postconf -P"))) {
    const valor = linea.split("=").slice(1).join("=").replace(/'/g, "");
    assert.ok(!/\s/.test(valor), `el valor de -P no puede llevar espacios: ${valor}`);
  }
});

test("la validación y el status leen el valor EXPANDIDO (-x), no la referencia", () => {
  // Sin -x, `postconf -P` devuelve "$delivrix_cap_policy" y el grep de check_policy_service falla:
  // un nodo bien cableado se reportaría como abierto.
  const validar = buildDailyCapInstallPlan({ cap: 2000 }).find((p) => p.label === "validate-wired");
  assert.match(validar?.command ?? "", /postconf -x -P submission\/inet/);
  assert.match(buildDailyCapStatusCommand(), /postconf -x -P submission\/inet/);
});

test("el plan autoprueba el script ANTES de cablear Postfix", () => {
  const plan = buildDailyCapInstallPlan({ cap: 2000 });
  const etiquetas = plan.map((p) => p.label);
  const selfcheck = etiquetas.indexOf("selfcheck-policy-script");
  assert.ok(selfcheck > etiquetas.indexOf("write-policy-script"), "primero se escribe");
  assert.ok(selfcheck < etiquetas.indexOf("wire-master-spawn"), "y se prueba ANTES de cablear");
  assert.ok(selfcheck < etiquetas.indexOf("wire-submission-restrictions"));
  assert.ok(etiquetas.indexOf("reload-postfix") > etiquetas.indexOf("wire-submission-restrictions"));
});

test("el plan usa reload y NO toca el smtpd global (el 25 recibe los rebotes)", () => {
  const plan = buildDailyCapInstallPlan({ cap: 2000 });
  const todo = plan.map((p) => p.command).join("\n");
  assert.ok(todo.includes("postfix reload"));
  assert.ok(!todo.includes("systemctl restart"), "restart corta conexiones en vuelo");
  // Solo se tocan los listeners de envío autenticado, nunca la restriction global.
  assert.ok(todo.includes("submission/inet/smtpd_recipient_restrictions"));
  assert.ok(todo.includes("smtps/inet/smtpd_recipient_restrictions"));
  assert.ok(
    !/postconf -e\s+'?smtpd_recipient_restrictions/.test(todo),
    "tocar la global contaría el correo ENTRANTE contra el cap de salida"
  );
});

test("el cap del plan se valida: nada de 0, negativos ni fracciones", () => {
  assert.throws(() => buildDailyCapInstallPlan({ cap: 0 }), /cap invalido/);
  assert.throws(() => buildDailyCapInstallPlan({ cap: -5 }), /cap invalido/);
  assert.throws(() => buildDailyCapInstallPlan({ cap: 12.5 }), /cap invalido/);
  assert.equal(buildDailyCapInstallPlan({ cap: 2000 }).length > 0, true);
});

test("el cap físico NO puede instalarse por encima del techo irreversible", () => {
  // EL INCIDENTE: hay nueve nodos con 15.000/día cableado, 3× el umbral permanente de Google, y
  // los nueve figuran hoy como cruzados. El cap hizo su trabajo; el trabajo estaba mal definido,
  // porque este módulo validaba contra 4.000 mientras la decisión del warmup validaba contra
  // 2.000. Dos números para la misma pared = ninguna pared.
  assert.throws(() => buildDailyCapInstallPlan({ cap: 15_000 }), /TECHO_DURO_POR_DOMINIO/);
  assert.throws(() => buildDailyCapInstallPlan({ cap: 50_000 }), /TECHO_DURO_POR_DOMINIO/);
  assert.throws(() => buildDailyCapInstallPlan({ cap: TECHO_DURO_POR_DOMINIO + 1 }), /TECHO_DURO_POR_DOMINIO/);
  assert.equal(buildDailyCapInstallPlan({ cap: TECHO_DURO_POR_DOMINIO }).length > 0, true, "el techo exacto sí vale");
  assert.equal(TECHO_DURO_POR_DOMINIO, 2000, "si esto cambia, cambió la pared de todo el sistema");
});

test("el cruce que faltaba: cerca del umbral Y con un cap que lo deja cruzarlo", () => {
  // infranationalreport.com: pico de 4.649/día a Google (93% del umbral irreversible) con 15.000
  // instalado. Los dos archivos los lee el monitor en la misma vuelta, cada 10 minutos, y nadie
  // los relacionó jamás — así que el aviso llegaría el día después de que ya no sirva.
  const nodos = [
    { domain: "infranationalreport.com", cap: 15_000 },
    { domain: "corpfiling-infra.com", cap: 20 },
    { domain: "docfiling-ops.com", cap: 2000 }
  ];
  assert.deepEqual(
    porEncimaDelTecho({ cerca: ["infranationalreport.com", "corpfiling-infra.com", "docfiling-ops.com"], nodos }),
    // EL CAP VIAJA CON EL NOMBRE. Con la lista de nombres sola, el mensaje de d2 no podía decir los
    // dos números que hacen falta para decidir (15.000 cableado contra 2.000 de techo) y la
    // respuesta textual del jefe al mensaje sin números fue "No entiendo, es decir ?".
    [{ dominio: "infranationalreport.com", cap: 15_000 }],
    "sólo el que está por ENCIMA del techo; 2000 exacto es el techo, no una violación"
  );
});

test("los que YA CRUZARON también se miran: son los nodos más cargados de la flota", () => {
  // EL PUNTO CIEGO MEDIDO EL 2026-08-07: `flota.cerca` EXCLUYE a los cruzados por diseño (estar en
  // las dos listas hacía contar el mismo dominio dos veces), y el llamador le pasaba sólo `cerca`.
  // Resultado: los 9 nodos con el tope cableado a 15.000/día moviendo entre 9.910 y 11.025 mensajes
  // diarios —los ÚNICOS que ya demostraron que su volumen alcanza para cruzar un umbral permanente—
  // eran invisibles para la única regla que mira el tope. Y 8 de esos 9 figuran cerca de Yahoo: van
  // camino a un SEGUNDO umbral permanente con el freno puesto siete veces por encima.
  //
  // Cruzar uno no es razón para dejar de vigilar el siguiente: es exactamente al revés.
  assert.deepEqual(
    porEncimaDelTecho({ cerca: [], cruzados: ["infranationalreport.com"], nodos: [{ domain: "infranationalreport.com", cap: 15_000 }] }),
    [{ dominio: "infranationalreport.com", cap: 15_000 }]
  );

  // Un dominio en las DOS listas sale UNA vez. Con dos filas, la firma del hecho de la regla d2
  // cambia sola y el aviso se repite sin que nada haya cambiado.
  assert.deepEqual(
    porEncimaDelTecho({ cerca: ["x.com"], cruzados: ["X.COM"], nodos: [{ domain: "x.com", cap: 15_000 }] }),
    [{ dominio: "x.com", cap: 15_000 }],
    "ni duplicado ni sensible a la capitalización"
  );

  // Y las reglas viejas siguen mandando sobre los cruzados: un cruzado sin cap leído NO entra.
  assert.deepEqual(porEncimaDelTecho({ cerca: [], cruzados: ["x.com"], nodos: [{ domain: "x.com", cap: null }] }), []);
  assert.deepEqual(porEncimaDelTecho({ cerca: [], cruzados: ["x.com"], nodos: [{ domain: "x.com", cap: 2000 }] }), [], "el techo exacto no es una violación");
  // Sin el campo se comporta como antes: es opcional y el llamador viejo no cambia de conducta.
  assert.deepEqual(porEncimaDelTecho({ cerca: ["x.com"], nodos: [{ domain: "x.com", cap: 15_000 }] }), [{ dominio: "x.com", cap: 15_000 }]);
});

test("no medido NO es 'está sobre el techo': sin cap leído, el dominio no entra", () => {
  // La regla 5 del encargo, acá donde más caro sale: éste es el input de una regla de DAÑO, y un
  // aviso de daño inventado sobre un `cap: null` (SSH caído en ese nodo) es exactamente el probe
  // colgado del 2026-07-29 con otra ropa.
  assert.deepEqual(porEncimaDelTecho({ cerca: ["x.com"], nodos: [{ domain: "x.com", cap: null }] }), []);
  assert.deepEqual(porEncimaDelTecho({ cerca: ["x.com"], nodos: [] }), [], "ausente del archivo tampoco afirma nada");
  assert.deepEqual(porEncimaDelTecho({ cerca: [], nodos: [{ domain: "x.com", cap: 15_000 }] }), [], "sin cercanía no hay daño inminente");
});

test("un rollback fallido NO puede reportar éxito (el `|| true` va aislado)", () => {
  // `A && B && C || true` sale 0 aunque A falle: el rollback diría OK dejando el nodo difiriendo.
  // Se verifica ejecutando la FORMA del comando con un primer paso que falla.
  const cmd = buildDailyCapRollbackPlan()[0]?.command ?? "";
  const forma = cmd.replace(/postconf -P '[^']*'/g, "false").replace(/postconf -X \w+/, "true");
  const r = spawnSync("bash", ["-c", forma], { encoding: "utf8" });
  assert.notEqual(r.status, 0, `el fallo se tragó: ${forma}`);

  // Y con todo OK, sale 0 aunque el borrado del parámetro falle (ese sí es tolerante).
  const tolerante = cmd.replace(/postconf -P '[^']*'/g, "true").replace(/postconf -X \w+/, "false");
  assert.equal(spawnSync("bash", ["-c", tolerante], { encoding: "utf8" }).status, 0);
});

test("el rollback saca la restriction ANTES que el servicio, y recarga", () => {
  const etiquetas = buildDailyCapRollbackPlan().map((p) => p.label);
  assert.deepEqual(etiquetas, ["unwire-submission-restrictions", "unwire-master-spawn", "reload-postfix"]);
  const restaura = buildDailyCapRollbackPlan()[0]?.command ?? "";
  assert.ok(restaura.includes("permit_sasl_authenticated,reject"));
  assert.ok(!restaura.includes("check_policy_service"));
});

test("el audit del paso que escribe el script no filtra su contenido", () => {
  const paso = buildDailyCapInstallPlan({ cap: 2000 }).find((p) => p.label === "write-policy-script");
  assert.ok(paso?.stdin?.includes("smtpd_access_policy"), "el contenido va por stdin");
  assert.ok(!paso?.auditCommand.includes("smtpd_access_policy"), "y NO al audit log");
});

// ── El status ────────────────────────────────────────────────────────────────────────────────────

test("status: nodo con el límite puesto", () => {
  const s = parseDailyCapStatus(
    [
      "## CAP",
      "2000",
      "## COUNT",
      "417",
      "## WIRED",
      "smtpd_recipient_restrictions = check_policy_service unix:private/quota, permit_sasl_authenticated, reject",
      "## WIRED_SMTPS",
      "smtpd_recipient_restrictions = check_policy_service unix:private/quota, permit_sasl_authenticated, reject",
      "## SPAWN",
      "quota/unix = quota unix - n n - 4 spawn user=postfix-quota argv=/usr/bin/python3 /usr/local/lib/postfix-quota/daily-quota-policy.py",
      "## END"
    ].join("\n")
  );
  // `sin_sello` y no `intacto`: este nodo nunca se frenó, así que no hay nada que afirmar sobre la
  // durabilidad de un freno que no existe.
  assert.deepEqual(s, { cap: 2000, consumidoHoy: 417, cableado: true, motivo: null, freno: { estado: "sin_sello", capEscritoEn: null } });
});

test("status: nodo SIN límite se declara, no se asume", () => {
  const s = parseDailyCapStatus(["## CAP", "## COUNT", "## WIRED", "smtpd_recipient_restrictions = permit_sasl_authenticated,reject", "## SPAWN", "## END"].join("\n"));
  assert.equal(s.cableado, false);
  assert.equal(s.cap, null, "sin cap = null, NUNCA 0 (un 0 se leería como 'no puede enviar')");
  assert.equal(s.consumidoHoy, null, "sin contador = null, NO 'cero enviados hoy'");
  assert.match(s.motivo ?? "", /restriction en submission.*servicio en master/);
});

test("status: media instalación (script cableado en master pero no en submission) se declara", () => {
  const s = parseDailyCapStatus(
    ["## CAP", "2000", "## COUNT", "## WIRED", "smtpd_recipient_restrictions = permit_sasl_authenticated,reject", "## SPAWN", "quota/unix = quota unix - n n - 4 spawn user=postfix-quota", "## END"].join("\n")
  );
  assert.equal(s.cableado, false, "no alcanza con el servicio: si no está en la restriction, no capa nada");
  assert.match(s.motivo ?? "", /restriction en submission/);
  assert.ok(!(s.motivo ?? "").includes("master.cf"));
});

test("status: un centinela PEGADO no se lee como 'nodo abierto'", () => {
  // El bug del canary: el contador se escribía sin newline final, `cat` lo pegaba al echo
  // siguiente ("2## WIRED"), la sección WIRED desaparecía y un nodo CON límite salía ABIERTO.
  const s = parseDailyCapStatus(
    ["## CAP", "2000", "## COUNT", "2## WIRED", "smtpd_recipient_restrictions = check_policy_service unix:private/quota, permit_sasl_authenticated, reject", "## SPAWN", "quota/unix = quota unix - n n - 4 spawn", "## END"].join("\n")
  );
  assert.equal(s.cableado, false);
  assert.match(s.motivo ?? "", /centinela pegado/, "se declara ilegible, no se inventa un veredicto");
  assert.equal(s.cap, null);
});

test("el contador nunca pasa por vacío: se escribe antes de truncar", async () => {
  // Con truncate-then-write hay una ventana en que el archivo está vacío; spawn(8) mata el
  // proceso con KILL de rutina, y un kill ahí adentro reabre el día entero (fail-open).
  const script = renderDailyCapPolicyScript();
  const orden = [script.indexOf("os.pwrite"), script.indexOf("os.ftruncate")];
  assert.ok(orden[0]! > 0 && orden[1]! > 0, "usa pwrite + ftruncate");
  assert.ok(orden[0]! < orden[1]!, "primero escribe, después trunca");
  assert.ok(!script.includes("os.ftruncate(fd, 0)"), "nunca trunca a cero");
});

test("el status exige NUESTRO socket, no un policy service cualquiera", () => {
  // Otro policy daemon (postgrey, etc.) haría pasar por "con límite" un nodo sin ninguno.
  const conOtro = parseDailyCapStatus(
    [
      "## CAP", "2000", "## COUNT", "5",
      "## WIRED", "smtpd_recipient_restrictions = check_policy_service unix:private/postgrey, permit_sasl_authenticated, reject",
      "## WIRED_SMTPS", "smtpd_recipient_restrictions = check_policy_service unix:private/postgrey",
      "## SPAWN", "quota/unix = quota unix - n n - 4 spawn",
      "## END"
    ].join("\n")
  );
  assert.equal(conOtro.cableado, false, "un policy ajeno NO es nuestro límite");
  assert.match(conOtro.motivo ?? "", /submission/);
});

test("el 465 abierto NO se reporta como nodo con límite", () => {
  const s = parseDailyCapStatus(
    [
      "## CAP", "2000", "## COUNT", "5",
      "## WIRED", "smtpd_recipient_restrictions = check_policy_service unix:private/quota, permit_sasl_authenticated, reject",
      "## WIRED_SMTPS", "smtpd_recipient_restrictions = permit_sasl_authenticated,reject",
      "## SPAWN", "quota/unix = quota unix - n n - 4 spawn",
      "## END"
    ].join("\n")
  );
  assert.equal(s.cableado, false, "una puerta sin cap es un nodo sin cap");
  assert.match(s.motivo ?? "", /smtps \(465\)/);
});

test("el contador se escribe CON newline (o `cat` lo pega al centinela siguiente)", async () => {
  const { dir, script, capFile } = await prepararScript();
  await writeFile(capFile, "10\n");
  correr(script, request({ request: "smtpd_access_policy", sasl_username: "mailer@a.com" }), {
    QUOTA_CAP_FILE: capFile,
    QUOTA_COUNT_DIR: dir
  });
  const crudo = await readFile(join(dir, `count-${new Date().toISOString().slice(0, 10)}`), "utf8");
  assert.equal(crudo, "1\n", "sin el \\n final, el status del nodo se vuelve ilegible");
});

test("el status separa cada lectura con un echo propio", () => {
  // Defensa del emisor para el mismo bug: aunque un archivo venga sin newline, el centinela
  // siguiente arranca en su propia línea.
  // `stat ` entra al filtro junto con `cat`/`postconf`: el sello del freno se lee con `stat -c %Y`
  // y un mtime sin newline pegaría el centinela siguiente igual que el contador del canary.
  for (const linea of buildDailyCapStatusCommand().split("\n").filter((l) => l.includes("cat ") || l.includes("postconf") || l.includes("stat "))) {
    assert.match(linea, /;\s*echo$/, `falta el echo separador en: ${linea}`);
  }
});

test("status: salida truncada NO se sirve como completa", () => {
  const s = parseDailyCapStatus("## CAP\n2000\n## COUNT\n50\n");
  assert.equal(s.cableado, false);
  assert.equal(s.cap, null);
  assert.match(s.motivo ?? "", /truncada/);
});

// ── La durabilidad del freno ─────────────────────────────────────────────────────────────────────
//
// EL INCIDENTE: el 2026-08-06, entre las 03:24 y las 05:02 UTC, el agente ejecutó `frenar_dominio`
// seis veces sobre bizreport-control.com y las SEIS reportaron "cap 255 → 0". Con esa salida a la
// vista es imposible distinguir "alguien me deshace el freno" de "mi lectura del antes estaba
// vieja", así que el agente terminó escribiéndole a Juanes por Slack que mirara el nodo — o sea,
// delegándole justo lo que tiene que resolver solo.
//
// Se midió después, contra la flota real (2026-08-07): `/etc/postfix/daily_cap` en 86.48.29.176
// valía 0 con mtime del 2026-08-06T18:54:34Z, intacto 30 h más tarde, uptime 42 días, sin crontab
// de root ni unit ni timer que nombre el archivo. Nadie deshace nada. Lo que faltaba era poder
// AFIRMARLO sin ir a mirar el nodo a mano.

/** El armador de la salida del status, para no repetir las nueve secciones en cada caso. */
function salidaStatus(over: Partial<Record<"cap" | "count" | "capMtime" | "sello", string>> = {}): string {
  const wired = "smtpd_recipient_restrictions = check_policy_service unix:private/quota, permit_sasl_authenticated, reject";
  return [
    "## CAP", over.cap ?? "0",
    "## COUNT", over.count ?? "",
    "## WIRED", wired,
    "## WIRED_SMTPS", wired,
    "## SPAWN", "quota/unix = quota unix - n n - 4 spawn user=postfix-quota",
    "## CAP_MTIME", over.capMtime ?? "",
    "## FRENO_SELLO", over.sello ?? "",
    "## END"
  ].join("\n");
}

test("el freno SELLA el mtime del cap, y lo hace DESPUÉS de validar que quedó en 0", () => {
  const plan = buildFrenoPlan();
  assert.deepEqual(plan.map((p) => p.label), ["frenar-cap-cero", "validate-freno", "sellar-freno"]);
  // El orden no es cosmético: si la escritura del 0 falla, `validate-freno` corta el plan (el runner
  // lanza con exit != 0) y el sello NUNCA se escribe. Sellar un freno que no se puso sería
  // exactamente la mentira que este paso existe para impedir.
  const sello = plan.at(-1)!;
  assert.equal(sello.command, "stat -c %Y /etc/postfix/daily_cap > /etc/postfix/daily_cap.freno && chmod 0644 /etc/postfix/daily_cap.freno");
  assert.ok(sello.auditCommand.includes("daily_cap.freno"), "el audit dice qué archivo se tocó");
});

test("el plan del freno es idempotente: dos corridas, el mismo comando exacto", () => {
  // Es un plan de SSH contra 58 nodos de producción: no se prueba corriéndolo, se prueba el texto.
  assert.deepEqual(buildFrenoPlan(), buildFrenoPlan());
  const todo = buildFrenoPlan().map((p) => p.command).join("\n");
  assert.ok(!todo.includes(">>"), "nada se APPENDEA: correrlo dos veces no puede dejar dos valores");
  assert.ok(!todo.includes("postfix reload"), "el freno no recarga: el policy service ya lee el archivo en cada request");
  assert.ok(!/postconf/.test(todo), "el freno no toca el cableado: el nodo queda frenado pero observable");
});

test("el status del freno: el cap que nadie tocó desde el sello sale INTACTO", () => {
  const s = parseDailyCapStatus(salidaStatus({ cap: "0", capMtime: "1754506474", sello: "1754506474" }));
  assert.equal(s.freno?.estado, "intacto");
  assert.equal(s.freno?.capEscritoEn, new Date(1_754_506_474_000).toISOString());
  assert.equal(s.cap, 0);
});

test("el status del freno: mismo segundo de escritura y sello NO se lee como reescrito", () => {
  // `stat -c %Y` da segundos enteros y el sello se toma en el mismo segundo que el `printf`. Con
  // una comparación estricta, todo freno se declararía deshecho por sí mismo apenas se pone.
  assert.equal(parseDailyCapStatus(salidaStatus({ capMtime: "1754506474", sello: "1754506474" })).freno?.estado, "intacto");
  assert.equal(parseDailyCapStatus(salidaStatus({ capMtime: "1754506473", sello: "1754506474" })).freno?.estado, "intacto");
});

test("el status del freno: un cap escrito DESPUÉS del sello se declara REESCRITO, con la fecha", () => {
  // El caso que el agente no podía distinguir en la noche del 2026-08-06. Ahora sale con nombre y
  // con hora: no hay que preguntarle a Juanes cuándo lo pisaron.
  const s = parseDailyCapStatus(salidaStatus({ cap: "255", capMtime: "1754593200", sello: "1754506474" }));
  assert.equal(s.freno?.estado, "reescrito");
  assert.equal(s.freno?.capEscritoEn, new Date(1_754_593_200_000).toISOString());
  assert.equal(s.cap, 255, "y el cap con el que quedó, que es lo que hay que frenar de nuevo");
});

test("el status del freno: SIN SELLO no es 'intacto' — es 'no se sabe'", () => {
  // Es el estado de los 58 nodos hasta que alguno se frene por primera vez. Leerlo como "está todo
  // bien" es la lección más cara de este proyecto: un cero que nadie midió leído como limpio.
  const s = parseDailyCapStatus(salidaStatus({ cap: "2000", capMtime: "1754506474" }));
  assert.equal(s.freno?.estado, "sin_sello");
  assert.notEqual(s.freno?.estado, "intacto");
  assert.equal(s.freno?.capEscritoEn, new Date(1_754_506_474_000).toISOString(), "el cuándo se sabe igual: sirve para fechar cualquier cap");
});

test("el status del freno: con sello pero sin mtime legible el veredicto es 'no_se', nunca 'intacto'", () => {
  // Un `stat` que no devuelve nada (archivo borrado, permisos) es ausencia de dato. Ausencia de
  // dato no es evidencia de que el freno siga puesto.
  const s = parseDailyCapStatus(salidaStatus({ sello: "1754506474" }));
  assert.equal(s.freno?.estado, "no_se");
  assert.equal(s.freno?.capEscritoEn, null);
});

test("el status del freno: una salida ilegible deja el freno en 'no_se', no en 'intacto'", () => {
  for (const roto of ["## CAP\n0\n## COUNT\n", salidaStatus({ capMtime: "1754506474" }).replace("## SPAWN", "x## SPAWN")]) {
    const s = parseDailyCapStatus(roto);
    assert.equal(s.freno?.estado, "no_se", `salida rota leída como veredicto: ${roto.slice(0, 40)}`);
    assert.equal(s.freno?.capEscritoEn, null);
  }
});

test("el status lee el mtime del cap y el sello, y el ## END sigue siendo el último", () => {
  const cmd = buildDailyCapStatusCommand();
  assert.ok(cmd.includes('echo "## CAP_MTIME"; stat -c %Y /etc/postfix/daily_cap'), "sin el mtime el status es una foto sin fecha");
  assert.ok(cmd.includes('echo "## FRENO_SELLO"; cat /etc/postfix/daily_cap.freno'));
  assert.equal(cmd.trim().split("\n").at(-1), 'echo "## END"', "el centinela final tiene que quedar último o todo se lee truncado");
  // Read-only por construcción: el status lo corre el monitor cada vez que juzga un freno, así que
  // la única redirección que puede haber es la del `2>/dev/null` que traga los errores.
  const redirecciones = [...cmd.matchAll(/.>/g)].map((m) => m[0]);
  assert.ok(redirecciones.length > 0);
  assert.deepEqual([...new Set(redirecciones)], ["2>"], `el status escribe en el nodo: ${cmd}`);
});

test("la salida REAL de un nodo se parsea entera (capturada de la flota, no inventada)", () => {
  // Copiada tal cual de contabo-203400096 (bizreport-control.com, 86.48.29.176) el 2026-08-07,
  // corriendo `buildDailyCapStatusCommand()` por SSH contra el nodo de producción.
  //
  // La lección de Bedrock: un fixture escrito desde mi suposición del wire no caza que el contrato
  // esté mal, porque el test y el código comparten el mismo error. Fijate que el nodo REAL imprime
  // "submission/inet/smtpd_recipient_restrictions = …" con el prefijo del listener, mientras los
  // fixtures de arriba usan la forma corta: si el parser hubiera dependido de esa forma, todos los
  // tests pasarían y la flota entera saldría ABIERTA.
  const real = [
    "## CAP", "0", "",
    "## COUNT", "",
    "## WIRED",
    "submission/inet/smtpd_recipient_restrictions = check_policy_service unix:private/quota, permit_sasl_authenticated, reject", "",
    "## WIRED_SMTPS",
    "smtps/inet/smtpd_recipient_restrictions = check_policy_service unix:private/quota, permit_sasl_authenticated, reject", "",
    "## SPAWN",
    "quota      unix  -       n       n       -       4       spawn user=postfix-quota argv=/usr/bin/python3 /usr/local/lib/postfix-quota/daily-quota-policy.py", "",
    "## CAP_MTIME", "1786042474", "",
    "## FRENO_SELLO", "",
    "## END"
  ].join("\n");

  const s = parseDailyCapStatus(real);
  assert.equal(s.cableado, true);
  assert.equal(s.cap, 0, "el nodo está frenado");
  assert.equal(s.consumidoHoy, null, "sin contador del día NO es 'cero enviados'");
  // EL DATO QUE FALTABA, y que fecha el freno sin ir a mirar el nodo a mano: coincide al segundo
  // con el `stat -c %y` que se leyó por separado (2026-08-06 20:54:34 +0200).
  assert.equal(s.freno?.capEscritoEn, "2026-08-06T18:54:34.000Z");
  // Y el veredicto honesto: este 0 lo puso un freno ANTERIOR al sello, así que no se afirma que
  // haya durado. Recién el próximo freno lo sella y a partir de ahí sí se puede afirmar.
  assert.equal(s.freno?.estado, "sin_sello");
});

// ── EL CONTRATO ENTRE EL RENGLÓN Y SU PARSER ─────────────────────────────────────────────────────

/**
 * Las regex REALES de `leerCupoDelNodo`, leídas del orquestador como TEXTO.
 *
 * No se transcriben: se extraen del archivo vivo. Una copia acá se desincroniza en silencio y el
 * test pasaría a probar mi idea del parser en vez del parser — la lección de Bedrock, textual: un
 * fixture escrito desde mi suposición del wire no caza que el contrato está mal, porque el test y
 * el código comparten el error. Leerlo como texto (y no importarlo) es el mismo patrón que usa el
 * test de contrato de las manos en agents/warmup-monitor.test.ts: importarlo arrancaría el
 * orquestador entero.
 */
async function parserDelAgente(): Promise<(linea: string) => { cap: number | null; consumidoHoy: number | null }> {
  const crudo = await readFile(new URL("../../../scripts/ops/warmup-monitor.ts", import.meta.url), "utf8");
  const cuerpo = crudo.slice(crudo.indexOf("async function leerCupoDelNodo"));
  const fuente = (nombre: string, patron: RegExp): RegExp => {
    const m = cuerpo.match(patron);
    assert.ok(m, `no encontré la regex de ${nombre} en leerCupoDelNodo: cambió el parser y este contrato ya no lo cubre`);
    return new RegExp(m![1]!);
  };
  const rFrenado = fuente("frenado", /const frenado = \/(.+?)\/\.test\(linea\)/);
  const rCap = fuente("cap", /const mCap = linea\.match\(\/(.+?)\/\)/);
  const rUso = fuente("uso", /const mUso = linea\.match\(\/(.+?)\/\)/);
  const rSinContador = fuente("sin contador", /consumidoHoy: \/(.+?)\/\.test\(linea\)/);
  return (linea: string) => {
    const mCap = linea.match(rCap);
    const mUso = linea.match(rUso);
    return {
      cap: rFrenado.test(linea) ? 0 : mCap ? Number(mCap[1]) : null,
      consumidoHoy: rSinContador.test(linea) ? null : mUso ? Number(mUso[1]) : null
    };
  };
}

test("CONTRATO: lo que imprime el status es lo que el agente sabe leer, CON contador del día", async () => {
  // EL BUG QUE ESTE TEST HABRÍA CAZADO, y que estuvo vivo hasta el 2026-08-07: la rama con contador
  // tiraba el prefijo del cupo y el renglón quedaba `12800/15000`. Las dos regex del agente buscan
  // `FRENADO (cap 0)` o `cap N/día`, así que ninguna matcheaba: `cap: null`, y `bajar_cap_nodo`
  // fallaba cerrado sobre los NUEVE nodos por encima del techo — el 100% de los que existe para
  // arreglar, los nueve con contador del día, entre ellos infranationalreport.com con 15.000/día
  // contra un umbral permanente de 5.000.
  //
  // Los dos lados se testeaban por separado y los dos pasaban. Lo que no tenía dueño era el medio.
  const leer = await parserDelAgente();
  const casos: Array<[{ cap: number | null; consumidoHoy: number | null }, string]> = [
    [{ cap: 15000, consumidoHoy: 12800 }, "el caso REAL de los 9 nodos por encima del techo"],
    [{ cap: 0, consumidoHoy: 7 }, "frenado y con envíos de hoy: el cero del freno no se puede perder"],
    [{ cap: 0, consumidoHoy: null }, "frenado sin contador (bizreport-control.com, el del incidente)"],
    [{ cap: 255, consumidoHoy: null }, "con cupo y sin contador"],
    [{ cap: 20, consumidoHoy: 3 }, "el cupo chico del warmup, ya usado"],
    [{ cap: null, consumidoHoy: null }, "cupo ilegible: null, jamás un cero"]
  ];
  for (const [s, porque] of casos) {
    const linea = `  CAP  ${"x.com".padEnd(32)} ${lineaDeUso(s)}`;
    assert.deepEqual(leer(linea), s, `${porque} → "${linea.trim()}"`);
  }
});

test("CONTRATO: el renglón del freno reescrito va aparte y no se mete en el que se parsea", async () => {
  // `leerCupoDelNodo` toma la PRIMERA línea que contenga el dominio, así que meter el aviso de
  // "el cap se reescribió" adentro del renglón de uso le cambiaría el cupo al agente.
  const leer = await parserDelAgente();
  assert.deepEqual(leer(`  CAP  x.com   ${lineaDeUso({ cap: 2000, consumidoHoy: 1999 })} — salida truncada: falta ## END`), {
    cap: 2000,
    consumidoHoy: 1999
  });
});

test("instalar un cupo BORRA el sello del freno: soltar un nodo no es que alguien lo haya pisado", () => {
  // La secuencia que fabricaba el hecho falso: frenar (sello = T1) → soltar por decisión del propio
  // agente (cap escrito en T2 > T1) → el nodo queda en `reescrito` para siempre, y el veredicto le
  // diría a Juanes "alguien reescribió el cap el <fecha>" sobre algo que decidió el agente. Por este
  // mismo plan pasan `soltar_dominio` y `bajar_cap_nodo`.
  const freno = buildFrenoPlan();
  assert.ok(freno.some((p) => p.command.includes("daily_cap.freno")), "el freno sella");

  const soltar = buildDailyCapInstallPlan({ cap: 20 });
  const escribe = soltar.find((p) => p.label === "write-cap-file");
  assert.match(escribe!.command, /rm -f \/etc\/postfix\/daily_cap\.freno/, "instalar un cupo levanta el freno a propósito");
  assert.match(escribe!.auditCommand, /rm .*daily_cap\.freno/, "y queda en la auditoría: es un cambio de estado, no limpieza");
});

test("sin sello y con el cap recién escrito el veredicto es `sin_sello`, nunca `reescrito`", () => {
  // El otro lado del mismo arreglo: borrado el sello, el status del nodo tiene que decir "no hay
  // freno vigente que juzgar" y no "alguien lo pisó". `sin_sello` tampoco es `intacto`.
  const s = parseDailyCapStatus(
    ["## CAP", "20", "", "## COUNT", "", "## WIRED", "", "## WIRED_SMTPS", "", "## SPAWN", "", "## CAP_MTIME", "1786042474", "", "## FRENO_SELLO", "", "## END"].join("\n")
  );
  assert.equal(s.freno?.estado, "sin_sello");
  assert.equal(s.freno?.capEscritoEn, "2026-08-06T18:54:34.000Z");
});
