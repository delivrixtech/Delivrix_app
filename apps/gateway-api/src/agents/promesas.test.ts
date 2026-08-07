import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { HORAS_PARA_VENCER, anotarPromesa, revisarPromesas, type Promesa } from "./promesas.ts";

const T0 = "2026-08-06T20:00:00.000Z";
const mas = (horas: number, desde = T0): string => new Date(Date.parse(desde) + horas * 3_600_000).toISOString();

const HILO = "1754500000.111100";
const CAMPO = "placement:corp-delivery.com";

/** El retrato de la fábrica. Ya no se consulta al PROMETER (ver el test de la disculpa honesta): se
 *  consulta al vencer, para saber si alguien está midiendo la clave prometida. */
const RETRATO = { [CAMPO]: "SPAM", "cap.frenados": 8 };
/**
 * Cuándo se tomó el snapshot previo. Va ANTES de la promesa a propósito: una promesa solo se cumple
 * con un dato posterior a ella, y en producción ese instante sale de `previa.generadoEn`.
 */
const PREVIO_DE = T0;

const promesa = (que = "el placement de corp-delivery.com", esperando: string | null = CAMPO, hilo: string | null = HILO, cuando = T0) =>
  anotarPromesa([], { que, hilo, esperando }, cuando);

test("CUMPLIMIENTO: cuando el dato llega, contesta EN EL HILO y con los dos valores", () => {
  // Las 7 promesas medidas el 2026-08-06 ("Apenas caiga la lectura te traigo el estado real de…")
  // dieron 0 cumplidas. Y aunque hubiera hablado, `mandarASlack` de la guardia no pasaba threadTs
  // (scripts/ops/warmup-monitor.ts:820) mientras el chat sí (:1152): una respuesta suelta en el
  // canal tres horas después no se lee como respuesta a nada.
  const r = revisarPromesas(promesa(), { [CAMPO]: "SPAM" }, { [CAMPO]: "INBOX" }, mas(0.5), PREVIO_DE);

  assert.ok(r.aviso, "tenía el dato prometido y se calló");
  assert.equal(r.aviso.hilo, HILO, "sale en el hilo donde se prometió");
  assert.match(r.aviso.motivo, /cumplo lo prometido/);
  // Cumplir citando el dato, no anunciando que lo tiene: una promesa cumplida sin el número es una
  // promesa cumplida con otra promesa.
  assert.match(r.aviso.texto, /SPAM/, "cita el valor viejo");
  assert.match(r.aviso.texto, /INBOX/, "cita el valor nuevo");
  assert.equal(r.lista[0]?.comoCerro, "cumplida");
  assert.equal(r.lista[0]?.cerradaEn, mas(0.5));
});

test("SILENCIO: mientras el dato no cambie, no dice nada", () => {
  // Sin esto el mecanismo se convierte en un goteo de "sigo esperando" cada 10 minutos, que es
  // exactamente el ruido que la queja 2 vino a matar.
  const r = revisarPromesas(promesa(), { [CAMPO]: "SPAM" }, { [CAMPO]: "SPAM" }, mas(1), PREVIO_DE);
  assert.equal(r.aviso, null);
  assert.equal(r.lista[0]?.cerradaEn, undefined, "sigue abierta");
});

test("LA PRIMERA MEDICIÓN CUENTA: no-medido → INBOX es una novedad", () => {
  // "No medido" y "cero" no son lo mismo. Si el campo no existía y ahora existe, el dato prometido
  // llegó: esperar un "cambio entre dos valores presentes" dejaría sin cumplir justamente el caso
  // más común, un dominio que todavía no se había medido nunca.
  //
  // El snapshot previo tiene OTRAS claves: lo que no puede estar es vacío (ver el fail-closed).
  const r = revisarPromesas(promesa(), { "cap.frenados": 8 }, { [CAMPO]: "INBOX" }, mas(1), PREVIO_DE);
  assert.ok(r.aviso);
  assert.match(r.aviso.texto, /sin medir/, "dice que antes no había dato, no que era cero");
  assert.match(r.aviso.texto, /INBOX/);
});

