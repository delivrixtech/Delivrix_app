# Arquitectura de producción — Mac Studio (2026-08-05)

**Objetivo:** delivrix app operando 24/7 en la Mac Studio, sin interrupción aunque la máquina
se reinicie por un bug o una actualización del sistema operativo. Nada puede depender de una
sesión abierta (terminal, screen, VS Code) ni de que alguien haga login.

**Mapa visual:** `MAPA_PRODUCCION_MAC_STUDIO_2026_08_05.html` (regenerable con
`DOCUMENTACION/herramientas/gen_mapa_produccion_studio.py`). Verificado en navegador.

---

## 1. Quién vive dónde

| Máquina | Rol | Tailscale |
|---|---|---|
| **Mac Studio** (M4 Max, 64 GB) | **Producción**: gateway :3000, panel :5173, warmup daemon, agente monitor, cupo, PostgreSQL | `100.87.218.46` |
| **Mac mini** (M4 Pro, 48 GB) | Cerebro de inferencia: Qwen3.6 (LM Studio). El agente le consulta cada 10 min. Recibe el backup nocturno. | `100.104.216.127` |
| **MacBook de Juanes** | Desarrollo. Ya NO corre producción. | `100.75.144.40` |
| **Flota** (58 nodos Contabo/Webdock) | Envío SMTP real. Nunca dependió de una Mac: Postfix sigue solo. | — (SSH directo) |
| **Bastión Tampa (Hivelocity)** | Futuro: colo propio, próximos SMTPs. Contratado, sin cablear. Ver `PLAN_COOL_HIVELOCITY_DIVIDIR_BESTION_2026_06_26.md`. | — |

Acceso remoto (iPhone/MacBook desde cualquier lugar) **solo por Tailscale**. El panel no se
parte con Vercel ni se expone a internet: el gateway guarda las llaves SSH de la flota, los
tokens de aprobación y el kill switch; cero puertos abiertos al público.

## 2. Los servicios como launchd (no screen)

Hoy en la laptop todo corre en `screen` lanzado a mano — muere con la sesión. En la Studio,
cada proceso es un **LaunchDaemon** (`/Library/LaunchDaemons/com.delivrix.*.plist`) con:

- `RunAtLoad=true` → arranca al encender la Mac, **antes y sin login de nadie**.
- `KeepAlive=true` → si el proceso muere (bug, OOM), launchd lo relanza solo en segundos.
- `UserName` = usuario operador (no root), `WorkingDirectory` = el repo, `StandardOutPath`/`StandardErrorPath` → `runtime/logs/`.
- `ThrottleInterval=10` para no ciclar en caliente si algo muere en bucle.

Servicios (×6): `gateway`, `admin-panel`, `warmup-daemon`, `warmup-monitor`, `warmup-cupo`, `postgresql`.

**PostgreSQL: Homebrew, NO Docker/OrbStack.** Cualquier runtime de contenedores (Docker Desktop,
OrbStack) corre como app de usuario y necesita sesión iniciada — exactamente la dependencia que
estamos eliminando. En la Studio: `postgresql@16` + extensión `pgvector` por Homebrew (brew
services ya es launchd por debajo). Los datos se migran una vez con `pg_dump`/`pg_restore` desde
el contenedor `delivrix-postgres` de la laptop. **Consecuencia:** la licencia de OrbStack se
queda solo en la MacBook (desarrollo); ni la mini ni la Studio la necesitan.

**Secretos:** `config/gateway.env` (con `CREDENTIAL_ENCRYPTION_KEY`) y las llaves SSH de la
flota se copian una vez a la Studio, permisos `600`. FileVault va **apagado** (ver §3), así que
el disco no cifra en frío — aceptable porque la Studio está fija en el sitio de Miami y no viaja.

## 3. La tabla del "jamás parar"

| Evento | Defensa | Tiempo muerto |
|---|---|---|
| Corte de luz | **No aplica**: el sitio de Miami tiene generadores. `pmset autorestart 1` queda igual, por si acaso | 0 |
| Kernel panic / la Mac se cuelga | `systemsetup -setrestartfreeze on` + RunAtLoad | ~2 min |
| Un proceso muere (bug, OOM) | `KeepAlive` de launchd | segundos |
| Proceso vivo pero colgado | watchdog launchd cada 5 min: `curl /health` y estado del daemon → `launchctl kickstart -k` si falla | ≤ 5 min |
| La Mac se duerme | `pmset sleep 0` — jamás duerme (el modo de falla que hoy mata todo en la laptop) | nunca ocurre |
| Actualización de macOS | Automáticas **APAGADAS**. Se hacen a mano, en ventana elegida; al volver, todo arranca solo | ventana que tú eliges |
| FileVault pidiendo clave al arrancar | FileVault **OFF** en esta máquina (si no, tras cada reinicio espera una contraseña que nadie va a teclear y NADA arranca) | — |
| Actualización de delivrix app | ver §4 | segundos |
| La Studio muere del todo (hardware) | ver §5 | horas el cerebro; la flota, cero |

