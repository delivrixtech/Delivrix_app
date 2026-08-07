// El LÍMITE FÍSICO de la fábrica: el cap diario que vive EN el nodo, no en el orquestador.
//
// Por qué existe: hasta hoy `hoyPuede` (sender-quota.ts) era un contrato de honor. Quien tenga la
// credencial SASL `mailer@<dominio>` puede meter por el 587 lo que quiera, y ni el código ni el
// main.cf de los 58 nodos tienen un solo tope de volumen. Cruzar ~5.000/día hacia Gmail clasifica
// el dominio como "bulk sender" PARA SIEMPRE (irreversible, ya nos pasó con bizreport-control.com).
// Un techo que solo se calcula no protege de nada: este módulo lo hace físico.
//
// Cómo: policy delegation de Postfix (SMTPD_POLICY_README) con un script propio de ~50 líneas
// supervisado por el propio master(8) vía spawn(8) — sin demonios nuevos, sin paquetes nuevos.
//
// Por qué NO anvil: su contador vive en memoria volátil ("No persistent state is kept", anvil(8)),
// así que cada `postfix reload` — rutina en esta flota — resetearía el día entero: fail-OPEN justo
// en el límite que no se puede cruzar. Y la doc de postconf(5) prohíbe explícitamente usarlo para
// regular tráfico legítimo. El contador de acá vive en disco por fecha: sobrevive reload y reboot.
//
// DÓNDE se engancha (quirúrgico, y esto importa): SOLO en los listeners de envío autenticado
// (submission/587 y smtps/465). NO en el smtpd global, porque el 25 recibe correo ENTRANTE —
// rebotes y respuestas de las semillas del warmup — y contarlo contra el cap de SALIDA haría que
// la bandeja dejara de recibir sus propios bounces al llegar al tope.
//
// LO QUE ESTE LÍMITE **NO** CUBRE (decirlo es parte del contrato):
// policy delegation solo la consulta `smtpd`. El correo inyectado LOCALMENTE con `sendmail`
// (pickup → cleanup → qmgr, sin pasar por smtpd) lo esquiva por completo, y hoy la rampa de
// warmup envía justo así: `/usr/sbin/sendmail -t` por SSH (routes/warmup-ramp.ts). O sea que el
// techo REAL de un nodo mientras calienta = este cap (587/465) + lo que meta la rampa, que no se
// cuenta acá. Cerrar eso es otro trabajo: o la rampa pasa a enviar por 587 autenticado, o se
// restringe la inyección local con `authorized_submit_users`. Mientras tanto, "físico" significa
// físico PARA EL CAMINO AUTENTICADO (el de NFC), no para quien ya tiene root en el nodo.

import { TECHO_DURO_POR_DOMINIO } from "../../warmup-engine/src/domain/decision-diaria.ts";

/** Un paso remoto, compatible con lo que consume SmtpSshRunner.run(). */
export interface NodeCapStep {
  label: string;
  command: string;
  /** Lo que va al audit log: nunca el contenido crudo del stdin. */
  auditCommand: string;
  stdin?: string;
  timeoutMs?: number;
}

export const CAP_FILE = "/etc/postfix/daily_cap";
export const COUNT_DIR = "/var/lib/postfix-quota";
export const SCRIPT_PATH = "/usr/local/lib/postfix-quota/daily-quota-policy.py";
export const POLICY_USER = "postfix-quota";
/** El socket que ve Postfix. `private/` = relativo al queue dir, lo crea master. */
export const POLICY_SOCKET = "unix:private/quota";

/**
 * El orden de las restricciones NO es cosmético: Postfix evalúa de izquierda a derecha y se
 * DETIENE en el primer PERMIT. Con `permit_sasl_authenticated` primero, el policy service no se
 * consultaría nunca y el cap sería decorativo. Por eso va PRIMERO.
 *
 * Y como va primero, también lo tocan las conexiones sin autenticar: por eso el script NO cuenta
 * cuando `sasl_username` viene vacío (devuelve DUNNO y deja que el `reject` final las eche). Si
 * contara, cualquiera podría agotarnos el cupo del día desde afuera sin autenticarse.
 */