test("FAIL-CLOSED: con el snapshot previo VACÍO no se cumple nada", () => {
  // El agujero medido: `revisarPromesas` cerraba TODA promesa abierta como CUMPLIDA anunciando "pasó
  // de sin medir a X" — un cambio que nunca ocurrió. `novedades()` en slack.ts ya tenía este mismo
  // fail-closed con su test; acá faltaba, y el `camposAntes` del orquestador sale de una lectura de
  // disco con `.catch(() => null)`, así que un tropiezo de lectura lo dispara. Un dato fabricado en
  // el mensaje que existe justamente para reconstruir la confianza.
  const r = revisarPromesas(promesa(), {}, { [CAMPO]: "INBOX" }, mas(1), PREVIO_DE);
  assert.equal(r.aviso, null, "no hay con qué comparar: no cumplió nadie");
  assert.equal(r.lista[0]?.cerradaEn, undefined, "y la promesa sigue abierta, que es lo honesto");

  // Las VENCIDAS no dependen del snapshot: no afirman ningún dato, solo dicen que el plazo se acabó.
  const vencida = revisarPromesas(promesa(), {}, {}, mas(HORAS_PARA_VENCER + 1), PREVIO_DE);
  assert.match(vencida.aviso?.texto ?? "", /nadie está midiendo eso/);
});

test("UNA PROMESA NO SE CUMPLE CON UN DATO ANTERIOR A ELLA", () => {
  // La ventana del diff es (snapshot previo → ahora). Si la promesa se hizo DESPUÉS de ese snapshot,
  // el cambio que se ve ya había ocurrido antes de prometer nada, y el mensaje sería "te dije que te
  // avisaba y pasó de SPAM a INBOX" sobre un dato de dos minutos antes de la promesa. Cumplir con un
  // dato viejo es la misma mentira que no cumplir, con mejor cara.
  const tarde = promesa("el placement de corp-delivery.com", CAMPO, HILO, mas(0.5));
  const r = revisarPromesas(tarde, { [CAMPO]: "SPAM" }, { [CAMPO]: "INBOX" }, mas(0.6), T0);
  assert.equal(r.aviso, null, "el cambio es anterior a la promesa");

  // Con el snapshot previo posterior a la promesa, la misma entrada sí cumple.
  const ok = revisarPromesas(tarde, { [CAMPO]: "SPAM" }, { [CAMPO]: "INBOX" }, mas(1), mas(0.5));
  assert.match(ok.aviso?.texto ?? "", /SPAM.*INBOX/s);
});

test("sin saber CUÁNDO se tomó el snapshot previo, no se cumple nada", () => {
  // `previosDe: null` es "no sé de cuándo es este retrato". Con esa entrada no se puede afirmar que
  // el cambio sea posterior a la promesa, así que solo se puede vencer. Es el fallo correcto: el
  // parámetro es obligatorio para que quien cablea decida, no para heredar un silencio.
  assert.equal(revisarPromesas(promesa(), { [CAMPO]: "SPAM" }, { [CAMPO]: "INBOX" }, mas(1), null).aviso, null);
});

test("EL DATO QUE DESAPARECE NO CUMPLE NADA", () => {
  // Ausencia de dato no es evidencia. Si el campo se cayó del snapshot nuevo, mandar "pasó de INBOX
  // a sin medir" sería fabricar una noticia con un punto ciego.
  const r = revisarPromesas(promesa(), { [CAMPO]: "INBOX" }, {}, mas(1), PREVIO_DE);
  assert.equal(r.aviso, null);
  assert.equal(r.lista[0]?.cerradaEn, undefined);
});

