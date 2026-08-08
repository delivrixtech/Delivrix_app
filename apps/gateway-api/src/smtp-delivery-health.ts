// Salud de entrega por nodo, leída del propio mail.log — la señal que faltaba.
//
// El 2026-07-25 se midió con envíos reales que 38 de 64 nodos estaban bloqueados por
// Gmail con 550-5.7.1, mientras el chequeo de listas negras daba "0 blacklist" y el
// inventario decía `authComplete: true`. Las dos cosas eran ciertas y las dos eran
// ciegas: la reputación era interna de Google, no una lista pública.
//
// La evidencia estaba en cada máquina desde hacía semanas — `corp-delivery.com` tenía
// 3883 rechazos de Gmail acumulados en su mail.log — y nadie la leía. Este módulo la
// lee. Es PASIVO a propósito: no envía nada, no cuesta reputación, y se puede correr
// cuantas veces se quiera. Un probe que necesita enviar correo para medir salud no se
// corre seguido; uno que solo lee, sí.
//
// Corre por el mismo `SmtpSshRunner` que provisiona, así hereda usuario y sudo por
// provider (Contabo entra como root; Webdock como delivrixops + sudo).

// La familia del receptor, prestada del módulo de volumen en vez de duplicar la tabla acá: es la
// misma pregunta ("¿este dominio es un receptor grande o el typo de un cliente?") y dos listas del
// mismo hecho son las que se desincronizan. El import es de una sola dirección — smtp-provider-volume
// no importa nada de este archivo — así que no hay ciclo.
import { providerFamilyFor } from "./smtp-provider-volume.ts";

/**
 * LAS DOS UNIDADES DEL LOG, y por qué hacen falta las dos.
 *
 * `delivered` / `blocked` / `deferred` son MENSAJES (deduplicados por queue-id). `intentos` son las
 * LÍNEAS que ese mismo puñado de mensajes dejó escritas en el mail.log. Salen de la MISMA pasada del
 * mismo `sort | uniq -c`, así que no hay dos lecturas que puedan divergir — que es literalmente lo
 * que produjo el incidente del 2026-08-07 (el mismo nodo leído dos veces con la ventana corrida un
 * día: 165/136 y 16/1).
 *
 * POR QUÉ EL MENSAJE SOLO NO ALCANZA, medido en 193.181.212.223 el 2026-08-08 sobre el log retenido:
 *   · entregado: 14.440 líneas / 14.439 mensajes = 1,00
 *   · rechazado: 33.554 líneas / 33.553 mensajes = 1,00
 *   · diferido:  yahoo 25.894/2.018 = 12,8 · gmail 8.719/86 = 101 · aol 5.562/505 = 11,0
 * O sea que el dedup NO mueve el ratio que decide `blocked_by_provider` (la hipótesis que motivó
 * este trabajo está muerta con datos), y toda la señal que perdió al deduplicar está en el DIFERIDO.
 * Ahí vive el receptor que nos cierra la puerta con un 4xx y NUNCA escribe un `status=bounced`:
 * Yahoo nos dijo 34.524 veces "421 4.7.0 [TSS04] Messages from 193.181.212.223 temporarily
 * deferred", con nuestra IP por escrito, y para el veredicto eso valía exactamente cero porque
 * `attempts` es `delivered + blocked`. Sin este campo ese receptor es estructuralmente invisible.
 *
 * OPCIONAL a propósito, igual que `encolados` en sender-measurement y por el mismo motivo: hay
 * fixtures y objetos armados a mano. Ausente ⇒ una línea por mensaje ⇒ presión 1,0 ⇒ la regla de la
 * puerta 4xx se calla sola, que es el lado seguro (no inventa un bloqueo que no midió).
 */
export interface DeliveryCounters {
  delivered: number;
  blocked: number;
  deferred: number;
}

/** Recuento de intentos hacia un proveedor de correo desde un nodo. */
export interface ProviderDeliveryStats extends DeliveryCounters {
  provider: string;
  /** Las LÍNEAS de log que dejaron esos mensajes. Ver `DeliveryCounters`. */
  intentos?: DeliveryCounters;
}

export interface NodeDeliveryStats {
  totals: DeliveryCounters;
  /** Las LÍNEAS de log que dejaron esos mensajes. Ver `DeliveryCounters`. */
  intentos?: DeliveryCounters;
  byProvider: ProviderDeliveryStats[];
}

/**
 * Cuántos días de log mira el sensor.
 *
 * Antes leía `/var/log/mail.log*` — con asterisco, o sea TODO lo rotado, semanas enteras. Como los
 * contadores solo suman, un nodo que se destrabó hace días quedaba condenado a `stalled` para
 * siempre: medido el 2026-08-06, 29 de 58 nodos atascados y el pool del warmup en 6 de 58. El
 * sensor no medía "¿está atascado HOY?", medía "¿alguna vez lo estuvo?".
 *
 * Por qué 5 y no un número lindo: es el `maximal_queue_lifetime` real de 47 de los 58 nodos (los
 * otros 11 corren 2d y ahí sobran 3 días). Es la ventana más chica que contiene un ciclo de
 * reintento completo de Postfix — más corta y un diferido legítimo se leería como si el mensaje
 * hubiera desaparecido — y la más grande que no arrastra ninguno ya vencido.
 *
 * El tope de 28 no es capricho: la retención medida del log está entre 12 y 26 días, así que pedir
 * 90 devolvería exactamente lo mismo que pedir 26 con un rótulo que vuelve a mentir. Y el mínimo de
 * 1 porque una ventana de 0 días no mide nada y se leería como "no hay tráfico".
 *
 * Es LA perilla de calibración: se mueve por entorno, sin desplegar código, el día que la física de
 * la flota cambie (más nodos con queue lifetime de 2d, o rotación diaria en vez de semanal).
 */
export function resolverDiasDeVentana(raw: string | undefined): number {
  const n = Number((raw ?? "").trim());
  return Number.isInteger(n) && n >= 1 && n <= 28 ? n : 5;
}
export const DELIVERY_STATS_WINDOW_DAYS = resolverDiasDeVentana(process.env.DELIVERY_STATS_WINDOW_DAYS);

/**
 * La ventana que cubren los numeros, en texto, tal como la lee el operador y el agente.
 *
 * Este string NO se queda acá: viaja al campo `ventana` de sender-measurement.json, a
 * `GET /v1/sender-measurement` y a la tool `read_sender_measurement` del modelo. Un rótulo que
 * promete más de lo que el número contiene es un mock servido como medición, y el que estaba antes
 * prometía el log entero retenido. Ahora dice los días reales.
 *
 * Dice "por fecha de la línea" porque es literal, y ese rótulo costó un defecto: cuando la ventana
 * se acotaba por MTIME del archivo, decía "por archivo, el log corriente arrastra hasta un ciclo de
 * rotación más" — y el que arrastraba la semana entera era el ROTADO, no el corriente. El rótulo
 * describía mal el mismo número que promete describir.
 */
export function ventanaDeclarada(dias: number): string {
  return `últimos ${dias} días de mail.log (por fecha de la línea)`;
}
export const DELIVERY_STATS_WINDOW = ventanaDeclarada(DELIVERY_STATS_WINDOW_DAYS);

const MESES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * Los prefijos de fecha que SÍ entran en la ventana, uno por día y por formato.
 *
 * Por qué existe: acotar por `find -mtime` elige ARCHIVOS, no días. Un rotado que se toca hoy trae
 * adentro la semana entera que acumuló, así que la ventana real era N días MÁS un ciclo de rotación,
 * y oscilaba con el día de la semana. Medido contra el fixture: el MISMO nodo, con 100 rechazos de
 * Gmail y CERO entregas recientes, se leía `healthy` con el rotado a 1 y a 4 días, y
 * `blocked_by_provider` con el rotado a 6 — sin que nadie tocara nada, solo por el mtime. O sea que
 * un nodo genuinamente roto entraba al pool 5 de cada 7 días.
 *
 * Se compara por PREFIJO literal y no con un parser de fechas en awk a propósito: los dos formatos
 * de la flota (syslog `Aug  6` y el ISO-8601 de los 12 Webdock) se resuelven con la misma lista, y
 * el año fantasma del syslog —que no lleva año— lo sigue cerrando el `find -mtime`, que ni ABRE un
 * rotado viejo. Los dos filtros juntos: el archivo acota el año, la línea acota el día.
 *
 * Arranca en MAÑANA (i = -1) por el huso: la lista se genera en UTC acá, y el nodo escribe con su
 * reloj — Contabo en Alemania va hasta 2h adelante. Sin ese día de más, las líneas más nuevas del
 * nodo con más tráfico serían justo las que se descartan.
 */
export function prefijosDeDias(dias: number, ahora: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = -1; i < dias; i++) {
    const d = new Date(ahora.getTime() - i * 86_400_000);
    const mes = MESES[d.getUTCMonth()]!;
    const dd = d.getUTCDate();
    // Las dos variantes del día en syslog: `Aug  6` (padding con espacio, lo que emite rsyslog) y
    // `Aug 06`. Del 10 en adelante son iguales y el Set las une.
    out.push(`${mes} ${String(dd).padStart(2, " ")}`, `${mes} ${String(dd).padStart(2, "0")}`, d.toISOString().slice(0, 10));
  }
  return [...new Set(out)];
}

/**
 * DE QUIÉN SE QUEJA EL RECEPTOR CUANDO NOS RECHAZA. Es el dato que decide si se gasta plata.
 *
 * EL INCIDENTE, 2026-08-07, con la compra a punto de salir: la mano `revisar_reputacion` publicó
 * "bizreport-control.com (86.48.29.176): listas negras sin detecciones · auth SPF ok, DKIM ok,
 * DMARC ok, PTR ok · receptor: CERRADO en gmail.com, hotmail.com, outlook.com" y el jefe preguntó
 * si alcanzaba con "comprar 2 dominios nuevos y configurarlos a esos smtps". El agente dijo que sí.
 * Nadie en el sistema podía contestar esa pregunta, porque el sistema entero sabía QUIÉN cierra la
 * puerta y NUNCA POR QUÉ. Hubo que entrar por SSH al nodo a mano para averiguarlo, y la respuesta
 * era distinta por receptor:
 *   · Gmail  → 334 rebotes "very low reputation of the sending DOMAIN"     ⇒ dominio nuevo AYUDA.
 *   · Microsoft → 171 rebotes "messages from [86.48.29.176] weren't sent … block list (S3150)"
 *   · Apple  → 503 rebotes "[HCM2] Your mail from 80.190.75.57 was rejected"
 *     ⇒ esos dos castigan la IP, y un dominio nuevo sobre la MISMA IP nace bloqueado.
 * O sea: la mitad del consejo era cierta, y por eso era caro. Sin esta clasificación, "comprá un
 * dominio nuevo" y "no gastes un peso" son indistinguibles con la evidencia que teníamos.
 *
 * `"no-se"` es una rama de verdad, no un relleno: un patrón que no conocemos NUNCA se disfraza de
 * "ip" ni de "dominio". Ausencia de dato no es evidencia — la regla de la casa desde el probe que
 * se colgaba el 2026-07-29 y devolvió "bloqueado" falso en 10 de 10 nodos.
 */
export type Culpa = "dominio" | "ip" | "buzon" | "no-se";

/**
 * LA PERILLA DE CALIBRACIÓN. Un receptor nuevo es UNA línea acá más un caso en el test, no una
 * refactorización — por eso la tabla se exporta: se mira, se discute y se ajusta sin abrir el
 * parser.
 *
 * No se trata de entender todos los códigos SMTP del mundo. Alcanza con separar los textos que
 * NOMBRAN LA IP de los que NOMBRAN EL DOMINIO, que es exactamente la pregunta que decide la compra.
 * Todos estos patrones salen de `/var/log/mail.log` de 86.48.29.176 y 80.190.75.57, medidos el
 * 2026-08-07 y contados: no son inventados de la documentación del proveedor.
 *
 * El orden importa: gana el PRIMERO que matchea, así que lo que habla de política va antes que lo
 * que habla del buzón.
 */
