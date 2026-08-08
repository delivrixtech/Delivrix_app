#!/usr/bin/env bash
# UNA foto de producción, para que nadie más tenga que ir a buscarla.
#
# POR QUÉ EXISTE. La noche del 2026-08-07 corrieron cinco equipos de agentes sobre la fábrica y TRES
# quedaron bloqueados por política de seguridad: cada uno abría su propio SSH contra la Studio y
# contra los nodos SMTP para leer los mismos cuatro archivos. Uno de los bloqueados era justo el que
# tenía que producir la tabla de los 58 nodos, así que el entregable más importante de esa corrida no
# existió. El problema no era la política —leer producción cincuenta y ocho veces para lo mismo es
# una mala práctica con o sin política—: era la arquitectura del trabajo.
#
# Con esto el acceso a producción ocurre UNA vez, de forma trazable y con el operador en el loop, y
# los agentes trabajan sobre una copia local. Tres cosas que se ganan además del desbloqueo:
#
#   · REPRODUCIBILIDAD. Dos agentes que miran la misma foto llegan al mismo número. Contra
#     producción viva no: la ventana del sensor se corre y el 2026-08-08 eso hizo que dos lecturas
#     con SEIS HORAS de diferencia dieran 35 nodos bloqueados y 1, y casi lo diagnosticamos como un
#     bug de código. La foto lleva su `tomadaEn` justamente para que eso no se pueda confundir.
#   · COSTO. 58 sesiones SSH contra VPS por cada agente, contra una.
#   · SEGURIDAD. La superficie de acceso a la infraestructura de envío deja de escalar con la
#     cantidad de agentes.
#
# NO reemplaza medir de verdad: es una FOTO, y una foto envejece. Para decidir sobre el estado de
# AHORA hay que volver a tomarla. Por eso el manifiesto guarda la hora y todo lector la ve.
#
# ── LO QUE LE FALTABA, MEDIDO SOBRE LA FOTO DEL 2026-08-08T14:40Z ────────────────────────────────
#
# La primera versión copiaba los archivos y estampaba UNA hora. Contra las preguntas que de verdad
# se hicieron esa noche, se quedó corta en cuatro lugares, y los cuatro están arreglados acá:
#
#   1. UNA SOLA HORA PARA VEINTIÚN ARCHIVOS DE EDADES DISTINTAS. En esa foto, `sender-measurement`
#      tenía 24 minutos, `sender-cap` 5 h 22, `warmup-reputacion` 14 h 38 y `webdock-servers` 68
#      DÍAS. El encabezado decía "tomada 14:40" y era verdad para la carpeta y mentira para casi
#      todo lo de adentro. Ahora el manifiesto trae la edad de CADA archivo.
#   2. EL `scp` BORRABA LA EDAD. Sin `-p`, la copia local nace con la hora de la copia, así que los
#      OCHO archivos del inventario que no traen sello propio adentro (warmup-seeds, warmup-slack,
#      decisiones-del-jefe…) se quedaban literalmente sin ninguna forma de fecharse. Un carácter.
#   3. NO HABÍA NADA DEL HOST. Ni si los servicios estaban vivos, ni si el árbol de producción
#      tenía cambios sin commitear (con lo cual la línea "commit desplegado" puede estar mintiendo),
#      ni qué flags estaban prendidos. Un archivo del inventario lo escribe un SERVICIO: si el
#      servicio está caído, el archivo es un fósil por más nueva que sea la foto — y eso no se veía.
#   4. LOS LOGS SE RECORTABAN EN SILENCIO. `warmup-monitor.log` salía con exactamente 4000 líneas y
#      nada decía que atrás había 124.000 más. Y dos de los logs (`warmup-daemon`, `warmup-cupo`) no
#      escriben fecha en sus líneas, así que "vuelta #28" no se puede ubicar en el tiempo: eso ahora
#      está declarado como límite en vez de descubrirse a mano.
#
#   bash scripts/ops/foto-produccion.sh [destino]
#
# Solo lectura: copia archivos JSON del inventario, recorta logs y pregunta por el estado del host.
# No escribe nada en producción, no reinicia nada, no manda un correo.
#
# CÓMO SE PRUEBA SIN TOCAR PRODUCCIÓN. `DELIVRIX_RAIZ` apunta a un árbol de mentira y `ssh`/`scp`
# se reemplazan por dos shims de tres líneas que corren local (`shift; exec "$@"` y `cp -p`):
#
#   PATH=/tmp/shims:$PATH DELIVRIX_RAIZ=/tmp/raiz-falsa bash scripts/ops/foto-produccion.sh /tmp/out
#
# Con eso se ejercita todo el camino —secciones, tabla de edades, manifiesto— sin una sola conexión.
# La parte que un árbol de mentira NO puede probar es el comportamiento del host real (launchctl,
# permisos): ahí el script está escrito para decir NO SÉ, nunca para inventar un negativo.

