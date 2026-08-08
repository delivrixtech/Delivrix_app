// EL BARREDOR DE MANOS SIN LLAMADOR.
//
// La clase de falla más cara y más repetida de este repo: una capacidad ENTERA —implementada, con
// tests verdes, con comentarios que explican por qué existe— y ningún llamador de producción. Van
// OCHO instancias contadas (`leerLibroPropio` y el libro de NFC, `proponer_subida`/`datosParaProponer`,
// `que_paso`/`quePaso`, `yaDaLoMismo`, `marcarRecordadas`, `ultimoEnvioNuestro`, la tabla de
// relevancia de slack.ts, `validateApprovalToken`). Ninguna se cayó sola: todas se descubrieron
// mirando, y varias después de que alguien afirmara por escrito que estaban cableadas.
//
// POR QUÉ UN TEST Y NO UNA REVISIÓN. Los dos mecanismos que ya funcionan en este repo son locales:
// derivar la lista del prompt en vez de espejarla (`ACCIONES_VALIDAS` × SISTEMA en
// acciones-agente.test.ts) y el test bisagra que lee al llamador desde disco (el mismo archivo,
// `scripts/ops/warmup-monitor.ts` sin comentarios). Los dos cubren UNA capacidad cada uno: hay que
// acordarse de escribirlos, y justo lo que falla es acordarse. Esto barre el árbol.
//
// LOS COMENTARIOS SE BORRAN ANTES DE CONTAR, y no es una optimización: es EL punto. `promoverPorPreguntas`
// tiene adentro la frase "el orquestador corre `promoverPorPreguntas` UNA VEZ POR VUELTA (paso 9)",
// que es falsa — el orquestador ni la importa. Un barredor que cuente menciones en prosa se deja
// tapar la boca por la misma prosa que documenta el agujero.
//
// ALCANCE ACOTADO A LA FÁBRICA VIVA, a propósito. En el árbol entero hay 89 huérfanas y la mayoría
// es andamiaje del MVP viejo (runbooks, adaptadores de proveedores que nadie instancia). Una lista
// de 89 que nadie cura envejece hacia la ficción, que es exactamente lo que le pasó a SIN_ANUNCIAR
// cuando decía que `proponer_subida` estaba cableada. Acá entran los directorios donde una mano
// muda se traduce en que el agente no actúa o el warmup manda desde un nodo quemado.

// ponytail: barre SÍMBOLOS EXPORTADOS, no CAMPOS. Tres de los agujeros de esta misma clase son de
// campo y este test NO los ve: `ultimoEnvioNuestro` (se escribe en sender-measurement.ts y no lo lee
// nadie), `rechazos[].ejemplo` (lo produce `resumirRechazos` y `construirPrompt` no lo imprime) y
// `flota.atribuido` (lo lee la regla c4 del canal y el prompt del agente no). Un barrido de campos
// pide un pase de tipos (ts-morph o el checker de tsc), que es mucha más máquina; si aparece una
// cuarta instancia de campo, ahí sí vale el pase de tipos.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Dónde barremos. Fuera de acá vive el MVP viejo, que es deuda conocida y de otra conversación.
 *
 * ERA `apps/gateway-api/src/agents` + `.../security`, Y ESO DEJABA AFUERA AL ARCHIVO DONDE VIVE LA
 * INSTANCIA INSIGNIA. `apps/gateway-api/src` a secas —sender-measurement.ts, smtp-delivery-health.ts,
 * node-daily-cap.ts, routes/— no entraba, así que `leerLibroPropio`, que el encabezado de este mismo
 * archivo enumera como la PRIMERA de las ocho instancias de la clase, era invisible para el barrido
 * escrito para atajarla. Un detector que no ve el caso que lo motivó no es un detector.
 *
 * Al abrirlo aparecieron 12 huérfanas, no 89: se declaran una por una abajo. Ése era el miedo
 * razonable del alcance acotado (una lista larga que nadie cura envejece hacia la ficción) y con 12
 * no se cumple — la lista es curable y la segunda aserción impide que envejezca.
 */
const ALCANCE = [
  "apps/gateway-api/src",
  "apps/warmup-engine/src"
];