export const MOTIVOS_DE_CULPA: ReadonlyArray<{ patron: RegExp; culpa: Culpa }> = [
  // Gmail culpando a la IP. Va PRIMERO porque gana el primer patrón que matchea y la frase es casi
  // idéntica a la de abajo: "very low reputation of the sending IP address" contra "…of the sending
  // domain". Tres letras separan "comprá un dominio nuevo" de "no gastes un peso", y hasta el
  // 2026-08-08 ninguna de las dos tenía patrón que las distinguiera en el log real.
  // Medido en 193.181.212.223 (nodo corpfilingcontrol): 3 veces. Son pocas y entran igual — el error
  // caro es el optimista, y esta variante es la que desmiente el consejo de comprar dominio.
  { patron: /reputation of the sending ip address/i, culpa: "ip" },
  // Gmail, 334 veces en 86.48.29.176 y 10.686 en 80.190.75.57. Es el ÚNICO de los tres grandes que
  // culpa al dominio, y es la razón por la que el consejo del agente sonaba razonable.
  { patron: /reputation of the sending domain/i, culpa: "dominio" },
  // La OTRA frase de Gmail, la que le tira a nuestro volumen chico, y hasta hoy no tenía patrón:
  // "Gmail has detected that this message is likely unsolicited mail". Medido el 2026-08-08: 1.512
  // veces en 193.181.212.223 y es la que aparece en el nodo del incidente (annualcorp-control.com).
  // Se clasifica `dominio` y no `ip` porque Gmail nunca nombra la IP como bloqueada en este texto, y
  // porque la propia medición de la casa (2026-08-03) ya había separado a Gmail —castiga la
  // reputación del DOMINIO, sin trámite— de Yahoo y Apple, que castigan la IP. Si algún día se mide
  // lo contrario, es esta línea y nada más.
  { patron: /likely unsolicited mail/i, culpa: "dominio" },
  // Microsoft (hotmail/outlook/live/msn), 171 + 817. La lista S3150 es de ELLOS, no es pública:
  // por eso el chequeo de listas negras da limpio y la puerta igual está cerrada.
  { patron: /block list \(s3150\)/i, culpa: "ip" },
  { patron: /messages from \[[0-9.]+\] weren'?t sent/i, culpa: "ip" },
  // Apple (icloud/me/mac), 503 veces. Nombra la IP con número y letra.
  { patron: /\[hcm2\]|your mail from [0-9.]+ was rejected/i, culpa: "ip" },
  // Yahoo cerrando la puerta en 4xx: "421 4.7.0 [TSS04] Messages from 193.181.212.223 temporarily
  // deferred due to unexpected volume or user complaints". 34.524 veces en ese nodo, y nombra
  // NUESTRA IP por escrito. Va antes que el patrón de buzón a propósito: en un receptor que nos
  // difiere por las dos razones (casillas llenas Y volumen), la que habla de nosotros tiene que
  // ganar, o la casilla llena de un tercero taparía la puerta cerrada.
  { patron: /messages from [0-9.]+ temporarily deferred/i, culpa: "ip" },
  // Comcast y Charter cerrando la puerta EN LA CONEXIÓN: "delivery temporarily suspended: host
  // mx2a1.comcast.net[96.103.145.162] refused to talk to me: 554 imp…". Postfix lo anota como
  // `status=deferred` aunque el código sea 5xx, así que es 100% invisible para `delivered + blocked`
  // — el caso que justifica que la puerta se mida en el eje del diferido. ~2.000 líneas en
  // 86.48.29.176 el 2026-08-08, repartidas entre charter.net, comcast.net y wi.rr.com.
  //
  // Va antes que el patrón de buzón por la misma razón que el de Yahoo: Comcast también nos difiere
  // por casillas llenas ("user over quota", 7 líneas), y la casilla de un tercero no puede tapar una
  // puerta que nos cierran a nosotros.
  { patron: /refused to talk to me/i, culpa: "ip" },
  // Buzón inexistente: es del DESTINATARIO, no nuestro. Va último para que un rechazo de política
  // que además mencione un 5.1.1 no se lea como lista sucia. Medido el 2026-08-03: nuestros rebotes
  // son ~99% política y casi cero buzón, así que ver muchos de estos sería noticia.
  { patron: /\b5\.1\.1\b|user unknown|no such user|recipient address rejected/i, culpa: "buzon" },
  // Y LA MISMA FAMILIA EN 4xx, que es la que importa desde que la regla de la puerta mira el
  // diferido. Estos textos también son del destinatario y NO son un receptor cerrándonos la puerta.
  //
  // POR QUÉ HIZO FALTA, medido el 2026-08-08 en annualcorp-control.com: los 864 diferidos hacia
  // Gmail de la ventana son 864 de 864 `452-4.2.2 The recipient's inbox is out of storage space`.
  // Son siete casillas llenas reintentadas ~108 veces cada una. Sin estos patrones la regla de la
  // puerta las contaba como evidencia y publicaba "gmail.com no abre la puerta", que es FALSO —
  // exactamente la clase de afirmación no medida que este módulo existe para no volver a hacer.
  //
  // `4.2.2` es el código estándar de casilla llena (RFC 3463) y `4.1.1` el de dirección inexistente;
  // los textos que van al lado salen del log de los dos nodos y están contados: "out of storage
  // space" 864, "user over quota" 7, "Recipient temporarily unavailable" 107.
  {
    patron: /\b4\.2\.2\b|\b4\.1\.1\b|out of storage space|over quota|recipient temporarily unavailable/i,
    culpa: "buzon"
  }
];

/**
 * Saca los prefijos de continuación que Postfix deja INCRUSTADOS EN LA FRASE.
 *
 * EL DEFECTO, medido el 2026-08-08 y no deducido: el receptor contesta un 550 de varias líneas y
 * cada continuación arrastra su `550-5.7.1 `. Postfix pega todo en UNA línea de log, así que el
 * prefijo queda en el medio de la oración — y DÓNDE cae depende del LARGO DE LA IP, porque la IP va
 * al principio de la respuesta y empuja el corte.
 *
 * El número, contando el log retenido entero de los dos nodos:
 *   · 80.190.76.57 (12 caracteres):    "…reputation of the sending domain."            4.148 veces
 *   · 193.181.212.223 (15 caracteres): "…reputation of the sending 550-5.7.1 domain." 16.253 veces
 *     y "reputation of the sending domain" sin cortar: CERO.
 * O sea que el patrón de la tabla acertaba el 100% en un nodo y el 0% en el otro, por tres
 * caracteres de IP. Ese nodo entero salía `"no-se"` y nadie podía contestar si un dominio nuevo
 * sobre esa IP arreglaba algo — que es la única pregunta que decide si se gasta la plata.
 *
 * DOS PASADAS, no una. Primero se clasifica el texto CRUDO y recién si eso no dijo nada se prueba el
 * normalizado: así ningún patrón que hoy acierta puede empezar a fallar por culpa de esta limpieza.
 * Importa por el buzón: `550-5.1.1 The email account…` matchea `\b5\.1\.1\b` en crudo, y limpiarlo
 * primero le borraría la única evidencia que tiene.
 */
export function sinContinuaciones(motivo: string): string {
  // Solo la forma con GUIÓN (`550-5.7.1`), que es la que el SMTP usa para "sigue otra línea". La
  // forma con espacio (`550 5.1.1`) es la línea final de la respuesta y es justo la que lleva el
  // código que el patrón de buzón necesita leer.
  return motivo.replace(/\d{3}-\d\.\d\.\d\b/g, " ").replace(/\s+/g, " ");
}

export function clasificarCulpa(motivo: string): Culpa {
  for (const texto of [motivo, sinContinuaciones(motivo)]) {
    for (const m of MOTIVOS_DE_CULPA) if (m.patron.test(texto)) return m.culpa;
  }
  return "no-se";
}

/**
 * Cuando un mismo receptor rechaza por varios motivos, gana el que MÁS FRENA LA COMPRA.
 *
 * `ip` le gana a `dominio` a propósito: si un receptor alguna vez nombró la IP, montar un dominio
 * nuevo sobre esa misma IP no lo levanta, y el error caro es el optimista. `buzon` es del
 * destinatario y nunca puede tapar una política.
 */
const PESO_DE_CULPA: Record<Culpa, number> = { ip: 3, dominio: 2, buzon: 1, "no-se": 0 };

/**
 * EL MISMO DESEMPATE PARA EL MAPA DE DIFERIDOS, PERO AL REVÉS DONDE TIENE QUE ESTARLO.
 *
 * El orden de arriba se diseñó para la decisión de COMPRA sobre rechazos 5xx: ahí gana lo más grave,
 * y `buzon` —culpa del destinatario— es lo más leve. Reusarlo tal cual para los 4xx INVIERTE el
 * sentido, porque en la puerta 4xx `buzon` no es el valor leve: es el único valor que ABSUELVE al
 * receptor y APAGA la regla (`culpaDiferida[p] !== "buzon"`). Con el peso viejo, `buzon` (1) le gana
 * a `no-se` (0) y una sola casilla llena decide por todo el receptor.
 *
 * MEDIDO, no razonado. Probe por el camino de producción (bash + `buildDeliveryStatsCommand` sin
 * tocar + líneas crudas del log real, reloj fijo 2026-08-06T12:00Z): 10 mensajes × 8 reintentos
 * contra un MX que ni acepta la conexión (`status=deferred (delivery temporarily suspended: connect
 * to alt4.gmail-smtp-in.l.google.com[...]:25: Connection refused)`, que la tabla clasifica `no-se`)
 * ⇒ `stalled`. Se agrega UN mensaje con `452-4.2.2 The recipient's inbox is out of storage space`
 * ⇒ el receptor entero pasa a `buzon`, la puerta se calla y el veredicto sale **healthy**: once
 * mensajes colgados, 88 líneas, cero entregas, y el nodo vendiendo cupo adentro del pool.
 * Y el archivo afirmaba lo contrario en su propio comentario ("solo `buzon` desactiva la puerta; un
 * `no-se` SÍ cuenta"), que es la peor forma de tenerlo mal.
 *
 * Hoy no está decidiendo mal ningún nodo (barrido pasivo sobre los 64: 0 receptores enmascarados),
 * porque hace falta un texto de puerta que la tabla todavía no conozca. Pero `no-se` es por
 * definición el balde del receptor que no vimos nunca, y la casilla llena es ubicua: la
 * co-ocurrencia llega el día que aparezca un receptor nuevo.
 *
 * `buzon` en 0 y `no-se` en 1, no al revés: el `?? "no-se"` del acumulador hace de centinela, así que
 * si `no-se` fuera el mínimo `buzon` no se escribiría NUNCA y la regla se volvería fail-open al otro
 * lado (ningún diferido de casilla llena podría absolver, y volveríamos a acusar a Gmail por las
 * 864 casillas llenas de annualcorp-control.com). Por eso el desempate compara contra "no vi nada"
 * (`undefined`) y no contra el centinela.
 *
 * DESDE EL 2026-08-08 ES SOLO EL DESEMPATE ENTRE ETIQUETAS QUE PESAN LO MISMO, no la regla. Como
 * MÁXIMO puro decidía por PRESENCIA, y presencia es una unidad que no dice nada cuando un receptor
 * deja cientos de filas: en annualcorp-ops.com, gmail.com difiere 296 líneas de casilla llena y UNA
 * de `421-4.3.0 Temporary System Problem`, y esa sola línea se llevaba el receptor entero a `no-se`
 * ⇒ el sensor publicaba "gmail.com no abre la puerta" sobre siete casillas llenas de terceros. Ver
 * `parseCulpa`: ahora la etiqueta sale por peso de LÍNEAS y esto sólo rompe los empates.
 */
const PESO_DIFERIDO: Record<Culpa, number> = { ip: 3, dominio: 2, "no-se": 1, buzon: 0 };

export type DeliveryHealthStatus =
  | "healthy"
  | "degraded"
  | "blocked_by_provider"
  /**
   * El correo sale pero no llega: casi todo queda diferido.
   *
   * Faltaba, y su ausencia era el peor agujero del modulo. `attempts` era delivered+blocked, o
   * sea que `deferred` NO existia para el veredicto: un nodo con 920 mensajes atascados y cero
   * entregas caia en `no_traffic` — "el nodo no registra trafico saliente" — que es exactamente
   * lo contrario de lo que pasa. Medido en la flota el 2026-07-30: 2.193 diferidos contra 1.504
   * entregados en un solo dia hacia Gmail.
   */
  | "stalled"
  | "no_traffic"
  /**
   * El nodo movió correo y NADA de eso es nuestro.
   *
   * No es `no_traffic` (el log no está vacío) ni `blocked_by_provider` (no medimos NUESTRA
   * entrega): es "no sé", y tiene que existir como estado propio o el "no sé" se disfraza del
   * estado equivocado.
   *
   * QUÉ PASABA SIN ESTE ESTADO, medido el 2026-08-06: al separar el tráfico de NFC, 63 de 64 nodos
   * quedan por debajo de los 20 intentos que exigen BLOCKED_MIN_ATTEMPTS y STALLED_MIN_ATTEMPTS.
   * Si esos 63 devolvieran `no_traffic`, se leerían como dominios recién comprados — y `no_traffic`
   * ENTRA al pool del warmup A PROPÓSITO (plan-diario.ts:200, "un nodo nuevo es el candidato
   * natural a arrancar"). El pool habría saltado de 6 a ~63 y las 14 vueltas del día se habrían
   * repartido entre nodos que NFC ya quemó. Filtrar el ruido sin este estado era peor que no
   * filtrarlo.
   */
  | "no_own_traffic"
  /**
   * HAY RECHAZOS Y NO ALCANZAN PARA JUZGAR. El estado que faltaba, y su ausencia era un fail-open.
   *
   * EL INCIDENTE, 2026-08-07: annualcorp-control.com se leyó `blocked_by_provider` a las 20:05 UTC
   * (165 entregados / 136 rechazados, 99,3% de Gmail, 134 de esos rebotes diciendo textual "very low
   * reputation of the sending domain") y `healthy` a las 23:00 con el MISMO código — la ventana de 5
   * días se comió el 3 de agosto, que aportaba 149 entregas y 135 rechazos, y al nodo le quedó
   * 0 entregados / 1 rechazado a Gmail. Un intento no cruza `BLOCKED_MIN_ATTEMPTS`, el `continue` del
   * loop no anota nada, `blockedProviders` sale `[]` y el último `return` lo pintaba verde con el
   * texto "16 entregados, 1 rechazados". El nodo dejó de mandar PORQUE estaba bloqueado y al quedarse
   * callado se absolvía solo.
   *
   * Medido el 2026-08-08: 23 de los 29 nodos que se leían `healthy` tenían un receptor grande
   * rechazándoles el 100% por debajo del piso. Es la firma de siempre — "no medido" leído como
   * "sano" — la misma del probe que se colgaba (2026-07-29, 10 de 10 falsos) y del "0 blacklist"
   * contra 38 nodos cerrados en Gmail (2026-07-25).
   *
   * NO ES PEGAJOSO, y eso es deliberado: no escribe `blockedProviders`, o sea que no alimenta el
   * `cerradoEn` de sender-measurement, que NO caduca (plan-diario.ts lo dice: "no caduca solo, se
   * olvida borrando cerradoEn a mano"). La asimetría tiene razón de ser: 20 intentos con 90% de
   * rechazo es evidencia fuerte y se arrastra; 1 a 3 rechazos justifican "hoy no", jamás "nunca más".
   * Un dominio recién comprado cuyo primer lote rebote dos veces tiene que poder volver mañana.
   */
  | "insufficient_sample"
  | "unreadable";

export interface DeliveryHealthVerdict {
  status: DeliveryHealthStatus;
  /** Qué periodo cubren los numeros, en los días que se leyeron de verdad. */
  window: string;
  /**
   * LO NUESTRO — o el nodo entero cuando `atribucion.modo === "todo"`. Es lo único que decide el
   * veredicto. No se renombra a propósito: `scripts/ops/deliverability-health.ts` y el panel lo
   * leen por este nombre, y una migración de nombre en el mismo commit que cambia la semántica
   * esconde el cambio que importa.
   */
  stats: NodeDeliveryStats;
  /**
   * Lo que movió el nodo y NO es nuestro (el otro inquilino). Se MUESTRA — es el contexto que
   * explica por qué un dominio está quemado — pero NUNCA entra al veredicto.
   */
  ajenos: NodeDeliveryStats;
  /** Cómo se separó, y cuánto libro había para separarlo. Sin esto nadie puede auditar el número. */
  atribucion: { modo: "nuestro" | "todo"; queueIds: number; descartados: number };
  /**
   * Mensajes en la cola de Postfix AHORA, no en la ventana. `null` = no se pudo leer, que NO es
   * cero: un cero inventado sobre un nodo con 15.693 mensajes trabados lo manda derecho al pool.
   */
  encolados: number | null;
  /** Proveedores donde el nodo está efectivamente cerrado. */
  blockedProviders: string[];
  /** Proveedores con rechazo parcial relevante. */
  degradedProviders: string[];
  /**
   * Receptores que nos rechazaron TODO lo que intentamos y no llegaron al piso para poder acusarlos.
   *
   * Es el veto que impide que la ausencia de veredicto se lea como salud: si esta lista tiene algo,
   * el estado es `insufficient_sample` y nunca `healthy`. Ver ese miembro para el incidente del
   * 2026-08-07 (annualcorp-control.com verde con 136 rechazos de Gmail de hacía cuatro días).
   *
   * VIAJA APARTE DE `blockedProviders` A PROPÓSITO: ese campo es el que sender-measurement persiste
   * como `cerradoEn`, y `cerradoEn` no caduca. Meter acá un dominio con 2 rechazos lo condenaría
   * para siempre por un umbral que no cruzó.
   */
  sinMuestra: string[];
  /**
   * A QUIÉN castiga cada receptor que nos cierra o nos degrada, leído del texto de sus propios
   * rebotes. Una clave por cada nombre de `blockedProviders` y `degradedProviders`, siempre —
   * `"no-se"` cuando el motivo no se pudo clasificar, nunca una clave ausente que el que lee
   * complete con lo que le convenga.
   *
   * Sin este campo, el 2026-08-07 el sistema podía decir "CERRADO en gmail, hotmail, outlook" y no
   * tenía con qué contestar la única pregunta que importaba: ¿un dominio nuevo sobre esta misma IP
   * arregla algo? Ver `Culpa`.
   */
  culpaPorProveedor: Record<string, Culpa>;
  /**
   * Entregas de `stats` que salieron A UN TERCERO: el total menos lo que el nodo se manda a sí mismo
   * (su propio dominio y sus subdominios, por el pipe de rebotes `delivered to command:`).
   *
   * EXISTE PORQUE EL NÚMERO SE CALCULABA Y SE TIRABA. Hasta el 2026-08-08 esta cuenta vivía suelta
   * dentro de la rama `healthy`, sólo para escribir la frase "N entregados a terceros", y el que
   * decide —`plan-diario.ts`, vía `sender-measurement.json`— seguía leyendo `stats.totals.delivered`,
   * que trae las auto-entregas adentro. Resultado medido por SSH contra el nodo real el 2026-08-08:
   * corpfilingcontrol.com (193.181.212.223) con la ventana corrida a 3 días sale `healthy` con
   * "0 entregados a terceros ... (y 6 a sí mismo, que no son entrega)" y ENTRA al pool — sobre un log
   * retenido con 16.525 mensajes rebotados en gmail.com contra 495 entregados, o sea 97% de rechazo.
   * Con ventana de 3 días la flota entera pasaba de 6 boxes a 25, y 19 de esos 25 tenían CERO
   * entregas a terceros: su `healthy` entero se apoyaba en correo que el nodo se manda solo.
   *
   * Y no lo tapaba el guard de auto-entrega que ya existía en plan-diario: ese lee `porReceptor`, que
   * sale filtrado a 20 intentos en sender-measurement.ts y en estos nodos llega VACÍO.
   *
   * Va en el veredicto y no recalculado río abajo porque la regla de qué es "propio" (dominio y
   * subdominios) vive acá; duplicarla en el otro módulo es que se separen sin que nadie se entere.
   */
  entregadosATerceros: number;
  detail: string;
}

export interface DeliveryHealthSshRunner {
  run(input: {
    serverSlug?: string | null;
    serverIp: string;
    command: string;
    timeoutMs?: number;
  }): Promise<{ stdout: string; exitCode: number | null }>;
}

/**
 * Un proveedor cuenta como bloqueado si rechazó al menos esto y casi todo lo intentado.
 *
 * SE MIDIÓ SI HABÍA QUE MOVERLO Y LA RESPUESTA FUE NO, así que queda escrito para que nadie lo
 * vuelva a discutir de memoria. La sospecha era que el dedup por queue-id le había cambiado la
 * UNIDAD (de línea de log a mensaje) y lo había dejado calibrado en la vieja. Medido el 2026-08-08
 * sobre el log retenido de 193.181.212.223: entregado 14.440 líneas / 14.439 mensajes, rechazado
 * 33.554 / 33.553. Factor 1,00 en los dos. Como `attempts = delivered + blocked`, la unidad de ESTE
 * piso no cambió ni un punto, y el ratio que decide el bloqueo tampoco.
 *
 * TAMPOCO SE BAJA. En la flota hay más de veinte mil filas de receptor con algún rechazo y casi
 * todas son typos de una sola línea (`gamil.com`, `yahoo.comm`, `hotmail.con`): con el piso en 1,
 * un dedo equivocado declararía un dominio cerrado. Lo que separa señal de ruido no es el número,
 * es a QUIÉN — un 550 de gmail.com pesa y uno de `yahoo.coom` no pesa nada.
 *
 * LO QUE SÍ HAY QUE SABER, y por eso está acá y no en un informe: con NUESTRO propio volumen este
 * piso es INALCANZABLE. Los seis dominios que hoy calientan movieron a Gmail, en cinco días, 15, 8,
 * 7, 7, 6 y 4 intentos. Ninguno llega a 20. Los veredictos de bloqueo que existen hoy salen del
 * correo de NFC, que se está apagando. Por eso lo que se arregló no es el número sino lo que pasa
 * DEBAJO de él: ver `insufficient_sample`.
 */
export const BLOCKED_MIN_ATTEMPTS = 20;
export const BLOCKED_MIN_RATIO = 0.9;
export const DEGRADED_MIN_RATIO = 0.25;
/**
 * Rechazos mínimos para marcar `degraded` DEBAJO del piso de intentos.
 *
 * No es un umbral nuevo: es el `degraded` más barato que se puede emitir ARRIBA del piso —
 * `BLOCKED_MIN_ATTEMPTS × DEGRADED_MIN_RATIO`, o sea 5 rechazos sobre 20 intentos. Se deriva y no
 * se escribe a mano para que la promesa que hace el clasificador ("abajo del piso la regla no puede
 * ser más dura que arriba") no se pueda romper moviendo uno solo de los dos números.
 *
 * Sin él, 3 entregas y 1 rechazo (4 intentos, 25%) marcaría un dominio sano. Con él hace falta
 * evidencia del mismo tamaño que arriba: 2/17 y 9/10 quedan marcados, 3/1 no.
 */
export const DEGRADED_MIN_RECHAZOS = Math.ceil(BLOCKED_MIN_ATTEMPTS * DEGRADED_MIN_RATIO);
/**
 * Mensajes TRABADOS que hacen falta para declarar al nodo entero atascado por el log.
 *
 * Se recalibró contra la unidad nueva y dio el mismo número, y eso se escribe en vez de callarse:
 * cuando el sensor contaba líneas, 20 líneas de diferido eran ~1,2 mensajes reales (el diferido
 * dedupea 17x en la flota) y el umbral no filtraba nada; ahora son 20 mensajes distintos que no
 * salieron. El rótulo dice lo mismo y mide diez veces más.
 */
export const STALLED_MIN_ATTEMPTS = 20;

/**
 * LÍNEAS DE LOG POR MENSAJE DIFERIDO a partir de las cuales el receptor nos cerró la puerta en 4xx.
 *
 * EL AGUJERO QUE TAPA, con nombre: `attempts` es `delivered + blocked`, o sea que un receptor que
 * nos rechaza SIEMPRE con un código temporal y nunca escribe un `status=bounced` no tiene forma de
 * cruzar ningún piso ni de mover ningún ratio. Es invisible por construcción. Y no es hipotético:
 * Yahoo nos dijo 34.524 veces `421 4.7.0 [TSS04] Messages from 193.181.212.223 temporarily deferred
 * due to unexpected volume or user complaints`, con nuestra IP por escrito, y `blockedProviders`
 * salía `[]`. La tabla de `Culpa` tampoco lo ve, porque solo lee `status=bounced`.
 *
 * POR QUÉ 6, medido el 2026-08-08 y no elegido por lindo. Los anclajes:
 *   · se difiere una vez y sale ............................... 1,0 – 1,5
 *   · mezcla de toda la flota ................................. 17,2
 *   · por receptor en un nodo estrangulado (193.181.212.223):
 *       aol 11,0 · yahoo 12,8 · gmail 101,4
 *   · mensajes que nunca salieron ............................. 106,7
 * Entre 1,5 y 11 no hay NADA. 6 cae en el hueco de la distribución, no en una pendiente, así que
 * moverlo un punto para cualquier lado no cambia un solo veredicto. Físicamente: con el
 * `minimal_backoff` de 300 s de Postfix, seis reintentos promedio son horas de puerta cerrada.
 *
 * Es una PERILLA, no una constante: se mueve por entorno el día que la física de la flota cambie,
 * igual que `DELIVERY_STATS_WINDOW_DAYS`. El piso de 1,5 del validador no es capricho — abajo de eso
 * "se difirió una vez" pasaría por "puerta cerrada" y el sensor acusaría a medio mundo.
 */
export function resolverPresionBloqueo(raw: string | undefined): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n >= 1.5 && n <= 100 ? n : 6;
}
export const PRESION_BLOQUEO = resolverPresionBloqueo(process.env.SMTP_PRESION_BLOQUEO);