export const SUBMISSION_RESTRICTIONS = `check_policy_service ${POLICY_SOCKET}, permit_sasl_authenticated, reject`;
/** El valor original del provisioning: a esto vuelve el rollback. */
export const SUBMISSION_RESTRICTIONS_ORIGINAL = "permit_sasl_authenticated,reject";

/**
 * La lista va a un parámetro de main.cf y el listener lo REFERENCIA, en vez de escribirla inline.
 * No es elegancia: `postconf -P` muere con `-Pe does not accept whitespace in parameter value`, y
 * `check_policy_service unix:private/quota` lleva un espacio irreductible. Es además el idioma que
 * trae Postfix de fábrica (`-o smtpd_recipient_restrictions=$mua_recipient_restrictions`).
 * Para leerlo se usa `postconf -x`, que expande la referencia.
 */
export const CAP_POLICY_PARAM = "delivrix_cap_policy";

/**
 * El policy service. Protocolo: atributos `name=value` uno por línea, línea vacía = fin del
 * request; se responde `action=...` + línea vacía (SMTPD_POLICY_README).
 *
 * Se cuenta por RCPT (una llamada por destinatario), que es la métrica conservadora: Google mide
 * mensajes recibidos por buzón, no transacciones SMTP.
 */
export function renderDailyCapPolicyScript(): string {
  return `#!/usr/bin/env python3
# Delivrix — limite fisico diario de salida. Policy service de Postfix bajo spawn(8).
# NO editar a mano en el nodo: lo reescribe apps/gateway-api/src/node-daily-cap.ts.
import fcntl, os, sys, time

CAP_FILE = os.environ.get("QUOTA_CAP_FILE", "${CAP_FILE}")
COUNT_DIR = os.environ.get("QUOTA_COUNT_DIR", "${COUNT_DIR}")


def read_cap():
    # Sin cap legible => 0 => todo se difiere. Fail-closed: un archivo roto NUNCA abre la puerta.
    try:
        return int(open(CAP_FILE).read().strip())
    except Exception:
        return 0


def bump_and_check():
    # UTC a proposito: el status lo lee con \`date -u\` y los nodos estan en husos distintos. Con
    # hora local, el lector abriria un archivo que no existe y reportaria "sin contador" mientras
    # el nodo ya consumio su cupo.
    path = os.path.join(COUNT_DIR, "count-" + time.strftime("%Y-%m-%d", time.gmtime()))
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)  # smtpd es concurrente: el conteo va bajo lock
        raw = os.read(fd, 64).strip()
        n = int(raw) if raw else 0
        if n >= read_cap():
            return False
        # Escribir ANTES de truncar. Al reves (truncate-then-write) hay una ventana en la que el
        # archivo queda VACIO, y spawn(8) mata este proceso con KILL al vencer su time limit: si
        # cae justo ahi, el contador se lee 0 y el dia se reabre entero. Fail-OPEN, el unico del
        # diseno. Con pwrite+ftruncate(len) el archivo nunca pasa por vacio.
        data = (str(n + 1) + "\\n").encode()  # con newline: sin el, cat pega el numero al centinela
        os.pwrite(fd, data, 0)
        os.ftruncate(fd, len(data))
        return True
    finally:
        os.close(fd)


def decide(attrs):
    if attrs.get("request") != "smtpd_access_policy":
        return "DUNNO"
    # Sin SASL no se cuenta: el reject posterior la echa igual, y contarla dejaria que un tercero
    # nos agote el cupo del dia sin credenciales.
    if not attrs.get("sasl_username"):
        return "DUNNO"
    try:
        ok = bump_and_check()
    except Exception:
        # Contador ilegible o no escribible (dir sin permisos, archivo con basura). Sin este catch
        # el proceso moria y Postfix caia a su default 451: mismo veredicto, pero por crash-loop.
        # Asi el fail-closed es propio, explicito y testeable.
        return "DEFER_IF_PERMIT 4.3.5 quota state unreadable on this node"
    if ok:
        return "DUNNO"
    return "DEFER_IF_PERMIT 4.7.1 daily send cap reached on this node"


def main():
    attrs = {}
    for line in sys.stdin:
        line = line.rstrip("\\n")
        if line:
            k, _, v = line.partition("=")
            attrs[k] = v
            continue
        sys.stdout.write("action=%s\\n\\n" % decide(attrs))
        sys.stdout.flush()
        attrs = {}


if __name__ == "__main__":
    main()
`;
}