/**
 * Dónde puede estar el llamador. Es TODO el árbol y no sólo `ALCANCE`: una mano de los agentes la
 * cablea `scripts/ops/warmup-monitor.ts`, que vive afuera. Buscar el llamador sólo dentro del
 * alcance daría huérfanas falsas — el error que vuelve inútil a un aviso.
 */
const DONDE_BUSCAR = ["apps", "scripts", "packages"];

const esTest = (f: string): boolean => /\.(test|spec)\.[tj]sx?$/.test(f) || f.includes("/__tests__/") || f.includes(".fixture.");

function archivos(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(RAIZ, dir), { withFileTypes: true, recursive: true }) as Array<{
    name: string;
    parentPath: string;
    isFile(): boolean;
  }>) {
    if (!e.isFile()) continue;
    if (!/\.[tj]sx?$/.test(e.name) || e.name.endsWith(".d.ts")) continue;
    const abs = join(e.parentPath, e.name);
    if (abs.includes("node_modules") || abs.includes("/dist/")) continue;
    out.push(relative(RAIZ, abs));
  }
  return out;
}

/** Sin comentarios. Ver la nota de arriba: un llamador imaginario en prosa no es un llamador. */
const sinComentarios = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Los identificadores que el archivo NOMBRA de verdad. Set para que la búsqueda no sea O(n×m). */
const identificadores = (t: string): Set<string> => new Set(sinComentarios(t).match(/[A-Za-z_$][\w$]*/g) ?? []);

/**
 * LO QUE HOY ESTÁ MUDO Y POR QUÉ. Clave `archivo:nombre` (sin línea: una lista que se rompe al
 * mover código enseña a regenerarla sin leerla). El valor NO es una excusa, es la deuda escrita
 * donde se ve — qué le falta y quién tendría que llamarla.
 *
 * Sacar algo de acá exige cablearlo o BORRARLO. Las dos aserciones de abajo van en los dos sentidos
 * justamente para que esta lista no se pueda convertir en decoración.
 */