/**
 * Mensajes trabados con UN receptor que hacen falta para acusarlo de tener la puerta cerrada.
 *
 * `atascados = max(0, deferred − delivered − blocked)` es una COTA INFERIOR a propósito: un mensaje
 * que se difirió y después salió aparece en las dos cuentas (cada estado se dedupea por separado,
 * no hay desempate), así que restarlo SUBESTIMA lo trabado y nunca lo infla. Sub-contar es el lado
 * seguro para una regla que solo puede sacar nodos del pool.
 *
 * Cinco y no veinte porque la evidencia acá se mide en el otro eje: 5 mensajes × 6 reintentos son 30
 * intentos de entrega, todos colgados. Es MÁS evidencia que los 20 intentos que exige
 * `BLOCKED_MIN_ATTEMPTS`, no menos — la regla no es más laxa, mide donde el dato existe.
 */
export const ATASCADOS_MIN = 5;

/**
 * Encolados AHORA a partir de los cuales el nodo está atascado, gane lo que gane el log.
 *
 * Calibrado sobre la foto de la flota del 2026-08-06: 9 nodos tenían entre 7.306 y 15.693 mensajes
 * en cola y 20 tenían 5 o menos. No hay UN solo nodo entre 50 y 300, así que el umbral no es
 * delicado — cae en un hueco enorme de la distribución. Igual es una perilla: si la distribución
 * cambia (nodos chicos con colas de cientos por diseño) hay que volver a mirarla.
 */
export const COLA_ATASCADA_MIN = 500;

/**
 * A QUIÉN se le atribuye el tráfico del log.
 *
 * `readonly string[]` = los queue-ids de NUESTROS envíos, sacados de `warmup_activity`. Todo lo que
 * no esté en esa lista es del otro inquilino.
 * `"todo"` = no se atribuye nada, los números son del nodo entero. Es lo correcto para un
 * diagnóstico de máquina (`scripts/ops/deliverability-health.ts`), y una mentira para un veredicto
 * de NUESTRA reputación.
 *
 * POR QUÉ EXISTE ESTA DECISIÓN, con el número: por los mismos 58 nodos SMTP pasa el correo de NFC,
 * otro producto con otros clientes, que inyecta por 587 con SASL. Medido el 2026-08-06 sobre el log
 * retenido de los 64 nodos: 791.300 mensajes de NFC contra 222 nuestros (0,028%). O sea que el
 * 99,97% de la evidencia con la que este módulo declaraba `healthy` / `blocked_by_provider` /
 * `stalled` era reputación que quemó otro producto, publicada como medición nuestra en
 * `sender-measurement.json`, en `GET /v1/sender-measurement`, en la tool `read_sender_measurement`
 * del agente y en el panel.
 *
 * Y OJO CON EL DISCRIMINANTE, porque el obvio NO funciona: no alcanza con mirar `sasl_username` ni
 * el remitente. Los dos inquilinos autentican con el MISMO buzón (`mailer@<dominio>`) — medido en
 * nationalfiling-infra.com: 22.597 mensajes de NFC y 2 nuestros, todos con
 * `sasl_username=mailer@nationalfiling-infra.com`. Tampoco sirve "el warmup entra por sendmail
 * local": ese es el camino VIEJO (30 mensajes en toda la flota, último uso 31/07); el daemon que
 * corre hoy entra por 587 con SASL igual que NFC. Y el `client=` (EC2 = NFC) es una observación de
 * hoy, no una garantía: si NFC muda su emisor, deja de discriminar en silencio y sin error.
 *
 * Lo único robusto es NUESTRO PROPIO LIBRO: la respuesta 250 de Postfix trae el queue-id
 * ("250 2.0.0 Ok: queued as B7CA03F69F") y el daemon ya la guarda. La identificación es POSITIVA
 * — nuestro = está en el libro; todo lo demás = no nuestro — así que no depende de ninguna decisión
 * de NFC, y lo que no se puede atribuir cae del lado seguro (sub-cuenta lo nuestro, nunca lo
 * infla).
 */
export type ModoAtribucion = readonly string[] | "todo";