set -euo pipefail

DESTINO="${1:-.foto-produccion}"
REMOTO="${DELIVRIX_SSH_HOST:-studio}"
# La raíz de producción. Es override-able SÓLO para poder probar este script contra un árbol de
# mentira: sin eso, la única forma de ejercitarlo era correrlo contra la Studio, que es exactamente
# lo que el script existe para evitar. En producción nadie la pasa.
RAIZ="${DELIVRIX_RAIZ:-/Users/Shared/delivrix}"
# Cuántas líneas de cada log viajan. Vive en UNA variable porque el número lo usan dos lados: el
# `tail` de acá y el aviso de "RECORTADO" que arma el remoto. Con dos copias, el día que alguien
# suba el tail el manifiesto empieza a mentir sobre cuánto se recortó.
TAIL=4000
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/produccion/lib.sh"

# shellcheck source=scripts/produccion/lib.sh
source "${LIB}"

mkdir -p "$DESTINO/inventory" "$DESTINO/logs"

echo "tomando la foto de $REMOTO ..."

# EL INVENTARIO: los archivos que deciden el pool, la cuota y los veredictos de salud.
#
# `-p` NO ES DETALLE: preserva la hora de modificación del original. Ocho de los veintiún archivos
# no traen ningún sello de tiempo adentro (warmup-seeds.json, warmup-slack.json,
# decisiones-del-jefe.json, warmup-promesas.json…), así que sin `-p` su ÚNICA edad posible era la
# hora de la copia — o sea, todos parecían recién nacidos. Con `-p`, la tabla de edades del
# manifiesto puede fechar hasta los que no se fechan solos.
scp -qp "$REMOTO:$RAIZ/runtime/openclaw-workspace/inventory/"*.json "$DESTINO/inventory/" 2>/dev/null || {
  echo "ERROR: no pude leer el inventario de $REMOTO. ¿Está levantada la Studio y el alias SSH configurado?" >&2
  exit 1
}