const SIN_LLAMADOR: Record<string, string> = {
  // ── ACCESORES DE TEST DECLARADOS COMO TALES. No son manos: no hay nada que cablear. ──
  "apps/gateway-api/src/agents/acciones-agente.ts:hechosVinculantes": "accesor de test, declarado así en su propio doc",
  "apps/gateway-api/src/agents/acciones-agente.ts:olvidarHechosVinculantes": "accesor de test: la memoria es de proceso",
  "apps/gateway-api/src/agents/warmup-audit-run.ts:statusOfForTests": "accesor de test, el nombre lo dice",
  "apps/warmup-engine/src/live/smtp-credential-decrypt.ts:encryptForTest": "accesor de test, el nombre lo dice",

  // ── LA INSTANCIA INSIGNIA, y la razón por la que este barrido existe. ──
  "apps/gateway-api/src/sender-measurement.ts:leerLibroPropio":
    "EL AISLAMIENTO DE NFC EN LA ATRIBUCIÓN. El mecanismo entero está construido (`libro`, `atribucion`, " +
    "`ajeno`, y esta función que lee los queue-ids nuestros) y el interruptor nunca se accionó: " +
    "scripts/ops/medir-flota.ts sigue en `libro: \"todo\"`, y sobre la foto del 2026-08-08 eso da " +
    "`atribucion.modo = {todo: 58}` con 0 queue-ids vistos. NO se enciende a ciegas: con " +
    "BLOCKED_MIN_ATTEMPTS=20 por proveedor contra 6 envíos propios en el dominio que más manda, " +
    "`libro: \"nuestro\"` deja CERO veredictos `healthy` en las 58 bandejas. Encenderlo es decisión del " +
    "operador y el verificador de despliegue ya imprime la frase exacta que hay que decirle al jefe. " +
    "Y ojo con la confusión que importa: esto cambia lo que VEMOS, no lo que PASA — el aislamiento " +
    "FÍSICO (que NFC deje de inyectar por estos nodos) no es código de este repo",

  // ── SÓLO LAS EJERCE UN TEST. Es la forma que este barrido vino a nombrar: cobertura verde sobre
  //    código que producción no llama. Ninguna es urgente; todas son candidatas a BORRAR. ──
  "apps/gateway-api/src/openclaw-tools-builder.ts:openClawToolDefinitionNames": "sólo la llama openclaw-tools-builder.test.ts, para contrastar la lista contra el prompt",
  "apps/gateway-api/src/routes/sensitive-read-auth.ts:resetSensitiveReadAuthBucketsForTests": "accesor de test, el nombre lo dice: lo usan los `beforeEach` de las rutas",
  "apps/gateway-api/src/routes/smtp-health-issue-catalog.ts:isKnownSmtpHealthIssueCode": "el catálogo se valida en su propio test; ninguna ruta consulta el predicado",
  "apps/gateway-api/src/routes/smtp-provisioning.ts:buildOpsUserRevokeStep": "la REVOCACIÓN del usuario ops por SSH: hay paso de alta cableado y el de baja sólo lo corre su test",
  "apps/gateway-api/src/services/naming-validator.ts:validateHostnameNaming": "validador de nombres de host que ningún camino de alta consulta",
  "apps/gateway-api/src/smtp-credentials.ts:decryptSshPrivateKey": "mitad de lectura del acceso SSH ops (rama feat/ops-ssh-credentials); sin consumidor vivo",
  "apps/gateway-api/src/smtp-credentials.ts:removeSshAccessFromRecord": "ídem, la mitad de revocación",
  "apps/gateway-api/src/zip-archive.test-helpers.ts:readZipEntries":
    "helper de test que el barrido no reconoce como test: el nombre del archivo es `.test-helpers.ts` y " +
    "`esTest` sólo matchea `.test.ts`. Lo importa zip-archive.test.ts. Se cura renombrando, no cableando",

  // ── CERO REFERENCIAS EN TODO EL ÁRBOL, ni siquiera un test. Son BORRAR, no cablear. ──
  "apps/gateway-api/src/routes/infrastructure.ts:auditWebdockAccountHealthTransitions": "nadie la nombra en ningún archivo del repo, tests incluidos",
  "apps/gateway-api/src/smtp-credentials.ts:ensureSmtpCredential": "ídem: cero referencias. El alta de credenciales vive por otro camino",
  "apps/gateway-api/src/webhook-broadcast.ts:createEquipoWebhookBroadcasterFromEnv": "ídem: el broadcaster nunca se arma desde el entorno",

  // ── MANOS MUDAS DE VERDAD. Cada una es una decisión pendiente del operador. ──
  "apps/gateway-api/src/agents/bitacora-acciones.ts:daLoMismo":
    "el corta-circuito de la mano que devuelve siempre lo mismo. `ejecutarAcciones` lo consume por " +
    "`ctx.yaDaLoMismo` (acciones-agente.ts:1234) y el orquestador no lo arma: la mano repetida nunca se corta",
  "apps/gateway-api/src/agents/decisiones-del-jefe.ts:marcarRecordadas":
    "el contador `recordada` sigue en 0 en las 7 decisiones del archivo real; su doc dice 'lo llama quien persiste' y nadie persiste",
  "apps/gateway-api/src/agents/decisiones-del-jefe.ts:olvidar":
    "el jefe no tiene forma de revocar una decisión: no hay acción ni ruta que llame acá",
  "apps/gateway-api/src/agents/slack.ts:promoverPorPreguntas": "tabla de relevancia sin cablear (ver el bloque de abajo)",
  "apps/gateway-api/src/agents/slack.ts:registrarSalida": "tabla de relevancia sin cablear (ver el bloque de abajo)",
  "apps/gateway-api/src/agents/slack.ts:registrarReaccion": "tabla de relevancia sin cablear (ver el bloque de abajo)",
  "apps/gateway-api/src/agents/slack.ts:loQueSeCallo": "tabla de relevancia sin cablear (ver el bloque de abajo)",
  "apps/gateway-api/src/agents/historia.ts:historiaDe":
    "la ÚNICA puerta del módulo de historia, y nadie la abre. Es la implementación detrás de `que_paso`, " +
    "que acciones-agente.test.ts ya declara sin cablear (`ctx.quePaso`): el módulo entero espera ese mismo diff",
  "apps/gateway-api/src/agents/historia.ts:esLineaDe": "el filtro por dominio de ese mismo módulo mudo",
  "apps/gateway-api/src/agents/multi-agent-runtime.ts:createMultiAgentRuntime": "el runtime multi-agente nunca se monta; divergencia doc-vs-código ya registrada",
  "apps/gateway-api/src/agents/agent-registry.ts:getAgentDefinition": "parte del mismo runtime multi-agente sin montar",
  "apps/gateway-api/src/security/approval-token.ts:validateApprovalToken":
    "verifica la firma HMAC, ata el token a su target y CONSUME el nonce. El carril vivo aprueba por " +
    "evento de auditoría (approval-guard.ts), así que la firma que emite `issueApprovalToken` no la verifica nadie",
  "apps/gateway-api/src/security/runbook-authorization.ts:validateRunbookExecuteAuthorization":
    "guardaba /v1/agent/runbook/execute, que hoy es una ruta deprecada que sólo devuelve el aviso (main.ts:5023). " +
    "NO es un agujero: es un guardia sin puerta. Va a BORRAR",
  "apps/gateway-api/src/security/approval-token.ts:getApprovalNonceForToken": "sólo sirve para llamar a `validateApprovalToken`, que no se llama",
  "apps/gateway-api/src/security/approval-token.ts:reconstructApprovalToken": "ídem: rearma el token desde la fila para poder validarlo",

  // ── ANDAMIAJE DEL MOTOR QUE EL DAEMON NO USA. Candidatos a BORRAR, no a cablear. ──
  "apps/warmup-engine/src/domain/decision-diaria.ts:textoPorProveedor": "render por proveedor que ninguna vista arma",
  "apps/warmup-engine/src/domain/recipient-pool.ts:createRecipientPool": "el daemon elige destino con `elegirSemillaDelRegistro`/`warmup-seeds`",
  "apps/warmup-engine/src/domain/auth-checks.ts:V1_REQUIRED_CHECKS": "checklist v1 que ningún gate consulta",
  "apps/warmup-engine/src/domain/trends.ts:bucketOfLanded": "agregador de tendencias sin vista",
  "apps/warmup-engine/src/domain/types.ts:DEFAULT_DAILY_LIMIT": "default de la rampa vieja; el cupo real sale de `plan-diario`",
  "apps/warmup-engine/src/domain/types.ts:DEFAULT_INCREASE_BY_DAY": "ídem",
  "apps/warmup-engine/src/checks/dns-auth-checks.ts:createDnsAuthChecker": "el check-runner v1 nunca se montó; hoy SPF/DKIM/DMARC/PTR los mide `warmup-reputacion`",
  "apps/warmup-engine/src/checks/ip-network-checks.ts:createIpNetworkCheckers": "ídem: listas negras y TLS los mide el barrido de reputación",
  "apps/warmup-engine/src/checks/liveness-checks.ts:createLivenessCheckers": "ídem",
  "apps/warmup-engine/src/runtime/config.ts:readWarmupSmtpConfig": "config del motor v1; el daemon lee credenciales del inventario cifrado",
  "apps/warmup-engine/src/live/dns-adapters.ts:createNodeDnsResolver": "cadena de chequeos DNS que sólo instancia `createDnsAuthChecker`, que tampoco se instancia",
  "apps/warmup-engine/src/live/dns-adapters.ts:createNodeReverseDnsResolver": "ídem",
  "apps/warmup-engine/src/live/dns-adapters.ts:createDnsBlocklistResolver": "ídem",
  "apps/warmup-engine/src/live/dns-adapters.ts:createDomainBlocklistResolver": "ídem",
  "apps/warmup-engine/src/live/dns-adapters.ts:createTlsStarttlsProbe": "ídem",
  "apps/warmup-engine/src/live/mail-adapters.ts:createNodemailerSmtpAuthProbe": "sondas del check-runner que nadie arranca",
  "apps/warmup-engine/src/live/mail-adapters.ts:createImapflowAuthProbe": "ídem",
  "apps/warmup-engine/src/live/mail-adapters.ts:createImapflowClient": "el daemon abre IMAP por su cuenta",
  "apps/warmup-engine/src/live/mail-adapters.ts:createNodemailerSmtpClient": "el daemon usa `createBoxMailer`",
  "apps/warmup-engine/src/live/imap-thread-reader.ts:CARPETAS_ENTRADA": "reemplazadas por la búsqueda por flag SPECIAL-USE",
  "apps/warmup-engine/src/live/imap-thread-reader.ts:CARPETAS_ENVIADOS": "ídem",
  "apps/warmup-engine/src/reader/imap-placement-reader.ts:shouldKeepPolling": "el poller v1 no corre; el placement lo mide el daemon",
  "apps/warmup-engine/src/reader/imap-placement-reader.ts:nextPollAt": "ídem",
  "apps/warmup-engine/src/service/ingest.ts:ingestDeliveryOutcome": "camino de ingesta del motor v1, nunca montado",
  "apps/warmup-engine/src/service/live-warmup-daemon.ts:elegirSemillaDelRegistro": "alias exportado de `elegirSemilla` que quedó sin consumidor"
};