**Chequeo cruzado (lección del nodo vivo-pero-incomunicado):** una máquina nunca es testigo de
su propia muerte. La **mini** (que ya está 24/7) consulta cada 10 min el `/health` de la Studio
por Tailscale y deja alerta si no responde. El watchdog local cubre el proceso colgado; la mini
cubre la Studio colgada.

## 4. Actualizar sin interrumpir la producción

```
ssh studio (Tailscale) → git fetch + git merge --ff-only origin/produ → launchctl kickstart -k <servicios que cambiaron>
```

- El corte es de **segundos**. La flota ni se entera (Postfix sigue enviando); el daemon retoma
  la vuelta siguiente y la medición del cupo sobrevive interrupciones (commit `37878e7`).
- Regla vigente: **un proceso largo NO se entera de un commit** — sin `kickstart`, sigue
  corriendo la versión que tenía en memoria.
- Los reinicios de segundos son inocuos. Lo letal era lo de antes: horas muerta porque una
  laptop se durmió.

## 5. Si la Studio muere igual (radio de la explosión)

- **La flota sigue enviando**: los 58 nodos nunca dependieron de una Mac.
- **El warmup pausa**: la reputación no retrocede, solo deja de avanzar. (La medición del cupo
  vence a las 12 h; al revivir, el servicio `cupo` re-mide solo.)
- **Restaurar en otra Mac** (mini o MacBook) en ~1 hora con 3 respaldos:
  1. el repo (GitHub, rama `produ`);
  2. `pg_dump` **nocturno** (launchd) que viaja por Tailscale a la mini;
  3. copia cifrada de `config/gateway.env` + llaves SSH.

## 6. Qué NO cambia

- La rama de despliegue sigue siendo `produ`, mismo flujo de PRs.
- El agente sigue consultando el modelo de la mini (repuntarlo a la Studio es una migración
  futura aparte, con su propia prueba de estrés).
- Los gates: approval tokens, kill switch, dry-run por defecto, `SMTP_SEND_REAL_EMAIL_ENABLE=false`.
- Tampa/Hivelocity entra después como más nodos de flota bajo el mismo orquestador — el cerebro
  no se toca.

## 7. Relevo en la mini — standby tibio, activación con decisión

La idea del owner (2026-08-05): que Studio y mini trabajen "en cadena" — si una falla, la otra
entra en faena. El concepto es correcto (alta disponibilidad activo-pasivo), pero con una regla
dura de ESTE dominio:

> **En warmup, correr DOS VECES es peor que estar PAUSADO.** Un warmup pausado no pierde
> reputación (solo deja de avanzar). Un warmup duplicado duplica el volumen hacia Gmail y
> empuja dominios al umbral de "bulk sender", que es **permanente e irreversible**
> (`gmail-bulk-sender-permanente`). Por eso el failover jamás es automático.

El lock de instancia del daemon (`live-warmup-daemon.ts`, `pg_try_advisory_lock`) protege
contra dos daemons **sobre la misma base**. Si la mini tuviera su propia copia de la base, el
lock NO protege: partición de red entre las dos Macs → cada una cree que la otra murió → dos
daemons enviando → split-brain con daño permanente. La única defensa real es que activar el
relevo sea una decisión, no un reflejo.

> **Bug encontrado y corregido el 2026-08-05 al diseñar esto.** El lock se tomaba sobre el
> *pool* (`pool.query`), y pg-pool cierra las conexiones ociosas a los 10 s
> (`idleTimeoutMillis` por defecto): como el daemon duerme minutos entre vueltas, la sesión
> moría y **el lock se evaporaba a los ~10 s de arrancar**. Reproducido contra la base real y
> corregido: cliente dedicado que vive lo que vive el daemon + revalidación al inicio de cada
> vuelta + **fail-closed** (antes seguía sin lock ante un error). Verificado por el camino de
> producción: un segundo daemon ahora se niega a correr. Esto vale con una sola máquina — el
> bug ya permitía dos daemons en la misma Mac.

**Topología de datos del standby (decidida por el panel adversarial):** Postgres corre **solo
en la Studio** (escritor único). Los componentes seguros que se dupliquen en la mini apuntan a
ESA base, nunca a una copia propia. Se descarta explícitamente la réplica streaming con
promoción automática: los advisory locks viven en memoria del primario y no se replican, así
que una promoción en partición da dos contadores independientes. La copia restaurada del
respaldo **jamás decide volumen**: al activar el relevo, el día en curso se reconstruye desde
la verdad física de los nodos (contadores del policy service + logs por SSH), y se arranca a
medio tope durante 24 h.

