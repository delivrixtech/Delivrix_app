# Producción — la Mac Studio que no se detiene

Kit para que delivrix app corra 24/7 en la Mac Studio, sobreviva reinicios sin que nadie haga
login, y se actualice desde la laptop sin cortar la operación.

Diseño y razones: `DOCUMENTACION/ARQUITECTURA_PRODUCCION_MAC_STUDIO_2026_08_05.md`
Mapa visual: `DOCUMENTACION/MAPA_PRODUCCION_MAC_STUDIO_2026_08_05.html`

## Las piezas

| Archivo | Dónde corre | Qué hace |
|---|---|---|
| `servicio.sh` | Studio (lo llama launchd) | lanza UN servicio en primer plano. Sin screen, sin PID files: launchd es el supervisor |
| `instalar-produccion.sh` | Studio, con sudo | energía + actualizaciones + LaunchDaemons + watchdog + respaldo. Idempotente |
| `watchdog.sh` | Studio, cada 5 min | el caso que launchd NO ve: proceso vivo pero colgado |
| `respaldo-nocturno.sh` | Studio, 03:30 | pg_dump verificado + copia a la mini por Tailscale |
| `activar-warmup.sh` | **la laptop** | enciende el emisor en producción (una vez) |
| `tunel.sh` | **la laptop** | trae el panel de producción a tu navegador |
| `desplegar.sh` | **la laptop** | produ → producción, reiniciando solo lo que cambió |
| `vigilar-desde-la-mini.sh` | la mini, cada 10 min | mira a la Studio desde afuera y avisa; NO activa nada |
| `lib.sh` | ambas | la lógica que puede fallar en silencio, para poder probarla |
| `produccion.test.sh` | cualquiera | `bash scripts/produccion/produccion.test.sh` |

## Instalación en la Studio (una sola vez)

Requisitos previos, a mano:

1. **Sesión remota (SSH)** encendida: Ajustes → General → Compartir → Sesión remota.
2. **Tailscale** con la misma cuenta (la Studio ya es `100.87.218.46`).
3. **Homebrew + node + Postgres**, NO contenedores:
   ```
   brew install node postgresql@17 pgvector
   brew services start postgresql@17
   ```
   Docker/OrbStack corre como app de usuario y necesita sesión iniciada — justo la dependencia
   que este kit elimina. Por eso Postgres va nativo.
4. **FileVault apagado.** Con FileVault, tras cada reinicio la Mac espera una contraseña que
   nadie va a teclear y no arranca nada. La promesa de 24/7 sería falsa.
5. El repo clonado en **`/Users/Shared/delivrix`** (NO en `~/Documents`: macOS le prohíbe a los
   LaunchDaemons leer Documents/Desktop/Downloads y mueren con `Operation not permitted`),
   rama `produ`, con `config/gateway.env`
   copiado (permisos 600) y **`POSTGRES_CONTAINER=` vacío**.
6. Datos migrados: `pg_dump` desde la laptop → `pg_restore`/`psql` en la Studio.

Después:

```bash
# 1) todo MENOS el daemon que manda correo
sudo ./scripts/produccion/instalar-produccion.sh

# 2) reiniciar la Studio y comprobar que TODO vuelve solo   ← la prueba que vale
sudo reboot

# 3) recién ahí, apagar el stack de la laptop
#    (en la laptop):  ./scripts/warmup-servicios.sh stop && ./scripts/delivrix-gateway-stop.sh

# 4) y activar el emisor en producción (DESDE LA LAPTOP)
./scripts/produccion/activar-warmup.sh
```

El orden de 3 y 4 **no es negociable**: dos daemons contra bases distintas duplican el volumen
hacia Gmail, y cruzar el umbral de "bulk sender" es permanente. El lock de la base protege dos
daemons sobre la MISMA base — no cruza máquinas.

## Desplegar una versión nueva (desde la laptop)

```bash
git push origin produ
./scripts/produccion/desplegar.sh      # ← EN LA LAPTOP, no dentro de la Studio
```

Hace fetch + `merge --ff-only`, reinicia **solo** los servicios cuyos archivos cambiaron,
corre `npm ci` si cambió `package.json`, y verifica `/health` antes de darse por bueno.
Se niega a correr si la laptop todavía tiene el daemon de warmup vivo.

El corte es de segundos y es inocuo: la flota de 58 nodos sigue enviando sola (Postfix no
depende de ninguna Mac) y el daemon retoma en la vuelta siguiente.

## Operación diaria

```bash
launchctl list | grep delivrix                 # qué está cargado
tail -f runtime/logs/gateway.log               # o panel / warmup-daemon / watchdog
sudo launchctl kickstart -k system/com.delivrix.gateway    # reiniciar uno
sudo launchctl bootout system/com.delivrix.warmup-daemon   # apagar el emisor (queda apagado)
```

Verificación canónica (la misma de siempre):

```bash
curl -s localhost:3000/health | head -3        # status ok
curl -s -o /dev/null -w '%{http_code}' localhost:5173/v1/openclaw/chat/conversations   # 200, no 401
curl -s localhost:5173/v1/warmup/status        # enabled: true
curl -s localhost:5173/v1/warmup/plan          # el pool del día
```

## Lo que este kit NO hace

- **No hace failover automático a la mini.** Es deliberado: en warmup, enviar dos veces es peor
  que estar pausado. Pausar no cuesta reputación; duplicar puede cruzar un umbral permanente. El
  relevo se activa a mano (§7 del documento de arquitectura).
- **No protege contra que se caiga el sitio.** El sitio de Miami tiene generadores, así que la
  luz no es el riesgo; lo compartido es la RED y la ubicación. Eso lo ataca Tampa, no un UPS.
- **No reemplaza mirar los logs.** El watchdog reinicia lo que no responde y lo deja escrito;
  no diagnostica por qué.
