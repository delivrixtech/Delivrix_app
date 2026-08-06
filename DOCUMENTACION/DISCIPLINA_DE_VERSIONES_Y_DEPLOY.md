# Disciplina de versiones y deploy — Delivrix

Cómo se sube una versión nueva a producción **sin romper lo que está funcionando**. Este es el
acuerdo entre el operador (Juanes) y quien asista (Claude/Codex): las dos partes siguen esto.

Contexto que lo hace necesario: desde el 2026-08-05 producción es la **Mac Studio** y el
desarrollo es la **laptop**. Son dos máquinas distintas corriendo el mismo repo, y la pregunta
"¿lo que estoy mirando ya tiene el fix?" dejó de tener respuesta obvia.

---

## 1. La versión vive en un solo lugar

`CHANGELOG.md`, en la raíz. **Su primer encabezado ES la versión.**

```markdown
# v1.5 — 2026-08-12

- lo que mejoró, en una frase que entienda alguien que no vio el código
- ...
```

Nadie sincroniza nada: `apps/gateway-api/src/build-info.ts` lee ese encabezado y le suma el
commit real (`git rev-parse HEAD` al arrancar). De ahí sale todo lo demás.

**El número lo subís vos, a mano.** Es exactamente el evento que estás describiendo cuando decís
"esto ya es la 1.5", no una tarea nueva. La fecha y el commit los calcula la máquina, así que si
la prosa se queda vieja, el desfase se ve — en vez de mentir en silencio.

Criterio para el número, simple y sin ceremonia:

| Cambio | Sube |
|---|---|
| Arreglos, ajustes, mejoras internas | nada (queda en el changelog de la versión en curso) |
| Algo nuevo que el operador nota o usa | **menor** (1.0 → 1.1) |
| Cambia cómo se opera, o migra infraestructura | **mayor** (1.x → 2.0) |

## 2. Dónde se ve la versión

| Superficie | Cómo |
|---|---|
| **Panel** | chip "versión" en Gobierno → Seguridad, junto a "fase del norte" |
| **Desde afuera** | `curl -s localhost:3000/health` → `build: {version, commit, changelog}` |
| **Los agentes internos** | bloque `## version` al inicio del `<live_context>`, regenerado en cada turno |
| **El deploy** | imprime la versión y el commit que **reporta producción**, no el que calculó el script |

Lo de los agentes es la razón de ser de todo esto: cuando OpenClaw responde sobre el sistema, sabe
qué versión corre y qué cambió último. Va como **dato tipado, no como prosa** — un párrafo de
novedades suelto el modelo lo repite como si fuera un hallazgo propio, y ese bug ya se pagó una
vez en el monitor del warmup.

## 3. El ciclo, de principio a fin

```bash
# 1. trabajás en la laptop, en una rama o directo en produ
npm test                                    # el gate: 2740 tests, tiene que dar 0 fallos

# 2. si la versión sube, editás CHANGELOG.md (encabezado nuevo arriba)

# 3. commit y push
git push origin produ

# 4. a producción
./scripts/produccion/desplegar.sh

# 5. mirarlo funcionando
./scripts/produccion/tunel.sh               # abre el panel de producción en tu navegador
```

El paso 4 hace, por su cuenta: `fetch` + `merge --ff-only`, reinicia **solo** los servicios cuyos
archivos cambiaron, corre `npm ci` si cambió `package.json`, y **verifica que el gateway reporte
el commit nuevo**. Si producción sigue corriendo código viejo, el deploy **falla**.

Te va a pedir **una vez** la contraseña de la Studio: reiniciar servicios de sistema exige root.
Está agrupado para que sea un solo prompt por deploy, no uno por servicio.

Esa contraseña es **la última dependencia humana de todo el sistema**. Todo lo demás corre solo:
launchd levanta los servicios al arrancar la Studio, el watchdog los repone si se caen, el respaldo
corre de noche, y el agente vigila y actúa cada 10 minutos. Pero el código nuevo se queda esperando
a que alguien esté despierto y conectado.

Para cortarla hay un script que instala una regla acotada en `/etc/sudoers.d/delivrix-deploy`:

```bash
bash scripts/produccion/deploy-sin-clave.sh     # una sola vez
```

Instala **exactamente** esto y nada más:

