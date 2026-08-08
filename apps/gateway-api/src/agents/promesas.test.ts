import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  HORAS_PARA_VENCER,
  aInstante,
  anotarPromesa,
  porQueNoSePodraCumplir,
  revisarPromesas,
  type Promesa
} from "./promesas.ts";

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
  assert.match(vencida.aviso?.texto ?? "", /nadie está midiendo el placement de corp-delivery\.com/);
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

test("DOS PROMESAS QUE ESPERAN EL MISMO CAMPO CUMPLEN CON EL MISMO DATO: un renglón, no dos", () => {
  // EL DEFECTO QUE ESTE TEST HABRÍA CAZADO, con el archivo real del 2026-08-07: las promesas
  // abiertas en producción eran DOS FORMAS DE PEDIR LO MISMO —"reporte de cómo va la evaluación de
  // los frenados" y "avisar cuando cambie el conteo de dominios frenados"— las dos con
  // `espero=cap.frenados`. `anotarPromesa` no las junta porque el TEXTO difiere, así que el estreno
  // de esta función en el canal era un muro de renglones con la misma novedad repetida. El dedupe
  // es de lo que el jefe LEE: las dos se cierran igual.
  // COPIADAS DEL ARCHIVO REAL (warmup-promesas.json de la Mac Studio, 2026-08-07), y por eso van
  // como literal y no por `anotarPromesa`: el dedupe por términos que se agregó después SÍ las junta
  // hoy, pero éstas ya estaban escritas en producción cuando entró, y las de mañana pueden esperar
  // el mismo campo con textos que no compartan un solo término.
  const dos: Promesa[] = [
    { id: "pm-3", que: "reporte de cómo va la evaluación de los frenados y cualquier dominio que suelte", hilo: HILO, esperando: "cap.frenados", abiertoEn: T0, venceEn: mas(6), visto: 1 },
    { id: "pm-4", que: "avisar cuando cambie el conteo de dominios frenados (alguno liberado)", hilo: HILO, esperando: "cap.frenados", abiertoEn: T0, venceEn: mas(6), visto: 1 }
  ];

  const r = revisarPromesas(dos, { "cap.frenados": 8 }, { "cap.frenados": 7 }, mas(1), PREVIO_DE);
  assert.equal(r.aviso?.texto.split("\n").length, 1, `un renglón por dato: ${r.aviso?.texto}`);
  // Y EN CASTELLANO: decía "cap.frenados pasó de 8 a 7", que es la clave de máquina. El mapa
  // `ETIQUETA` ya existía en slack.ts y este camino no lo usaba.
  assert.match(r.aviso?.texto ?? "", /los dominios frenados pasaron de 8 a 7/);
  assert.doesNotMatch(r.aviso?.texto ?? "", /cap\.frenados/);
  // Las DOS se cierran: se deduplica el mensaje, no el registro.
  assert.deepEqual(r.lista.map((p) => p.comoCerro), ["cumplida", "cumplida"]);

  // Y dos campos DISTINTOS siguen siendo dos renglones: el dedupe no puede comerse una novedad.
  let otras = anotarPromesa([], { que: "los frenados", hilo: HILO, esperando: "cap.frenados" }, T0);
  otras = anotarPromesa(otras, { que: "dónde cae corp-delivery", hilo: HILO, esperando: CAMPO }, T0);
  const r2 = revisarPromesas(otras, { "cap.frenados": 8, [CAMPO]: "SPAM" }, { "cap.frenados": 7, [CAMPO]: "INBOX" }, mas(1), PREVIO_DE);
  assert.equal(r2.aviso?.texto.split("\n").length, 2);
});

