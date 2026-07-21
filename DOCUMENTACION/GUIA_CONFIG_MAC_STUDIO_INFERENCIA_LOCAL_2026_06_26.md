# Guía de configuración — Mac Studio (cerebro IA local, Miami)

> Track E del roadmap Own the Rails. Comandos listos para ejecutar **apenas tengas el acceso remoto**.
> Rol de la Mac Studio: inferencia IA local barata y de alta frecuencia (clasificar respuestas / sentiment del Unibox, lógica de warm-up, scoring) para **no depender de Bedrock**.

**Máquina:** Mac Studio M4 Max, 64 GB · **Ubicación:** Miami (misma región que Cool/Tampa) · **Acceso:** remoto.

---

## Resumen del montaje

```
Delivrix (gateway / control plane)
        |  HTTP (API OpenAI-compatible) sobre Tailscale (red privada)
        v
Mac Studio (Miami)  ->  LM Studio (daemon headless)  ->  modelo local (gpt-oss-20b)
```

Tres pasos: **E1** acceso remoto · **E2** runtime + modelo · **E3** exponerlo a Delivrix. Cada uno con su criterio de cierre (DoD).

---

## E1 · Acceso remoto (SSH + Tailscale)

> Esto requiere un primer toque a la Mac (en persona, o por screen-sharing de quien la tenga al lado en Miami) para dejarla accesible. Después, todo es remoto.

**1. Habilitar SSH (Remote Login) en macOS.** En la Mac:

```
sudo systemsetup -setremotelogin on
# verificar:
sudo systemsetup -getremotelogin     # -> Remote Login: On
```

(O por GUI: Ajustes del Sistema > General > Compartir > Inicio de sesión remoto = ON.)

**2. Instalar Tailscale** (red privada cifrada; evita abrir puertos al internet público):

```
# opcion CLI (requiere Homebrew):
brew install --cask tailscale
# luego autenticar:
tailscale up
```

(O descargar la app desde tailscale.com, iniciar sesión con la misma cuenta del tailnet de Delivrix.)

**3. Anotar el nombre/IP de la Mac en el tailnet.** Tras `tailscale up`:

```
tailscale status        # muestra la IP 100.x.y.z y el nombre MagicDNS (ej. mac-studio)
tailscale ip -4         # solo la IPv4 del tailnet
```

**DoD E1:** desde otra máquina del tailnet, `ssh juanes@mac-studio` entra sin estar en la misma red local.

---

## E2 · Runtime de inferencia + modelo

> Camino recomendado: **LM Studio headless** (el más simple y robusto; trae servidor OpenAI-compatible). Más abajo está la alternativa MLX para máximo control.

### Opción A — LM Studio headless (recomendada)

**1. Instalar LM Studio** (incluye el CLI `lms`):

```
brew install --cask lm-studio
# (o descargar desde lmstudio.ai; el CLI 'lms' queda disponible tras el primer arranque)
```

**2. Arrancar el daemon headless** (no necesita la ventana de la app):

```
lms daemon up
```

**3. Descargar y cargar el modelo** gpt-oss-20b (rápido, MoE 3.6B activos, cabe sobrado en 64 GB):

```
lms load openai/gpt-oss-20b
# si pide bajarlo primero:  lms get openai/gpt-oss-20b
```

**4. Levantar el servidor** (OpenAI-compatible, escucha en el puerto 1234):

```
lms server start
# -> queda sirviendo en http://localhost:1234/v1
```

**DoD E2:** responde local:

```
curl http://localhost:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-oss-20b","messages":[{"role":"user","content":"responde solo OK"}]}'
```

### Opción B — MLX (alternativa, más liviano/rápido, más manual)

```
pip install "mlx-lm[server]"
mlx_lm.server --model mlx-community/Qwen3-30B-A3B-4bit --port 8080
# -> http://localhost:8080/v1  (API OpenAI-compatible)
```