/**
 * Autoprueba EN EL NODO antes de cablear nada. Es el paso que impide el peor final posible: si el
 * script estuviera roto, cablearlo primero dejaría el nodo difiriendo TODO el correo (fail-closed
 * es lo correcto ante una falla, pero no es aceptable provocarlo nosotros por un typo).
 *
 * Corre contra un directorio y un cap TEMPORALES: no toca el contador real del día.
 */
export function buildCapSelfCheckCommand(scriptPath: string = SCRIPT_PATH): string {
  // El request se pipea DIRECTO desde printf, nunca por `REQ=$(printf ...)`: la sustitución de
  // comandos come los newlines finales, y sin su línea en blanco terminadora el último request
  // se queda sin respuesta (pasó en el canary — el script estaba bien, la autoprueba no).
  const requests =
    "request=smtpd_access_policy\\nsasl_username=probe@local\\n\\n" +
    "request=smtpd_access_policy\\nsasl_username=probe@local\\n\\n" +
    "request=smtpd_access_policy\\n\\n";
  return [
    "set -eu",
    "T=$(mktemp -d)",
    'printf "1" > "$T/cap"',
    `OUT=$(printf '${requests}' | QUOTA_CAP_FILE="$T/cap" QUOTA_COUNT_DIR="$T" python3 ${scriptPath})`,
    'rm -rf "$T"',
    // Con cap=1: el 1º pasa, el 2º se difiere, y el 3º (sin sasl_username) no cuenta y pasa.
    'echo "$OUT" | sed -n "1p" | grep -qx "action=DUNNO"',
    'echo "$OUT" | sed -n "3p" | grep -q "^action=DEFER_IF_PERMIT"',
    'echo "$OUT" | sed -n "5p" | grep -qx "action=DUNNO"',
    'echo "## SELFCHECK OK"'
  ].join("\n");
}

/**
 * El plan de instalación. Idempotente (se puede correr dos veces) y ordenado por seguridad:
 * primero se instala y se AUTOPRUEBA el script, y recién después se cablea Postfix. Un paso que
 * falla corta el plan (el runner lanza si el exit != 0), así que nunca se cablea un script roto.
 */
