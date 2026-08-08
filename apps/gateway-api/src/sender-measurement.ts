// La corrida de medicion de la flota: llena las franjas 1 y 2 del inventario.
//
// Junta las dos lecturas que ya existen y las persiste por bandeja:
//   - readNodeDeliveryHealth  -> entrega / bloqueo / cola atascada, por proveedor destino
//   - readNodeProviderVolume  -> mensajes unicos por dia contra el umbral permanente de Google
//
// Las dos leen /var/log/mail.log del nodo por SSH. Es el censo de lo que TODOS los receptores
// contestaron, no una muestra: es lo que un proveedor que revende buzones ajenos no puede hacer.
//
// Se persiste porque una medicion cuesta ~59 sesiones SSH. La pantalla lee lo ultimo medido y
// DECLARA cuando fue; nunca se queda esperando una corrida para poder mostrar algo.
//
// ── DE QUIÉN ES EL CORREO QUE MEDIMOS ────────────────────────────────────────────────────────────
//
// Por los MISMOS nodos pasa el correo de NFC: otro producto, otros clientes, que inyectan por SMTP
// 587 con SASL. Hasta el 2026-08-06 el clasificador contaba TODA línea `status=` del mail.log sin
// mirar quién inyectó el mensaje. Sobre la flota eso es 791.300 mensajes de NFC contra 222 nuestros
// (0,028%): el 99,97% de la evidencia con la que se declaraba healthy/blocked/stalled era
// reputación que quemó otro producto, publicada como medición NUESTRA acá, en
// `GET /v1/sender-measurement`, en la tool `read_sender_measurement` del agente y en el panel.
//
// Los números que lo delatan, medidos ese día: en infranationalreport.com el panel decía 20.295
// entregados y 3.617 rechazados en 5 días — lo nuestro eran 6 entregados y 1 rechazado. En
// annualcorp-control.com el panel decía "cerrado en gmail: 136 rechazos sobre 137 intentos": 135
// eran de NFC y 1 nuestro.
//
// La separación se hace por NUESTRO PROPIO LIBRO (`leerLibroPropio`), no por heurística sobre el
// log. Ver `ModoAtribucion` en smtp-delivery-health.ts para por qué el discriminante obvio
// (sasl_username, remitente, sendmail vs 587) NO funciona.

import {
  BLOCKED_MIN_ATTEMPTS,
  readNodeDeliveryHealth,
  type Culpa,
  type DeliveryHealthSshRunner,
  type DeliveryHealthStatus,
  type ModoAtribucion
} from "./smtp-delivery-health.ts";
import type { PgClient } from "../../warmup-engine/src/store/pg-stores.ts";
import {
  readNodeProviderVolume,
  type ProviderFamily,
  type ProviderVolumeSshRunner
} from "./smtp-provider-volume.ts";
import type { OpenClawWorkspace } from "./openclaw-workspace.ts";

/** Donde vive la ultima medicion. Un archivo, no una tabla: no depende de Postgres. */
export const MEASUREMENT_FILE = "sender-measurement.json";

/**
 * Concurrencia de la medicion.
 *
 * Igual que el abanico de diagnostico y por la misma razon: cada lectura abre una sesion SSH
 * contra un nodo y no hay pool en ninguna capa de abajo. El limite lo pone la flota, no nosotros.
 */
export const MEASUREMENT_CONCURRENCY = 4;

/**
 * NUESTRO LIBRO DE ENVÍOS, el único discriminante que no depende de lo que haga el otro inquilino.
 *
 * `queueIdsPorDominio`: los queue-ids que Postfix nos devolvió al aceptar cada mensaje
 * ("250 2.0.0 Ok: queued as B7CA03F69F"), agrupados por dominio en minúsculas. Identificación
 * POSITIVA: nuestro = está acá; todo lo demás = no nuestro. Lo que no se puede atribuir cae del
 * lado seguro — sub-contamos lo nuestro, nunca lo inflamos.
 *
 * `ultimoEnvioPorDominio`: SIN ventana, a propósito. No es para atribuir, es para que el pool del
 * warmup pueda distinguir "nunca le mandamos nada" de "le mandamos, pero hace más de N días". Sin
 * esa distinción se abre un deadlock: un dominio que se queda sin vueltas pierde su muestra propia,
 * queda `no_own_traffic`, lo sacan del pool, y sin pool no vuelve a mandar nunca — el warmup se
 * apaga solo. La ventana la fija `dias`; la historia no tiene ventana.
 */