function barrer(): Map<string, { archivo: string; nombre: string; linea: number }> {
  const universo = [...new Set(DONDE_BUSCAR.flatMap(archivos))];
  const tokens = new Map<string, Set<string>>();
  const contenido = new Map<string, string>();
  for (const f of universo) {
    const txt = readFileSync(join(RAIZ, f), "utf8");
    contenido.set(f, txt);
    tokens.set(f, identificadores(txt));
  }

  const huerfanas = new Map<string, { archivo: string; nombre: string; linea: number }>();
  const declaracion = /^export\s+(?:async\s+)?(?:function\*?|const|class|let|var)\s+([A-Za-z_$][\w$]*)/gm;

  for (const f of universo) {
    if (esTest(f) || !ALCANCE.some((d) => f.startsWith(`${d}/`))) continue;
    const txt = contenido.get(f) as string;
    const propios = identificadores(txt);
    declaracion.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = declaracion.exec(txt))) {
      const nombre = m[1] as string;
      // Usos DENTRO de su propio archivo: si otra función de acá la llama, no está muda.
      // `-1` descuenta la declaración misma; el conteo va sobre el texto sin comentarios.
      const dentro = (sinComentarios(txt).match(new RegExp(`\\b${nombre}\\b`, "g")) ?? []).length - 1;
      if (dentro > 0) continue;
      if (!propios.has(nombre)) continue;
      const afuera = universo.some((g) => g !== f && !esTest(g) && (tokens.get(g) as Set<string>).has(nombre));
      if (afuera) continue;
      huerfanas.set(`${f}:${nombre}`, { archivo: f, nombre, linea: txt.slice(0, m.index).split("\n").length });
    }
  }
  return huerfanas;
}