test("VENCIMIENTO, a los dos lados del borde: calla antes, cierra en voz alta después, y nunca más", () => {
  // El caso real: corp-delivery.com se midió 3 veces en 6 h y devolvió el mismo motivo textual
  // ("todavía no se midió nunca"). Sin plazo, "cumplo cuando el dato cambie" deja el pendiente
  // abierto para siempre — precedente p-1-outlook-y-yahoo, visto=13 desde el 2026-08-04.
  const abierta = promesa();
  const campos = { [CAMPO]: "SPAM" };

  const antes = revisarPromesas(abierta, campos, campos, mas(HORAS_PARA_VENCER - 1), PREVIO_DE);
  assert.equal(antes.aviso, null, "a la hora N-1 todavía se aguanta");
  assert.equal(antes.lista[0]?.cerradaEn, undefined);

  const despues = revisarPromesas(abierta, campos, campos, mas(HORAS_PARA_VENCER + 1), PREVIO_DE);
  assert.ok(despues.aviso, "a la hora N+1 lo dice");
  assert.match(despues.aviso.texto, /no se movió en/, "es honesto: no simula haber cumplido");
  assert.equal(despues.aviso.hilo, HILO);
  assert.equal(despues.lista[0]?.comoCerro, "vencida");

  const siguiente = revisarPromesas(despues.lista, campos, campos, mas(HORAS_PARA_VENCER + 2), PREVIO_DE);
  assert.equal(siguiente.aviso, null, "una promesa cerrada no vuelve a hablar nunca");
});

test("RE-PROMETER NO EXTIENDE EL PLAZO", () => {
  // Un agente que promete lo mismo cada dos horas y reinicia el reloj no vence nunca nada: vuelve a
  // ser el agente de hoy, con un archivo más. Volver a prometer es señal de que NO cumplió, no de
  // que empiece un plazo nuevo.
  const una = promesa();
  const dos = anotarPromesa(una, { que: "el placement de corp-delivery.com", hilo: HILO, esperando: CAMPO }, mas(3));

  assert.equal(dos.length, 1, "es la misma promesa");
  assert.equal(dos[0]?.visto, 2);
  assert.equal(dos[0]?.abiertoEn, T0, "conserva la fecha original");
  assert.equal(dos[0]?.venceEn, una[0]?.venceEn, "conserva el vencimiento original");

  const campos = { [CAMPO]: "SPAM" };
  assert.ok(
    revisarPromesas(dos, campos, campos, mas(HORAS_PARA_VENCER + 0.5), PREVIO_DE).aviso,
    "vence a las 6 h de la PRIMERA, no de la última"
  );
});

test("DEDUPE: la misma promesa dicha de dos formas es UNA sola — el disparador manda", () => {
  // El modelo reformula, es lo que hacen los modelos. Con dedup exacto la lista sería inservible en
  // un día — es el incidente por el que `mismoPendiente` existe (tres pendientes para "outlook y
  // yahoo" a los diez minutos de estrenarlo).
  const una = promesa("el placement de corp-delivery.com");
  const dos = anotarPromesa(una, { que: "placement de corp-delivery.com apenas mida", hilo: HILO, esperando: CAMPO }, mas(1));
  assert.equal(dos.length, 1);
  assert.equal(dos[0]?.visto, 2);

  // Y LOS TEXTOS QUE EL MODELO ESCRIBE DE VERDAD, que es donde el dedupe por términos se rompía: los
  // 5 textos medidos en producción NO nombran el dominio ("Apenas caiga la lectura te traigo el
  // estado real de…"), así que dos promesas sobre dominios distintos comparten todos los términos.
  // Sin mirar `esperando` colapsaban en UNA: quedaba el disparador de la segunda y la primera no
  // podía cumplirse ni vencer por separado. La promesa que se evapora, adentro del arreglo de la
  // promesa que se evapora.
  const OTRO = "placement:annualfilings-control.com";
  const retrato = { ...RETRATO, [OTRO]: "SPAM" };
  let genericas = anotarPromesa([], { que: "te traigo el estado real", hilo: "H-1", esperando: CAMPO }, T0);
  genericas = anotarPromesa(genericas, { que: "te traigo el estado real", hilo: "H-2", esperando: OTRO }, mas(0.5));
  assert.equal(genericas.length, 2, "dos disparadores distintos son dos promesas");
  assert.deepEqual(
    genericas.map((p) => p.esperando),
    [CAMPO, OTRO]
  );

  // Y promesas GENUINAMENTE distintas conviven: si el dedupe fuera muy ancho se comería la segunda.
  const tres = anotarPromesa(dos, { que: "el cupo del nodo contabo-3", hilo: HILO, esperando: "cap.frenados" }, mas(1));
  assert.equal(tres.length, 2);
});