export interface LibroPropio {
  queueIdsPorDominio: Map<string, string[]>;
  ultimoEnvioPorDominio: Map<string, string>;
}

/**
 * Lee el libro de la base. NO ATRAPA ERRORES A PROPÓSITO: si esto tira, la corrida entera se cae y
 * `sender-measurement.json` queda como estaba.
 *
 * Devolver un libro vacío ante un fallo de Postgres sería la peor falla posible del módulo:
 * atribuiría CERO mensajes nuestros en los 58 nodos, la flota entera pasaría a `no_own_traffic`, y
 * el archivo publicaría eso como si lo hubiera medido. Un archivo viejo con su `medidoEn`
 * envejecido — que el panel ya sabe mostrar — es infinitamente mejor que uno nuevo con una
 * atribución inventada.
 */
export async function leerLibroPropio(pg: PgClient, dias: number): Promise<LibroPropio> {
  // `dias + 2` y no `dias`: `maximal_queue_lifetime = 2d` (postconf -n del nodo), así que un
  // mensaje que encolamos ANTES del borde de la ventana sigue escribiendo líneas `status=` DENTRO
  // de ella — sus reintentos. Sin el margen, esos rebotes nuestros se contarían como de NFC.
  // Y de paso acota el reúso de queue-id, que medido en el nodo de más volumen es 2 de 61.241
  // (0,003%) sobre TODO el log retenido y exactamente 0 dentro de la ventana de 5 días.
  const ventana = await pg.query<{ node_domain: string; smtp: string | null }>(
    "SELECT node_domain, detail->>'smtp' AS smtp FROM warmup_activity" +
      " WHERE kind = 'sent' AND occurred_at >= now() - make_interval(days => $1)" +
      " AND detail->>'smtp' ILIKE '%queued as %'",
    [dias + 2]
  );
  const historia = await pg.query<{ node_domain: string; ultimo: Date | string }>(
    "SELECT node_domain, MAX(occurred_at) AS ultimo FROM warmup_activity WHERE kind = 'sent' GROUP BY node_domain"
  );

  const queueIdsPorDominio = new Map<string, string[]>();
  for (const row of ventana.rows) {
    // Formato real de producción, verificado el 2026-08-06 contra la Postgres del Studio:
    // `250 2.0.0 Ok: queued as C921D46D53`. El `[A-Za-z0-9]{4,20}` cubre también el base-52 de los
    // nodos con `enable_long_queue_ids`; atarse al hex dejaría esos nodos sin libro y por lo tanto
    // en `no_own_traffic` para siempre.
    const m = /queued as ([A-Za-z0-9]{4,20})/i.exec(row.smtp ?? "");
    if (!m) continue;
    const dominio = row.node_domain.trim().toLowerCase();
    const ids = queueIdsPorDominio.get(dominio);
    if (ids) ids.push(m[1]!);
    else queueIdsPorDominio.set(dominio, [m[1]!]);
  }

  const ultimoEnvioPorDominio = new Map<string, string>();
  for (const row of historia.rows) {
    if (!row.ultimo) continue;
    ultimoEnvioPorDominio.set(
      row.node_domain.trim().toLowerCase(),
      row.ultimo instanceof Date ? row.ultimo.toISOString() : String(row.ultimo)
    );
  }

  return { queueIdsPorDominio, ultimoEnvioPorDominio };
}