```text
delivrixstudio ALL=(root) NOPASSWD: /bin/launchctl kickstart -k system/com.delivrix.*
```

Valida la sintaxis con `visudo -cf` **antes** de mover el archivo a su lugar (un sudoers roto deja
la máquina sin poder usar `sudo`, ni siquiera para arreglarlo) y después comprueba con `sudo -n`
que de verdad quedó sin contraseña, en vez de descubrirlo en el primer deploy nocturno.

Es una decisión del dueño, no la toma el asistente: cambia la postura de seguridad de la máquina.
Dicho sin adornos — **quien tenga la llave SSH puede reiniciar los servicios de Delivrix sin
contraseña**. Eso es una molestia (el warmup pierde unos segundos y vuelve), no un root arbitrario:
el comando está anclado con ruta absoluta y el comodín solo alcanza a `com.delivrix.*`, así que no
habilita instalar, leer archivos ajenos ni tocar ningún otro servicio.

Se revierte borrando el archivo: `ssh studio 'sudo rm /etc/sudoers.d/delivrix-deploy'`.

## 4. Las reglas que no se negocian

1. **`npm test` verde antes de push.** No es opinable: el gate corre 2740 tests y cubre la política
   de envío, las colas, la persistencia y los gates de seguridad.
2. **`--ff-only` siempre.** Producción nunca hace merge de verdad; si no avanza en línea recta,
   se resuelve en la laptop.
3. **Un proceso largo no se entera de un commit.** Sin reiniciar el servicio, sigue corriendo la
   versión que tenía en memoria. Por eso el deploy reinicia — y por eso verifica el commit.
4. **Nunca dos emisores de warmup.** El daemon manda correo real; dos instancias contra bases
   distintas duplican el volumen hacia Gmail y eso cruza un umbral **permanente**. El lock de la
   base protege dentro de una máquina, no entre máquinas.
5. **Producción no se edita a mano.** Todo cambio entra por `produ`. Si hubo que tocar algo en
   caliente, se replica en el repo el mismo día o se pierde en el próximo deploy.
6. **Ante la duda, pausar.** Pausar el warmup no cuesta reputación; enviar de más sí, y no se
   deshace.

## 5. Si algo sale mal

```bash
# ver qué corre realmente
curl -s localhost:3000/health | head -8            # con el túnel abierto

# volver atrás: producción vuelve al commit anterior y se reinicia
ssh studio 'cd /Users/Shared/delivrix && git reset --hard <commit-bueno>'
ssh -t studio 'sudo launchctl kickstart -k system/com.delivrix.gateway'

# apagar el emisor sin tocar nada más (queda apagado hasta que lo vuelvas a cargar)
ssh -t studio 'sudo launchctl bootout system/com.delivrix.warmup-daemon'

# logs
ssh studio 'tail -50 /Users/Shared/delivrix/runtime/logs/gateway.log'
ssh studio 'tail -30 /Users/Shared/delivrix/runtime/logs/watchdog.log'
```

El respaldo de la base sale todas las noches a las 03:30 y viaja a la mini. La flota de 58 nodos
sigue enviando aunque el cerebro esté caído: un deploy fallido pausa el warmup, no lo destruye.

## 6. Lo que este esquema NO cubre (a propósito)

- **El agente 24/7 del warmup no recibe el changelog.** Su prompt es código y valida que toda
  afirmación salga de hechos verificados; meterle prosa de novedades reintroduce un bug ya
  arreglado. Si algún día lo necesita, entra como campo tipado, nunca como párrafo.
- **El generador de conversación del warmup tampoco**, y menos: es un actor escribiendo correo
  real a Gmail. Un changelog ahí solo puede contaminar el texto que sale.
- **No hay semver por paquete, ni tags, ni changelog automático.** Un archivo declarativo y dos
  puntos de lectura. Si algún día hace falta más, se agrega — pero no antes.
- **Divergencia dev/prod del system prompt fijo**: `.audit/system-context.txt` está gitignoreado y
  no viaja a la Studio, así que producción lee el `.md` de fallback y la laptop lee el `.txt`.
  Es un problema real y **separado**; este esquema lo esquiva inyectando por el `live_context`,
  que es idéntico en las dos máquinas. Queda anotado para cerrarlo aparte.