test("REGLA DURA: una promesa produce MENSAJES, jamás volumen", () => {
  // Cumplir no puede mover un cap. Si algún día una promesa tiene que disparar `soltar_dominio`,
  // eso lo decide el operador y es otro ítem — no se cuela por acá.
  // Se fija por los imports porque es lo único que no se puede sortear escribiendo más código: sin
  // ejecutor, sin disco y sin red importados, este módulo no puede tener efectos.
  const src = readFileSync(new URL("./promesas.ts", import.meta.url), "utf8");
  const imports = src.split("\n").filter((l) => l.startsWith("import "));
  assert.deepEqual(imports, ['import { mismoPendiente } from "./acciones-agente.ts";'], "solo el dedupe: nada que ejecute, escriba o llame a un modelo");

  // Y es pura de verdad: no muta lo que recibe.
  const lista = Object.freeze(promesa()) as readonly Promesa[];
  const previos = Object.freeze({ [CAMPO]: "SPAM" });
  const ahora = Object.freeze({ [CAMPO]: "INBOX" });
  const r = revisarPromesas(lista, previos, ahora, mas(1), PREVIO_DE);
  assert.equal(lista[0]?.cerradaEn, undefined, "la entrada original queda intacta");
  assert.equal(r.lista[0]?.comoCerro, "cumplida");
  assert.deepEqual(previos, { [CAMPO]: "SPAM" });
});

test("TRES QUE VENCEN JUNTAS SON UN MENSAJE, no tres", () => {
  // Con 7 promesas en una tarde y una guardia que corre 144 veces por día, sin tope se reproducen
  // los ~25 mensajes de la noche del 2026-08-06 con mejor excusa — y encima de madrugada.
  const dominios = ["corp-delivery.com", "annualfilings-control.com", "corpfiling-infra.com"];
  const retrato = Object.fromEntries(dominios.map((d) => [`placement:${d}`, "SPAM"]));
  let lista: Promesa[] = [];
  for (const d of dominios) {
    lista = anotarPromesa(lista, { que: `el placement de ${d}`, hilo: HILO, esperando: `placement:${d}` }, T0);
  }
  const r = revisarPromesas(lista, retrato, retrato, mas(HORAS_PARA_VENCER + 1), PREVIO_DE);

  assert.ok(r.aviso);
  assert.equal(r.aviso.texto.split("\n").length, 3, "un mensaje con tres líneas");
  assert.equal(r.lista.filter((p) => p.comoCerro === "vencida").length, 3, "las cierra a las tres");
});

test("`esperando` que NADIE MIDE: habla igual, y dice la verdad distinta", () => {
  // El caso MEDIDO, no el borde. Los tres dominios sobre los que gira la conversación real del
  // 2026-08-06 —controlcontrolledger.com, corpfiling-outbound.com, corp-delivery.com— no tienen ni
  // un ciclo en 5 días, así que ninguno produce clave `placement:`. Con la validación al anotar,
  // TODAS esas promesas quedaban genéricas y vencían en silencio: para Juanes eso es idéntico a hoy
  // —prometió y desapareció—, o sea la queja 1 intacta con un JSON más.
  const claveRara = promesa("el placement de un dominio que no existe", "placement:no-existe.example");
  assert.equal(claveRara[0]?.esperando, "placement:no-existe.example", "el disparador se guarda tal cual: quién mide qué se sabe al vencer");

  const campos = { [CAMPO]: "INBOX" };
  assert.equal(revisarPromesas(claveRara, RETRATO, campos, mas(1), PREVIO_DE).aviso, null, "no se cumple con un dato ajeno");

  const vencida = revisarPromesas(claveRara, RETRATO, campos, mas(HORAS_PARA_VENCER + 1), PREVIO_DE);
  assert.equal(vencida.lista[0]?.comoCerro, "vencida");
  // Y le dice algo ACCIONABLE: que ese dominio no tiene ciclos. Es más honesto que el silencio.
  assert.match(vencida.aviso?.texto ?? "", /nadie está midiendo eso/);
  assert.match(vencida.aviso?.texto ?? "", /placement:no-existe\.example/);
});