**Diseño del standby:**

- La mini tiene TODO instalado pero **apagado**: repo en `produ`, `gateway.env`, llaves SSH,
  Postgres Homebrew, los mismos plists launchd con los servicios **desactivados** (`bootout`).
- El respaldo nocturno (§5) se restaura automáticamente en el Postgres de la mini: la base
  standby nunca está a más de 24 h del presente (subir a cada hora si duele — el dato del
  warmup tolera perder un día).
- **Activar el relevo = un solo comando en la mini** (`standby-activar`), que exige dos cosas:
  (1) verifica él mismo por Tailscale + SSH que la Studio está realmente muerta, y
  (2) confirmación humana explícita. Recuperación en ~2 minutos en vez de ~1 hora, decisión
  incluida.
- **Volver a la Studio** = el mismo procedimiento al revés, con la regla inviolable: primero
  apagar los servicios en una, después encenderlos en la otra. Nunca dos activos.

**¿Y si fallan las dos?** La flota sigue enviando sola (nunca dependió de una Mac) y la MacBook
puede levantar el mismo standby desde los 3 respaldos. Una tercera réplica dedicada hoy es
sobre-ingeniería: dos máquinas siempre encendidas + flota autónoma + restauración en minutos ya
cubre el caso. Cuando el bastión de Tampa esté cableado, esa será la tercera pata natural.

**Corrección del 2026-08-05 (dato del owner):** las dos Macs están en Miami, en un sitio con
generadores. La luz deja de ser un riesgo compartido y el UPS deja de tener sentido. Lo que
SIGUE siendo compartido es la **red y la ubicación**: las dos están detrás del mismo enlace, así
que una caída de conectividad del sitio las deja a ambas incomunicadas. Eso no lo arregla un
relevo entre ellas — lo arregla Tampa, que es un dominio de falla independiente.

**Sobre "cargas de trabajo grandes":** el cerebro no es la carga pesada — pesa ~660 MB y decide;
el trabajo pesado lo hacen la flota (envío) y la mini (inferencia). La Studio con 64 GB queda
con margen enorme; el cuello de botella del sistema es la reputación ante Gmail, no el hardware.

## 8. Checklist de migración (orden de ejecución)

El kit vive en `scripts/produccion/` (ver su `README.md`). Los pasos marcados ✅ ya están
construidos y probados; los `[ ]` son los que requieren la máquina.

- ✅ Kit de producción escrito y probado: `servicio.sh`, `instalar-produccion.sh`, `watchdog.sh`,
  `respaldo-nocturno.sh`, `desplegar.sh`, `vigilar-desde-la-mini.sh`, `lib.sh` +
  `produccion.test.sh` (self-check verde).
- ✅ Lanzador verificado por el camino real: el panel levanta en :5173 y su proxy autenticado
  responde 200 (no 401), o sea que la derivación de tokens es correcta.
- ✅ Bug del lock anti-duplicados encontrado, reproducido y corregido (§7).
1. [ ] Studio: usuario operador, **Remote Login (SSH) ON** ← lo único que bloquea empezar.
       Tailscale ya está (`100.87.218.46`, responde).
2. [ ] Homebrew + `node` + `postgresql@16` + `pgvector`; `sudo brew services start postgresql@16`.
3. [ ] FileVault OFF (si no, tras cada reinicio nada arranca).
4. [ ] Clonar repo en `produ`; copiar `config/gateway.env` (600) con **`POSTGRES_CONTAINER=`
       vacío**, y las llaves SSH de la flota.
5. [ ] Migrar datos: `pg_dump` del contenedor de la laptop → restaurar en la Studio.
6. [ ] `sudo ./scripts/produccion/instalar-produccion.sh` (sin el emisor).
7. [ ] Verificación canónica: `/health` ok, historial sin 401, `/v1/warmup/status` enabled,
       `/v1/warmup/plan` con pool.
8. [ ] **Prueba de fuego: reiniciar la Studio** y comprobar que todo vuelve solo, sin tocar nada.
9. [ ] Apagar el stack de la laptop (`warmup-servicios.sh stop` + `delivrix-gateway-stop.sh`).
10. [ ] `sudo ./scripts/produccion/instalar-produccion.sh --con-warmup` ← recién acá empieza a
        mandar correo desde producción. El orden 9→10 no es negociable.
11. [ ] Mini: `vigilar-desde-la-mini.sh` cada 10 min + recibir el respaldo nocturno.
12. [ ] Standby completo en la mini (§7): piezas instaladas y APAGADAS + `activar-cerebro.sh` con
        interlocks. (Diseñado, no construido: se hace cuando lo anterior esté firme.)

El paso 8 no es opcional: es la prueba de que la promesa ("así se reinicie, sigue operando")
es verdad medida y no configuración declarada.