/**
 * Techo de queue-ids que se mandan dentro del comando. Nuestro máximo real por nodo y ventana,
 * medido contra la base de producción el 2026-08-06, es 13. 500 es dos órdenes de margen.
 *
 * Arriba de eso NO se atribuye a ciegas: se devuelve `unreadable`. Un libro que creció 40x es un
 * cambio de régimen que nadie previó (¿el warmup se disparó? ¿alguien mezcló dominios?), y seguir
 * armando una línea de shell de 50 KB con datos que vienen de una columna JSON no es "degradarse
 * con gracia", es adivinar.
 */
export const MAX_QUEUE_IDS = 500;

/**
 * BORDE DE CONFIANZA. Estos ids salen de `warmup_activity.detail->>'smtp'`, una columna JSON de
 * Postgres, y terminan DENTRO de una línea de shell que corre por SSH en 58 nodos de producción.
 * Entre esos dos puntos no hay ninguna otra validación: esta es la única.
 *
 * `[A-Za-z0-9]{4,20}` es exactamente la forma de un queue-id de Postfix en la flota: hex corto
 * (`B7CA03F69F`) y base-52 de `enable_long_queue_ids` (`4bXyZ9Qm2Rz1kT`). Cualquier cosa con
 * comilla, `;`, `$(`, espacio o `|` no matchea y se DESCARTA — no se escapa, no se cita, se tira.
 * Escapar es una lista de casos que alguien olvida; una lista blanca de dos clases de caracteres no
 * tiene casos que olvidar.
 *
 * `descartados` se devuelve y viaja al veredicto a propósito: un id que se cae es correo nuestro
 * que vamos a contar como ajeno, y eso tiene que ser visible, no silencioso.
 */
export function sanearIds(ids: readonly string[]): { ok: string[]; descartados: number } {
  const ok = [...new Set(ids.filter((s) => /^[A-Za-z0-9]{4,20}$/.test(s)))];
  return { ok, descartados: ids.length - ok.length };
}

/**
 * Comando de lectura. Sale SIEMPRE 0 y marca el fin de la salida: un exit distinto de
 * cero lo convierte el runner en excepción, y ahí "no pude leer" se disfrazaría de
 * "no hay problemas". Misma regla que el probe de propiedad.
 *
 * `propios` va PRIMERO y sin default: la atribución es una decisión, no una opción. Un default
 * silencioso ("si no me decís, cuento todo") es exactamente la forma en que vuelve el bug que este
 * cambio arregla — nadie escribe `propios: "todo"` por error, pero todos se olvidan de un campo
 * opcional.
 *
 * `logDir` existe SOLO para que el test pueda correr este mismo comando de verdad contra un
 * directorio de fixtures: en producción nadie lo pasa. Es la lección del fixture de Bedrock — un
 * test escrito sobre mi suposición de cómo se ve la salida comparte el error con el código y no
 * salva de nada; este corre por el camino de producción.
 */
export function buildDeliveryStatsCommand(
  propios: ModoAtribucion,
  dias = DELIVERY_STATS_WINDOW_DAYS,
  logDir = "/var/log",
  ahora = new Date()
): string {
  // En modo "todo" no se manda ni un id: el awk cuenta el total y la sección OWN sale vacía, y es
  // TypeScript el que después iguala propio = total. Cero ramas nuevas dentro del shell, que es
  // donde no hay tipos ni tests unitarios que sostengan una bifurcación.
  const idsAwk = propios === "todo" ? "" : sanearIds(propios).ok.join(" ");
  // El corte por DÍA, aplicado a la línea. Va primero en el pipe porque es el que más descarta.
  const enVentana = `grep -E "^(${prefijosDeDias(dias, ahora).join("|")})"`;
  // Un mensaje cuenta UNA vez, no una por reintento — Y ADEMÁS SE DICE CUÁNTAS LÍNEAS DEJÓ.
  //
  // Contar líneas era el 16x de inflación que condenaba nodos sanos: Postfix escribe una línea
  // `status=deferred` por CADA reintento del MISMO queue-id, así que un puñado de mensajes trabados
  // producía cientos de "intentos" y el ratio de diferidos se iba arriba del 50% solo. Y se dedupean
  // los TRES estados, no solo el diferido: deduplicar únicamente el numerador dejaría el ratio
  // comparando mensajes contra intentos y aflojaría el clasificador al revés.
  //
  // PERO DEDUPLICAR TIRABA LA SEÑAL DEL 4xx. `sort -u` contestaba "cuántos mensajes" y borraba
  // "cuánto costó cada uno", que es exactamente el dato que delata al receptor que nos difiere sin
  // rebotar nunca (Yahoo, 34.524 líneas `421 4.7.0 [TSS04]` con nuestra IP adentro). `sort | uniq -c`
  // trae las DOS unidades del MISMO recorrido: el awk lleva un acumulador de mensajes y otro de
  // líneas, y emite `<mensajes>/<lineas> <dominio>`. Cero pasadas nuevas sobre los .gz, tres
  // caracteres de shell.
  //
  // Que salgan de la MISMA pasada no es elegancia: dos lecturas separadas pueden divergir, y eso ya
  // pasó — el 2026-08-07 el mismo nodo dio 165/136 y 16/1 con el MISMO código, solo porque las dos
  // corridas cayeron a los dos lados de la medianoche UTC y la ventana soltó el 3 de agosto.
  //
  // `split($1,f," ")` y NO asignarle a `$1`: con `-F'\t'`, `uniq -c` deja `<cuenta> <queue-id>` en el
  // primer campo y el dominio en el segundo. Tocar `$1` haría que awk reconstruya el registro con
  // OFS y se lleve puesto el tabulador que separa los campos.
  //
  // El queue-id se saca con `[^ :]+` y NO con el `[0-9A-Fa-f]{6,}` del módulo de volumen: medido
  // contra el fixture, el patrón hex pierde `4bXyZ9Qm2Rz1kT`, que es la forma que tienen los nodos
  // con `enable_long_queue_ids` (base-52). Copiar el hex habría dejado el sensor en cero justo ahí.
  //
  // LA MISMA PASADA CUENTA DOS VECES: total del nodo y lo NUESTRO. No se agrega ni un `zcat` más
  // (ya son cuatro pasadas sobre los .gz de un nodo que puede tener 60.000 mensajes retenidos); el
  // awk del final lleva dos acumuladores y emite él mismo el marcador de la sección propia.
  //
  // El `END` de awk corre AUNQUE NO ENTRE NI UNA LÍNEA, así que el marcador `## OWN_*` existe
  // siempre que el comando haya llegado a correr. Esa garantía es la que le permite al parser tratar
  // su AUSENCIA como "no entiendo esta salida" en vez de como "no hay nada nuestro" — la diferencia
  // entre `unreadable` y convertir la flota entera en `no_own_traffic` sin que nadie se entere.
  const pipeline = (status: string, seccionPropia: string): string =>
    `[ -n "$READ" ] && $READ $LOGS 2>/dev/null | ${enVentana} | grep "status=${status}"` +
    " | grep -oE '\\]: [^ :]+: to=<[^>]*@[^>]*>'" +
    // OJO: el separador del sed es un TABULADOR REAL (el `\t` de este literal de JS emite el
    // carácter). El sed de BSD — el de esta Mac, donde corre el test de integración — no interpreta
    // `\t` en el reemplazo y devolvería una `t` literal; el de GNU sí. Un tab real anda en los dos.
    ` | sed -E 's/^\\]: ([^ :]+): to=<[^>]*@([^>]*)>/\\1\t\\2/'` +
    " | sort | uniq -c" +
    ` | awk -F'\\t' -v ids='${idsAwk}' '` +
      'BEGIN{n=split(ids,a," ");for(i=1;i<=n;i++)m[a[i]]=1}' +
      '{split($1,f," ");p=tolower($2);t[p]++;lt[p]+=f[1];if(f[2] in m){o[p]++;lo[p]+=f[1]}}' +
      `END{for(p in t)printf "%d/%d %s\\n",t[p],lt[p],p;print "## ${seccionPropia}";for(p in o)printf "%d/%d %s\\n",o[p],lo[p],p}'` +
    " || true";

  return [
    "set -u",
    // El lector del log, resuelto en el nodo.
    //
    // /var/log/mail.log es `-rw-r----- syslog:adm`: el usuario ops NO lo lee sin sudo, y el
    // runner usa root en Contabo pero delivrixops en Webdock. Sin esto el comando salia con
    // exit 0 y CERO lineas, que el parser leia como "no hay trafico" — en un nodo que manda
    // 1.300 mensajes/dia. Es el mismo modo de falla que ya aparecio tres veces esta semana:
    // el sensor no fallaba, miraba donde no habia nada.
    //
    // Si no se puede leer de ninguna forma, se dice: ## NOACCESS. Nunca vacio.
    `if sudo -n test -r ${logDir}/mail.log 2>/dev/null; then READ="sudo -n zcat -f";` +
      ` elif test -r ${logDir}/mail.log; then READ="zcat -f";` +
      ' else echo "## NOACCESS"; READ=""; fi',
    // El `find -mtime` elige QUÉ ARCHIVOS abrir, y nada más. Acotar la ventana con él era el
    // defecto: un rotado semanal que se toca hoy trae adentro los siete días que acumuló, así que
    // la ventana era N días más un ciclo de rotación y cambiaba con el día de la semana. Lo que
    // acota los DÍAS ahora es `enVentana`, sobre la fecha de cada línea.
    //
    // Lo que sí sigue haciendo, y por eso no se saca: cierra el año fantasma. El syslog no escribe
    // el año, así que un `Aug  6` de hace doce meses matchearía el prefijo de hoy — pero ese
    // archivo ni se ABRE, y el sistema de archivos resuelve gratis lo que en awk sería un parser.
    //
    // `dias + 1` y no `dias`: el filtro fino ya lo hace la línea, así que el archivo se elige con
    // margen. Al revés (elegir justo) un rotado del borde se perdería con líneas que sí entraban.
    //
    // `-mtime` y no `-newermt`: `-mtime` es POSIX y anda igual en el find de los nodos y en el de
    // esta Mac; `-newermt '-5 days'` acá falla con "Invalid timestamp" (bfs) y volvería imposible el
    // test de integración.
    //
    // El log corriente entra SIEMPRE, sin depender de find: el probe de arriba acaba de verificar
    // que existe. Si find no está o falla, se lee igual el de hoy — ventana más corta, jamás un cero
    // fantasma. Este módulo ya se quemó tres veces con "comando que devuelve vacío" leído como "no
    // hay tráfico".
    `LOGS="${logDir}/mail.log $(find ${logDir} -maxdepth 1 -name 'mail.log.*' -mtime -${dias + 1} 2>/dev/null | tr '\\n' ' ')"`,
    // El seguro del filtro por fecha: cuántas líneas de entrega NO empiezan con ninguno de los dos
    // formatos que la flota sabe escribir.
    //
    // Hace falta porque el filtro por prefijo es fail-OPEN hacia abajo: un tercer formato que no
    // conocemos no da error, da CERO — y cero se lee `no_traffic`, que desde el arreglo del onboarding
    // es un estado que ENTRA al pool. O sea que un nodo ciego se leería como nodo nuevo. Con esto,
    // ciego se lee `unreadable`, que es lo que es.
    //
    // Mira solo el log corriente y no `$LOGS`: para saber en qué formato escribe ESTE nodo alcanza
    // con un archivo, y así el seguro no cuesta una pasada más sobre los .gz.
    "echo '## SINFECHA'",
    `[ -n "$READ" ] && $READ ${logDir}/mail.log 2>/dev/null | grep 'status=' | grep -cvE '^([A-Z][a-z][a-z] [ 0-9][0-9] |[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T)' || true`,
    "echo '## DELIVERED'",
    pipeline("sent", "OWN_DELIVERED"),
    "echo '## BLOCKED'",
    pipeline("bounced", "OWN_BLOCKED"),
    "echo '## DEFERRED'",
    pipeline("deferred", "OWN_DEFERRED"),
    // EL TEXTO DEL RECHAZO, que es el dato que decide si se gasta plata. Ver `Culpa` arriba para el
    // incidente del 2026-08-07: el sistema entero sabía QUIÉN nos cierra la puerta y nunca POR QUÉ,
    // y esa diferencia separa "comprá un dominio nuevo" de "no gastes un peso".
    //
    // VA AFUERA DE `pipeline()` a propósito. Ahí adentro no hay tipos ni tests unitarios que
    // sostengan una bifurcación, y esto no es una cuarta pasada del mismo molde: no cuenta mensajes,
    // no dedupea por queue-id, no tiene sección propia. Un `if status==bounced` metido adentro sería
    // exactamente la rama nueva que el comentario de arriba prohíbe.
    //
    // NO SE ATRIBUYE POR QUEUE-ID, y es deliberado: si Microsoft tiene esta IP en su lista S3150,
    // da igual que el mensaje que se lo hizo decir fuera de NFC — la IP es una sola y nuestro correo
    // choca con la misma pared. Es el mismo razonamiento que la cola de Postfix (física y
    // compartida), no un olvido.
    //
    // `sed -n … p` imprime SOLO las líneas que matchearon: una línea rara que no calce entra al
    // parser como basura, y basura en una sección nueva es la forma más barata de romper un sensor
    // que ya se quemó tres veces con "salida vacía leída como sin tráfico".
    //
    // `tr -d '#'` es BORDE DE CONFIANZA, no cosmética: este texto lo escribe el servidor del OTRO
    // LADO. Cualquiera que reciba correo nuestro puede contestar "550 ## END" y, sin esto, cortarle
    // la salida al parser desde afuera. Se borra la clase entera de caracteres en vez de escapar
    // casos, misma regla que `sanearIds`.
    //
    // `cut -c1-200`: el recorte saca parte de la cola variable (URLs de ayuda, "in reply to …").
    // 200 entra con margen para lo que el clasificador necesita — la frase de Gmail cortada por el
    // wrap cierra en el carácter 165 y la de Microsoft, la más larga, en 191, así que ACORTARLO NO
    // ES OPCIÓN: en 191 se pierde la lista S3150 y Microsoft entero pasa a `"no-se"`.
    //
    // Y ACÁ ESTABA UNA AFIRMACIÓN FALSA, medida el 2026-08-08 contra el log real: este comentario
    // decía que el recorte se lleva "los ids de sesión". Para el 452 de Gmail NO se los lleva. La
    // línea cruda, bajada de annualcorp-ops.com:
    //   452-4.2.2 The recipient's inbox is out of storage space. Please direct the 452-4.2.2
    //   recipient to 452 4.2.2  https://support.google.com/mail/?p=OverQuotaTemp
    //   a1e0cc1a2514c-977e6b2b7e7si1120678241.286 - gsmtp (in reply to RCPT TO command)
    // El id arranca en el carácter ~158 y entra ENTERO adentro de los 200. O sea: una fila distinta
    // POR MENSAJE. Medido, ese solo hecho le da a gmail.com 217 filas en nationalcorpops.com y 260
    // en annualcorp-ops.com — más filas que el techo global entero. De ahí salen las dos reglas de
    // abajo (techo por receptor y voto por peso), que es lo que vuelve inofensivo el recorte.
    //
    // EL TECHO SE ORDENA POR FRECUENCIA, y eso NO es cosmética. Con solo rebotes había 3 a 12 filas
    // distintas por nodo y cualquier `head` alcanzaba. Al sumar el diferido son 764 y 989 (medido en
    // los dos nodos el 2026-08-08), porque el correo de NFC toca miles de dominios receptores. Un
    // `head` sobre la salida ordenada ALFABÉTICAMENTE cortaba en la letra que fuera y se comía filas
    // que importaban — y así, con la primera versión de este cambio, corpfilingcontrol.com publicó
    // "gmail.com no abre la puerta" cuando sus 1.026 diferidos de Gmail eran 1.026 de 1.026 casillas
    // llenas: la fila que lo desmentía se había caído por el corte.
    //
    // ── Y EL TECHO GLOBAL SEGUÍA DECIDIENDO VEREDICTOS. Medido, no razonado ─────────────────────
    //
    // Ordenar por frecuencia arregló el corte alfabético y dejó vivo el modo de falla de al lado: UN
    // RECEPTOR RUIDOSO DESALOJA A OTRO. Barrido pasivo del 2026-08-08 sobre nationalcorpops.com con
    // el pipeline textual de producción: 680 filas distintas, techo 200 ⇒ se tiran 480, y SIETE
    // receptores pierden TODAS sus filas (centurytel.net, centurylink.net, allianceflgroup.com…).
    // Un receptor sin ninguna fila sale `culpaDiferido[x]` ausente ⇒ `?? "no-se"` ⇒ la puerta 4xx
    // DISPARA sobre algo que no se midió. Y en el truncado PARCIAL el error va para el otro lado:
    // annualcorp-ops.com sale `insufficient_sample` CON el techo y `stalled` ("gmail.com no abre la
    // puerta") SIN el techo, porque la fila que se cae es la única línea `421-4.3.0` que le gana por
    // desempate a 296 líneas de casilla llena. O sea que el techo estaba ABSOLVIENDO por suerte de
    // ranking, justo al revés de lo que decía este comentario.
    //
    // EL TECHO VA POR RECEPTOR Y EL CORTE VA POR TURNOS. Dos etapas, las dos baratas:
    //   1. cinco filas por RECEPTOR **Y ESTADO** (`c[receptor,status]`), no por receptor a secas.
    //      Cinco y no una porque el voto de abajo pesa líneas y necesita ver la mezcla, no sólo la
    //      fila más grande. Medido: nationalcorpops.com pasa de 680 filas a 158, y las etiquetas de
    //      sus 51 receptores con diferido salen IDÉNTICAS a las de la salida completa sin techo —
    //      contra 7 receptores sin ninguna etiqueta hoy.
    //      EL `status` EN LA CLAVE NO ES DETALLE: de esta sección salen DOS mapas con dos usos
    //      (`culpa` decide si comprar un dominio nuevo sirve; `culpaDiferido` sólo apaga la puerta).
    //      Con la clave por receptor pelada, en los nodos de NFC las filas de diferido —que son las
    //      de más volumen— se comían la cuota del receptor y sus rebotes 5xx no entraban: medido,
    //      13 receptores perdían su culpa de rechazo y `culpaPorProveedor` publicaba "no-se" donde
    //      antes decía "dominio" o "ip". Es el campo que decide una compra: no puede degradarse
    //      como efecto colateral de un techo.
    //   2. el `head` corta POR TURNOS Y POR VOLUMEN DE RECEPTOR, nunca por la cuenta de una fila
    //      suelta. El awk le pega a cada fila dos números: qué turno es (su 1ª, 2ª… fila de ese
    //      receptor) y el TOTAL de líneas de su receptor. El sort ordena turno ascendente y total
    //      descendente, así que primero entra la 1ª fila de cada receptor —los más grandes primero—
    //      y sólo cuando hay lugar entran las segundas. Consecuencias medidas:
    //        · un receptor ruidoso no puede borrar a otro: hacen falta 200 receptores DISTINTOS para
    //          que el 201 se quede sin nada, en vez de UNO con 217 filas propias.
    //        · centurytel.net, con 36 líneas en 28 filas de a una, deja de perderlo todo detrás de un
    //          receptor con una sola fila de 40 líneas.
    //        · en la flota, los pares receptor/nodo sin ninguna etiqueta bajan de 1.828 a 230, y los
    //          230 que quedan son la cola larga de los nodos de NFC (3.654 receptores en uno solo).
    // `-s` (estable) para que dentro del mismo turno y volumen se conserve el orden por líneas.
    //
    // `split($1,f," ")` por lo mismo que el awk de arriba: con `-F'\t'`, `uniq -c` deja
    // `<cuenta> <receptor>` pegados en el primer campo, así que la clave es `f[2]` y no `$1`. Los dos
    // números viajan adelante y el `cut -f3-` los saca antes de que lo vea el parser.
    //
    // El awk BUFFEREA (≤5 filas por receptor) porque el total de un receptor recién se sabe al final
    // del stream. En el nodo más grande de la flota son 3.654 receptores y 14.072 filas crudas ⇒
    // ~9.000 filas guardadas, unos 2 MB en memoria del awk del nodo. Barato al lado de las cuatro
    // pasadas de zcat que ya hace el comando.
    //
    // ponytail: 200 filas es un techo de TRANSPORTE, no de medición: en los nodos de NFC (3.654
    // receptores) los de cola larga siguen quedando sin etiqueta, y ausencia se lee `"no-se"`, que
    // frena en vez de absolver. Si algún día un receptor de cola larga tiene que poder ABSOLVER,
    // esto sube a 1.000 (200 KB por nodo) o se filtra por líneas mínimas en el propio awk.
    //
    // LA CUENTA DE `uniq -c` YA NO SE TIRA: antes un `sed` final la borraba y el parser leía
    // `<receptor>\t…` sin saber cuántas líneas había atrás de cada fila. Esa cuenta es la que
    // convierte el desempate por etiqueta (donde UNA línea sin clasificar le gana a 296 de casilla
    // llena) en un voto por peso. Ver `parseCulpa`.
    //
    // EL DIFERIDO TAMBIÉN, y en la MISMA pasada — pero en columnas separadas, no revuelto.
    //
    // Antes esto solo leía `status=bounced` y el comentario declaraba el punto ciego: "la culpa de un
    // receptor que solo nos difiere (Yahoo con su 421) hoy no se lee". Desde que existe la regla de
    // la puerta 4xx ese punto ciego dejó de ser aceptable EN LAS DOS DIRECCIONES:
    //   · Yahoo nos dijo 34.524 veces `421 4.7.0 [TSS04] Messages from 193.181.212.223 temporarily
    //     deferred`, con nuestra IP adentro, y era invisible.
    //   · Y al revés: annualcorp-control.com tiene 864 diferidos hacia Gmail y los 864 son
    //     `452-4.2.2 The recipient's inbox is out of storage space` — siete casillas llenas, no una
    //     puerta cerrada. Sin leer el motivo, la regla nueva habría publicado "gmail.com no abre la
    //     puerta" sobre un hecho que no midió.
    //
    // El `status` viaja como SEGUNDA COLUMNA y el parser guarda dos mapas: el de rechazos alimenta
    // `culpaPorProveedor` con exactamente la semántica de antes (solo 5xx) y el de diferidos solo
    // sirve para desactivar la puerta. La advertencia vieja sigue en pie y por eso están separados:
    // un 4xx no significa lo mismo que un 5xx y mezclarlos los leería como bloqueos permanentes.
    "echo '## CULPA'",
    `[ -n "$READ" ] && $READ $LOGS 2>/dev/null | ${enVentana} | grep -E 'status=(bounced|deferred)'` +
      // Y EL ID DE SESIÓN DE GMAIL SE VA ANTES DE AGRUPAR. Es la única cola variable que el
      // `cut -c1-200` NO alcanza a cortar —arranca alrededor del carácter 158 y entra entera—, y por
      // sí sola multiplica las filas por mensaje: medido el 2026-08-08, gmail.com deja 217 filas
      // distintas en nationalcorpops.com y 260 en annualcorp-ops.com, más que el techo entero de la
      // sección. Sin esto `uniq -c` cuenta 296 veces "1 mensaje" en vez de una vez "296 líneas", y el
      // voto por peso de `parseCulpa` se queda sin la unidad que necesita.
      //
      // El patrón es el de Gmail (`<id> - gsmtp`) porque Gmail es el ÚNICO receptor de la flota con
      // esta forma, contado: los demás repiten el mismo texto y ya agrupaban bien. Para los que
      // vengan, el techo por receptor de abajo acota el daño sin conocerlos.
      ` | sed -n -E -e 's/host [^ ]+ said: //' -e 's/ [A-Za-z0-9._-]{6,} - gsmtp.*$//'` +
      ` -e 's/^.*to=<[^>]*@([^>]*)>.*status=(bounced|deferred) \\((.*)$/\\1\t\\2\t\\3/p'` +
      " | tr -d '#' | cut -c1-200 | sort | uniq -c | sort -rn" +
      ` | awk -F'\\t' '{split($1,f," ");r=f[2] SUBSEP $2;t[r]+=f[1];if(++c[r]<=5){k[++m]=r;o[m]=c[r];l[m]=$0}}` +
      ` END{for(i=1;i<=m;i++)printf "%d\\t%d\\t%s\\n",o[i],t[k[i]],l[i]}'` +
      // OJO: el separador de `sort -t` es un TABULADOR REAL, igual que en el sed de arriba y por el
      // mismo motivo (el sort de BSD, el de esta Mac donde corre el test de integración, no
      // interpreta `\t`).
      " | sort -s -t'\t' -k1,1n -k2,2rn | head -n 200 | cut -f3- || true",
    // La respuesta DIRECTA a "¿está atascado HOY?": una línea, sin fechas, sin parser, sin escanear
    // un solo log. El log dice qué pasó en la ventana; la cola dice qué está pasando ahora mismo.
    // Si postqueue no existe o no se puede correr no imprime nada, y eso se lee como "no sé" —
    // nunca como cola limpia.
    "echo '## QUEUE'",
    "{ sudo -n postqueue -p 2>/dev/null || postqueue -p 2>/dev/null || true; } | tail -1",
    "echo '## END'"
  ].join("\n");
}