# EL ESTADO DEL HOST, EN UNA SOLA SESIÓN. Todo lo que no es un archivo pero decide cómo se lee un
# archivo: reloj, commit, si el árbol está sucio, si los servicios están vivos, qué tan recortado
# quedó cada log y qué flags están prendidos.
#
# Se manda por STDIN con `bash -s` en vez de armar una línea gigante entre comillas: así las dos
# funciones que vienen de lib.sh viajan con `declare -f` y corren ALLÁ EXACTAMENTE EL MISMO CÓDIGO
# que está probado ACÁ (produccion.test.sh). Una copia del parseo de `launchctl` adentro de una
# comilla remota es una copia que se separa del test en cuanto alguien la toca, y entonces la foto
# afirma cosas que ningún test sostiene.
{
  declare -f delivrix_env_seguro delivrix_launchd_campos
  cat <<'REMOTO_SH'
raiz="$1"
tope="$2"
echo "## RELOJ"
date -u +"%Y-%m-%dT%H:%M:%SZ"

# EL COMMIT SOLO NO ALCANZA. Un árbol con cambios sin commitear corre código que NO está en ese
# commit, y la línea "commit desplegado" pasa a ser una media verdad. Se declaran los dos.
echo "## GIT"
if cd "$raiz" 2>/dev/null; then
  echo "commit:  $(git log --oneline -1 2>/dev/null || echo '?')"
  echo "rama:    $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  sucio="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${sucio:-0}" = "0" ]; then
    echo "árbol:   limpio (lo que corre ES ese commit)"
  else
    echo "árbol:   ${sucio} archivos SIN COMMITEAR — lo que corre NO es exactamente ese commit"
  fi
else
  echo "(no pude entrar a $raiz)"
fi

# LOS SERVICIOS. Cada archivo del inventario lo escribe uno de estos: `sender-measurement.json` lo
# escribe flota-salud, `sender-cap.json` lo escribe warmup-cupo, `warmup-monitor.json` lo escribe
# warmup-monitor. Un servicio caído deja su archivo congelado sin que nada más lo delate, y la foto
# lo seguiría mostrando como si fuera el estado de hoy.
echo "## SERVICIOS"
for s in gateway panel warmup-daemon warmup-monitor warmup-cupo flota-salud; do
  if salida="$(launchctl print "system/com.delivrix.$s" 2>/dev/null)"; then
    campos="$(delivrix_launchd_campos "$salida")"
    printf '%-15s estado=%s pid=%s ultimo_exit=%s arranques=%s\n' "$s" \
      "$(echo "$campos" | cut -d'|' -f1)" "$(echo "$campos" | cut -d'|' -f2)" \
      "$(echo "$campos" | cut -d'|' -f3)" "$(echo "$campos" | cut -d'|' -f4)"
  else
    # NO SÉ, y no "caído": `launchctl print` también falla por permisos. La lección del probe que se
    # colgaba (2026-07-29, 10 de 10 negativos falsos) es que un chequeo que no se pudo hacer no es
    # un negativo.
    printf '%-15s NO SÉ (launchctl print falló: plist no cargado, o sin permiso para consultarlo)\n' "$s"
  fi
done

# LOS LOGS ENTEROS, PARA SABER CUÁNTO SE RECORTÓ. La foto se lleva las últimas 4000 líneas; sin este
# bloque, un log de 128.000 líneas y uno de 900 se ven idénticos en destino y nadie sabe cuál está
# truncado. Y la hora del último renglón es la respuesta directa a "¿este servicio sigue escribiendo?".
echo "## LOGS"
for f in "$raiz"/runtime/logs/*.log; do
  [ -f "$f" ] || continue
  # ponytail: `wc -l` lee el archivo entero. Hoy el más grande de la flota son ~130k líneas y tarda
  # menos de un segundo en la Studio. Si algún log llega a los GB, esto pasa a `stat -f %z` y la
  # cuenta de líneas se estima; recién ahí vale la pena.
  n="$(wc -l < "$f" | tr -d ' ')"
  if [ "${n:-0}" -gt "$tope" ] 2>/dev/null; then corte="RECORTADO — la copia trae sólo las últimas ${tope}"; else corte="completo"; fi
  printf '%-26s %8s líneas · %5s · último cambio %s · %s\n' "$(basename "$f")" \
    "$n" \
    "$(du -h "$f" 2>/dev/null | cut -f1 | tr -d ' ')" \
    "$(TZ=UTC stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%SZ' "$f" 2>/dev/null || echo '?')" \
    "$corte"
done

# QUÉ HAY EN EL INVENTARIO. La foto copia `*.json` y nada más: si mañana aparece un `.jsonl`, un
# subdirectorio o un archivo nuevo, acá se ve que existe y que NO viajó. Ausencia declarada en vez
# de ausencia silenciosa.
echo "## INVENTARIO_REMOTO"
ls -l "$raiz/runtime/openclaw-workspace/inventory/" 2>/dev/null | tail -n +2 || echo "(no pude listar)"

# LOS FLAGS. Sólo se publica el valor cuando no puede ser un secreto por su forma (true/false o un
# entero corto); el resto sale `(oculto)`. Ver `delivrix_env_seguro` en lib.sh: la lista es de
# FORMAS permitidas, no de nombres prohibidos, porque una lista de nombres es una lista que alguien
# se olvida de actualizar el día que agrega una credencial nueva.
#
# Para qué: sin esto, un agente no puede distinguir "WARMUP_AGENT_PUEDE_SOLTAR está apagado" de "ese
# flag no existe". Ausencia leída como apagado es la misma trampa que este proyecto ya pagó tres veces.
echo "## ENTORNO"
if [ -f "$raiz/config/gateway.env" ]; then
  delivrix_env_seguro < "$raiz/config/gateway.env"
else
  echo "(no encontré config/gateway.env)"
fi
echo "## FIN"
REMOTO_SH
} | ssh "$REMOTO" bash -s -- "$RAIZ" "$TAIL" > "$DESTINO/estado.txt" 2>/dev/null || true

# Si la sesión de estado no salió, el manifiesto tiene que DECIRLO. Un bloque vacío jamás se lee
# como "no había nada que reportar".
seccion() {
  local s
  s="$(awk -v m="## $1" '$0==m{f=1;next} /^## /{f=0} f' "$DESTINO/estado.txt" 2>/dev/null || true)"
  [ -n "$s" ] && printf '%s\n' "$s" || echo "  NO SÉ — la sesión de estado no devolvió esta sección"
}

# LOS LOGS, RECORTADOS. Enteros son cientos de MB y nadie los lee así; los últimos miles de líneas
# cubren lo que se investiga. `|| true` porque un log que todavía no existe no es un error — y la
# sección ## LOGS del estado dice cuáles existen de verdad, así que un log ausente se ve.
#
# `panel` estaba afuera y es uno de los seis servicios: cuando el panel se cae, su log es el único
# lugar donde eso queda escrito.
for log in warmup-monitor warmup-daemon warmup-cupo flota-salud gateway panel watchdog-launchd; do
  ssh "$REMOTO" "tail -n $TAIL $RAIZ/runtime/logs/$log.log 2>/dev/null" > "$DESTINO/logs/$log.log" 2>/dev/null || true
  [ -s "$DESTINO/logs/$log.log" ] || rm -f "$DESTINO/logs/$log.log"
done

# LA TABLA DE EDADES. Es la corrección del defecto central de la primera versión: una foto tiene UNA
# hora y adentro conviven archivos de cuatro minutos con archivos de sesenta y ocho días.
#
# El sello propio del archivo (`medidoEn`, `updatedAt`, `generadoEn`) le gana al mtime porque dice
# CUÁNDO SE MIDIÓ, no cuándo se escribió el archivo; para los ocho que no traen ninguno, el mtime que
# preservó `scp -p` es la única edad que existe.
EDADES="$(DESTINO="$DESTINO" node - <<'JS' 2>/dev/null || echo "  NO SÉ — no pude calcular las edades (¿node?)"
const fs = require("node:fs"), path = require("node:path");
const dir = path.join(process.env.DESTINO, "inventory");
const CLAVES = ["medidoEn", "generadoEn", "actualizadoEn", "updatedAt"];
const ahora = Date.now();
const edad = (ms) => {
  const m = Math.round((ahora - ms) / 60000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d`;
};
const filas = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
  const p = path.join(dir, f);
  let sello = null, de = "mtime";
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const k of CLAVES) {
      if (typeof j?.[k] === "string" && !Number.isNaN(Date.parse(j[k]))) { sello = j[k]; de = k; break; }
    }
  } catch { de = "mtime (no es JSON legible)"; }
  const t = sello ? Date.parse(sello) : fs.statSync(p).mtimeMs;
  return { f, cuando: new Date(t).toISOString().replace(/\.\d+Z$/, "Z"), edad: edad(t), de, t };
});
// Ordenadas de más VIEJA a más nueva: lo peligroso es lo de arriba, y así se lee primero.
filas.sort((a, b) => a.t - b.t);
for (const r of filas) console.log(`  ${r.f.padEnd(30)} ${r.cuando}  ${r.edad.padStart(8)}  (${r.de})`);
JS
)"

# El sello del archivo que DECIDE EL POOL, aparte de todo lo demás: es el único número que hay que
# mirar antes de afirmar algo sobre la salud de la flota.
MEDIDO="$(grep -m1 -oE '"medidoEn": *"[^"]+"' "$DESTINO/inventory/sender-measurement.json" 2>/dev/null | grep -oE '[0-9T:.Z-]{20,}' || echo "?")"
VENCE="$(node -e 'const t=Date.parse(process.argv[1]);process.stdout.write(Number.isNaN(t)?"?":new Date(t+6*3600e3).toISOString().replace(/\.\d+Z$/,"Z"))' "$MEDIDO" 2>/dev/null || echo "?")"

cat > "$DESTINO/MANIFIESTO.txt" <<EOF
FOTO DE PRODUCCIÓN — Delivrix
tomada en:        $(date -u +"%Y-%m-%dT%H:%M:%SZ") (UTC, reloj de la máquina que la tomó)
reloj del remoto: $(seccion RELOJ | tr -d '\n')
host:             $REMOTO ($RAIZ)
archivos:         $(ls -1 "$DESTINO/inventory" 2>/dev/null | wc -l | tr -d ' ') del inventario, $(ls -1 "$DESTINO/logs" 2>/dev/null | wc -l | tr -d ' ') logs recortados a ${TAIL} líneas

QUÉ ESTÁ CORRIENDO ALLÁ
$(seccion GIT | sed 's/^/  /')

═══ LA HORA QUE IMPORTA NO ES LA DE ARRIBA ═══════════════════════════════════════════════════════

El dato que decide QUÉ DOMINIOS CALIENTA EL WARMUP es inventory/sender-measurement.json, y lo
reescribe el servicio flota-salud cada 6 h. En esta foto está medido a las ${MEDIDO} y el
próximo barrido lo reemplaza alrededor de las ${VENCE}. Después de esa hora, esta foto no
describe la flota de ahora.

Y el veredicto de salud se calcula sobre una VENTANA DE 5 DÍAS QUE SE CORRE SOLA: un nodo que dejó
de mandar PORQUE está bloqueado pierde su evidencia a los 5 días y el sensor lo declara sano. El
2026-08-08 eso hizo que dos lecturas separadas por seis horas dieran 35 nodos bloqueados y 1, con
el mismo código. Si vas a afirmar algo sobre el estado de AHORA, mirá primero si esta foto venció.

EDAD DE CADA ARCHIVO (de más vieja a más nueva — una foto NO es una edad)
${EDADES}

SERVICIOS (launchd, al momento de la foto)
$(seccion SERVICIOS | sed 's/^/  /')

  Cada archivo de arriba lo escribe uno de estos: sender-measurement.json ← flota-salud,
  sender-cap.json ← warmup-cupo, warmup-monitor.json ← warmup-monitor. Servicio caído = archivo
  congelado, por más nueva que sea la foto.

LOGS EN EL ORIGEN (acá tenés las últimas ${TAIL} líneas de cada uno)
$(seccion LOGS | sed 's/^/  /')

  OJO: warmup-daemon.log y warmup-cupo.log NO ESCRIBEN FECHA en sus líneas. Se puede saber QUÉ pasó
  y en qué orden, nunca A QUÉ HORA. Para ubicar un evento en el tiempo hay que cruzarlo con
  warmup-monitor.log o gateway.log, que sí la escriben.

INVENTARIO EN EL ORIGEN (lo que existe allá; la foto copia sólo los .json)
$(seccion INVENTARIO_REMOTO | sed 's/^/  /')

ENTORNO (nombres siempre; el valor sólo cuando no puede ser un secreto por su forma)
$(seccion ENTORNO | sed 's/^/  /')

═══ DÓNDE ESTÁ CADA RESPUESTA ════════════════════════════════════════════════════════════════════

  qué nodos están sanos / atascados / cerrados y por quién   → inventory/sender-measurement.json
  qué decide el warmup hoy por dominio (placement, cupo,     → inventory/warmup-monitor.json,
    acción y motivo, ya cruzado con la base de datos)            en .hechos.plan y .hechos.flota
  cuánto puede mandar hoy cada nodo (cupo físico de Postfix) → inventory/sender-cap.json
  SPF / DKIM / DMARC / PTR / listas negras por dominio       → inventory/warmup-reputacion.json
  qué IP y qué nodo tiene cada dominio                       → inventory/smtp-provisioning.json
  a qué buzones semilla se manda y cuáles MIDEN              → inventory/warmup-seeds.json
  si NFC está aislado en la atribución                       → sender-measurement.json,
                                                                 .bandejas[].atribucion.modo
  si un dominio cruzó el umbral permanente de Google         → sender-measurement.json,
                                                                 .bandejas[].cruzados / .picos

═══ LO QUE ESTA FOTO NO PUEDE CONTESTAR ══════════════════════════════════════════════════════════

  · CUÁNTO DEL TRÁFICO ES DE NFC. Mientras medir-flota.ts llame con \`libro: "todo"\`, las bandejas
    miden el nodo entero: atribucion.modo="todo" y ajeno en cero. El cero NO significa "no hay
    tráfico ajeno", significa "no se separó".
  · EL DESGLOSE DE LA COLA LARGA DE NFC. porReceptor trae los receptores con 20 intentos o más
    (techo de TAMAÑO del archivo, no una medición) MÁS los que decidieron el veredicto, sin piso.
    Los miles de receptores de NFC con dos o tres líneas siguen sin aparecer, y su ausencia no es
    un cero.
  · A QUÉ HORA pasó algo del warmup-daemon o del cupo (sus logs no llevan fecha).
  · CUALQUIER COSA que sólo esté en el mail.log crudo de un nodo (58 VPS, cientos de MB).

  Ninguna de estas se va a buscar al nodo. Se escribe la pregunta y qué comando la contestaría.

═══ LO QUE ESTA FOTO CONTESTA DESDE EL DESPLIEGUE DEL 2026-08-08 ═════════════════════════════════

  Las dos entradas de abajo estaban en la lista de arriba hasta el 2026-08-08. El código ya las
  escribe, pero SÓLO APARECEN EN UNA FOTO POSTERIOR A "DESPLEGAR → VOLVER A MEDIR": flota-salud
  reescribe sender-measurement.json cada 6 h, y hasta ese barrido el archivo es el viejo. Si esta
  foto es posterior al barrido y el campo NO está, entonces el lote 3 no terminó — es esa la
  pregunta que hay que hacer, y no "¿estará cableado?".

  · POR QUÉ nos cierra un receptor        → sender-measurement.json,
                                              .bandejas[].culpaPorProveedor
    Una clave por cada receptor de cerradoEn (más los degradados) con dominio / ip / buzon / no-se.
    Es la diferencia entre "comprá un dominio nuevo" (dominio: el nombre está quemado, la IP no) y
    "no gastes un peso" (ip: un dominio nuevo sobre este nodo nace bloqueado). Un mapa {} quiere
    decir que no hay receptores cerrados, NO que no se midió; la clave ausente sí es "no se midió".
  · CUÁNTO MOVIÓ el receptor que nos cerró → sender-measurement.json,
                                              .bandejas[].porReceptor
    El receptor que decidió el veredicto ya no se cae por el piso de 20 intentos. Es el caso del
    nodo vetado por 1 entrega y 9 rechazos de Gmail: antes el estado salía sin un solo número que
    lo respaldara.

═══ CÓMO SE TRABAJA CON ESTO ═════════════════════════════════════════════════════════════════════

  1. No abras SSH contra producción. Lo que necesitás está en esta carpeta; el 2026-08-07 tres
     agentes quedaron bloqueados por ir a buscarlo ellos y un entregable no existió.
  2. Antes de citar un número, mirá su fila en EDAD DE CADA ARCHIVO — no la hora de la foto. En una
     misma foto conviven archivos de 4 minutos y de 68 días.
  3. Un bloque ausente o un cero sin medición es "no sé", nunca "no hay". Si no está acá, va a
     \`no_verificado\` con el comando que lo contestaría y por qué hace falta.
  4. Si te falta un dato, no vayas al nodo: pedile al operador que corra
     \`bash scripts/ops/foto-produccion.sh\` de nuevo, o agregale el campo al script.
  5. La foto es de LECTURA. Nada que se descubra acá se ejecuta contra producción: se le propone al
     operador, con su peor caso y su cuenta.
EOF

echo "listo: $DESTINO"
cat "$DESTINO/MANIFIESTO.txt"