export interface MedicionBandeja {
  domain: string;
  serverSlug: string;
  /** Nunca `healthy` por defecto: si no se pudo leer, el estado lo dice. */
  estado: DeliveryHealthStatus;
  detalle: string;
  /** Que ventana cubren los numeros de entrega, en los dias que se leyeron de verdad. */
  ventana: string;
  /**
   * ENTREGADOS/RECHAZADOS/DIFERIDOS/porReceptor/cerradoEn SON SOLO NUESTROS desde el 2026-08-06
   * (o del nodo entero si `atribucion.modo === "todo"`). Son justo los campos que leen
   * `plan-diario` y `sender-quota`, así que es acá donde el cambio tiene que morder: decidir el
   * pool del warmup y vender cupo con la reputación que quemó NFC era el defecto.
   */
  entregados: number | null;
  /**
   * De esos `entregados`, los que SALIERON DEL NODO: el total menos lo que el nodo se manda a sí
   * mismo (su propio dominio y subdominios, el pipe de rebotes). `null` = no se leyó.
   *
   * Opcional porque los archivos viejos no lo traen, y quien lo lee tiene que caer a `entregados`
   * cuando falta — no a cero, que excluiría media flota el día del despliegue.
   *
   * NO se le cambia el significado a `entregados`: el panel lo muestra con ese nombre y el operador
   * lo lee como "cuánto movió el nodo". Lo que cambia es cuál de los dos DECIDE (ver plan-diario).
   */
  entregadosATerceros?: number | null;
  /**
   * Mensajes trabados en la cola del nodo AHORA (no en la ventana). `null` = no se pudo leer.
   *
   * Opcional a proposito: los fixtures de sender-quota, sender-alerts y la ruta de lectura arman
   * este objeto a mano, y obligarlos a declarar un campo que no les importa habria sido tocar tres
   * archivos ajenos para no ganar nada.
   */
  encolados?: number | null;
  rechazados: number | null;
  diferidos: number | null;
  /** Receptores donde el nodo esta efectivamente cerrado. */
  cerradoEn: string[];
  /**
   * A QUIÉN castiga cada receptor que nos cierra o nos degrada, leído del texto de sus propios
   * rebotes: `"ip"`, `"dominio"`, `"buzon"` o `"no-se"`. Una clave por cada nombre de `cerradoEn`
   * más los degradados, siempre — `"no-se"` cuando el motivo no se pudo clasificar.
   *
   * EL DATO SE CALCULABA CADA 6 HORAS EN LOS 58 NODOS Y SE TIRABA A LA BASURA. `readNodeDeliveryHealth`
   * ya lo publica en su veredicto (smtp-delivery-health.ts, `culpaPorProveedor`), y este mapeador —el
   * único que persiste— lo omitía: medido sobre la copia de producción del 2026-08-08, 0 de 58
   * bandejas lo traen. Consecuencia exacta: el archivo podía decir "cerrado en gmail.com, icloud.com"
   * y NO tenía con qué contestar la única pregunta que cuesta plata — ¿es la IP, es el dominio, o son
   * buzones que no existen? Que es literalmente la diferencia entre "comprá un dominio nuevo" y "no
   * gastes un peso". Sin esto, eso sólo se contesta abriendo el mail.log crudo de un nodo por SSH,
   * que es la pregunta que dejó a tres agentes bloqueados por política en la corrida del 2026-08-07.
   *
   * `{}` y NUNCA la clave ausente cuando el nodo no se pudo leer: un bloque que no está se lee como
   * "está todo bien", y esa confusión ya costó 38 nodos cerrados leídos como sanos (2026-07-25).
   *
   * EL TAMAÑO ESTÁ ACOTADO POR CONSTRUCCIÓN, no por un techo que haya que mantener: las claves son
   * exactamente `blockedProviders + degradedProviders`, y en toda la flota eso son ~30 entradas
   * (contadas sobre la foto del 2026-08-08: 30 receptores en `cerradoEn` entre 58 bandejas).
   *
   * Opcional por el mismo motivo que `encolados` y `porReceptor`: hay fixtures que arman este objeto
   * a mano. Quien lo lea tiene que tratar la AUSENCIA como "esta medición es vieja y no lo trae",
   * jamás como "no hay culpa".
   */
  culpaPorProveedor?: Record<string, Culpa>;
  /**
   * Entregados/rechazados/diferidos POR RECEPTOR. Opcional, igual que `encolados` y por el mismo
   * motivo: hay fixtures que arman este objeto a mano.
   *
   * El clasificador YA calculaba esto (`NodeDeliveryStats.byProvider`) y el persistidor lo tiraba
   * entero: al archivo iban los totales globales y `cerradoEn`, o sea QUIEN cierra pero no CUANTO.
   * Dos consecuencias medidas el 2026-08-06, con 36 de 58 bandejas cerradas por el receptor:
   *
   *   1. Nadie podia decir cuanto correo seguia entregando cada una por las OTRAS puertas, que es
   *      justo el numero que decide si frenarla cuesta correo de cliente o no cuesta nada. La
   *      decision se tomaba a ciegas sobre 36 nodos.
   *   2. El punto ciego peor: el bloqueo se detecta SOLO por rebotes 5xx (`blocked/attempts >= 0,9`),
   *      y Yahoo tipicamente DIFIERE con 4xx. Un diferido no alimenta `cerradoEn`. Sin el diferido
   *      POR receptor, un bloqueo de Yahoo es literalmente invisible en este archivo — y asi fue
   *      como "Yahoo no aparece en ninguna de las 58" se leyo como "Yahoo no nos bloquea", que es
   *      ausencia de instrumento, no evidencia.
   *
   * NO se persiste `degradadoEn`: `degradedProviders` es `blocked/(delivered+blocked) >= 0,25`,
   * derivable de estas tres columnas por cualquier lector. Dos representaciones del mismo hecho es
   * la que se desincroniza.
   */
  porReceptor?: Array<{ receptor: string; entregados: number; rechazados: number; diferidos: number }>;
  /**
   * Cómo se separó el tráfico. `"nuestro"` = solo lo que figura en `warmup_activity` por queue-id;
   * `"todo"` = el nodo entero, sin atribuir. `descartados` son ids del libro que no pasaron el
   * saneo — correo nuestro que vamos a contar como ajeno, y por eso se publica en vez de callarse.
   *
   * Opcional por el mismo motivo que `encolados` y `porReceptor`: los fixtures de sender-quota,
   * sender-alerts y la ruta de lectura arman `MedicionBandeja` a mano, y obligarlos a declarar un
   * campo que no les importa sería tocar tres archivos ajenos para no ganar nada. Quien lo consuma
   * tiene que tratar la AUSENCIA como "el gateway no declaró procedencia", nunca como "es nuestro".
   */
  atribucion?: { modo: "nuestro" | "todo"; queueIds: number; descartados: number };
  /** Lo que movió el nodo y NO es nuestro (el otro inquilino). Se MUESTRA; jamás entra al veredicto. */
  ajeno?: { entregados: number | null; rechazados: number | null; diferidos: number | null };
  /**
   * Último envío NUESTRO por este dominio, sin ventana. `null` = nunca le mandamos nada.
   *
   * Existe para el pool del warmup, no para la pantalla: es lo único que distingue "el nodo está
   * quemado por NFC y nosotros nunca lo tocamos" de "lo veníamos calentando y se quedó sin vueltas".
   * Al segundo hay que dejarlo volver o el warmup se apaga solo; al primero, onboardearlo es una
   * DECISIÓN del operador, no el efecto lateral de un sensor.
   */
  ultimoEnvioNuestro?: string | null;
  /**
   * Pico diario de mensajes UNICOS contra el umbral publicado, por familia de receptor.
   *
   * `picos`, `cruzados` y `cerca` NO SE ATRIBUYEN, y eso es deliberado: ver la nota de
   * `smtp-provider-volume.ts`. El receptor cuenta por DOMINIO y por IP, no por quién inyectó, así
   * que los ~15.000 mensajes/día de NFC que salen de nuestros dominios cuentan enteros contra el
   * umbral permanente de Google. Filtrarlos apagaría el único sensor del daño que no se deshace.
   */
  picos: Array<{
    familia: ProviderFamily;
    dia: string;
    mensajes: number;
    umbral: number | null;
    ratio: number | null;
  }>;
  /** Familias que ya cruzaron el umbral. En Google es permanente. */
  cruzados: ProviderFamily[];
  /** Familias arriba del 40% del umbral. */
  cerca: ProviderFamily[];
}