### Modelo: cuál usar

- **gpt-oss-20b** (por defecto): el más rápido/eficiente para **alta frecuencia** (clasificar, taggear, decidir warm-up). MoE con solo 3.6B activos = latencia muy baja. Ideal para el rol de la Mac.
- **Qwen3-30B-A3B**: si querés más calidad de razonamiento en algunos casos (también MoE rápido). Cabe en 64 GB en 4-bit.

Para el trabajo de la Mac (clasificación + scoring de alto volumen), **gpt-oss-20b** es la mejor relación velocidad/calidad.

---

## E3 · Exponer el endpoint a Delivrix (sobre Tailscale)

> El gateway de Delivrix (o el host del control plane) debe estar en el **mismo tailnet**. Así la llamada viaja por la red privada cifrada, nunca por internet público.

**1. Hacer que el servidor escuche en la red (no solo en loopback).** En LM Studio: activar **"Serve on Local Network"** (Developer > Settings). Así el puerto 1234 queda accesible por la IP del tailnet.

**2. (Alternativa con HTTPS + nombre)** exponer el puerto al tailnet con Tailscale Serve, sin tocar el bind:

```
tailscale serve --bg 1234
# expone https://mac-studio.<tu-tailnet>.ts.net -> localhost:1234
# (verificá la sintaxis exacta de tu version con: tailscale serve --help)
```

**3. Probar desde el gateway** (otra máquina del tailnet):

```
curl http://mac-studio:1234/v1/models          # por MagicDNS, o
curl http://100.x.y.z:1234/v1/models           # por IP del tailnet
```

**DoD E3:** el gateway recibe respuesta del modelo por la IP/nombre Tailscale de la Mac.

---

## Cómo lo consume Delivrix

El endpoint es **OpenAI-compatible**, así que el gateway lo usa como cualquier proveedor LLM, apuntando la base URL a la Mac:

```
LOCAL_INFERENCE_BASE_URL = http://mac-studio:1234/v1     # via Tailscale
LOCAL_INFERENCE_MODEL     = openai/gpt-oss-20b
LOCAL_INFERENCE_API_KEY   = local                          # cualquier string; el tailnet es la capa de auth
```

Las tareas que se enrutan a la Mac (fase 2, tareas E4/E5 del checklist): clasificación de respuestas del Unibox (sentiment), decisiones de la lógica de warm-up, scoring de alta frecuencia. Lo pesado/crítico de razonamiento sigue en Bedrock; lo barato y frecuente baja a la Mac.

---

## Seguridad (importante)

- **Solo tailnet, nunca Funnel.** No uses `tailscale funnel` (eso lo abre a internet público). El acceso queda restringido a las máquinas de tu red Tailscale.
- **Sin secretos en la Mac.** Es un nodo de inferencia; no guarda credenciales de envío ni de clientes.
- **El modelo no decide acciones críticas.** Clasifica y puntúa; las acciones con efecto (enviar, provisionar) siguen pasando por las aprobaciones firmadas de OpenClaw.

---

## Decisión abierta (E6): ¿también control plane?

La Mac Studio está always-on en US. Si querés, puede alojar **también** el control plane (gateway + panel), lo que resolvería de paso el "host always-on" del Track D y traería el sistema "a casa". Trade-off: simplicidad y soberanía (todo en tu hardware) vs. mantener el control plane en un Linux dedicado. Lo dejamos como decisión tuya; no bloquea E1-E3.

---

## Fuentes (comandos verificados, jun-2026)

- LM Studio CLI / headless: lmstudio.ai/docs/cli y /docs/developer/core/headless
- gpt-oss-20b en LM Studio: lmstudio.ai/models/openai/gpt-oss-20b
- mlx-lm server: github.com/ml-explore/mlx-lm
- Tailscale Serve / MagicDNS: tailscale.com/docs/reference/tailscale-cli/serve