export function buildDailyCapInstallPlan(input: { cap: number }): NodeCapStep[] {
  if (!Number.isInteger(input.cap) || input.cap <= 0) {
    throw new Error(`cap invalido: ${input.cap} (debe ser entero > 0)`);
  }
  // EL MISMO TECHO QUE LA DECISIÓN DEL WARMUP, IMPORTADO DE UN SOLO LUGAR.
  //
  // Antes acá vivía `TECHO_ABSOLUTO` (4.000) y en `decision-diaria.ts` vivía
  // `TECHO_DURO_POR_DOMINIO` (2.000): dos números para la misma pared, y el que gobernaba lo que
  // se INSTALA en el nodo era el flojo. El resultado está MEDIDO contra el sender-cap.json de
  // producción del 2026-08-07T09:07Z: DIEZ nodos con 15.000/día cableado —3× el umbral permanente
  // de Google— y NUEVE de esos diez ya figuran como cruzados en sender-measurement.json. El décimo
  // es infranationalreport.com, que todavía no cruzó. El cap hizo exactamente lo que le pidieron;
  // lo que estaba mal era lo que le pidieron.
  //
  // Se RECHAZA, no se recorta: un recorte callado le mentiría al operador sobre lo que instaló, y
  // el número que él escribió es la señal de que entendió mal el límite.
  //
  // La constante vive en warmup-engine y se importa cruzado (patrón ya establecido en 6 archivos
  // del gateway). Un techo duplicado deja de ser un techo el día que alguien sube uno solo.
  if (input.cap > TECHO_DURO_POR_DOMINIO) {
    throw new Error(
      `cap ${input.cap} supera TECHO_DURO_POR_DOMINIO (${TECHO_DURO_POR_DOMINIO}/día): se rechaza, no se recorta. ` +
        `Cruzar 5.000/día a destinatarios personales clasifica el dominio como bulk sender de forma PERMANENTE.`
    );
  }
  return [
    {
      label: "create-policy-user",
      command: [
        "set -eu",
        `id -u ${POLICY_USER} >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin ${POLICY_USER}`,
        `install -d -o ${POLICY_USER} -g ${POLICY_USER} -m 0700 ${COUNT_DIR}`,
        "install -d -m 0755 /usr/local/lib/postfix-quota"
      ].join("\n"),
      auditCommand: `useradd ${POLICY_USER} + mkdir ${COUNT_DIR}`
    },
    {
      label: "write-policy-script",
      command: `install -m 0755 /dev/stdin ${SCRIPT_PATH}`,
      auditCommand: `write ${SCRIPT_PATH}`,
      stdin: renderDailyCapPolicyScript()
    },
    {
      label: "write-cap-file",
      command: `printf '%s\\n' ${input.cap} > ${CAP_FILE} && chmod 0644 ${CAP_FILE}`,
      auditCommand: `write ${CAP_FILE} = ${input.cap}`
    },
    {
      label: "selfcheck-policy-script",
      command: buildCapSelfCheckCommand(),
      auditCommand: "autoprueba del policy service (cap respetado, defer al cruzarlo, sin SASL no cuenta)"
    },
    {
      label: "wire-master-spawn",
      // `postconf -M` edita master.cf sin reescribirlo: preserva la deriva de config de los nodos
      // viejos, que un render completo pisaría.
      command:
        `postconf -M 'quota/unix=quota unix - n n - 4 spawn ` +
        `user=${POLICY_USER} argv=/usr/bin/python3 ${SCRIPT_PATH}' && ` +
        // Sin esto, spawn mata el servicio al minuto de vida (default 1000s) mientras smtpd
        // todavía retiene la conexión: 451 intermitentes sin causa visible.
        `postconf -e 'quota_time_limit=3600'`,
      auditCommand: "postconf -M add quota/unix spawn service + quota_time_limit"
    },
    {
      label: "wire-submission-restrictions",
      command: [
        `postconf -e '${CAP_POLICY_PARAM} = ${SUBMISSION_RESTRICTIONS}'`,
        `postconf -P 'submission/inet/smtpd_recipient_restrictions=$${CAP_POLICY_PARAM}'`,
        `postconf -P 'smtps/inet/smtpd_recipient_restrictions=$${CAP_POLICY_PARAM}'`
      ].join(" && "),
      auditCommand: "postconf -P check_policy_service PRIMERO en submission/smtps (el 25 no se toca)"
    },
    {
      label: "reload-postfix",
      // reload, NO restart: restart corta las conexiones en vuelo de toda la flota.
      command: "postfix reload",
      auditCommand: "postfix reload"
    },
    {
      label: "validate-wired",
      command: [
        "set -eu",
        "postconf -M quota/unix | grep -q spawn",
        // -x expande $delivrix_cap_policy: se valida el valor EFECTIVO, no la referencia.
        `postconf -x -P submission/inet/smtpd_recipient_restrictions | grep -q '${POLICY_SOCKET}'`,
        `postconf -x -P smtps/inet/smtpd_recipient_restrictions | grep -q '${POLICY_SOCKET}'`,
        "ss -ltn | grep -qE ':(587|465)\\s'",
        'echo "## WIRED OK"'
      ].join("\n"),
      auditCommand: "validar spawn + restriction + puertos 587/465 arriba"
    }
  ];
}