export interface MedicionFlota {
  medidoEn: string;
  duracionMs: number;
  /** Bandejas pedidas vs leidas: delata la cobertura sin depender de un log. */
  pedidas: number;
  leidas: number;
  bandejas: MedicionBandeja[];
}

export interface RunnerMedicion extends DeliveryHealthSshRunner, ProviderVolumeSshRunner {}

/**
 * Mide UNA bandeja. Fail-honest de punta a punta: cualquier problema termina en `unreadable`
 * con el motivo, nunca en ceros que se lean como salud.
 */
export async function medirBandeja(input: {
  sshRunner: RunnerMedicion;
  domain: string;
  serverSlug: string;
  serverIp: string;
  /** Queue-ids nuestros en este nodo, o `"todo"` para no atribuir. Requerido: es una decisión. */
  propios: ModoAtribucion;
  /** Último envío nuestro a este dominio, sin ventana. `null` = nunca le mandamos. */
  ultimoEnvioNuestro?: string | null;
}): Promise<MedicionBandeja> {
  const [salud, volumen] = await Promise.all([
    readNodeDeliveryHealth({
      sshRunner: input.sshRunner,
      serverSlug: input.serverSlug,
      serverIp: input.serverIp,
      propios: input.propios,
      // Los rebotes del propio dominio son bounce processing, no un bloqueo del receptor.
      selfDomain: input.domain
    }),
    readNodeProviderVolume({
      sshRunner: input.sshRunner,
      serverSlug: input.serverSlug,
      serverIp: input.serverIp
    })
  ]);

  const leyoSalud = salud.status !== "unreadable";

  /**
   * Los receptores cuya fila NO se puede filtrar por tamaño, porque son justo los que decidieron el
   * veredicto. Ver el filtro de `porReceptor` abajo para el por qué de cada lista.
   */
  const decidieron = new Set([...salud.blockedProviders, ...salud.degradedProviders, ...salud.sinMuestra]);

  return {
    domain: input.domain,
    serverSlug: input.serverSlug,
    estado: salud.status,
    detalle: salud.detail,
    ventana: salud.window,
    // null y no 0 cuando no se pudo leer: es la regla de toda la pantalla.
    entregados: leyoSalud ? salud.stats.totals.delivered : null,
    // La misma cuenta pero SIN el correo que el nodo se manda a sí mismo. Viene calculada del
    // veredicto en vez de rehacerse acá: la regla de qué es "propio" (dominio + subdominios) vive en
    // smtp-delivery-health y duplicarla es que se separen sin que nadie se entere.
    entregadosATerceros: leyoSalud ? salud.entregadosATerceros : null,
    // La cola viaja al archivo porque es la unica senal de "esta atascado AHORA": los totales de la
    // ventana dicen que paso, no que esta pasando. Sin esto el operador solo veia el veredicto.
    encolados: leyoSalud ? salud.encolados : null,
    rechazados: leyoSalud ? salud.stats.totals.blocked : null,
    diferidos: leyoSalud ? salud.stats.totals.deferred : null,
    atribucion: salud.atribucion,
    // Lo del otro inquilino viaja al archivo para que la pantalla pueda explicar POR QUÉ un dominio
    // está quemado sin que ese número entre en ninguna decisión. `null` cuando no se leyó, igual
    // que los nuestros: un cero acá diría "el nodo está vacío", que es lo contrario del caso.
    ajeno: leyoSalud
      ? {
          entregados: salud.ajenos.totals.delivered,
          rechazados: salud.ajenos.totals.blocked,
          diferidos: salud.ajenos.totals.deferred
        }
      : { entregados: null, rechazados: null, diferidos: null },
    ultimoEnvioNuestro: input.ultimoEnvioNuestro ?? null,
    cerradoEn: salud.blockedProviders,
    // POR QUÉ nos cierra cada uno, no sólo quién. Sale del veredicto en vez de reclasificarse acá: la
    // tabla de motivos (`MOTIVOS_DE_CULPA`) vive en smtp-delivery-health y tener dos copias es que se
    // separen sin que nadie se entere. El `{}` de la rama de abajo es la mitad que importa: ausencia
    // de bloque NO es "no hay culpa".
    culpaPorProveedor: leyoSalud ? salud.culpaPorProveedor : {},
    // El filtro por BLOCKED_MIN_ATTEMPTS no es cosmetico: acota el TAMANO del archivo. `byProvider`
    // trae una fila por dominio receptor visto, sin techo — 58 bandejas por cientos de receptores
    // inflarian el JSON que el panel sirve entero. 20 es exactamente el minimo de intentos que el
    // propio clasificador exige para emitir un veredicto, asi que abajo de eso no hay decision que
    // tomar. Se reusa la constante en vez de inventar un numero, para que no se puedan separar.
    //
    // Y suma los DIFERIDOS al conteo del filtro, aunque el clasificador no los cuente para su
    // `attempts`: si no, el receptor que solo difiere —el caso Yahoo, el que este campo existe para
    // destapar— quedaria filtrado por el mismo punto ciego que vino a arreglar.
    //
    // ── EL PISO NO APLICA A QUIEN DECIDIÓ EL VEREDICTO (2026-08-08) ─────────────────────────────
    //
    // El piso de 20 es un techo de TAMAÑO DE ARCHIVO, no una medición, y por eso no puede tapar a los
    // receptores sobre los que el veredicto YA se pronunció: ahí un `porReceptor` vacío se lee como
    // "no mandó nada" cuando lo que dice es "no llegó al piso". Es el modo de falla que este repo ya
    // pagó tres veces, y tiene un lector concreto: `cruzarEntregaConPlacement` (decision-diaria.ts)
    // imprime "nuestro MTA no reporta X en la ventana ... el cruce no se puede hacer" justo sobre el
    // receptor que nos cerró la puerta.
    //
    // CUÁL DE LAS TRES LISTAS MUERDE DE VERDAD, medido y no supuesto — importa porque las dos
    // primeras se ven necesarias y NO lo son:
    //   · `blockedProviders` y `degradedProviders` sólo se pueblan DESPUÉS del `if (attempts <
    //     BLOCKED_MIN_ATTEMPTS) continue` del clasificador, o sea con `delivered + blocked >= 20`.
    //     Como el filtro de acá suma además los diferidos, todo lo que entra ahí ya pasaba: es un
    //     no-op POR CONSTRUCCIÓN. Verificado sobre la foto de producción del 2026-08-08: 30 de 30
    //     receptores de `cerradoEn` ya estaban en `porReceptor`, cero ausentes. Se dejan igual porque
    //     el que lee esta línea no puede deducir eso sin ir al otro archivo, y si algún día los dos
    //     pisos se separan, la garantía tiene que estar acá y no en una coincidencia.
    //   · `sinMuestra` es la que muerde, y es exactamente la inversa: se puebla SÓLO por abajo del
    //     piso (el receptor rechazó casi todo y no alcanzó para acusarlo), así que sus filas son las
    //     únicas que el filtro tiraba siempre. Es el veto que desde el 2026-08-08 convierte `healthy`
    //     en `insufficient_sample`, y sin su fila el archivo publicaba el estado nuevo sin UN solo
    //     número que lo respaldara. El caso reproducido por el camino de producción: 1 entrega + 9
    //     rechazos 550-5.7.1 de Gmail (10 intentos, la mitad del piso) — el nodo queda vetado y
    //     `porReceptor` salía `[]`.
    //
    // La cola larga de NFC —miles de receptores con dos o tres líneas— sigue con el piso de 20
    // intacto, que es lo que mantiene acotado el JSON que el panel sirve entero.
    porReceptor: leyoSalud
      ? salud.stats.byProvider
          .filter((p) => p.delivered + p.blocked + p.deferred >= BLOCKED_MIN_ATTEMPTS || decidieron.has(p.provider))
          .map((p) => ({
            receptor: p.provider,
            entregados: p.delivered,
            rechazados: p.blocked,
            diferidos: p.deferred
          }))
      : [],
    picos: volumen.status === "ok"
      ? volumen.peakByFamily.map((p) => ({
          familia: p.family,
          dia: p.day,
          mensajes: p.messages,
          umbral: p.threshold,
          ratio: p.ratio
        }))
      : [],
    cruzados: volumen.status === "ok" ? volumen.overThreshold : [],
    cerca: volumen.status === "ok" ? volumen.nearThreshold : []
  };
}

