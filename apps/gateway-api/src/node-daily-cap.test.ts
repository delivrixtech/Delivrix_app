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
  CAP_POLICY_PARAM,
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
  assert.deepEqual(s, { cap: 2000, consumidoHoy: 417, cableado: true, motivo: null });
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
  for (const linea of buildDailyCapStatusCommand().split("\n").filter((l) => l.includes("cat ") || l.includes("postconf"))) {
    assert.match(linea, /;\s*echo$/, `falta el echo separador en: ${linea}`);
  }
});

test("status: salida truncada NO se sirve como completa", () => {
  const s = parseDailyCapStatus("## CAP\n2000\n## COUNT\n50\n");
  assert.equal(s.cableado, false);
  assert.equal(s.cap, null);
  assert.match(s.motivo ?? "", /truncada/);
});