function section(text: string, name: string): string {
  const start = text.indexOf(`## ${name}`);
  if (start === -1) return "";
  const rest = text.slice(start + `## ${name}`.length);
  const next = rest.indexOf("## ");
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/**
 * `<mensajes>/<lineas> <dominio>` → las dos cuentas por receptor.
 *
 * TOLERANTE CON EL FORMATO VIEJO A PROPÓSITO: `12 gmail.com`, sin la barra, se lee como 12 mensajes
 * y 12 líneas. O sea presión 1,0, o sea que la regla de la puerta 4xx se calla sola y el veredicto
 * sale idéntico al de antes del cambio.
 *
 * Por qué importa: entre que esto se despliega y que cada uno de los 58 nodos corre el comando nuevo
 * hay una ventana con las dos formas conviviendo. Exigir la barra convertiría a la flota entera en
 * `unreadable` durante esa ventana, que es la cuarta repetición del único modo de falla que este
 * archivo ya documenta tres veces: "comando que devuelve algo raro" leído como un desastre. Un campo
 * que todavía no viene es un campo con el valor conservador, no un sensor roto.
 */
function counts(text: string): Map<string, { msgs: number; lineas: number }> {
  const out = new Map<string, { msgs: number; lineas: number }>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)(?:\/(\d+))?\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    const provider = m[3]!.toLowerCase().replace(/\.$/, "");
    const msgs = Number(m[1]);
    const previo = out.get(provider) ?? { msgs: 0, lineas: 0 };
    out.set(provider, {
      msgs: previo.msgs + msgs,
      lineas: previo.lineas + (m[2] === undefined ? msgs : Number(m[2]))
    });
  }
  return out;
}

/** NOACCESS = no se pudo leer el log. Distinto de "no hubo trafico". */
export function deliveryStatsUnreadable(stdout: string): boolean {
  return stdout.includes("## NOACCESS");
}

/**
 * Líneas de entrega escritas en un formato de fecha que el filtro de ventana no reconoce.
 *
 * `0` = el nodo escribe en syslog o en ISO-8601 y el corte por día lo lee entero. Cualquier otro
 * número = el sensor está CIEGO a parte del log de ese nodo, y sus totales no significan nada.
 * `null` = ni eso se pudo contar (salida vieja o truncada), que tampoco es cero.
 */
export function parseLineasSinFecha(stdout: string): number | null {
  const m = /^\s*(\d+)\s*$/m.exec(section(stdout, "SINFECHA"));
  return m ? Number(m[1]) : null;
}

/**
 * Cuántos mensajes hay trabados en la cola AHORA. `postqueue -p` tiene tres finales posibles y los
 * tres significan cosas distintas:
 *   · "Mail queue is empty"            → 0 de verdad, el nodo está limpio.
 *   · "-- 107250 Kbytes in 15710 Requests." → ese número.
 *   · nada / cualquier otra cosa       → NO SÉ, y eso es `null`, jamás 0.
 *
 * El tercero es el que importa: el 2026-07-29 un probe que se colgaba devolvió "bloqueado" falso en
 * 10 de 10 nodos, y la lección fue que un sensor que no puede leer dice "no sé". Un cero inventado
 * acá metería al pool un nodo con 15.693 mensajes atascados.
 */