/** Corre la medicion sobre la flota con concurrencia acotada y la persiste. */
export async function medirFlota(input: {
  workspace: OpenClawWorkspace;
  sshRunner: RunnerMedicion;
  bandejas: ReadonlyArray<{ domain: string; serverSlug: string; serverIp: string }>;
  /**
   * El libro de `leerLibroPropio`, o `"todo"` para no atribuir.
   *
   * `"todo"` es SOLO para fixtures y para el diagnóstico de máquina
   * (`scripts/ops/deliverability-health.ts`), y se persiste como tal en `atribucion.modo` para que
   * nadie lea esos números como nuestros. Requerido y sin default: quien corre la medición decide
   * de qué reputación está hablando.
   */
  libro: LibroPropio | "todo";
  concurrency?: number;
  now?: () => Date;
  /**
   * `false` mide y devuelve sin tocar el archivo. Es el modo con el que el operador mira el
   * antes/después ANTES de dejar que una corrida normal reescriba la medición de producción.
   */
  persistir?: boolean;
}): Promise<MedicionFlota> {
  const now = input.now ?? (() => new Date());
  const inicio = now().getTime();
  const concurrency = Math.max(1, input.concurrency ?? MEASUREMENT_CONCURRENCY);

  const resultados = new Array<MedicionBandeja>(input.bandejas.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= input.bandejas.length) return;
      const target = input.bandejas[index]!;
      const dominio = target.domain.trim().toLowerCase();
      // Las dos búsquedas van FUERA del try, y no es cosmético: si tiran, tienen que tirar acá y no
      // adentro del `catch`. Una excepción dentro del manejador de errores mata el worker sin
      // escribir el resultado, `Promise.allSettled` se la come, y la bandeja DESAPARECE de la
      // flota — ni siquiera como `unreadable`. Es la peor forma de fallar de este módulo: no miente
      // sobre un nodo, lo borra.
      //
      // Un dominio SIN entrada en el libro recibe `[]`, no `"todo"`. Es la diferencia entre "no le
      // mandamos nada, así que nada del log es nuestro" y "contá todo como nuestro": el fallback
      // silencioso a "todo" sobre un dominio sin envíos devolvería exactamente el bug que este
      // cambio arregla, y justo en los nodos donde más ruido de NFC hay.
      const propios = input.libro === "todo" ? "todo" : (input.libro.queueIdsPorDominio.get(dominio) ?? []);
      const ultimoEnvioNuestro = input.libro === "todo" ? null : (input.libro.ultimoEnvioPorDominio.get(dominio) ?? null);
      try {
        resultados[index] = await medirBandeja({ sshRunner: input.sshRunner, ...target, propios, ultimoEnvioNuestro });
      } catch (error) {
        // Una bandeja que revienta no tumba la corrida, y NO se cuenta como sana.
        resultados[index] = {
          domain: target.domain,
          serverSlug: target.serverSlug,
          estado: "unreadable",
          detalle: error instanceof Error ? error.message : "fallo la medicion",
          ventana: "sin lectura",
          entregados: null,
          encolados: null,
          rechazados: null,
          diferidos: null,
          ajeno: { entregados: null, rechazados: null, diferidos: null },
          ultimoEnvioNuestro,
          cerradoEn: [],
          picos: [],
          cruzados: [],
          cerca: []
        };
      }
    }
  };

  await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, input.bandejas.length) }, () => worker())
  );

  const bandejas = resultados.filter(Boolean);

  // CRUCE PEGAJOSO. Cruzar el umbral permanente de Google es irreversible; olvidarlo NUNCA es
  // correcto. Pero `cruzados` viene de la lectura de VOLUMEN, que puede fallar (grep sin `## END`)
  // y entonces se persiste `[]` — indistinguible de "midio y no cruzo". Como cada corrida
  // sobreescribe el archivo entero, una lectura de volumen fallida borraria un cruce conocido y la
  // fabrica venderia verde un dominio quemado para siempre. Unimos con la corrida anterior: un
  // cruce solo se AGREGA (cuando el volumen lo lee sobre el umbral), nunca se quita.
  //
  // Y EL CIERRE DEL RECEPTOR SE ARRASTRA IGUAL, por el mismo motivo con otra forma. `estado`,
  // `cerradoEn` y `porReceptor` se recalculan enteros sobre la ventana de 5 días por fecha de
  // linea: un nodo que DEJA de mandar vuelve solo a `no_traffic` 0/0/0 con `cerradoEn: []`, o sea
  // que se auto-absuelve por el paso del tiempo. No es teorico y tiene fecha: NFC dejo de inyectar
  // por el /24 80.190.73.x el 2026-08-05, asi que alrededor del 9-11 de agosto sus TRES nodos
  // pasan solos a `no_traffic` — y `no_traffic` es justo la puerta por la que `elegirPool` deja
  // entrar a los dominios nuevos. controlstatecorp.com tiene 56 rechazos 550-5.7.1 de Gmail de
  // hace cuatro dias y quedaria leido como "nodo nuevo, candidato natural a arrancar". Ya paso
  // una vez: nationalfiling-infra.com estuvo en el pool el 2026-08-05 y mando un correo real.
  //
  // ponytail: sin caducidad — un cierre se olvida solo si alguien borra el campo a mano. Es la
  // misma regla que `cruzados` y nadie se quejo; si algun dominio se recupera de verdad, el
  // des-pegado es un acto humano deliberado, que es lo correcto para algo casi irreversible.
  const previa = await leerUltimaMedicion(input.workspace);
  if (previa) {
    const cruzadosPrevios = new Map<string, ProviderFamily[]>();
    const cerradosPrevios = new Map<string, string[]>();
    for (const b of previa.bandejas) {
      if (b.cruzados.length > 0) cruzadosPrevios.set(b.domain, b.cruzados);
      if ((b.cerradoEn ?? []).length > 0) cerradosPrevios.set(b.domain, b.cerradoEn);
    }
    for (const b of bandejas) {
      const antes = cruzadosPrevios.get(b.domain);
      if (antes) b.cruzados = [...new Set([...b.cruzados, ...antes])];
      const cerradoAntes = cerradosPrevios.get(b.domain);
      if (cerradoAntes) b.cerradoEn = [...new Set([...b.cerradoEn, ...cerradoAntes])];
    }
  }

  const medicion: MedicionFlota = {
    medidoEn: now().toISOString(),
    duracionMs: now().getTime() - inicio,
    pedidas: input.bandejas.length,
    leidas: bandejas.filter((r) => r.estado !== "unreadable").length,
    bandejas
  };

  if (input.persistir !== false) {
    await input.workspace.updateInventoryJson<MedicionFlota>(MEASUREMENT_FILE, () => medicion);
  }
  return medicion;
}

/** Lee la ultima medicion. `null` = nunca se midio, que NO es lo mismo que todo en cero. */
export async function leerUltimaMedicion(
  workspace: OpenClawWorkspace
): Promise<MedicionFlota | null> {
  const stored = await workspace
    .readInventoryJson<MedicionFlota>(MEASUREMENT_FILE)
    .catch(() => null);
  return stored && typeof stored.medidoEn === "string" ? stored : null;
}