test("UN RETRATO VACÍO AL ANOTAR NO MATA LA PROMESA", () => {
  // El agujero: `anotarPromesa` validaba `esperando` contra el retrato de esa vuelta, y el
  // orquestador lee ese retrato con un `.catch(() => null)`. Un tropiezo de lectura de 200 ms —o la
  // primera instalación, donde el archivo no existe— degradaba TODA promesa a genérica y decidía que
  // no se podría cumplir nunca, aunque el dato real llegara en la vuelta siguiente. Un fallo de
  // lectura no puede decidir qué se puede prometer.
  const p = anotarPromesa([], { que: "el placement de corp-delivery.com", hilo: HILO, esperando: CAMPO }, T0);
  assert.equal(p[0]?.esperando, CAMPO);
  const r = revisarPromesas(p, { [CAMPO]: "SPAM" }, { [CAMPO]: "INBOX" }, mas(1), PREVIO_DE);
  assert.match(r.aviso?.texto ?? "", /SPAM.*INBOX/s, "cumple con el dato de la vuelta siguiente");
});

test("LA MISMA DISCULPA NO VUELVE CADA 6,5 h PARA SIEMPRE", () => {
  // El dedupe miraba solo las promesas ABIERTAS. En cuanto una vencía y se cerraba, el mismo texto
  // con el mismo disparador abría una promesa NUEVA con reloj NUEVO. Reproducido con el jefe
  // re-preguntando cada 30 min por un dato que no se mueve: 3 mensajes IDÉNTICOS por día (06:00,
  // 12:30, 19:00), todos los días, indefinidamente. Y no es un borde: `cap.frenados`, `flota.sanas`
  // y `flota.bloqueadas` —las tres claves globales que el prompt le ofrece al modelo— cambian como
  // mucho una vez por día.
  const campos = { "cap.frenados": 8 };
  let lista: Promesa[] = [];
  let disculpas = 0;
  // 24 h de vueltas cada 30 minutos, re-prometiendo lo mismo en cada una.
  for (let i = 0; i < 48; i++) {
    const ahora = mas(i * 0.5);
    lista = anotarPromesa(lista, { que: "te traigo los dominios frenados", hilo: HILO, esperando: "cap.frenados" }, ahora);
    const r = revisarPromesas(lista, campos, campos, ahora, mas(i * 0.5 - 0.2));
    lista = r.lista;
    if (r.aviso) disculpas++;
  }
  assert.equal(disculpas, 1, "se disculpa UNA vez y no vuelve a hacerlo por lo mismo en 24 h");
  assert.ok(
    lista.some((p) => p.callada),
    "las que renacen quedan marcadas para cerrarse sin ruido, no bloqueadas: si el dato se mueve, cumplen y hablan"
  );
});

test("UNA CALLADA IGUAL CUMPLE SI EL DATO SE MUEVE", () => {
  // `callada` frena la DISCULPA, no la promesa. Si frenara la promesa entera, el jefe dejaría de
  // recibir el dato que pidió solo porque hace 6 h le pedimos disculpas por lo mismo.
  const campos = { "cap.frenados": 8 };
  let lista = anotarPromesa([], { que: "te traigo los dominios frenados", hilo: HILO, esperando: "cap.frenados" }, T0);
  lista = revisarPromesas(lista, campos, campos, mas(HORAS_PARA_VENCER + 1), mas(HORAS_PARA_VENCER)).lista;
  lista = anotarPromesa(lista, { que: "te traigo los dominios frenados", hilo: HILO, esperando: "cap.frenados" }, mas(8));
  assert.equal(lista.at(-1)?.callada, true);

  const r = revisarPromesas(lista, campos, { "cap.frenados": 7 }, mas(9), mas(8));
  assert.match(r.aviso?.texto ?? "", /8 a 7/, "cumple y habla igual");
});