export function parseQueueSize(stdout: string): number | null {
  const raw = section(stdout, "QUEUE");
  if (/Mail queue is empty/i.test(raw)) return 0;
  const m = /in\s+(\d+)\s+Request/i.exec(raw);
  return m ? Number(m[1]) : null;
}

type Cuenta = Map<string, { msgs: number; lineas: number }>;
const CERO = { msgs: 0, lineas: 0 } as const;

function armar(delivered: Cuenta, blocked: Cuenta, deferred: Cuenta): NodeDeliveryStats {
  const providers = new Set([...delivered.keys(), ...blocked.keys(), ...deferred.keys()]);
  const byProvider = [...providers]
    .map((provider) => {
      const d = delivered.get(provider) ?? CERO;
      const b = blocked.get(provider) ?? CERO;
      const f = deferred.get(provider) ?? CERO;
      return {
        provider,
        delivered: d.msgs,
        blocked: b.msgs,
        deferred: f.msgs,
        intentos: { delivered: d.lineas, blocked: b.lineas, deferred: f.lineas }
      };
    })
    .sort((a, b) => (b.delivered + b.blocked) - (a.delivered + a.blocked));

  const sum = (m: Cuenta, campo: "msgs" | "lineas"): number =>
    [...m.values()].reduce((a, b) => a + b[campo], 0);
  return {
    totals: { delivered: sum(delivered, "msgs"), blocked: sum(blocked, "msgs"), deferred: sum(deferred, "msgs") },
    intentos: { delivered: sum(delivered, "lineas"), blocked: sum(blocked, "lineas"), deferred: sum(deferred, "lineas") },
    byProvider
  };
}

/** Las líneas de un recuento, o los mensajes cuando el nodo todavía no las manda. Ver `counts()`. */
function lineasDe(c: { delivered: number; blocked: number; deferred: number }, intentos?: DeliveryCounters): DeliveryCounters {
  return intentos ?? { delivered: c.delivered, blocked: c.blocked, deferred: c.deferred };
}

/**
 * `<cuenta> <receptor>\t<status>\t<motivo>` → un veredicto de culpa por receptor.
 *
 * DELIBERADAMENTE FUERA DEL CHEQUEO DURO de `parseDeliveryStats`: si la sección `## CULPA` no está
 * (un nodo con la versión vieja del comando, una salida cortada antes de tiempo) esto devuelve `{}`
 * y el veredicto sale IDÉNTICO al de hoy. Sumar `## CULPA` a la lista de secciones obligatorias
 * convertiría 58 nodos en `unreadable` el día del despliegue, que es la cuarta repetición del único
 * modo de falla que este archivo ya documenta tres veces ("comando vacío leído como sin tráfico").
 * Un campo nuevo que no sabemos llenar es un campo vacío, no un sensor roto.
 *
 * La clave se normaliza igual que en `counts()` (minúscula, sin punto final) o no cruzaría con los
 * nombres de `byProvider` y el mapa quedaría lleno de claves que nadie encuentra.
 *
 * LOS DOS MAPAS DECIDEN DISTINTO PORQUE CONTESTAN DISTINTO:
 *
 *  · 5xx (`rechazo`) decide una COMPRA: ¿sirve montar un dominio nuevo sobre esta IP? Gana la culpa
 *    más grave que se haya visto UNA vez, porque una sola mención de la IP ya arruina la jugada.
 *    Semántica intacta, incluida la cuenta que se ignora.
 *
 *  · 4xx (`diferido`) decide si se APAGA la regla de la puerta, y ahí el máximo por presencia era el
 *    defecto. Medido el 2026-08-08 en annualcorp-ops.com: gmail.com difiere 296 líneas
 *    `452-4.2.2 out of storage space` (siete casillas llenas de terceros) y UNA línea
 *    `421-4.3.0 Temporary System Problem`. Con el máximo, esa única línea (`no-se`, peso 1) le ganaba
 *    a las 296 (`buzon`, peso 0) y el sensor publicaba "gmail.com no abre la puerta" — la acusación
 *    falsa exacta que la exención de buzón vino a evitar. Hoy no explota SÓLO porque el techo de la
 *    sección se come esa fila por ranking, o sea por suerte.
 *
 *    Ahora es un VOTO POR PESO DE LÍNEAS: `buzon` absuelve cuando es la mayoría de las líneas
 *    diferidas del receptor; si no, gana la etiqueta no-absolutoria con más líneas y `PESO_DIFERIDO`
 *    sólo rompe empates. Un transitorio suelto deja de tapar ocho mensajes de casilla llena, y ocho
 *    casillas llenas dejan de absolver a un receptor que nos difiere cien veces por política.
 *
 * LA CUENTA ES OPCIONAL a propósito: sin ella cada fila vale 1, que es exactamente el comportamiento
 * de la salida vieja (una fila = una etiqueta). Un campo que todavía no viene es el valor
 * conservador, no un parser roto.
 */
function parseCulpa(stdout: string): { rechazo: Record<string, Culpa>; diferido: Record<string, Culpa> } {
  const rechazo: Record<string, Culpa> = {};
  /** Líneas por etiqueta y por receptor, que es la unidad en la que se vota el 4xx. */
  const pesoDiferido = new Map<string, Map<Culpa, number>>();
  for (const line of section(stdout, "CULPA").split(/\r?\n/)) {
    // `<cuenta> <receptor>\t<status>\t<motivo>`. Tolerante con las salidas VIEJAS: sin cuenta
    // (`<receptor>\t<status>\t<motivo>`) y de dos columnas (`<receptor>\t<motivo>`, donde no hay
    // status y se cuenta como rechazo, que era lo único que esa versión miraba). Un receptor nunca
    // empieza con dígitos seguidos de espacio, así que el prefijo no es ambiguo. Este archivo ya se
    // quemó tres veces con "salida distinta a la esperada" leída como un desastre.
    const campos = line.split("\t");
    if (campos.length < 2) continue;
    const cabeza = /^\s*(?:(\d+)\s+)?(.*)$/.exec(campos[0]!)!;
    const lineas = cabeza[1] === undefined ? 1 : Number(cabeza[1]);
    const receptor = cabeza[2]!.trim().toLowerCase().replace(/\.$/, "");
    if (!receptor) continue;
    const esDiferido = campos.length >= 3 && campos[1] === "deferred";
    const culpa = clasificarCulpa(campos.slice(campos.length >= 3 ? 2 : 1).join("\t"));
    if (esDiferido) {
      const acc = pesoDiferido.get(receptor) ?? new Map<Culpa, number>();
      acc.set(culpa, (acc.get(culpa) ?? 0) + lineas);
      pesoDiferido.set(receptor, acc);
      continue;
    }
    // El de 5xx conserva su semántica exacta: con `previa === undefined` el primer `no-se` se
    // escribe igual que antes, y después gana lo más grave. Siempre se escribe la clave, aunque
    // gane `"no-se"`: "vimos rebotes de este receptor y no sabemos por qué" es información, y es
    // distinto de no haber visto nada.
    const previa = rechazo[receptor];
    rechazo[receptor] = previa === undefined || PESO_DE_CULPA[culpa] > PESO_DE_CULPA[previa] ? culpa : previa;
  }
  const diferido: Record<string, Culpa> = {};
  for (const [receptor, acc] of pesoDiferido) {
    const total = [...acc.values()].reduce((a, b) => a + b, 0);
    // MAYORÍA ESTRICTA para absolver, y el empate NO absuelve: la mitad de las líneas hablando de
    // una puerta cerrada es evidencia sobre nosotros, y la casilla llena de un tercero no la tapa.
    const buzon = acc.get("buzon") ?? 0;
    if (buzon * 2 > total) { diferido[receptor] = "buzon"; continue; }
    // Y entre las que NO absuelven gana la más grave, exactamente como antes. El peso de líneas
    // decide UNA cosa y nada más —si la casilla llena absuelve—, que es lo único que estaba mal.
    // Con el peso decidiendo también acá, 19 receptores de la flota pasaban de `ip` a `no-se` (el
    // "connect timed out" repetido le ganaba al "554 listed on Cloudmark" que nombra nuestra IP):
    // para la puerta da igual, pero es información que se perdía sin motivo.
    diferido[receptor] = [...acc.entries()]
      .filter(([c]) => c !== "buzon")
      .sort((a, b) => PESO_DIFERIDO[b[0]] - PESO_DIFERIDO[a[0]])[0]?.[0] ?? "buzon";
  }
  return { rechazo, diferido };
}

/**
 * Parte la salida en las DOS lecturas: el nodo entero y lo nuestro.
 *
 * FAIL-HONEST DOBLE. Sin `## END` devuelve `null` como siempre (salida truncada). Y si falta
 * CUALQUIERA de los tres `## OWN_*` también devuelve `null`, aunque el resto esté perfecto: una
 * sección propia ausente no son cero mensajes nuestros, es una salida que no sabemos leer.
 *
 * Por qué esa rama vale su propio `return`: leerla como cero convertiría cada nodo de la flota en
 * `no_own_traffic` de una, en silencio y sin un solo error — y el archivo que publica el panel se
 * llenaría de "sin muestra propia" sin que nadie sospeche del parser. Este módulo ya se quemó TRES
 * veces con la misma forma exacta: "comando que devuelve vacío" leído como "no hay tráfico".
 */
export function parseDeliveryStats(stdout: string): {
  total: NodeDeliveryStats;
  propio: NodeDeliveryStats;
  /** Culpa leída de los rechazos 5xx. Es la que decide si comprar un dominio nuevo sirve. */
  culpa: Record<string, Culpa>;
  /**
   * Culpa leída de los diferidos 4xx. NO se publica ni se mezcla con la de arriba: un 4xx no es un
   * bloqueo permanente. Su único uso es desactivar la regla de la puerta cuando lo que se difiere es
   * la casilla llena de un tercero y no una puerta que nos cierran.
   */
  culpaDiferido: Record<string, Culpa>;
} | null {
  if (!stdout.includes("## END")) return null; // salida truncada: no inventamos
  for (const s of ["OWN_DELIVERED", "OWN_BLOCKED", "OWN_DEFERRED"]) {
    if (!stdout.includes(`## ${s}`)) return null;
  }
  const culpa = parseCulpa(stdout);
  return {
    culpa: culpa.rechazo,
    culpaDiferido: culpa.diferido,
    total: armar(
      counts(section(stdout, "DELIVERED")),
      counts(section(stdout, "BLOCKED")),
      counts(section(stdout, "DEFERRED"))
    ),
    propio: armar(
      counts(section(stdout, "OWN_DELIVERED")),
      counts(section(stdout, "OWN_BLOCKED")),
      counts(section(stdout, "OWN_DEFERRED"))
    )
  };
}

/**
 * `total - propio`, por receptor y en los totales. Nunca negativo: si el propio superara al total
 * (imposible por construcción — la sección OWN es un subconjunto de la misma pasada) el clamp evita
 * publicar un número que no significa nada.
 */
function restar(total: NodeDeliveryStats, propio: NodeDeliveryStats): NodeDeliveryStats {
  const mio = new Map(propio.byProvider.map((p) => [p.provider, p]));
  const menos = (a: number, b: number): number => Math.max(0, a - b);
  const menosCuenta = (a: DeliveryCounters, b: DeliveryCounters): DeliveryCounters => ({
    delivered: menos(a.delivered, b.delivered),
    blocked: menos(a.blocked, b.blocked),
    deferred: menos(a.deferred, b.deferred)
  });
  return {
    totals: menosCuenta(total.totals, propio.totals),
    // Las líneas se restan igual que los mensajes: si no, `ajenos` publicaría la presión del nodo
    // ENTERO atribuida al otro inquilino, y la presión es justo el número que decide `stalled`.
    intentos: menosCuenta(lineasDe(total.totals, total.intentos), lineasDe(propio.totals, propio.intentos)),
    byProvider: total.byProvider
      .map((p) => {
        const m = mio.get(p.provider);
        return {
          provider: p.provider,
          ...menosCuenta(p, m ?? CERO_PROVEEDOR),
          intentos: menosCuenta(lineasDe(p, p.intentos), m ? lineasDe(m, m.intentos) : CERO_PROVEEDOR)
        };
      })
      .filter((p) => p.delivered + p.blocked + p.deferred > 0)
  };
}
const CERO_PROVEEDOR: DeliveryCounters = { delivered: 0, blocked: 0, deferred: 0 };

/**
 * `selfDomain` se excluye del veredicto: los rebotes a la propia máquina (avisos a
 * postmaster, notificaciones de no-entrega que Postfix se manda a sí mismo) no son un
 * bloqueo de proveedor. Sin esta exclusión, los nodos MÁS sanos aparecían "cerrados"
 * en su propio dominio — un falso positivo que habría enterrado la señal en ruido.
 */