/**
 * El rollback. El ORDEN importa: primero se saca la restriction, después el servicio. Al revés
 * (servicio primero) el nodo queda difiriendo todo hasta el reload — fail-closed, o sea molesto
 * pero no peligroso; aun así se hace bien.
 */
export function buildDailyCapRollbackPlan(): NodeCapStep[] {
  return [
    {
      label: "unwire-submission-restrictions",
      // El valor original NO lleva espacios, así que vuelve inline sin la indirección.
      // El `|| true` va AISLADO entre llaves. Sin eso, la precedencia del shell lo aplica a la
      // cadena entera (`A && B && C || true` sale 0 aunque A falle) y un rollback fallido se
      // reportaría OK, dejando el nodo difiriendo con el operador convencido de que lo revirtió.
      // Solo el borrado del parámetro es tolerante; restaurar las restrictions NO puede fallar.
      command:
        [
          `postconf -P 'submission/inet/smtpd_recipient_restrictions=${SUBMISSION_RESTRICTIONS_ORIGINAL}'`,
          `postconf -P 'smtps/inet/smtpd_recipient_restrictions=${SUBMISSION_RESTRICTIONS_ORIGINAL}'`
        ].join(" && ") + ` && { postconf -X ${CAP_POLICY_PARAM} || true; }`,
      auditCommand: "postconf -P restaurar restrictions originales"
    },
    {
      label: "unwire-master-spawn",
      command: "postconf -M# quota/unix || true",
      auditCommand: "postconf -M# quitar quota/unix"
    },
    {
      label: "reload-postfix",
      command: "postfix reload",
      auditCommand: "postfix reload"
    }
  ];
}

/**
 * FRENO: escribe cap 0 sin desmontar nada. En el policy service, `n >= 0` es siempre verdadero, así
 * que TODO el correo autenticado se difiere (4xx, no 5xx: la cola del emisor retiene y reintenta,
 * no se pierde correo). Es la forma de cortar a un emisor externo sin rotar credenciales ni
 * apagar el servicio, y se revierte escribiendo el cupo de vuelta.
 *
 * No toca el cableado a propósito: el policy service sigue montado y midiendo, así que el nodo
 * queda frenado pero observable.
 */
export function buildFrenoPlan(): NodeCapStep[] {
  return [
    {
      label: "frenar-cap-cero",
      command: `printf '0\\n' > ${CAP_FILE} && chmod 0644 ${CAP_FILE}`,
      auditCommand: `write ${CAP_FILE} = 0 (freno: difiere todo el correo autenticado)`
    },
    {
      label: "validate-freno",
      command: `test "$(cat ${CAP_FILE})" = "0"`,
      auditCommand: "validar que el cap quedó en 0"
    }
  ];
}

/** Lectura del estado del cap en un nodo. Read-only: no cambia nada. */
export function buildDailyCapStatusCommand(): string {
  // El `echo` extra después de cada lectura NO es redundante: un archivo sin newline final pega su
  // contenido con el centinela siguiente ("2## WIRED"), la sección se pierde y el nodo se reporta
  // ABIERTO teniendo el límite puesto. Pasó en el canary.
  return [
    "set -u",
    `echo "## CAP"; cat ${CAP_FILE} 2>/dev/null || true; echo`,
    `echo "## COUNT"; cat ${COUNT_DIR}/count-$(date -u +%Y-%m-%d) 2>/dev/null || true; echo`,
    'echo "## WIRED"; postconf -x -P submission/inet/smtpd_recipient_restrictions 2>/dev/null || true; echo',
    // El 465 también: si quedara abierto, el nodo tendría una puerta sin cap y el status diría CAP.
    'echo "## WIRED_SMTPS"; postconf -x -P smtps/inet/smtpd_recipient_restrictions 2>/dev/null || true; echo',
    'echo "## SPAWN"; postconf -M quota/unix 2>/dev/null || true; echo',
    'echo "## END"'
  ].join("\n");
}