test("EL FRENO DE LAS DISCULPAS: no consume el presupuesto de la fábrica, tiene el suyo", () => {
  // Dos agujeros que se tapaban entre sí. (a) El cierre de promesa se devolvía ANTES de consultar
  // `presupuestoDeAvances` y solo INCREMENTABA el contador: 36 promesas abiertas en 6 h daban 36
  // mensajes, y el antecedente que hizo que el jefe dijera "repetitivo e imbécil" fueron ~25. (b) Si
  // se lo hubiéramos metido en el mismo balde, diez cierres triviales se comían los 10 avances del
  // día y tapaban el SPAM→INBOX, que es justo lo que la queja 2 existe para no perder.
  // 36 promesas escalonadas cada 10 minutos ⇒ una vence en cada vuelta de la guardia. Sin freno,
  // 36 mensajes.
  const retrato = Object.fromEntries(Array.from({ length: 36 }, (_, i) => [`placement:d${i}.com`, "SPAM"]));
  let lista: Promesa[] = [];
  for (let i = 0; i < 36; i++) {
    lista = anotarPromesa(lista, { que: `el placement de d${i}.com`, hilo: `H-${i}`, esperando: `placement:d${i}.com` }, mas(i / 6));
  }
  let mensajes = 0;
  for (let i = 0; i < 36; i++) {
    const ahora = mas(HORAS_PARA_VENCER + 0.01 + i / 6);
    const r = revisarPromesas(lista, retrato, retrato, ahora, mas(HORAS_PARA_VENCER + i / 6));
    lista = r.lista;
    if (r.aviso) mensajes++;
  }
  assert.equal(mensajes, 3, "6 h de vueltas ⇒ 3 mensajes, no 36: una disculpa cada 2 h");
  // Y las que el freno tapó NO se cerraron mudas: siguen abiertas y salen cuando les toque. Cerrarlas
  // en silencio sería reconstruir la queja 1 adentro de su propio arreglo.
  assert.ok(lista.some((p) => !p.cerradaEn), "las tapadas siguen abiertas, no desaparecieron");
});

test("UNA CUMPLIDA NO ESPERA AL FRENO", () => {
  // El freno es SOLO para los mensajes que son puras disculpas. Una cumplida trae el dato que el
  // jefe pidió y está acotada por los cambios reales de la fábrica; hacerla esperar la rompe de
  // verdad, porque la ventana del diff avanza cada vuelta y la que espera un turno ya no encuentra
  // su cambio: terminaría degradada a disculpa.
  let lista = anotarPromesa([], { que: "los dominios frenados", hilo: HILO, esperando: "cap.frenados" }, T0);
  lista = anotarPromesa(lista, { que: "el placement de corp-delivery.com", hilo: HILO, esperando: CAMPO }, mas(2));
  // Primero vence la vieja y sale la disculpa: arranca el reloj del freno.
  const uno = revisarPromesas(lista, RETRATO, RETRATO, mas(6.5), mas(6.4));
  assert.match(uno.aviso?.texto ?? "", /no se movió/);
  // Doce minutos después llega el dato de la otra: sale igual, aunque el freno esté caliente.
  const dos = revisarPromesas(uno.lista, RETRATO, { ...RETRATO, [CAMPO]: "INBOX" }, mas(6.7), mas(6.5));
  assert.match(dos.aviso?.texto ?? "", /SPAM.*INBOX/s);
});