export function assessDeliveryHealth(
  stats: NodeDeliveryStats,
  selfDomain?: string,
  extra?: {
    encolados?: number | null;
    ventana?: string;
    /**
     * Lo que movió el nodo ENTERO. Ausente = `stats` ya es el total (modo "todo"), que es lo
     * honesto para un llamador que no atribuyó nada.
     */
    total?: NodeDeliveryStats;
    modo?: "nuestro" | "todo";
    queueIds?: number;
    descartados?: number;
    /** Lo que dijo cada receptor al rechazar (5xx), ya clasificado. Ver `Culpa`. */
    culpa?: Record<string, Culpa>;
    /** Lo que dijo cada receptor al DIFERIR (4xx). Solo desactiva la puerta; no se publica. */
    culpaDiferido?: Record<string, Culpa>;
  }
): DeliveryHealthVerdict {
  const ventana = extra?.ventana ?? DELIVERY_STATS_WINDOW;
  const encolados = extra?.encolados ?? null;
  const total = extra?.total ?? stats;
  const ajenos = restar(total, stats);
  const atribucion = {
    modo: extra?.modo ?? "todo",
    queueIds: extra?.queueIds ?? 0,
    descartados: extra?.descartados ?? 0
  } as const;
  const blockedProviders: string[] = [];
  const degradedProviders: string[] = [];
  /** Receptores que nos difieren y nunca resuelven: la puerta cerrada en 4xx. Ver `PRESION_BLOQUEO`. */
  const puertaCerrada: string[] = [];
  const sinMuestra: string[] = [];
  const culpaLeida = extra?.culpa ?? {};
  const culpaDiferida = extra?.culpaDiferido ?? {};
  const culpaPorProveedor: Record<string, Culpa> = {};
  const self = selfDomain?.trim().toLowerCase().replace(/\.$/, "");
  const esPropio = (provider: string): boolean =>
    !!self && (provider === self || provider.endsWith(`.${self}`));

  for (const p of stats.byProvider) {
    if (esPropio(p.provider)) continue;

    // LA PUERTA 4xx. Va ANTES del piso porque no depende de él: este receptor nunca va a escribir un
    // `status=bounced`, así que jamás sumaría un solo `attempt`. Se mide en el otro eje — cuántos
    // mensajes quedaron trabados con él y cuánto los hizo reintentar.
    const atascados = Math.max(0, p.deferred - p.delivered - p.blocked);
    const lineas = lineasDe(p, p.intentos);
    const presion = p.deferred > 0 ? lineas.deferred / p.deferred : 1;
    // Y el motivo tiene que hablar de NOSOTROS. Sin este filtro la regla acusaba al receptor de
    // cerrarnos la puerta cuando lo que había eran casillas llenas de terceros: medido el 2026-08-08
    // en annualcorp-control.com, los 864 diferidos hacia Gmail de la ventana son 864 de 864
    // `452-4.2.2 The recipient's inbox is out of storage space` — siete casillas reintentadas ~108
    // veces cada una. Publicar "gmail.com no abre la puerta" sobre eso es afirmar algo que no se
    // midió, que es la enfermedad que este módulo tiene por trabajo no repetir.
    //
    // Fail-closed igual: solo `"buzon"` desactiva la puerta. Un motivo que no sabemos clasificar
    // (`"no-se"`, que es lo que da el 421 de Yahoo hasta que alguien lo agregue a la tabla) SÍ
    // cuenta, porque "no sé por qué me difiere" no es "me difiere por culpa del destinatario".
    if (
      p.delivered === 0 &&
      atascados >= ATASCADOS_MIN &&
      presion >= PRESION_BLOQUEO &&
      (culpaDiferida[p.provider] ?? "no-se") !== "buzon"
    ) {
      puertaCerrada.push(p.provider);
    }

    const attempts = p.delivered + p.blocked;
    if (attempts < BLOCKED_MIN_ATTEMPTS) {
      // EL VETO QUE FALTABA. Antes acá había un `continue` pelado, o sea NINGÚN veredicto — y la
      // ausencia de veredicto caía hasta el `healthy` del final. Ver `insufficient_sample` para el
      // incidente completo: annualcorp-control.com verde con 136 rechazos 550-5.7.1 de Gmail de
      // hacía cuatro días, porque en la ventana corrida le quedaba UN intento.
      //
      // Las cuatro condiciones, cada una con su motivo, y las cuatro tienen que darse:
      //  · `blocked > 0`: sin un NO explícito no hay nada que juzgar. Los nodos sin tráfico ya tienen
      //    su estado (`no_traffic`) y no se pisan con éste. Queda implícito en el ratio (con 0
      //    rechazos da 0) y se deja escrito igual: es la condición que se lee primero.
      //  · el RATIO del receptor, el mismo `BLOCKED_MIN_RATIO` que decide arriba del piso. Acá
      //    estaba el agujero: la condición era `p.delivered === 0`, o sea que UNA sola entrega
      //    apagaba el veto entero. Y esa entrega la pone el propio warmup — los 6 nodos que hoy
      //    calientan le entregan todos los días a las mismas dos semillas de Gmail, así que la
      //    evidencia que compraba el fail-open estaba garantizada por construcción.
      //    REPRODUCIDO POR EL CAMINO DE PRODUCCIÓN el 2026-08-08 (líneas CRUDAS del mail.log de
      //    corpfilingcontrol.com y corpfiling-infra.com, sólo se les reescribió la fecha, bash +
      //    `buildDeliveryStatsCommand` sin tocar): 1 entrega + 9 rechazos 550-5.7.1 de Gmail = 90%
      //    de rechazo ⇒ `healthy`, "1 entregados a terceros, 9 rechazados". Con 1 + 13 (93%) lo
      //    mismo. Y no es un borde teórico: con nuestro volumen (~2 correos/día por dominio, ~10
      //    intentos en la ventana) el piso de 20 es INALCANZABLE, así que ése era el único camino
      //    por el que un nodo del pool podía salir marcado mientras se quema.
      //    Se usa el umbral que el archivo YA tiene y no uno nuevo: abajo del piso la regla no puede
      //    ser más dura que arriba, donde 90% es `blocked_by_provider` y 25% es `degraded` (y
      //    `degraded` entra al pool igual).
      //  · receptor de FAMILIA conocida: en la flota hay más de veinte mil filas con algún rechazo y
      //    casi todas son typos de una línea (`gamil.com`, `yahoo.comm`). Un dedo equivocado no puede
      //    congelar un dominio.
      //  · la culpa no es del BUZÓN: un 5.1.1 es una dirección que no existe, del destinatario y no
      //    nuestra. Se exige `!== "buzon"` y no `∈ {dominio, ip}` a propósito — medido, 33 de 39
      //    rebotes de política de Gmail salen `"no-se"`, así que pedir culpa conocida agarraría 4 de
      //    23 nodos y el veto sería decorativo. Fail-closed: lo que no se pudo clasificar SÍ frena.
      //
      // ── Y LA BANDA DEL MEDIO, QUE FALTABA (2026-08-08) ──────────────────────────────────────
      //
      // De los dos umbrales que el párrafo de arriba promete ("abajo del piso la regla no puede ser
      // más dura que arriba, donde 90% es `blocked_by_provider` y 25% es `degraded`") sólo estaba
      // implementado el 90%. El resultado, barrido sobre esta misma función (es pura) con un solo
      // receptor gmail.com: 2 entregas y 17 rechazos —89% sobre 19 intentos— salía `healthy` y sin
      // una marca; 9/10 (53%) también. Un intento más arriba, 5/20 (80%) es `degraded`. O sea que
      // abajo del piso la regla quedó 3,6× MÁS FLOJA que arriba, al revés de lo que decía.
      //
      // Y con nuestro volumen ésta es la ÚNICA regla que se le aplica a nuestros dominios: el piso
      // de 20 es inalcanzable con ~2 correos/día. El agujero además se AGRANDA el día que NFC deje
      // de inyectar — hoy los receptores grandes cruzan el piso gracias al tráfico de NFC.
      //
      // POR QUÉ `degraded` Y NO `insufficient_sample`: `degraded` ENTRA al pool igual
      // (plan-diario.ts:579), así que esto NO achica el pool ni concentra el sobre global del
      // daemon. Lo que cambia es lo que el sistema AFIRMA de sí mismo: deja de llamarle "healthy,
      // 2 entregados a terceros, 17 rechazados" a un 89% de rechazo. Aguas abajo sí baja el cupo de
      // NFC en ese dominio (sender-quota.ts:170 lo pinta rojo "rechazo parcial", hoyPuede 0), que
      // es la dirección segura: menos correo sobre un dominio que está siendo rechazado.
      //
      // EL MÍNIMO ABSOLUTO DE RECHAZOS NO ES UN NÚMERO NUEVO: arriba del piso, el `degraded` más
      // barato posible son 20 intentos × 25% = 5 rechazos. Pedir lo mismo acá abajo es lo que hace
      // literalmente cierta la frase "no más dura que arriba" — sin él, 3 entregas y 1 rechazo (4
      // intentos, 25%) marcaría un dominio sano, y un aviso que grita en falso enseña a ignorar
      // todos los demás. Con él: 2/17 y 9/10 quedan marcados, 3/1 no.
      const creible =
        p.blocked > 0 &&
        providerFamilyFor(p.provider) !== "otros" &&
        (culpaLeida[p.provider] ?? "no-se") !== "buzon";
      const ratioBajoPiso = p.blocked / attempts;
      if (creible && ratioBajoPiso >= BLOCKED_MIN_RATIO) {
        sinMuestra.push(p.provider);
      } else if (creible && ratioBajoPiso >= DEGRADED_MIN_RATIO && p.blocked >= DEGRADED_MIN_RECHAZOS) {
        degradedProviders.push(p.provider);
      }
      continue;
    }
    const ratio = p.blocked / attempts;
    if (ratio >= BLOCKED_MIN_RATIO) blockedProviders.push(p.provider);
    else if (ratio >= DEGRADED_MIN_RATIO) degradedProviders.push(p.provider);
    else continue;
    // La culpa se anota SOLO para los que efectivamente nos cierran o nos degradan, en el mismo
    // loop que los declara: así las claves de este mapa son exactamente los nombres que después se
    // publican, y no puede aparecer una culpa de un receptor que nadie mencionó ni faltar la de uno
    // que sí. El `?? "no-se"` es lo que impide que "no lo pudimos clasificar" se lea como "no pasa
    // nada" — ausencia de dato no es evidencia.
    culpaPorProveedor[p.provider] = culpaLeida[p.provider] ?? "no-se";
  }

  // La cola de AHORA manda sobre el log de la ventana, y va PRIMERA.
  //
  // El dedup por queue-id, solo, libera cuatro nodos con más de siete mil mensajes trabados
  // (nationalfiling-control 9.457, nationalfiling-infra 9.840, nationalfilingops 9.316,
  // corpdocfiling-ledger 7.306): su log deja de acusarlos porque los reintentos dejan de contar como
  // intentos distintos, pero el correo sigue sin salir del nodo. El dedup y este sensor van juntos o
  // no va ninguno.
  //
  // Va acá y no en el pool a propósito: así el veredicto viaja por los cables que YA existen — la
  // alerta `high` de sender-alerts.ts y el rojo de sender-quota.ts disparan por la etiqueta "cola
  // atascada", que sale de este `stalled`. Ponerlo en elegirPool habría sacado el nodo del warmup
  // dejándolo verde en la pantalla.
  //
  // Y es de UNA SOLA DIRECCIÓN: la cola solo puede EMPEORAR el veredicto. No existe la inversa
  // ("cola limpia veta el stalled del log"), que marcaría sano a un nodo cuyo diferido deduplicado
  // sigue arriba del 50%. Lo que libera nodos es el dedup, no la cola.
  // UN SOLO armador para los siete veredictos, en vez de siete objetos literales.
  //
  // No es cosmético: el 2026-08-06, al agregar `encolados`, cinco de los seis `return` se quedaron
  // sin el campo nuevo. Como corremos con --experimental-strip-types no hay chequeo en tiempo de
  // ejecución, así que salía `undefined`, JSON.stringify borraba la clave, y sender-measurement.json
  // quedó sin el dato en 49 de 58 nodos. Este cambio agrega DOS campos más (`ajenos`, `atribucion`)
  // y multiplicaría por tres la misma trampa. Con un armador, olvidarse ya no es posible.
  // Las auto-entregas y las de verdad, contadas UNA vez para los siete veredictos. Antes esto vivía
  // suelto dentro de la rama `healthy` y sólo servía para la frase; ahora viaja en el objeto. Ver
  // `entregadosATerceros` en el tipo para el nodo real que entraba al pool con cero entregas.
  const aSiMismo = stats.byProvider.reduce((a, p) => a + (esPropio(p.provider) ? p.delivered : 0), 0);
  const entregadosATerceros = Math.max(0, stats.totals.delivered - aSiMismo);
  const veredicto = (status: DeliveryHealthStatus, detail: string): DeliveryHealthVerdict => ({
    status, window: ventana, stats, ajenos, atribucion, encolados, blockedProviders, degradedProviders,
    sinMuestra, culpaPorProveedor, entregadosATerceros, detail
  });

  if (encolados !== null && encolados >= COLA_ATASCADA_MIN) {
    // Y ESTA RAMA NO SE ATRIBUYE NUNCA, ni cuando el modo es "nuestro". La cola de Postfix es FÍSICA
    // y COMPARTIDA: si el nodo tiene 15.693 mensajes trabados porque NFC los inyectó, nuestro correo
    // tampoco sale de ahí. Preguntar "¿de quién son los mensajes trabados?" es la pregunta
    // equivocada; la correcta es "¿sale correo de este nodo?", y la respuesta es no.
    return veredicto(
      "stalled",
      `${encolados} mensajes en la cola AHORA (postqueue): el correo no está saliendo del nodo`
    );
  }

  // El diferido cuenta. Sin esto, un nodo que no entrega NADA porque todo se difiere se leia
  // como "sin trafico" (si no hubo entregas) o como "sano" (si alguna paso), y en los dos casos
  // el operador no se enteraba de que la cola crecia.
  const totalAttempts = stats.totals.delivered + stats.totals.blocked + stats.totals.deferred;
  const attemptsDelNodo = total.totals.delivered + total.totals.blocked + total.totals.deferred;
  // La misma cuenta que la puerta 4xx, pero del nodo entero: cuánto quedó trabado y cuánto costó.
  const atascadosDelNodo = Math.max(0, stats.totals.deferred - stats.totals.delivered - stats.totals.blocked);
  const lineasDelNodo = lineasDe(stats.totals, stats.intentos);
  const presionDelNodo = stats.totals.deferred > 0 ? lineasDelNodo.deferred / stats.totals.deferred : 1;

  // El orden de estas dos ramas es el que separa "no sé" de "nodo nuevo", y no es intercambiable.
  if (totalAttempts === 0 && attemptsDelNodo > 0) {
    return veredicto(
      "no_own_traffic",
      `el nodo movió ${attemptsDelNodo} mensajes en la ventana y ninguno es nuestro ` +
        `(${atribucion.queueIds} envíos en nuestro libro): sin muestra propia no hay veredicto`
    );
  }
  if (totalAttempts === 0) {
    // Log genuinamente vacío. La semántica queda INTACTA: un dominio recién comprado no dejó huella
    // en ningún mail.log y tiene que poder recibir su primer correo de warmup. Es la trampa que
    // documenta plan-diario.ts:177-195 y este cambio no la reabre.
    return veredicto("no_traffic", "el log no registra ni entregas ni rechazos ni diferidos en la ventana leida");
  }
  // LA PUERTA CERRADA EN 4xx, y devuelve `stalled` — NO `blocked_by_provider`. La distinción es la
  // decisión de diseño más consecuente de este cambio, así que queda escrita:
  //
  //  · `stalled` describe exactamente lo que pasa: "el correo sale del nodo pero no llega".
  //  · `blockedProviders` es el campo que sender-measurement persiste como `cerradoEn`, y `cerradoEn`
  //    NO CADUCA (plan-diario lo dice textual: "no caduca solo, se olvida borrando cerradoEn a mano").
  //    Un dominio recién comprado cuyo primer lote de warmup difiera cinco mensajes con el backoff
  //    normal de Postfix quedaría PERMANENTEMENTE inelegible por un throttle transitorio. Un sensor
  //    que bloquea todo es tan inútil como uno que no bloquea nada.
  //  · `stalled` no es pegajoso: se recalcula sobre los 5 días. El nodo deja de mandar, su ventana se
  //    vacía y vuelve a `no_traffic`, que es la puerta que el pool abre a propósito. Costo de
  //    averiguar si se recuperó: una vuelta cada cinco días.
  //  · Y aguas abajo no hay que cablear NADA: `stalled` ya es rojo en el semáforo, ya excluye del
  //    pool, ya dispara alerta `high` y ya está en accionables.
  if (puertaCerrada.length > 0) {
    return veredicto(
      "stalled",
      `${puertaCerrada.join(", ")} no abre la puerta: nos difiere y nunca entrega ` +
        `(${PRESION_BLOQUEO}+ reintentos por mensaje y ninguna entrega en la ventana)`
    );
  }
  // Y la misma regla al nivel del nodo. El segundo disyuntor no es un piso más flojo: `delivered +
  // blocked === 0` quiere decir que en cinco días NO SE RESOLVIÓ NI UN MENSAJE, ni bien ni mal. Sin
  // él, un nodo con 920 mensajes colgados y cero entregas caía en `healthy` con el texto "0
  // entregados, 0 rechazados", que es el mismo fail-open que este archivo vino a cerrar.
  //
  // Acá murió `STALLED_MIN_DEFERRED_RATIO = 0.5`, y no fue una recalibración: el número dejó de
  // MEDIR. Cada estado se dedupea por separado y no hay desempate, así que un mensaje diferido una
  // vez y después resuelto suma +1 a `deferred` Y +1 a `sent`/`bounced`: para un nodo normal
  // `deferred ≈ sent + blocked` y el ratio tiende a 0,5000 exacto. Medido el 2026-08-08: 33 de 64
  // nodos caían en ese balde y 38 en la banda 0,40–0,60, o sea que el veredicto de más de la mitad
  // de la flota lo decidía UN mensaje. Siete nodos salían `stalled` con la cola en 2-5 mensajes.
  if (
    atascadosDelNodo >= STALLED_MIN_ATTEMPTS &&
    (presionDelNodo >= PRESION_BLOQUEO || stats.totals.delivered + stats.totals.blocked === 0)
  ) {
    return veredicto(
      "stalled",
      `${atascadosDelNodo} mensajes trabados de ${totalAttempts} y ` +
        `${presionDelNodo.toFixed(1)} reintentos por diferido: ` +
        // La frase se conserva palabra por palabra: sender-measurement.test.ts la afirma para probar
        // que un nodo atascado no se publica sano, y romperla desde acá haría rojo un test que no
        // tiene nada que ver con este cambio.
        "el correo sale del nodo pero no llega; la cola se acumula"
    );
  }
  if (blockedProviders.length > 0) {
    const worst = stats.byProvider.find((p) => p.provider === blockedProviders[0])!;
    return veredicto(
      "blocked_by_provider",
      `cerrado en ${blockedProviders.join(", ")} (${worst.provider}: ${worst.blocked} rechazos sobre ${worst.delivered + worst.blocked} intentos)`
    );
  }
  if (degradedProviders.length > 0) {
    return veredicto("degraded", `rechazo parcial en ${degradedProviders.join(", ")}`);
  }
  // EL VETO. Va acá, último antes del sano, porque es el más débil de los rojos: cualquier veredicto
  // con evidencia de verdad le gana. Pero le gana a `healthy`, que es todo el punto.
  if (sinMuestra.length > 0) {
    const peor = stats.byProvider.find((p) => p.provider === sinMuestra[0])!;
    return veredicto(
      "insufficient_sample",
      `${sinMuestra.join(", ")} rechazó casi todo lo que le mandamos y no alcanza para acusarlo ` +
        // El número sale del dato y no de la condición: desde que el veto mira el RATIO y no
        // `delivered === 0`, "0 entregados" podía ser mentira en el mismo texto que denuncia
        // mediciones que mienten.
        `(${peor.provider}: ${peor.delivered} entregados y ${peor.blocked} rechazados, el piso son ${BLOCKED_MIN_ATTEMPTS} intentos): ` +
        "no sé si está cerrado, y eso NO es estar sano"
    );
  }
  // EL DETALLE CUENTA ENTREGAS A TERCEROS, no el total. El loop de arriba ya excluye el dominio
  // propio del veredicto, pero `stats.totals` lo sigue incluyendo — y de ahí salía la frase que lee
  // el operador, el panel y el agente.
  //
  // Qué decía en la práctica, medido el 2026-08-08: 23 de los 29 nodos "sanos" publicaban cosas como
  // "47 entregados, 3 rechazados" cuando las 47 eran entregas LOCALES a su propio manejador de
  // rebotes (`delivered to command: /usr/local/bin/nfc-verp-bounce.sh`) y las entregas a un tercero
  // eran CERO. El número que el operador leía como salud de entrega era el volumen de sus propios
  // rebotes. No cambia ningún veredicto; cambia lo que el sistema afirma sobre sí mismo, que es de
  // donde salió el incidente de la compra de dominios.
  return veredicto(
    "healthy",
    `${entregadosATerceros} entregados a terceros, ${stats.totals.blocked} rechazados` +
      (aSiMismo > 0 ? ` (y ${aSiMismo} a sí mismo, que no son entrega)` : "")
  );
}