/**
 * Donde queda la última lectura del cap de la flota. Mismo patrón que la medición: el SSH se paga
 * UNA vez en la corrida, y el hot path (alertas, panel, tools) lee este JSON local — barato,
 * siempre disponible, no se cae.
 */
export const CAP_MEASUREMENT_FILE = "sender-cap.json";

/** Arriba de esto el nodo está por quedarse sin cupo: avisa antes de que frene. */
export const CERCA_DEL_CAP = 0.8;

export interface CapNodo extends DailyCapStatus {
  domain: string;
  serverSlug: string;
}

export interface CapFlota {
  medidoEn: string;
  /** Nodos leídos. Los que no respondieron NO figuran: su ausencia la declara `ilegibles`. */
  nodos: CapNodo[];
  /** Cuántos no se pudieron leer (SSH caído). Null con motivo, nunca un cero optimista. */
  ilegibles: number;
  /**
   * Bandejas que el inventario descartó ANTES de intentar leerlas (sin binding, en conflicto).
   * Se declaran porque son, por definición, dominios que NADIE está capando: omitirlos haría que
   * el panel dijera "58 nodos" sobre una flota más grande y los diera por cubiertos.
   */
  omitidos: number;
}

/**
 * EL CRUCE QUE NADIE HACÍA: los dominios que están cerca del umbral permanente Y encima tienen
 * instalado un cap que los deja cruzarlo.
 *
 * Los dos archivos ya se leen en la MISMA vuelta del monitor, cada 10 minutos, y nadie los
 * relacionó nunca. El caso concreto que lo motiva: infranationalreport.com viene con un pico de
 * 4.649/día hacia Google —el 93% del umbral irreversible— y tiene 15.000 puesto en el nodo. O sea
 * que el freno que debería atajarlo está configurado tres veces por encima de lo que hay que
 * atajar, y el único aviso posible llegaría el día después de que ya no sirva.
 *
 * PURA a propósito: es el input de la regla de DAÑO del canal, y una regla de daño no puede
 * depender de una lectura de disco que puede fallar.
 *
 * FAIL-HONEST en las dos direcciones:
 *  · un dominio `cerca` que no figura en la medición del cap NO entra. No sabemos qué cap tiene, y
 *    "no medido" no es "está sobre el techo" — inventarlo produciría el aviso de daño más caro del
 *    sistema sobre nada.
 *  · un dominio con `cap: null` (el archivo no se pudo leer en ese nodo) tampoco entra, por lo
 *    mismo. Su silencio lo declara `ilegibles` en el propio CapFlota.
 */
export function porEncimaDelTecho(input: {
  /** Dominios que la medición de la flota marcó cerca del umbral permanente y que NO lo cruzaron. */
  cerca: readonly string[];
  /** La última lectura del cap por nodo. */
  nodos: readonly { domain: string; cap: number | null }[];
}): Array<{ dominio: string; cap: number }> {
  const capDe = new Map(input.nodos.map((n) => [n.domain.toLowerCase(), n.cap]));
  // SALE EL CAP AL LADO DEL NOMBRE. Con la lista de nombres sola, el aviso de daño decía "tiene el
  // cupo del nodo por encima del techo que aguanta el dominio" y la respuesta textual del jefe fue
  // "No entiendo, es decir ?". Los dos números —15.000 cableado y 2.000 de techo— son lo único que
  // convierte ese mensaje en una acción.
  return input.cerca
    .flatMap((d) => {
      const cap = capDe.get(d.toLowerCase());
      return typeof cap === "number" && cap > TECHO_DURO_POR_DOMINIO ? [{ dominio: d, cap }] : [];
    })
    .sort((a, b) => a.dominio.localeCompare(b.dominio));
}