test("ninguna mano queda implementada y muda sin que se diga por qué", () => {
  // SE REPORTAN TODAS DE UNA, no la primera. Un aviso que obliga a correr el test nueve veces para
  // ver nueve agujeros se lee como "hay uno" y se parchea como uno.
  const sinDeclarar = [...barrer()]
    .filter(([clave]) => !SIN_LLAMADOR[clave])
    .map(([, d]) => `${d.archivo}:${d.linea} → ${d.nombre}`);
  assert.deepEqual(
    sinDeclarar,
    [],
    `Estas exportaciones no las nombra NINGÚN archivo de producción fuera de los comentarios:\n  ${sinDeclarar.join("\n  ")}\n` +
      `Código muerto que parece cobertura es peor que no tenerlo: o se cablea (con el llamador en el MISMO diff), ` +
      `o se BORRA, o se declara en SIN_LLAMADOR por qué todavía no. Van nueve instancias de esta misma clase.`
  );
});

test("la deuda declarada tiene que seguir siendo cierta", () => {
  // EL OTRO SENTIDO, que ya falló una vez: SIN_ANUNCIAR afirmaba que `proponer_subida` estaba
  // "implementada y cableada", era mentira, y una auditoría lo repitió como hecho verificado. Una
  // lista de deuda que nadie contrasta contra el árbol envejece hacia la ficción.
  const huerfanas = barrer();
  for (const clave of Object.keys(SIN_LLAMADOR)) {
    assert.ok(
      huerfanas.has(clave),
      `${clave} ya NO está muda (o se movió/renombró): sacala de SIN_LLAMADOR o la lista se vuelve decoración.`
    );
  }
});