const EMPTY_STATS: NodeDeliveryStats = {
  totals: { delivered: 0, blocked: 0, deferred: 0 },
  intentos: { delivered: 0, blocked: 0, deferred: 0 },
  byProvider: []
};

/**
 * Lee la salud de entrega de un nodo. Best-effort: nunca tira. Si no se pudo leer, el
 * estado es `unreadable` — jamás `healthy`, que sería el falso negativo peligroso.
 */
export async function readNodeDeliveryHealth(input: {
  sshRunner: DeliveryHealthSshRunner;
  serverSlug: string;
  serverIp: string;
  /**
   * REQUERIDO, sin default. Los queue-ids de nuestros envíos a ESTE nodo en la ventana, o `"todo"`
   * para no atribuir. Es la decisión más consecuente del módulo — de qué reputación estamos
   * hablando — y un campo opcional es un campo que alguien no completa.
   */
  propios: ModoAtribucion;
  /** Dominio del propio nodo: sus rebotes internos no cuentan como bloqueo. */
  selfDomain?: string;
  /** Días de log a mirar. Por defecto la perilla del entorno. */
  dias?: number;
  timeoutMs?: number;
}): Promise<DeliveryHealthVerdict> {
  // La ventana se resuelve UNA vez, en el borde, y viaja por parámetro. Leer `process.env` acá
  // adentro haría imposible correr la tabla antes/después con dos ventanas distintas en el mismo
  // proceso, que es justo la medición que decide si este cambio se mergea.
  const dias = input.dias ?? DELIVERY_STATS_WINDOW_DAYS;
  const ventana = ventanaDeclarada(dias);
  const modo = input.propios === "todo" ? "todo" : "nuestro";
  const saneados = input.propios === "todo" ? { ok: [] as string[], descartados: 0 } : sanearIds(input.propios);
  const atribucion = { modo, queueIds: saneados.ok.length, descartados: saneados.descartados } as const;
  const ilegible = (detail: string, encolados: number | null = null): DeliveryHealthVerdict => ({
    status: "unreadable",
    window: ventana,
    stats: EMPTY_STATS,
    ajenos: EMPTY_STATS,
    atribucion,
    encolados,
    blockedProviders: [],
    degradedProviders: [],
    // Vacíos y no `undefined`: este es el ÚNICO veredicto que no sale del armador único, y el
    // 2026-08-06 exactamente por eso cinco de seis `return` se quedaron sin `encolados` y
    // sender-measurement.json perdió el dato en 49 de 58 nodos.
    sinMuestra: [],
    culpaPorProveedor: {},
    // Cero como el resto de EMPTY_STATS: acá no se leyó nada. Quien decide no puede leer este cero
    // como "no entregó" — sender-measurement lo publica como `null` junto con los demás, y es `null`
    // lo que el pool trata como "no sé".
    entregadosATerceros: 0,
    detail
  });

  if (saneados.ok.length > MAX_QUEUE_IDS) {
    return ilegible(
      `${saneados.ok.length} queue-ids en la ventana (tope ${MAX_QUEUE_IDS}): el libro creció más de ` +
        "lo previsto, no atribuyo a ciegas"
    );
  }

  // EL PRESUPUESTO DE LECTURA, Y POR QUÉ NO SON 60 SEGUNDOS.
  //
  // La sección `## CULPA` pasó a leer `status=(bounced|deferred)` y no sólo los rebotes, y el
  // diferido es el estado con MÁS líneas del log: el comando salió 3,4× más caro. Medido el
  // 2026-08-08 alternando las dos versiones contra el MISMO nodo (annualfiling-infra.com), dos veces
  // cada una y con el timeout en 300 s para que ninguna se corte: 17,1 s y 20,1 s la vieja, 64,8 s y
  // 69,0 s la nueva. O sea que con 60 s la nueva cruza el techo POR DISEÑO en los nodos grandes.
  //
  // Y no cruza en cualquier lado: con el default viejo, los tres que se caían eran
  // annualfiling-infra.com, corpannualinfra.com y corpledger-control.com (verificado: los tres a
  // 60,0 s clavados, `unreadable`), que son justo los que tienen 16.749, 14.936 y 16.655 mensajes
  // trabados en la cola AHORA y `cruzados: ["google"]`. El sensor se quedaba ciego exactamente donde
  // vive la evidencia — y para el pool falla del lado seguro (`entregados: null` ⇒ excluido), pero
  // el veredicto que decía "16.749 mensajes en la cola AHORA" se degradaba a "no pude leer el nodo"
  // y el `cerradoEn` de esos tres dejaba de actualizarse.
  //
  // 180 s = ~2,6× el peor caso medido, que es margen para que el log siga creciendo. Es lectura
  // pasiva: no manda un correo ni cuesta reputación, sólo tiempo de barrido.
  // ponytail: el techo es que el costo crece con el log. El arreglo de fondo es fundir la pasada de
  // `## CULPA` con la de `## DEFERRED` (un solo `$READ | awk` con dos acumuladores, la misma técnica
  // que el comando ya usa para contar mensajes y líneas); se hace el día que 180 s no alcancen.
  const presupuestoMs = input.timeoutMs ?? 180_000;
  try {
    const result = await input.sshRunner.run({
      serverSlug: input.serverSlug,
      serverIp: input.serverIp,
      command: buildDeliveryStatsCommand(input.propios, dias),
      timeoutMs: presupuestoMs
    });
    if (deliveryStatsUnreadable(result.stdout)) {
      return ilegible("sin permiso para leer /var/log/mail.log (es syslog:adm; el usuario ops necesita sudo)");
    }
    const stats = parseDeliveryStats(result.stdout);
    if (!stats) {
      return ilegible("salida incompleta (falta ## END o alguna sección ## OWN_*)");
    }
    // Un nodo que escribe la fecha en un tercer formato queda fuera del corte por día y devuelve
    // cero de todo. Cero se lee `no_traffic`, y `no_traffic` limpio ENTRA al pool desde el arreglo
    // del onboarding: sin esta rama, un nodo ciego se calentaría creyendo que es nuevo.
    const sinFecha = parseLineasSinFecha(result.stdout);
    if (sinFecha !== null && sinFecha > 0) {
      return ilegible(
        `${sinFecha} líneas de entrega con una fecha que no es syslog ni ISO-8601: el corte por día no las ve, así que los totales no valen`,
        parseQueueSize(result.stdout)
      );
    }
    // En modo "todo" el propio ES el total: no hay nada que restar y `ajenos` queda en cero. Sin
    // este `?:` el mismo objeto viajaría dos veces y el veredicto diría "0 nuestros de N" sobre un
    // llamador que nunca pidió atribuir.
    return assessDeliveryHealth(modo === "todo" ? stats.total : stats.propio, input.selfDomain, {
      encolados: parseQueueSize(result.stdout),
      ventana,
      total: stats.total,
      culpa: stats.culpa,
      culpaDiferido: stats.culpaDiferido,
      ...atribucion
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // UN CHEQUEO QUE SE CUELGA ES "NO SÉ", Y ADEMÁS TIENE QUE DECIR DE QUÉ. Es la lección del probe
    // del 2026-07-29, donde un `head -c 120` que esperaba un banner devolvió "puerto 25 bloqueado"
    // en 10 de 10 nodos. Acá el estado ya es el correcto (`unreadable`, nunca `healthy`), pero el
    // texto mandaba a buscar sudo cuando lo que faltaba era tiempo: se nombra el presupuesto para
    // que se vea que la perilla es ésta y no un permiso.
    return ilegible(
      /timed out|ETIMEDOUT/i.test(msg)
        ? `la lectura no terminó en ${Math.round(presupuestoMs / 1000)}s (el log de este nodo es más grande que el presupuesto): no sé qué pasa acá, no es que esté limpio`
        : `lectura fallida: ${msg}`
    );
  }
}