test("REGLA DURA: una promesa produce MENSAJES, jamás volumen", () => {
  // Cumplir no puede mover un cap. Si algún día una promesa tiene que disparar `soltar_dominio`,
  // eso lo decide el operador y es otro ítem — no se cuela por acá.
  // Se fija por los imports porque es lo único que no se puede sortear escribiendo más código: sin
  // ejecutor, sin disco y sin red importados, este módulo no puede tener efectos.
  //
  // SE FIJA TRANSITIVAMENTE Y NO CON UNA LISTA DE NOMBRES. La versión anterior era un whitelist de
  // UN import literal, y eso tiene dos problemas: se rompe cuando entra un import legítimo (pasó al
  // reusar `claveLegible` y `enCastellano` de slack.ts, que son texto puro) y no dice nada del
  // import DE ESE import. Lo que hay que garantizar no es "cuántos imports", es que en todo el árbol
  // no haya disco, red, proceso ni base: sin eso, este módulo no puede tener efectos aunque quiera.
  const externos = new Set<string>();
  const vistos = new Set<string>();
  const pila = [new URL("./promesas.ts", import.meta.url)];
  while (pila.length > 0) {
    const u = pila.pop() as URL;
    if (vistos.has(u.pathname)) continue;
    vistos.add(u.pathname);
    for (const m of readFileSync(u, "utf8").matchAll(/\bfrom\s+"([^"]+)"/g)) {
      const spec = m[1] as string;
      if (spec.startsWith(".")) pila.push(new URL(spec, u));
      else externos.add(spec);
    }
  }
  assert.ok(vistos.size > 1, "el barrido tiene que haber seguido al menos un import");
  assert.deepEqual([...externos], [], `el árbol de promesas.ts importa algo de afuera: ${[...externos].join(", ")}`);

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
  // EN CASTELLANO Y NO EN CLAVES DE MÁQUINA. Decía textual "nadie está midiendo eso
  // (placement:no-existe.example)" — el identificador crudo del retrato, en el canal. El dominio,
  // que es la parte accionable, se conserva entero.
  assert.match(vencida.aviso?.texto ?? "", /nadie está midiendo el placement de no-existe\.example/);
  assert.doesNotMatch(vencida.aviso?.texto ?? "", /placement:/, "la clave cruda no sale al canal");
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

test("LOS 4 PENDIENTES REALES SON DOS PROMESAS: el disparador ya es la identidad", () => {
  // Textuales de warmup-promesas.json de la Mac Studio (2026-08-07). pm-1/pm-2 esperan el mismo
  // campo en el mismo hilo con un minuto de diferencia, y pm-3/pm-4 igual: el modelo reformula, que
  // es lo que hacen los modelos, y el dedupe por TEXTO no las juntaba. El jefe terminaba recibiendo
  // dos avisos por cada cosa que le prometieron una vez, y el segundo sin un dato nuevo.
  const reales: Array<[string, string, string]> = [
    ["resultados de medición/diagnóstico de los frenados evaluados", "1786114077.973449", "placement:filing-ops.com"],
    ["resultados de la medición de filing-ops.com y qué decisión tomé con él", "1786114077.973449", "placement:filing-ops.com"],
    ["reporte de cómo va la evaluación de los frenados y cualquier dominio que suelte", "1786127249.643589", "cap.frenados"],
    ["avisar cuando cambie el conteo de dominios frenados (alguno liberado)", "1786127249.643589", "cap.frenados"]
  ];
  let lista: Promesa[] = [];
  reales.forEach(([que, hilo, esperando], i) => {
    lista = anotarPromesa(lista, { que, hilo, esperando }, new Date(Date.parse(T0) + i * 60_000).toISOString());
  });
  assert.equal(lista.length, 2, "dos promesas, no cuatro");
  assert.deepEqual(lista.map((p) => p.visto), [2, 2]);
  assert.deepEqual(lista.map((p) => p.esperando), ["placement:filing-ops.com", "cap.frenados"]);
  // El reloj NO se mueve al re-prometer: volver a prometer es la señal de que todavía no cumplió.
  assert.equal(lista[0]!.abiertoEn, T0);
});

// ── LA PROMESA IMPOSIBLE, DESCUBIERTA AL PROMETER ────────────────────────────────────────────────

/** Textuales de warmup-promesas.json (Mac Studio, 2026-08-07): las dos sobre un dominio en cap 0. */
const PM_1 = "resultados de medición/diagnóstico de los frenados evaluados";
const PM_2 = "resultados de la medición de filing-ops.com y qué decisión tomé con él";
const FRENADO = "placement:filing-ops.com";

test("UNA PROMESA SOBRE UN DOMINIO EN CAP 0 SE ANOTA Y SE LO DICE EN EL MOMENTO", () => {
  // EL INCIDENTE, con los datos del archivo real: pm-1 y pm-2 se abrieron a las 14:48 y 14:49
  // esperando `placement:filing-ops.com` y se cerraron "vencida" a las 20:58:53.920Z. filing-ops.com
  // tiene `cap: 0` en sender-cap.json y CERO filas en warmup_activity en toda la historia de la
  // tabla: no puede mandar, así que nunca iba a existir una medición que avisar. El sistema hizo lo
  // correcto —venció en voz alta— pero el jefe esperó 6 horas por algo que era imposible en el
  // instante en que se prometió.
  const frenados = ["filing-ops.com", "bizregistry-ops.com"];
  const motivo = porQueNoSePodraCumplir(FRENADO, frenados);
  assert.ok(motivo, "no dijo nada sobre un dominio que no puede mandar");
  assert.match(motivo, /filing-ops\.com/);
  assert.match(motivo, /cap 0/);
  assert.match(motivo, /soltarlo/, "y dice qué hacer: la imposibilidad es CONDICIONAL, no permanente");

  // LA PROMESA QUEDA IGUAL, marcada `callada`. Rechazarla la borraría en silencio y el agente YA
  // dijo "te aviso" en el canal: eso es la queja 1 ("promete y desaparece") reconstruida adentro del
  // arreglo de la queja 1. Y cap 0 es exactamente lo que `soltar_dominio` cambia.
  let lista = anotarPromesa([], { que: PM_1, hilo: HILO, esperando: FRENADO, callada: motivo !== null }, T0);
  assert.equal(lista.length, 1, "se anota igual");
  assert.equal(lista[0]?.callada, true);
  // La segunda es la MISMA promesa (mismo campo, mismo hilo) y no apaga la marca.
  lista = anotarPromesa(lista, { que: PM_2, hilo: HILO, esperando: FRENADO, callada: true }, mas(0.02));
  assert.equal(lista.length, 1);
  assert.equal(lista[0]?.callada, true, "`callada` es de un solo sentido: nunca se apaga");

  // A las 6 h se cierra SIN una segunda disculpa: ya se lo dijimos en el mismo mensaje.
  const r = revisarPromesas(lista, RETRATO, RETRATO, mas(HORAS_PARA_VENCER + 1), PREVIO_DE);
  assert.equal(r.aviso, null, "no le pide perdón por algo que ya le avisó al prometer");
  assert.equal(r.lista[0]?.comoCerro, "vencida");
});

test("UNA CALLADA POR IMPOSIBLE IGUAL CUMPLE SI LO SUELTAN", () => {
  // Es el test que hace que RECHAZAR la promesa sea la opción equivocada. `cap: 0` no es una
  // condena: `soltar_dominio` lo cambia, y el día que el operador lo suelte va a aparecer
  // `placement:filing-ops.com` en el retrato. La promesa tiene que estar viva para cumplirla.
  const lista = anotarPromesa([], { que: PM_2, hilo: HILO, esperando: FRENADO, callada: true }, T0);
  const r = revisarPromesas(lista, { "cap.frenados": 8 }, { [FRENADO]: "INBOX" }, mas(1), PREVIO_DE);
  assert.match(r.aviso?.texto ?? "", /INBOX/, "lo soltaron, midió, y el aviso SALE con el dato");
  assert.equal(r.lista[0]?.comoCerro, "cumplida");
});

test("NUNCA SE JUZGA POR AUSENCIA: el predicado lee PRESENCIA en una lista, no falta de dato", () => {
  // Las dos razones por las que el chequeo contra el retrato se sacó a propósito (ver el comentario
  // largo de `anotarPromesa`): degradaba TODA promesa legítima sobre un dominio nuevo a genérica
  // —los tres dominios de la conversación real del 2026-08-06 no tenían un solo ciclo— y un `campos`
  // vacío por un `.catch(() => null)` las mataba a todas. Éste mira la lista POSITIVA de frenados y
  // solo dictamina cuando el nombre ESTÁ adentro.
  assert.equal(porQueNoSePodraCumplir("placement:corp-delivery.com", []), null, "en el pool, todavía sin ciclos ⇒ se anota");
  // `frenados: null` = la medición del cupo está vencida (>12 h). El 2026-08-04 sender-cap.json
  // decía 2000 en nodos que en vivo estaban en 0, y un reparo falso enseña a ignorar todos los demás.
  assert.equal(porQueNoSePodraCumplir(FRENADO, null), null, "sin medición fresca del cupo no hay veredicto");
  assert.equal(porQueNoSePodraCumplir(null, ["filing-ops.com"]), null, "sin disparador no hay nada que juzgar");
  assert.equal(porQueNoSePodraCumplir("cap.frenados", ["filing-ops.com"]), null, "una clave que no es placement: no la toca");
});

test("`plan:X.enPool` SOBRE UN FRENADO NO SE MARCA: ésa es LA promesa legítima sobre un frenado", () => {
  // "Avísame cuando vuelva a calentar" es exactamente lo que uno promete sobre un dominio en cap 0,
  // y `plan:X.enPool` yendo de 0 a 1 es el cumplimiento. Un predicado que mirara solo "está en
  // frenados" la mataría — por eso mira `placement:` y nada más.
  assert.equal(porQueNoSePodraCumplir("plan:filing-ops.com.enPool", ["filing-ops.com"]), null);
  assert.equal(porQueNoSePodraCumplir("plan:filing-ops.com.accion", ["filing-ops.com"]), null);
  // Y el nombre se compara en minúsculas y sin espacios: el modelo escribe como quiere.
  assert.ok(porQueNoSePodraCumplir("placement:FILING-OPS.com", [" filing-ops.com "]));
});

// ── LA PROMESA POR FECHA ─────────────────────────────────────────────────────────────────────────

/** "el lunes a las 5pm hora Colombia", ya convertido por el modelo a hora de pared. */
const CITA = "2026-08-10T17:00";
const CITA_UTC = "2026-08-10T22:00:00.000Z";

test("LAS 5PM DE BOGOTÁ SON LAS 5PM DE BOGOTÁ, corra la máquina donde corra", () => {
  // MEDIDO: la Studio corre en America/New_York (`ssh studio date` → EDT, offset 240) y
  // `grep -c '^TZ=' config/gateway.env` da 0. Ahí `Date.parse("2026-08-10T17:00")` devuelve 21:00Z
  // cuando las 5pm de Bogotá son 22:00Z: UNA HORA ANTES. Y solo de marzo a noviembre, así que en
  // horario de invierno el bug pasa cualquier prueba. El offset de Colombia va explícito y fijo
  // (-05:00, sin horario de verano desde 1993): la única zona que entra en la cuenta es la del jefe,
  // que es constante; la de la máquina, que no lo es, no aparece.
  const original = process.env.TZ;
  try {
    for (const tz of ["America/New_York", "Etc/UTC", "Asia/Tokyo"]) {
      process.env.TZ = tz;
      assert.equal(aInstante(CITA, T0), CITA_UTC, `con TZ=${tz} la cita se movió`);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("UNA FECHA QUE NO EXISTE NO DISPARA, Y NO TUMBA LA PROMESA", () => {
  // El 30 de febrero NO da NaN: `Date.parse("2026-02-30T17:00:00-05:00")` es aceptado y corrido al 2
  // de marzo (verificado). El round-trip contra Intl/America-Bogota es lo único que ve esa corrida
  // silenciosa — sin él, la cita saldría tres días tarde y nadie sabría por qué.
  assert.equal(aInstante("2026-02-30T17:00", T0), null, "el 30 de febrero se corre solo al 2 de marzo");
  assert.equal(aInstante("2026-08-05T17:00", T0), null, "una cita en el pasado dispararía en la vuelta siguiente");
  assert.equal(aInstante("2026-10-20T17:00", T0), null, "a más de 30 días es el modelo inventando, no el jefe pidiendo");
  assert.equal(aInstante("el lunes", T0), null, "el instante lo emite el modelo YA convertido a absoluto");
  assert.equal(aInstante(null, T0), null);
  assert.equal(aInstante("2026-08-10T24:00", T0), null, "hora fuera de rango");

  // Y EN LOS TRES CASOS LA PROMESA SE ANOTA IGUAL: sin cita, vence a las 6 h y dice algo. Una fecha
  // que no se pudo leer no puede borrar lo que el jefe pidió.
  for (const cuando of ["2026-02-30T17:00", "el lunes", "2026-10-20T17:00"]) {
    const lista = anotarPromesa([], { que: "el reporte de la fábrica", hilo: HILO, esperando: null, cuando }, T0);
    assert.equal(lista.length, 1, `"${cuando}" tumbó la promesa`);
    assert.equal(lista[0]?.cuandoEn, undefined, `"${cuando}" no puede quedar como cita`);
    assert.equal(lista[0]?.venceEn, mas(HORAS_PARA_VENCER), `"${cuando}" tiene que vencer a las 6 h como cualquier genérica`);
    const r = revisarPromesas(lista, RETRATO, RETRATO, mas(HORAS_PARA_VENCER + 1), PREVIO_DE);
    assert.ok(r.aviso, `"${cuando}" venció en silencio`);
  }
});

test("LA CITA NO SE MUERE ANTES DE LA HORA NI LA FRENA UNA DISCULPA", () => {
  // El jefe dijo "el lunes a las 5pm hora Colombia" y el agente contestó "queda anotado" — y no
  // había NADA que lo trajera de vuelta el lunes. Con el vencimiento colgado de `abiertoEn`, la
  // promesa del lunes hecha el jueves se cerraba el JUEVES a la noche con una disculpa por algo que
  // todavía no tocaba.
  const lista = anotarPromesa([], { que: "el reporte de la fábrica", hilo: HILO, esperando: null, cuando: CITA }, T0);
  assert.equal(lista[0]?.cuandoEn, CITA_UTC);
  assert.equal(lista[0]?.esperando, null, "la fecha NUNCA viaja como `esperando`: no es un campo observable");

  const temprano = revisarPromesas(lista, RETRATO, RETRATO, mas(HORAS_PARA_VENCER + 1), PREVIO_DE);
  assert.equal(temprano.aviso, null, "a las 6 h todavía no es lunes");
  assert.equal(temprano.lista[0]?.cerradaEn, undefined, "y sigue viva");

  // AHORA LA HORA. Con una disculpa que salió hace 10 minutos (el freno caliente), con el snapshot
  // previo VACÍO (el `.catch(() => null)` del orquestador) y sin saber de cuándo es: una cita se
  // cumple con el reloj, no con un campo, así que nada de eso la puede tapar.
  const reciente: Promesa = {
    id: "pm-vieja",
    que: "los dominios frenados",
    hilo: HILO,
    esperando: "cap.frenados",
    abiertoEn: T0,
    venceEn: "2026-08-10T22:00:00.000Z",
    visto: 1,
    cerradaEn: "2026-08-10T22:00:00.000Z",
    comoCerro: "vencida",
    anuncioEn: "2026-08-10T22:00:00.000Z"
  };
  const r = revisarPromesas([...temprano.lista, reciente], {}, {}, "2026-08-10T22:10:00.000Z", null);
  assert.ok(r.aviso, "llegó la hora y no dijo nada");
  assert.equal(r.aviso.texto.split("\n").length, 1, `exactamente un mensaje: ${r.aviso.texto}`);
  assert.match(r.aviso.texto, /el reporte de la fábrica/, "recita lo que él pidió, con sus palabras");
  assert.match(r.aviso.texto, /Aquí estoy/);
  assert.doesNotMatch(r.aviso.texto, /2026-08-10|22:00|Z\b/, "cero formateo de fechas en la salida: `que` ya trae las palabras del jefe");
  assert.equal(r.aviso.pide, true, "suena el móvil: la hora la eligió él");
  assert.equal(r.lista[0]?.comoCerro, "cumplida");

  // Y NO VUELVE A SONAR.
  assert.equal(revisarPromesas(r.lista, {}, {}, "2026-08-10T22:20:00.000Z", null).aviso, null);
});

test("SI LA MÁQUINA DURMIÓ MÁS DE LA GRACIA, la cita se cierra pidiendo perdón, no en silencio", () => {
  // Las 6 h se reusan como ventana de GRACIA: si la Studio durmió (17 reinicios en 29 h el
  // 2026-08-06), el recordatorio sale igual al despertar dentro de esas 6 h. Pasado ese plazo ya no
  // es un recordatorio útil, y callarse sería la queja 1 otra vez.
  const lista = anotarPromesa([], { que: "el reporte de la fábrica", hilo: HILO, esperando: null, cuando: CITA }, T0);
  const aDestiempo = revisarPromesas(lista, {}, {}, "2026-08-11T05:00:00.000Z", null);
  assert.match(aDestiempo.aviso?.texto ?? "", /se me pasó la hora/);
  assert.equal(aDestiempo.lista[0]?.comoCerro, "vencida");
});

test("CAMBIAR LA HORA NO DEJA DOS RECORDATORIOS", () => {
  // "Mejor el martes" no es una promesa nueva: es LA MISMA cita movida. Sin identidad propia quedan
  // dos recordatorios vivos y suenan los dos. Es lo CONTRARIO de la regla de las de campo, a
  // propósito: re-prometer un campo prueba que todavía no cumplió (estirar el plazo sería no vencer
  // nunca); re-prometer una fecha ES la cita nueva.
  let lista = anotarPromesa([], { que: "el reporte de la fábrica", hilo: HILO, esperando: null, cuando: CITA }, T0);
  lista = anotarPromesa(lista, { que: "el reporte de la fabrica, mejor el martes", hilo: HILO, esperando: null, cuando: "2026-08-11T17:00" }, mas(1));
  assert.equal(lista.length, 1, "una sola cita viva");
  assert.equal(lista[0]?.cuandoEn, "2026-08-11T22:00:00.000Z", "manda la última hora que dijo");
  assert.equal(lista[0]?.venceEn, "2026-08-12T04:00:00.000Z", "y la gracia se mueve con ella");
  assert.equal(lista[0]?.visto, 2);
  // El lunes a las 5pm ya no suena nada.
  assert.equal(revisarPromesas(lista, {}, {}, "2026-08-10T22:10:00.000Z", null).aviso, null);

  // Y LA REGLA DE LAS DE CAMPO NO SE TOCA: re-prometer un campo NO estira el plazo.
  const una = promesa();
  const dos = anotarPromesa(una, { que: "el placement de corp-delivery.com", hilo: HILO, esperando: CAMPO }, mas(3));
  assert.equal(dos[0]?.venceEn, una[0]?.venceEn);
});

test("LA VOZ DEL REPARO: colombiano con tuteo, sin claves de máquina", () => {
  // Es lo que el agente le dice al jefe en el canal, así que pasa por el mismo embudo que el resto.
  const t = porQueNoSePodraCumplir(FRENADO, ["filing-ops.com"]) ?? "";
  assert.match(t, /\bquieres\b/, "tuteo colombiano");
  assert.doesNotMatch(t, /\b(querés|tenés|podés|avisáme|dale)\b/i, "sin voseo: la voz del agente es colombiana");
  assert.doesNotMatch(t, /placement:|cap\.frenados|sender-cap/, "la clave cruda y los nombres de archivo no salen al canal");
  assert.doesNotMatch(t, /[*"`_]/, "y pasó por `enCastellano`: sin comillas, asteriscos ni snake_case");
});

test("el MISMO disparador en OTRO hilo es otra promesa: son dos conversaciones", () => {
  // El jefe está leyendo dos hilos, y una respuesta dentro de un hilo no suena en el otro.
  let lista = anotarPromesa([], { que: "te traigo el placement", hilo: "h1", esperando: "placement:a.com" }, T0);
  lista = anotarPromesa(lista, { que: "te traigo el placement", hilo: "h2", esperando: "placement:a.com" }, T0);
  assert.equal(lista.length, 2);

  // Y disparadores DISTINTOS en el mismo hilo también son dos: no hay heurístico que discutir.
  let otra = anotarPromesa([], { que: "te aviso de esto", hilo: "h1", esperando: "placement:a.com" }, T0);
  otra = anotarPromesa(otra, { que: "te aviso de esto", hilo: "h1", esperando: "cap.frenados" }, T0);
  assert.equal(otra.length, 2);
});

// ── LAS DOS CLAVES JUNTAS: LO DECIDE EL CÓDIGO, NO EL PROMPT ────────────────────────────────────

test("con `espero=` Y `cuando=` gana el CAMPO: la cita perdía el disparador y estiraba su vencimiento", () => {
  // EL DEFECTO (encontrado por QA antes de desplegar, 2026-08-07). `anotarPromesa` guardaba las dos,
  // y `revisarPromesas` abre con `if (p.cuandoEn !== undefined) { … continue; }` INCONDICIONAL: la
  // rama del campo observable no corría NUNCA. Reproducido con el código real: promesa sobre
  // `placement:corp-delivery.com` con cita el lunes 5pm; el placement cambia de verdad de SPAM a
  // INBOX dos horas después y `revisarPromesas` devolvía `aviso: null`. El jefe no se enteraba del
  // dato que pidió, y encima `venceEn` saltaba de 6 h a cuatro días: la promesa tampoco vencía.
  //
  // Lo único que lo prevenía era una regla EN PROSA dentro del prompt ("no se combina con espero="),
  // que es textualmente el modo de falla que este repo declara haber pagado: un criterio en prosa el
  // modelo lo devuelve como hallazgo propio, y si es falso lo devuelve con seguridad. Y no es un
  // borde inventado: hay un test que EXIGE que `extraerPromesa` devuelva las dos claves juntas.
  //
  // GANA `esperando`, y el criterio es cuál falla mejor: con el campo, el jefe recibe el DATO que
  // pidió —quizás antes de la hora, que no es un fallo— y la promesa conserva su vencimiento de 6 h,
  // que al menos dice algo. Con la cita, el dato se pierde en silencio hasta el lunes.
  const lista = anotarPromesa([], { que: "te aviso apenas caiga la medición", hilo: HILO, esperando: CAMPO, cuando: CITA }, T0);
  assert.equal(lista[0]?.esperando, CAMPO);
  assert.equal(lista[0]?.cuandoEn, undefined, "la cita se descarta: no puede tapar el disparador");
  assert.equal(lista[0]?.venceEn, mas(HORAS_PARA_VENCER), "y el vencimiento sigue siendo el de una promesa de campo");

  // Y EL CAMPO CUMPLE DE VERDAD: SPAM → INBOX dos horas después de prometer.
  const r = revisarPromesas(lista, RETRATO, { ...RETRATO, [CAMPO]: "INBOX" }, mas(2), PREVIO_DE);
  assert.ok(r.aviso, "el cambio real del campo tiene que avisar");
  assert.match(r.aviso!.texto, /de SPAM a INBOX/);
  assert.equal(r.lista[0]?.comoCerro, "cumplida");
});

test("una CITA con fecha ilegible se cierra, no queda abierta para siempre", () => {
  // La rama del campo tiene ese guard desde su primer día ("Una promesa cuya fecha no se puede leer
  // se cierra en vez de quedar abierta para siempre"); la rama de la cita nació sin él: con
  // `cuandoEn` sin parsear no entraba a ninguna de sus tres salidas y caía al `continue`.
  // Reproducido: 400 días de vueltas y la promesa seguía abierta, ocupando lugar en el archivo
  // —donde `recortar` NO puede tirar una abierta— y sin decirle nada al jefe.
  const rota: Promesa[] = [
    {
      id: "pm-x",
      que: "el reporte de la fábrica",
      hilo: HILO,
      esperando: null,
      abiertoEn: T0,
      venceEn: mas(HORAS_PARA_VENCER),
      cuandoEn: "el lunes a las 5",
      visto: 1
    }
  ];
  const r = revisarPromesas(rota, RETRATO, RETRATO, mas(24 * 400), PREVIO_DE);
  assert.ok(r.aviso, "tiene que decir algo en vez de evaporarse");
  assert.equal(r.lista[0]?.comoCerro, "vencida");
  assert.ok(r.lista[0]?.cerradaEn, "y quedar cerrada");
});