export interface DailyCapStatus {
  /** El tope vigente en el nodo. `null` = no hay archivo de cap (o no se pudo leer). */
  cap: number | null;
  /** Consumido hoy (UTC). `null` = todavía no hay contador del día, que NO es "cero enviados". */
  consumidoHoy: number | null;
  /** El policy service está realmente enganchado en submission Y declarado en master. */
  cableado: boolean;
  /** Por qué no está cableado, o qué faltó leer. `null` cuando está todo bien. */
  motivo: string | null;
}

/**
 * Parseo fail-honest de la salida del status. Null con motivo, nunca 0: un `0` en "consumido hoy"
 * se leería como "no envió nada", cuando puede ser "no pude leer el contador".
 */
export function parseDailyCapStatus(stdout: string): DailyCapStatus {
  const lineas = stdout.split("\n").map((l) => l.trimEnd());
  if (!lineas.some((l) => l === "## END")) {
    return { cap: null, consumidoHoy: null, cableado: false, motivo: "salida truncada: falta ## END" };
  }
  // Un centinela pegado a la salida anterior ("2## WIRED") haría desaparecer su sección y el nodo
  // se reportaría ABIERTO teniendo el límite. Se declara ilegible en vez de mentir por omisión.
  const pegado = lineas.find((l) => l.includes("## ") && !l.startsWith("## "));
  if (pegado) {
    return { cap: null, consumidoHoy: null, cableado: false, motivo: `salida ilegible: centinela pegado en "${pegado}"` };
  }
  const seccion = (nombre: string): string[] => {
    const desde = lineas.indexOf(`## ${nombre}`);
    if (desde === -1) return [];
    const out: string[] = [];
    for (let i = desde + 1; i < lineas.length; i += 1) {
      if (lineas[i]?.startsWith("## ")) break;
      const linea = lineas[i]?.trim();
      if (linea) out.push(linea);
    }
    return out;
  };
  const entero = (linea: string | undefined): number | null => {
    if (linea === undefined) return null;
    // Estricto a propósito: `parseInt("2abc")` daría 2 y reportaría un contador con basura como
    // un número creíble. Si no es un entero limpio, es null con motivo.
    if (!/^\d+$/.test(linea)) return null;
    const n = Number.parseInt(linea, 10);
    return Number.isFinite(n) ? n : null;
  };

  // Se exige NUESTRO socket exacto, no un `check_policy_service` cualquiera: otro policy daemon
  // (un postgrey, por ejemplo) haría pasar por "con límite" un nodo que no tiene ninguno.
  const apuntaANuestroPolicy = (texto: string): boolean =>
    new RegExp(`check_policy_service\\s+${POLICY_SOCKET.replace(/[/:]/g, "\\$&")}`).test(texto);

  const enSubmission = apuntaANuestroPolicy(seccion("WIRED").join(" "));
  const enSmtps = apuntaANuestroPolicy(seccion("WIRED_SMTPS").join(" "));
  const enMaster = seccion("SPAWN").join(" ").includes("spawn");
  const cableado = enSubmission && enSmtps && enMaster;

  let motivo: string | null = null;
  if (!cableado) {
    const faltan = [
      !enSubmission ? "restriction en submission (587)" : null,
      !enSmtps ? "restriction en smtps (465)" : null,
      !enMaster ? "servicio en master.cf" : null
    ]
      .filter(Boolean)
      .join(" y ");
    motivo = `sin límite físico: falta ${faltan}`;
  }

  return {
    cap: entero(seccion("CAP")[0]),
    consumidoHoy: entero(seccion("COUNT")[0]),
    cableado,
    motivo
  };
}