test("el archivo no crece sin techo, pero NUNCA tira una promesa abierta", () => {
  // Una promesa abierta es exactamente la que todavía le debe un mensaje al jefe: recortarla nos
  // devuelve al estado de hoy. Las abiertas se drenan solas en 6 h, así que el techo se sostiene.
  const retrato = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`placement:dominio${i}.com`, "SPAM"]));
  let lista: Promesa[] = [];
  for (let i = 0; i < 40; i++) {
    lista = anotarPromesa(lista, { que: `el placement de dominio${i}.com`, hilo: HILO, esperando: `placement:dominio${i}.com` }, T0);
  }
  assert.equal(lista.length, 40, "abiertas: no se tira ninguna");

  const r = revisarPromesas(lista, retrato, retrato, mas(HORAS_PARA_VENCER + 1), PREVIO_DE);
  // 30 + 1: la última anunciada se conserva SIEMPRE porque en ella vive el reloj de
  // `MINUTOS_ENTRE_DISCULPAS`. Sin esa excepción, un recorte apagaba el freno justo cuando había
  // tormenta (medido: 9 disculpas en 6 h en vez de 3).
  assert.ok(r.lista.length <= 31, `ya cerradas, se recortan (quedaron ${r.lista.length})`);
  // Y el mensaje no es un muro de 40 líneas a las 4am: el sobrante se CUENTA, no se pierde.
  assert.ok((r.aviso?.texto.split("\n").length ?? 0) <= 6, "acota las líneas");
  assert.match(r.aviso?.texto ?? "", /más que cierro igual/, "dice cuántas quedaron afuera");
});

test("un marcador vacío no crea una promesa", () => {
  // Si el modelo emite `PROMETI:` sin nada, anotarlo termina en un mensaje al jefe a las 6 h
  // diciendo que no pudo medir "". Ruido fabricado por un marcador roto.
  assert.deepEqual(anotarPromesa([], { que: "  ", hilo: HILO, esperando: CAMPO }, T0), []);
  assert.deepEqual(anotarPromesa([], { que: "ok", hilo: null, esperando: null }, T0), []);
});

test("un mixto cumplida+vencida sale en UN mensaje y lo dice en el motivo", () => {
  // El tope es un mensaje por vuelta, así que cuando coinciden no puede tragarse una: la cumplida
  // manda (trae dato) y la vencida viaja en la misma tanda. Que el motivo lo diga es lo que hace
  // auditable el log.
  const OTRO = "placement:otro-dominio.com";
  const retrato = { ...RETRATO, [OTRO]: "SPAM" };
  let lista = anotarPromesa([], { que: "el placement de corp-delivery.com", hilo: HILO, esperando: CAMPO }, T0);
  lista = anotarPromesa(lista, { que: "el placement de otro-dominio.com", hilo: "1754599999.222200", esperando: OTRO }, T0);
  const r = revisarPromesas(lista, retrato, { ...retrato, [CAMPO]: "INBOX" }, mas(HORAS_PARA_VENCER + 1), PREVIO_DE);

  assert.ok(r.aviso);
  assert.match(r.aviso.motivo, /cumplo lo prometido/);
  assert.match(r.aviso.motivo, /1 vencida/);
  assert.equal(r.aviso.hilo, HILO, "manda la cumplida: es la que trae el dato");
  assert.equal(r.aviso.texto.split("\n").length, 2);
});

test("la ventana de silencio son 24 h DE VERDAD, no para siempre", () => {
  // Si la ventana se midiera contra el cierre en vez de contra la disculpa que salió, cada promesa
  // cerrada CALLADA la correría hacia adelante: con el jefe re-preguntando cada pocas horas, la
  // cadena "prometo / se cierra callada / vuelvo a prometer" nunca deja pasar 24 h y el jefe recibe
  // la disculpa UNA vez en la vida del archivo. Silencio permanente disfrazado de enfriamiento.
  const campos = { "cap.frenados": 8 };
  let lista: Promesa[] = [];
  const disculpas: string[] = [];
  // 48 h re-prometiendo cada 3 h lo mismo sobre un dato que no se mueve.
  for (let i = 0; i < 96; i++) {
    const ahora = mas(i * 0.5);
    if (i % 6 === 0) lista = anotarPromesa(lista, { que: "te traigo los dominios frenados", hilo: HILO, esperando: "cap.frenados" }, ahora);
    const r = revisarPromesas(lista, campos, campos, ahora, mas(i * 0.5 - 0.2));
    lista = r.lista;
    if (r.aviso) disculpas.push(ahora);
  }
  assert.equal(disculpas.length, 2, `una por día, no una por vida ni una cada 6,5 h (salieron en ${disculpas.join(", ")})`);
});
